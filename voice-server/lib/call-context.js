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
    .select("id, name, industry, timezone, business_hours, default_appointment_duration, country, business_state, recording_consent_mode, appointment_verification_fields, recording_disclosure_text")
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
      appointment_verification_fields: org.appointment_verification_fields || null,
      recording_disclosure_text: org.recording_disclosure_text || null,
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
    .select("id, name, industry, timezone, business_hours, default_appointment_duration, country, business_state, recording_consent_mode, appointment_verification_fields, recording_disclosure_text")
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
      appointment_verification_fields: org.appointment_verification_fields || null,
      recording_disclosure_text: org.recording_disclosure_text || null,
    },
    knowledgeBase,
    calendarEnabled,
    transferRules,
    isAfterHours,
    afterHoursConfig,
    serviceTypes,
  };
}

// ─── Schedule Snapshot helpers ──────────────────────────────────────────────

/**
 * Extract hour and minute from a Date in a specific timezone.
 * Uses Intl.DateTimeFormat for correct DST-aware conversion.
 *
 * @param {Date} date
 * @param {string} timezone - IANA timezone (e.g. "Australia/Sydney")
 * @returns {{ hours: number, minutes: number }}
 */
function getTimeComponents(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const hourPart = parts.find((p) => p.type === "hour");
  const minutePart = parts.find((p) => p.type === "minute");
  return {
    hours: parseInt(hourPart?.value || "0", 10),
    minutes: parseInt(minutePart?.value || "0", 10),
  };
}

/**
 * Returns an array of "YYYY-MM-DD" date strings for the next N business days,
 * skipping closed days according to businessHours config.
 *
 * @param {string} timezone - IANA timezone
 * @param {object} businessHours - Map of lowercase day name -> { open, close } or { closed: true }
 * @param {number} [days=7] - Number of business days to find
 * @returns {string[]}
 */
function getBusinessDates(timezone, businessHours, days = 7) {
  if (!timezone || !businessHours || typeof businessHours !== "object") {
    return [];
  }

  const dates = [];
  const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const dayNameFormatter = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone });

  const now = new Date();
  const MAX_SCAN = 21; // safety cap: never scan more than 21 calendar days

  for (let i = 0; i < MAX_SCAN && dates.length < days; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const dayName = dayNameFormatter.format(candidate).toLowerCase();
    const dayConfig = businessHours[dayName];

    // Skip closed days or days with no config
    if (!dayConfig || dayConfig.closed === true || !dayConfig.open || !dayConfig.close) {
      continue;
    }

    dates.push(dateFormatter.format(candidate));
  }

  return dates;
}

/**
 * Generate time slots for a given date between open and close times.
 *
 * @param {string} date - "YYYY-MM-DD"
 * @param {string} open - "HH:MM" (24h)
 * @param {string} close - "HH:MM" (24h)
 * @param {number} [durationMinutes=30]
 * @returns {string[]} Array of "YYYY-MM-DDThh:mm:00" strings
 */
function generateTimeSlots(date, open, close, durationMinutes = 30) {
  if (!date || !open || !close) return [];

  const [openH, openM] = open.split(":").map(Number);
  const [closeH, closeM] = close.split(":").map(Number);

  if (isNaN(openH) || isNaN(openM) || isNaN(closeH) || isNaN(closeM)) return [];

  const openMinutes = openH * 60 + (openM || 0);
  const closeMinutes = closeH * 60 + (closeM || 0);

  const slots = [];
  for (let m = openMinutes; m + durationMinutes <= closeMinutes; m += durationMinutes) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    slots.push(`${date}T${hh}:${mm}:00`);
  }
  return slots;
}

/**
 * Convert a local datetime string + timezone into a UTC ISO string for Supabase queries.
 * E.g. "2026-04-12T00:00:00" in "Australia/Sydney" -> UTC ISO string.
 *
 * @param {string} localDatetime - "YYYY-MM-DDThh:mm:ss"
 * @param {string} timezone - IANA timezone
 * @returns {string} UTC ISO string
 */
