const { getSupabase } = require("./supabase");
const { isWithinBusinessHours } = require("./business-hours");

/**
 * Validate and sanitize after_hours_config from DB.
 * Ensures each field has the expected type to prevent runtime crashes
 * (e.g., calling .includes() on a non-string greeting).
 */
function sanitizeAfterHoursConfig(raw, assistantId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw) {
      console.error("[CallContext] after_hours_config has unexpected shape — ignoring:", {
        assistantId, type: typeof raw,
      });
    }
    return null;
  }
  return {
    greeting: typeof raw.greeting === "string" ? raw.greeting : undefined,
    customInstructions: typeof raw.customInstructions === "string" ? raw.customInstructions : undefined,
    disableScheduling: typeof raw.disableScheduling === "boolean" ? raw.disableScheduling : undefined,
  };
}

/**
 * Load all context needed to handle a call on a self-hosted phone number.
 *
 * @param {string} calledNumber - E.164 phone number (e.g. "+61299999999")
 * @param {object} [prefetchedPhone] - Optional pre-fetched phone record from lookupPhoneNumber()
 * @returns {Promise<object|null>} Combined context or null if not found/not active
 */
async function loadCallContext(calledNumber, prefetchedPhone) {
  const supabase = getSupabase();

  let phone = prefetchedPhone;
  if (phone && phone.ai_enabled === false) return null;
  if (!phone) {
    // Standalone query (backwards compat)
    // 1. Look up the phone number — must be active (accepts any voice_provider
    //    since all Twilio-routed numbers now point at the voice server)
    const { data, error: phoneError } = await supabase
      .from("phone_numbers")
      .select("id, organization_id, assistant_id")
      .eq("phone_number", calledNumber)
      .eq("is_active", true)
      .eq("ai_enabled", true)
      .single();

    if (phoneError || !data) {
      if (phoneError && phoneError.code !== "PGRST116") {
        console.error("[CallContext] Phone lookup error:", phoneError);
      }
      return null;
    }
    phone = data;
  }

  if (!phone.assistant_id) {
    console.error("[CallContext] Phone number has no assistant assigned:", calledNumber);
    return null;
  }

  // 2. Load assistant
  const { data: assistant, error: assistantError } = await supabase
    .from("assistants")
    .select("id, name, system_prompt, prompt_config, settings, first_message, is_active, voice_id, language, after_hours_config")
    .eq("id", phone.assistant_id)
    .single();

  if (assistantError || !assistant) {
    console.error("[CallContext] Assistant lookup error:", assistantError);
    return null;
  }

  if (!assistant.is_active) {
    console.warn("[CallContext] Assistant is inactive:", assistant.id);
    return null;
  }

  // 3. Load organization
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, name, industry, timezone, business_hours, default_appointment_duration, country, business_state, recording_consent_mode, appointment_verification_fields")
    .eq("id", phone.organization_id)
    .single();

  if (orgError || !org) {
    console.error("[CallContext] Organization lookup error:", orgError);
    return null;
  }

  // 4. Load knowledge base (org-level, active entries)
  const { data: kbEntries, error: kbError } = await supabase
    .from("knowledge_bases")
    .select("id, title, source_type, content, is_active")
    .eq("organization_id", phone.organization_id)
    .is("assistant_id", null)
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (kbError) {
    console.error("[CallContext] Knowledge base lookup error:", kbError);
    // Non-fatal — proceed without KB
  }

  // 5. Check if org has a calendar integration (determines whether to enable calendar tools)
  let hasCalendarIntegration = false;
  const { data: calIntegration, error: calError } = await supabase
    .from("calendar_integrations")
    .select("id")
    .eq("organization_id", phone.organization_id)
    .eq("is_active", true)
    .limit(1);

  if (calError) {
    console.error("[CallContext] Calendar integration lookup error:", calError);
    // Non-fatal — proceed without calendar tools
  } else {
    hasCalendarIntegration = (calIntegration && calIntegration.length > 0);
  }

  // 6. Check if org has business hours configured (built-in scheduling works without Cal.com)
  const hasBusinessHours = !!(org.business_hours && Object.keys(org.business_hours).length > 0);

  // 7. Load transfer rules for this assistant
  let transferRules = [];
  const { data: rules, error: rulesError } = await supabase
    .from("transfer_rules")
    .select("id, name, trigger_keywords, trigger_intent, transfer_to_phone, transfer_to_name, announcement_message, priority, destinations, require_confirmation")
    .eq("organization_id", phone.organization_id)
    .eq("assistant_id", phone.assistant_id)
    .eq("is_active", true)
    .order("priority", { ascending: false });

  if (rulesError) {
    console.error("[CallContext] Transfer rules lookup error:", rulesError);
    // Non-fatal — proceed without transfer
  } else if (rules && rules.length > 0) {
    transferRules = rules.map((r) => ({
      id: r.id,
      name: r.name,
      triggerKeywords: r.trigger_keywords || [],
      triggerIntent: r.trigger_intent,
      transferToPhone: r.transfer_to_phone,
      transferToName: r.transfer_to_name,
      announcementMessage: r.announcement_message,
      priority: r.priority,
      destinations: r.destinations || [],
      requireConfirmation: r.require_confirmation ?? false,
    }));
  }

  // 8. Load active service types for this organization
  let serviceTypes = [];
  const { data: stData, error: stError } = await supabase
    .from("service_types")
    .select("id, name, duration_minutes, description")
    .eq("organization_id", phone.organization_id)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (stError) {
    console.error("[CallContext] Service types lookup error:", stError);
  } else if (stData && stData.length > 0) {
    serviceTypes = stData;
  }

  // Aggregate KB content (mirrors src/lib/knowledge-base/aggregate.ts)
  let knowledgeBase = "";
  if (kbEntries && kbEntries.length > 0) {
    const sections = [];
    for (const entry of kbEntries) {
      const heading = entry.title || entry.source_type;
      if (entry.source_type === "faq") {
        try {
          const pairs = JSON.parse(entry.content);
          const qaParts = pairs
            .map((p) => `Q: ${p.question}\nA: ${p.answer}`)
            .join("\n\n");
          sections.push(`## ${heading}\n${qaParts}`);
        } catch (parseErr) {
          console.warn("[CallContext] FAQ entry has malformed JSON — using raw content:", {
            entryId: entry.id,
            error: parseErr.message,
          });
          sections.push(`## ${heading}\n${entry.content}`);
        }
      } else {
        sections.push(`## ${heading}\n${entry.content}`);
      }
    }
    knowledgeBase = sections.join("\n\n");
  }

  // Calendar tools are available if there's a Cal.com integration OR business hours
  // (built-in scheduling works with just business hours configured)
  const calendarEnabled = hasCalendarIntegration || hasBusinessHours;

  // Determine if the call is arriving outside business hours
  const afterHoursConfig = sanitizeAfterHoursConfig(assistant.after_hours_config, assistant.id);
  const isAfterHours = !isWithinBusinessHours(org.timezone, org.business_hours);

  // Warn if after-hours handling is enabled but timezone/hours not configured
  if (assistant.prompt_config?.behaviors?.afterHoursHandling && (!org.timezone || !org.business_hours)) {
    console.warn("[CallContext] After-hours handling enabled but timezone/business_hours not configured — after-hours detection will not work", {
      assistantId: assistant.id, organizationId: phone.organization_id,
      hasTimezone: !!org.timezone, hasBusinessHours: !!(org.business_hours && Object.keys(org.business_hours).length > 0),
    });
  }

  return {
    phoneNumberId: phone.id,
    organizationId: phone.organization_id,
    assistantId: assistant.id,
    telephonyProvider: phone.telephony_provider || "twilio",
    assistant: {
      name: assistant.name,
      systemPrompt: assistant.system_prompt,
      promptConfig: assistant.prompt_config,
      settings: assistant.settings,
      voiceId: assistant.voice_id,
      firstMessage: assistant.first_message,
      language: assistant.language || "en",
    },
    organization: {
      name: org.name,
      industry: org.industry || "other",
      timezone: org.timezone || undefined,
      businessHours: org.business_hours || undefined,
      defaultAppointmentDuration: org.default_appointment_duration ?? undefined,
      country: org.country || "US",
      businessState: org.business_state || null,
      recordingConsentMode: org.recording_consent_mode || "auto",
    },
    knowledgeBase,
    calendarEnabled,
    transferRules,
    isAfterHours,
    afterHoursConfig,
    serviceTypes,
  };
}