function localToUtcIso(localDatetime, timezone) {
  // Use Intl to find the UTC offset for this timezone at this moment,
  // then compute the UTC equivalent.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const utcFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  // Treat the local datetime as a UTC instant to get a reference point
  const refDate = new Date(`${localDatetime}Z`);
  if (isNaN(refDate.getTime())) return new Date().toISOString();

  const getPart = (parts, type) =>
    parts.find((p) => p.type === type)?.value || "0";

  const tzParts = formatter.formatToParts(refDate);
  const utcParts = utcFormatter.formatToParts(refDate);

  const tzTotal = new Date(
    parseInt(getPart(tzParts, "year"), 10),
    parseInt(getPart(tzParts, "month"), 10) - 1,
    parseInt(getPart(tzParts, "day"), 10),
    parseInt(getPart(tzParts, "hour"), 10),
    parseInt(getPart(tzParts, "minute"), 10)
  ).getTime();

  const utcTotal = new Date(
    parseInt(getPart(utcParts, "year"), 10),
    parseInt(getPart(utcParts, "month"), 10) - 1,
    parseInt(getPart(utcParts, "day"), 10),
    parseInt(getPart(utcParts, "hour"), 10),
    parseInt(getPart(utcParts, "minute"), 10)
  ).getTime();

  const offsetMs = tzTotal - utcTotal;
  // The local datetime should map to (refDate - offset) in UTC
  const utcDate = new Date(refDate.getTime() - offsetMs);
  return utcDate.toISOString();
}

/**
 * Load a 7-business-day schedule snapshot for an organization.
 * Used by the schedule cache to pre-fetch availability data.
 *
 * @param {string} organizationId
 * @param {{ timezone: string, businessHours: object, defaultAppointmentDuration?: number }} orgConfig
 * @param {Array<{ id: string, name: string, duration_minutes: number }>} [serviceTypes]
 * @returns {Promise<object|null>} ScheduleSnapshot or null if config is invalid
 */