/**
 * Load context for a test call by assistantId and organizationId (no phone number needed).
 */
async function loadTestCallContext(assistantId, organizationId) {
  const supabase = getSupabase();

  // 1. Load assistant
  const { data: assistant, error: assistantError } = await supabase
    .from("assistants")
    .select("id, name, system_prompt, prompt_config, settings, first_message, is_active, voice_id, language, after_hours_config")
    .eq("id", assistantId)
    .eq("organization_id", organizationId)
    .single();

  if (assistantError || !assistant) {
    console.error("[TestCallContext] Assistant lookup error:", assistantError);
    return null;
  }

  // 2. Load organization
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, name, industry, timezone, business_hours, default_appointment_duration, country, business_state, recording_consent_mode, appointment_verification_fields")
    .eq("id", organizationId)
    .single();

  if (orgError || !org) {
    console.error("[TestCallContext] Organization lookup error:", orgError);
    return null;
  }

  // 3. Load knowledge base
  const { data: kbEntries, error: kbError } = await supabase
    .from("knowledge_bases")
    .select("id, title, source_type, content, is_active")
    .eq("organization_id", organizationId)
    .is("assistant_id", null)
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (kbError) {
    console.error("[TestCallContext] Knowledge base lookup error:", { organizationId, error: kbError });
  }

  // 4. Check calendar integration
  let calendarEnabled = false;
  const { data: calIntegration, error: calError } = await supabase
    .from("calendar_integrations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .limit(1);

  if (calError) {
    console.error("[TestCallContext] Calendar integration lookup error:", { organizationId, error: calError });
  }

  const hasCalendarIntegration = (calIntegration && calIntegration.length > 0);
  const hasBusinessHours = !!(org.business_hours && Object.keys(org.business_hours).length > 0);
  calendarEnabled = hasCalendarIntegration || hasBusinessHours;

  // 5. Load transfer rules
  let transferRules = [];
  const { data: rules, error: rulesError } = await supabase
    .from("transfer_rules")
    .select("id, name, trigger_keywords, trigger_intent, transfer_to_phone, transfer_to_name, announcement_message, priority, destinations, require_confirmation")
    .eq("organization_id", organizationId)
    .eq("assistant_id", assistantId)
    .eq("is_active", true)
    .order("priority", { ascending: false });

  if (rulesError) {
    console.error("[TestCallContext] Transfer rules lookup error:", { organizationId, error: rulesError });
  }

  if (rules && rules.length > 0) {
    transferRules = rules.map((r) => ({
      id: r.id,
      name: r.name,
      triggerKeywords: r.trigger_keywords || [],
      triggerIntent: r.trigger_intent,
      transferToPhone: r.transfer_to_phone,
      transferToName: r.transfer_to_name,
      announcementMessage: r.announcement_message,
      priority: r.priority,
      destinations: r.destinations || [],
      requireConfirmation: r.require_confirmation ?? false,
    }));
  }

  // 6. Load active service types for this organization
  let serviceTypes = [];
  const { data: stData, error: stError } = await supabase
    .from("service_types")
    .select("id, name, duration_minutes, description")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (stError) {
    console.error("[TestCallContext] Service types lookup error:", stError);
  } else if (stData && stData.length > 0) {
    serviceTypes = stData;
  }

  // Aggregate KB
  let knowledgeBase = "";
  if (kbEntries && kbEntries.length > 0) {
    const sections = [];
    for (const entry of kbEntries) {
      const heading = entry.title || entry.source_type;
      if (entry.source_type === "faq") {
        try {
          const pairs = JSON.parse(entry.content);
          const qaParts = pairs
            .map((p) => `Q: ${p.question}\nA: ${p.answer}`)
            .join("\n\n");
          sections.push(`## ${heading}\n${qaParts}`);
        } catch (parseErr) {
          console.warn("[TestCallContext] FAQ entry has malformed JSON — using raw content:", {
            entryId: entry.id,
            error: parseErr.message,
          });
          sections.push(`## ${heading}\n${entry.content}`);
        }
      } else {
        sections.push(`## ${heading}\n${entry.content}`);
      }
    }
    knowledgeBase = sections.join("\n\n");
  }

  // Determine if the call is arriving outside business hours
  const afterHoursConfig = sanitizeAfterHoursConfig(assistant.after_hours_config, assistant.id);
  const isAfterHours = !isWithinBusinessHours(org.timezone, org.business_hours);

  // Warn if after-hours handling is enabled but timezone/hours not configured
  if (assistant.prompt_config?.behaviors?.afterHoursHandling && (!org.timezone || !org.business_hours)) {
    console.warn("[TestCallContext] After-hours handling enabled but timezone/business_hours not configured — after-hours detection will not work", {
      assistantId: assistant.id, organizationId,
      hasTimezone: !!org.timezone, hasBusinessHours: !!(org.business_hours && Object.keys(org.business_hours).length > 0),
    });
  }

  return {
    organizationId,
    assistantId: assistant.id,
    assistant: {
      name: assistant.name,
      systemPrompt: assistant.system_prompt,
      promptConfig: assistant.prompt_config,
      settings: assistant.settings,
      voiceId: assistant.voice_id,
      firstMessage: assistant.first_message,
      language: assistant.language || "en",
    },
    organization: {
      name: org.name,
      industry: org.industry || "other",
      timezone: org.timezone || undefined,
      businessHours: org.business_hours || undefined,
      defaultAppointmentDuration: org.default_appointment_duration ?? undefined,
      country: org.country || "US",
      businessState: org.business_state || null,
      recordingConsentMode: org.recording_consent_mode || "auto",
    },
    knowledgeBase,
    calendarEnabled,
    transferRules,
    isAfterHours,
    afterHoursConfig,
    serviceTypes,
  };
}

module.exports = { loadCallContext, loadTestCallContext };