async function loadScheduleSnapshot(organizationId, orgConfig, serviceTypes) {
  const { timezone, businessHours, defaultAppointmentDuration } = orgConfig || {};

  // Validate required config
  if (!timezone || !businessHours || typeof businessHours !== "object" || Object.keys(businessHours).length === 0) {
    console.warn("[ScheduleSnapshot] Missing timezone or businessHours — cannot compute snapshot", {
      organizationId, hasTimezone: !!timezone, hasBusinessHours: !!businessHours,
    });
    return null;
  }

  const duration = defaultAppointmentDuration || 30;

  // 1. Get the next 7 business days
  const dates = getBusinessDates(timezone, businessHours, 7);
  if (dates.length === 0) {
    console.warn("[ScheduleSnapshot] No business dates found in next 21 calendar days", { organizationId });
    return null;
  }

  // 2. Convert date boundaries to UTC for Supabase queries
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const rangeStartUtc = localToUtcIso(`${firstDate}T00:00:00`, timezone);
  const rangeEndUtc = localToUtcIso(`${lastDate}T23:59:59`, timezone);

  const supabase = getSupabase();

  // 3. Parallel fetch: appointments, blocked_times, practitioners
  const [appointmentsResult, blockedResult, practitionersResult] = await Promise.all([
    supabase
      .from("appointments")
      .select("id, start_time, end_time, duration_minutes, status, practitioner_id, attendee_name, service_type_id, confirmation_code")
      .eq("organization_id", organizationId)
      .in("status", ["confirmed", "pending"])
      .gte("start_time", rangeStartUtc)
      .lte("start_time", rangeEndUtc),

    supabase
      .from("blocked_times")
      .select("id, start_time, end_time, practitioner_id")
      .eq("organization_id", organizationId)
      .gte("start_time", rangeStartUtc)
      .lte("end_time", rangeEndUtc),

    supabase
      .from("practitioners")
      .select("id, name, is_active")
      .eq("organization_id", organizationId)
      .eq("is_active", true),
  ]);

  if (appointmentsResult.error) {
    console.error("[ScheduleSnapshot] Appointments fetch error:", appointmentsResult.error);
  }
  if (blockedResult.error) {
    console.error("[ScheduleSnapshot] Blocked times fetch error:", blockedResult.error);
  }
  if (practitionersResult.error) {
    console.error("[ScheduleSnapshot] Practitioners fetch error:", practitionersResult.error);
  }

  const appointments = appointmentsResult.data || [];
  const blockedTimes = blockedResult.data || [];
  const practitioners = practitionersResult.data || [];

  // 4. If practitioners exist, fetch practitioner_services mapping
  let enrichedPractitioners = practitioners.map((p) => ({
    id: p.id,
    name: p.name,
    serviceTypeIds: [],
  }));

  if (practitioners.length > 0) {
    const practitionerIds = practitioners.map((p) => p.id);
    const { data: psData, error: psError } = await supabase
      .from("practitioner_services")
      .select("practitioner_id, service_type_id")
      .in("practitioner_id", practitionerIds);

    if (psError) {
      console.error("[ScheduleSnapshot] Practitioner services fetch error:", psError);
    } else if (psData) {
      const serviceMap = {};
      for (const row of psData) {
        if (!serviceMap[row.practitioner_id]) {
          serviceMap[row.practitioner_id] = [];
        }
        serviceMap[row.practitioner_id].push(row.service_type_id);
      }
      enrichedPractitioners = practitioners.map((p) => ({
        id: p.id,
        name: p.name,
        serviceTypeIds: serviceMap[p.id] || [],
      }));
    }
  }

  // 5. Compute available slots per date
  const slots = {};

  // Get current time in org timezone for filtering past slots on today
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
  const nowComponents = getTimeComponents(now, timezone);
  const nowMinutes = nowComponents.hours * 60 + nowComponents.minutes;

  for (const date of dates) {
    // Get day name for this date (use noon to avoid DST boundary issues)
    const dateObj = new Date(`${date}T12:00:00Z`);
    const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone })
      .format(dateObj)
      .toLowerCase();
    const dayConfig = businessHours[dayName];

    if (!dayConfig || dayConfig.closed || !dayConfig.open || !dayConfig.close) {
      slots[date] = [];
      continue;
    }

    // Generate all possible slots for this day
    let daySlots = generateTimeSlots(date, dayConfig.open, dayConfig.close, duration);

    // Filter past slots for today
    if (date === todayStr) {
      daySlots = daySlots.filter((slot) => {
        const [, timeStr] = slot.split("T");
        const [h, m] = timeStr.split(":").map(Number);
        return h * 60 + m > nowMinutes;
      });
    }

    // Filter org-level blocked time overlaps (blocks without a practitioner_id)
    const orgBlocks = blockedTimes.filter((bt) => !bt.practitioner_id);
    if (orgBlocks.length > 0) {
      daySlots = daySlots.filter((slot) => {
        const [, timeStr] = slot.split("T");
        const [slotH, slotM] = timeStr.split(":").map(Number);
        const slotStartMin = slotH * 60 + slotM;
        const slotEndMin = slotStartMin + duration;

        return !orgBlocks.some((bt) => {
          const btStart = getTimeComponents(new Date(bt.start_time), timezone);
          const btEnd = getTimeComponents(new Date(bt.end_time), timezone);
          const btStartMin = btStart.hours * 60 + btStart.minutes;
          const btEndMin = btEnd.hours * 60 + btEnd.minutes;

          // Check if the blocked date overlaps with this slot's date
          const btStartDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(bt.start_time));
          const btEndDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(bt.end_time));

          // Only consider blocks that overlap this date
          if (btEndDate < date || btStartDate > date) return false;

          // If block spans across the whole day, all slots are blocked
          if (btStartDate < date && btEndDate > date) return true;

          // Compute effective block boundaries for this date
          const effectiveStart = btStartDate < date ? 0 : btStartMin;
          const effectiveEnd = btEndDate > date ? 24 * 60 : btEndMin;

          return slotStartMin < effectiveEnd && slotEndMin > effectiveStart;
        });
      });
    }

    // Save slots after org-level block filtering (before appointment filtering)
    // Used as base for per-practitioner computation below
    const slotsAfterOrgBlocks = [...daySlots];

    // Filter appointment overlaps (compare in org-local minutes-since-midnight)
    // When practitioners exist, a slot is only unavailable when ALL practitioners
    // are busy at that time. This matches the logic in getBuiltInAvailability()
    // (src/lib/calendar/tool-handlers.ts).
    if (appointments.length > 0) {
      const practitionerIds = enrichedPractitioners.map((p) => p.id);
      const hasPractitioners = practitionerIds.length > 0;

      daySlots = daySlots.filter((slot) => {
        const [, timeStr] = slot.split("T");
        const [slotH, slotM] = timeStr.split(":").map(Number);
        const slotStartMin = slotH * 60 + slotM;
        const slotEndMin = slotStartMin + duration;

        if (hasPractitioners) {
          // Multi-practitioner: slot available if at least one practitioner is free
          const busyPractitioners = new Set();
          for (const appt of appointments) {
            const apptDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
              .format(new Date(appt.start_time));
            if (apptDate !== date) continue;

            const apptStart = getTimeComponents(new Date(appt.start_time), timezone);
            const apptStartMin = apptStart.hours * 60 + apptStart.minutes;
            let apptEndMin;
            if (appt.end_time) {
              const apptEnd = getTimeComponents(new Date(appt.end_time), timezone);
              apptEndMin = apptEnd.hours * 60 + apptEnd.minutes;
            } else {
              apptEndMin = apptStartMin + (appt.duration_minutes || duration);
            }

            if (slotStartMin < apptEndMin && slotEndMin > apptStartMin && appt.practitioner_id) {
              busyPractitioners.add(appt.practitioner_id);
            }
          }
          // Slot available if not ALL practitioners are busy
          return busyPractitioners.size < practitionerIds.length;
        }

        // No practitioners: original behavior — any overlapping appointment blocks the slot
        return !appointments.some((appt) => {
          const apptDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
            .format(new Date(appt.start_time));
          if (apptDate !== date) return false;

          const apptStart = getTimeComponents(new Date(appt.start_time), timezone);
          const apptStartMin = apptStart.hours * 60 + apptStart.minutes;

          let apptEndMin;
          if (appt.end_time) {
            const apptEnd = getTimeComponents(new Date(appt.end_time), timezone);
            apptEndMin = apptEnd.hours * 60 + apptEnd.minutes;
          } else {
            apptEndMin = apptStartMin + (appt.duration_minutes || duration);
          }

          return slotStartMin < apptEndMin && slotEndMin > apptStartMin;
        });
      });
    }

    // Compute per-practitioner availability (only when practitioners exist)
    const practSlots = {};
    if (enrichedPractitioners.length > 0) {
      for (const practitioner of enrichedPractitioners) {
        // Start with all base day slots (after org-level block filtering but BEFORE appointment filtering)
        let pSlots = [...slotsAfterOrgBlocks];

        // Filter by this practitioner's specific blocked times
        const practBlocks = blockedTimes.filter((bt) => bt.practitioner_id === practitioner.id);
        if (practBlocks.length > 0) {
          pSlots = pSlots.filter((slot) => {
            const [, timeStr] = slot.split("T");
            const [slotH, slotM] = timeStr.split(":").map(Number);
            const slotStartMin = slotH * 60 + slotM;
            const slotEndMin = slotStartMin + duration;

            return !practBlocks.some((bt) => {
              const btStart = getTimeComponents(new Date(bt.start_time), timezone);
              const btEnd = getTimeComponents(new Date(bt.end_time), timezone);
              const btStartMin = btStart.hours * 60 + btStart.minutes;
              const btEndMin = btEnd.hours * 60 + btEnd.minutes;

              const btStartDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(bt.start_time));
              const btEndDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(bt.end_time));

              if (btEndDate < date || btStartDate > date) return false;
              if (btStartDate < date && btEndDate > date) return true;

              const effectiveStart = btStartDate < date ? 0 : btStartMin;
              const effectiveEnd = btEndDate > date ? 24 * 60 : btEndMin;

              return slotStartMin < effectiveEnd && slotEndMin > effectiveStart;
            });
          });
        }

        // Filter by this practitioner's appointments
        const practAppts = appointments.filter((a) => a.practitioner_id === practitioner.id);
        if (practAppts.length > 0) {
          pSlots = pSlots.filter((slot) => {
            const [, timeStr] = slot.split("T");
            const [slotH, slotM] = timeStr.split(":").map(Number);
            const slotStartMin = slotH * 60 + slotM;
            const slotEndMin = slotStartMin + duration;

            return !practAppts.some((appt) => {
              const apptDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
                .format(new Date(appt.start_time));
              if (apptDate !== date) return false;

              const apptStart = getTimeComponents(new Date(appt.start_time), timezone);
              const apptStartMin = apptStart.hours * 60 + apptStart.minutes;
              let apptEndMin;
              if (appt.end_time) {
                const apptEnd = getTimeComponents(new Date(appt.end_time), timezone);
                apptEndMin = apptEnd.hours * 60 + apptEnd.minutes;
              } else {
                apptEndMin = apptStartMin + (appt.duration_minutes || duration);
              }

              return slotStartMin < apptEndMin && slotEndMin > apptStartMin;
            });
          });
        }

        practSlots[practitioner.id] = pSlots;
      }
    }

    // Build final slot structure: structured when practitioners exist, flat otherwise
    if (enrichedPractitioners.length === 0) {
      slots[date] = daySlots; // flat array (backward compatible)
    } else {
      slots[date] = { _any: daySlots, ...practSlots };
    }
  }

  return {
    appointments,
    blockedTimes,
    practitioners: enrichedPractitioners,
    slots,
    serviceTypes: serviceTypes || [],
    timezone,
    businessHours,
    defaultDuration: duration,
  };
}

module.exports = {
  loadCallContext,
  loadTestCallContext,
  loadScheduleSnapshot,
  getBusinessDates,
  generateTimeSlots,
  _test: { getTimeComponents },
};
