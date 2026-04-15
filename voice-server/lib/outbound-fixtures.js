/**
 * Test fixture management for outbound calling service.
 * Creates test orgs/assistants per industry; handles assistant swapping on phone numbers.
 */

const crypto = require("crypto");
const { getSupabase } = require("./supabase");

/**
 * Generate a deterministic UUID v4 from a seed string.
 * Same seed always produces the same UUID — makes fixtures idempotent.
 */
function deterministicUuid(seed) {
  const hash = crypto.createHash("sha256").update(seed).digest();
  // Set version 4 (bits 12-15 of byte 6) and variant (bits 6-7 of byte 8)
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Industry fixture definitions.
 * Each defines: org name, industry key, tone, service types, practitioners, KB entries.
 */
const FIXTURE_DEFS = {
  dental: {
    orgName: "Smile Hub Dental",
    industry: "dental",
    tone: "friendly",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "08:00", close: "17:00" },
      tuesday: { open: "08:00", close: "17:00" },
      wednesday: { open: "08:00", close: "17:00" },
      thursday: { open: "08:00", close: "17:00" },
      friday: { open: "08:00", close: "17:00" },
      saturday: { open: "08:00", close: "12:00" },
    },
    serviceTypes: [
      { name: "Check-up & Clean", duration_minutes: 45, description: "Routine dental examination and professional cleaning" },
      { name: "Filling", duration_minutes: 30, description: "Dental filling for cavities" },
      { name: "Emergency Consultation", duration_minutes: 20, description: "Urgent dental issue assessment" },
    ],
    kbEntries: [
      {
        title: "Pricing",
        source_type: "manual",
        content: "Check-up & Clean: $199. Filling: $150-$350 depending on size. Emergency consultation: $120. We accept all major private health insurance providers. New patient discount: 15% off first visit.",
      },
      {
        title: "FAQ",
        source_type: "faq",
        content: JSON.stringify([
          { question: "Do you accept walk-ins?", answer: "We prefer appointments but accept walk-ins for emergencies subject to availability." },
          { question: "How long is a check-up?", answer: "A standard check-up and clean takes about 45 minutes." },
          { question: "Do you offer payment plans?", answer: "Yes, we offer interest-free payment plans for treatments over $500." },
        ]),
      },
    ],
  },
  legal: {
    orgName: "Parker & Associates Law",
    industry: "legal",
    tone: "professional",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "09:00", close: "17:30" },
      tuesday: { open: "09:00", close: "17:30" },
      wednesday: { open: "09:00", close: "17:30" },
      thursday: { open: "09:00", close: "17:30" },
      friday: { open: "09:00", close: "17:00" },
    },
    serviceTypes: [
      { name: "Initial Consultation", duration_minutes: 60, description: "First meeting to discuss your legal matter" },
      { name: "Case Review", duration_minutes: 30, description: "Review of ongoing case progress" },
    ],
    kbEntries: [
      {
        title: "Practice Areas",
        source_type: "manual",
        content: "Parker & Associates specialises in property law, contract disputes, family law, and estate planning. We do NOT handle criminal law or immigration matters.",
      },
      {
        title: "FAQ",
        source_type: "faq",
        content: JSON.stringify([
          { question: "How much is an initial consultation?", answer: "Initial consultations are $350 for a 60-minute session." },
          { question: "Do you offer free consultations?", answer: "We do not offer free consultations, but the initial consultation fee is credited toward your matter if you engage our services." },
        ]),
      },
    ],
  },
  home_services: {
    orgName: "QuickFix Plumbing",
    industry: "home_services",
    tone: "casual",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "07:00", close: "17:00" },
      tuesday: { open: "07:00", close: "17:00" },
      wednesday: { open: "07:00", close: "17:00" },
      thursday: { open: "07:00", close: "17:00" },
      friday: { open: "07:00", close: "16:00" },
      saturday: { open: "08:00", close: "12:00" },
    },
    serviceTypes: [
      { name: "Emergency Repair", duration_minutes: 60, description: "Urgent plumbing repair — burst pipes, major leaks, no hot water" },
      { name: "Routine Maintenance", duration_minutes: 45, description: "General plumbing check, tap repairs, minor fixes" },
      { name: "Quote / Inspection", duration_minutes: 30, description: "On-site inspection and quote for larger jobs" },
    ],
    kbEntries: [
      {
        title: "Services & Pricing",
        source_type: "manual",
        content: "Emergency callout: $150 + parts. Routine maintenance starts at $120/hour. Free quotes for jobs over $500. We service all of Sydney metro. Licensed and insured (Licence #12345).",
      },
    ],
  },
  medical: {
    orgName: "Northside Medical Clinic",
    industry: "medical",
    tone: "friendly",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "08:00", close: "18:00" },
      tuesday: { open: "08:00", close: "18:00" },
      wednesday: { open: "08:00", close: "18:00" },
      thursday: { open: "08:00", close: "20:00" },
      friday: { open: "08:00", close: "17:00" },
      saturday: { open: "09:00", close: "13:00" },
    },
    serviceTypes: [
      { name: "GP Consultation", duration_minutes: 15, description: "Standard doctor's appointment" },
      { name: "Blood Test", duration_minutes: 10, description: "Pathology blood draw" },
      { name: "Vaccination", duration_minutes: 15, description: "Flu shot or other vaccination" },
    ],
    kbEntries: [
      {
        title: "FAQ",
        source_type: "faq",
        content: JSON.stringify([
          { question: "Do you bulk bill?", answer: "We bulk bill concession card holders and children under 16. Standard consultation gap is $39." },
          { question: "Do I need a referral?", answer: "No referral is needed for GP appointments. Specialist referrals can be arranged during your visit." },
        ]),
      },
    ],
  },
  real_estate: {
    orgName: "Harbour Realty",
    industry: "real_estate",
    tone: "friendly",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "09:00", close: "17:30" },
      tuesday: { open: "09:00", close: "17:30" },
      wednesday: { open: "09:00", close: "17:30" },
      thursday: { open: "09:00", close: "17:30" },
      friday: { open: "09:00", close: "17:00" },
      saturday: { open: "09:00", close: "16:00" },
    },
    serviceTypes: [
      { name: "Property Inspection", duration_minutes: 30, description: "Scheduled viewing of a listed property" },
      { name: "Appraisal / Valuation", duration_minutes: 45, description: "Property value assessment for sellers" },
    ],
    kbEntries: [
      {
        title: "Services",
        source_type: "manual",
        content: "Harbour Realty specialises in residential property sales and rentals across Sydney's North Shore. Free appraisals for potential sellers. Current listings available on our website.",
      },
    ],
  },
  salon: {
    orgName: "Luxe Hair Studio",
    industry: "salon",
    tone: "friendly",
    timezone: "Australia/Sydney",
    businessHours: {
      tuesday: { open: "09:00", close: "18:00" },
      wednesday: { open: "09:00", close: "18:00" },
      thursday: { open: "09:00", close: "20:00" },
      friday: { open: "09:00", close: "18:00" },
      saturday: { open: "09:00", close: "16:00" },
    },
    serviceTypes: [
      { name: "Cut & Style", duration_minutes: 45, description: "Haircut and blow-dry styling" },
      { name: "Colour", duration_minutes: 90, description: "Full colour, highlights, or balayage" },
      { name: "Cut & Colour", duration_minutes: 120, description: "Combined cut and colour service" },
    ],
    kbEntries: [
      {
        title: "Pricing",
        source_type: "manual",
        content: "Cut & Style: $85 (short), $110 (long). Colour: from $150. Cut & Colour: from $220. All services include a complimentary scalp massage and Olaplex treatment. Closed Mondays and Sundays.",
      },
    ],
  },
  automotive: {
    orgName: "Sydney Auto Care",
    industry: "automotive",
    tone: "casual",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "07:30", close: "17:30" },
      tuesday: { open: "07:30", close: "17:30" },
      wednesday: { open: "07:30", close: "17:30" },
      thursday: { open: "07:30", close: "17:30" },
      friday: { open: "07:30", close: "17:00" },
      saturday: { open: "08:00", close: "12:00" },
    },
    serviceTypes: [
      { name: "Logbook Service", duration_minutes: 120, description: "Manufacturer-recommended service that maintains your new-car warranty" },
      { name: "Brake Inspection", duration_minutes: 45, description: "Visual + test drive inspection of brake pads, rotors, and fluid" },
      { name: "Pink Slip (eSafety)", duration_minutes: 30, description: "NSW annual safety inspection for rego renewal" },
    ],
    kbEntries: [
      {
        title: "Services & Pricing",
        source_type: "manual",
        content: "Logbook service: from $290 (4-cyl) / $390 (6-cyl). Brake pad replacement: $250-$450 per axle. Pink Slip: $42. We service all makes and models. Loan cars available on request, 24-hour notice. Drop off by 8:30am for same-day pickup on most services.",
      },
      {
        title: "FAQ",
        source_type: "faq",
        content: JSON.stringify([
          { question: "Do I need to book in advance?", answer: "For logbook services yes — usually 1 week ahead. Pink slips and brake inspections we can often fit in same-week." },
          { question: "Can you pick up my car?", answer: "Yes, within 5km of the shop for a $30 fee." },
        ]),
      },
    ],
  },
  veterinary: {
    orgName: "Bondi Beach Vet",
    industry: "veterinary",
    tone: "friendly",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "08:00", close: "18:00" },
      tuesday: { open: "08:00", close: "18:00" },
      wednesday: { open: "08:00", close: "18:00" },
      thursday: { open: "08:00", close: "18:00" },
      friday: { open: "08:00", close: "18:00" },
      saturday: { open: "09:00", close: "14:00" },
    },
    serviceTypes: [
      { name: "Consultation", duration_minutes: 20, description: "Standard vet check-up" },
      { name: "Vaccination", duration_minutes: 15, description: "Annual booster vaccinations" },
      { name: "Dental Clean (under GA)", duration_minutes: 90, description: "Teeth cleaning under general anaesthetic" },
    ],
    kbEntries: [
      {
        title: "Services",
        source_type: "manual",
        content: "Consultation: $95. Vaccination (F3/C5): $120. Dental clean under GA: $450-$900 depending on size and extractions needed. We treat dogs, cats, rabbits, and small pocket pets. For bird/reptile care we refer to specialists. Emergency out-of-hours: SASH Small Animal Specialist Hospital (North Ryde).",
      },
    ],
  },
  accounting: {
    orgName: "Harbourview Accountants",
    industry: "accounting",
    tone: "professional",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "09:00", close: "17:30" },
      tuesday: { open: "09:00", close: "17:30" },
      wednesday: { open: "09:00", close: "17:30" },
      thursday: { open: "09:00", close: "17:30" },
      friday: { open: "09:00", close: "17:00" },
    },
    serviceTypes: [
      { name: "Individual Tax Return", duration_minutes: 45, description: "Personal income tax return prep" },
      { name: "Business BAS / Bookkeeping", duration_minutes: 60, description: "Quarterly BAS lodgement and bookkeeping review" },
      { name: "Advisory Meeting", duration_minutes: 60, description: "Tax planning or business advisory discussion" },
    ],
    kbEntries: [
      {
        title: "Services & Fees",
        source_type: "manual",
        content: "Individual tax return: $165 (simple) / $250 (with investment property or shares). BAS + bookkeeping: from $400/quarter. Advisory meetings: $220/hr. ABN/company setup: $550 flat. We are registered tax agents with the TPB. Tax return deadline (via us): 15 May the following year.",
      },
    ],
  },
  insurance: {
    orgName: "Coastal Insurance Brokers",
    industry: "insurance",
    tone: "professional",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "08:30", close: "17:00" },
      tuesday: { open: "08:30", close: "17:00" },
      wednesday: { open: "08:30", close: "17:00" },
      thursday: { open: "08:30", close: "17:00" },
      friday: { open: "08:30", close: "16:30" },
    },
    serviceTypes: [
      { name: "New Policy Consultation", duration_minutes: 45, description: "Review insurance needs and recommend coverage" },
      { name: "Claims Assistance", duration_minutes: 30, description: "Help lodging or following up a claim" },
      { name: "Policy Review", duration_minutes: 30, description: "Annual review of existing policies" },
    ],
    kbEntries: [
      {
        title: "Services",
        source_type: "manual",
        content: "Coastal Insurance Brokers specialises in home & contents, landlord, business pack, and professional indemnity insurance. We compare across 12+ insurers including QBE, Allianz, CGU, and Vero. Free initial consultation. We do NOT sell life insurance or health insurance — for those we refer to specialist brokers.",
      },
    ],
  },
  fitness: {
    orgName: "CrossPeak Fitness Gym",
    industry: "fitness",
    tone: "casual",
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "05:30", close: "21:30" },
      tuesday: { open: "05:30", close: "21:30" },
      wednesday: { open: "05:30", close: "21:30" },
      thursday: { open: "05:30", close: "21:30" },
      friday: { open: "05:30", close: "20:00" },
      saturday: { open: "07:00", close: "17:00" },
      sunday: { open: "07:00", close: "17:00" },
    },
    serviceTypes: [
      { name: "Free Trial Session", duration_minutes: 60, description: "Try out the gym with a trainer-led intro" },
      { name: "Personal Training Session", duration_minutes: 45, description: "1-on-1 session with a personal trainer" },
      { name: "Group Class (HIIT)", duration_minutes: 45, description: "High-intensity interval training group class" },
    ],
    kbEntries: [
      {
        title: "Membership & Pricing",
        source_type: "manual",
        content: "Memberships: $25/week (24-month commitment) or $35/week (no lock-in). Free 3-day trial for new members — just book in! Personal training: $85/session, cheaper in packs of 10. Group classes included in membership. 24/7 access included with all memberships.",
      },
    ],
  },
};

/**
 * Create or verify a test fixture for one industry.
 * Idempotent — checks if org already exists before creating.
 *
 * @param {string} industry - One of the FIXTURE_DEFS keys
 * @returns {Promise<{orgId: string, assistantId: string, status: "created"|"already_exists"}>}
 */
async function createFixture(industry) {
  const def = FIXTURE_DEFS[industry];
  if (!def) throw new Error(`Unknown industry: ${industry}`);

  const supabase = getSupabase();
  const orgId = deterministicUuid(`outbound-test-org-${industry}`);
  const assistantId = deterministicUuid(`outbound-test-assistant-${industry}`);

  // Check if org already exists
  const { data: existing } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", orgId)
    .single();

  if (existing) {
    // Org exists — check if assistant also exists (may have failed on a previous run)
    const { data: existingAssistant } = await supabase
      .from("assistants")
      .select("id")
      .eq("id", assistantId)
      .single();

    if (existingAssistant) {
      return { orgId, assistantId, status: "already_exists" };
    }
    // Org exists but assistant doesn't — fall through to create assistant + resources
    console.log(`[Fixtures] Org ${industry} exists but assistant missing — creating assistant`);
  }

  // Create organization (skip if it already exists from a partial previous run)
  if (!existing) {
    const slug = def.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-test";
    const { error: orgError } = await supabase.from("organizations").insert({
      id: orgId,
      name: def.orgName,
      slug,
      industry: def.industry,
    timezone: def.timezone,
    business_hours: def.businessHours,
    country: "AU",
    default_appointment_duration: def.serviceTypes[0]?.duration_minutes || 30,
    recording_consent_mode: "auto",
    });
    if (orgError) throw new Error(`Failed to create org: ${orgError.message}`);
  }

  // Build promptConfig using same defaults as the UI
  const promptConfig = {
    version: 1,
    fields: [], // Will use industry defaults at prompt-build time
    behaviors: {
      scheduleAppointments: true,
      handleEmergencies: def.industry === "dental" || def.industry === "medical" || def.industry === "home_services",
      providePricingInfo: true,
      takeMessages: true,
      transferToHuman: false,
      afterHoursHandling: true,
    },
    tone: def.tone,
    customInstructions: "",
    isManuallyEdited: false,
  };

  // Create assistant
  // system_prompt is a legacy NOT NULL column — runtime uses prompt_config when present
  const { error: assistantError } = await supabase.from("assistants").insert({
    id: assistantId,
    organization_id: orgId,
    name: `${def.orgName} Receptionist`,
    system_prompt: `You are the AI receptionist for ${def.orgName}. Be helpful and professional.`,
    prompt_config: promptConfig,
    settings: {},
    is_active: true,
    language: "en",
    voice_id: "XB0fDUnXU5powFXDhCwa", // Charlotte (AU female)
  });
  if (assistantError) throw new Error(`Failed to create assistant: ${assistantError.message}`);

  // Create service types
  for (let i = 0; i < def.serviceTypes.length; i++) {
    const st = def.serviceTypes[i];
    const { error: stError } = await supabase.from("service_types").insert({
      organization_id: orgId,
      name: st.name,
      duration_minutes: st.duration_minutes,
      description: st.description,
      is_active: true,
      sort_order: i,
    });
    if (stError) console.warn(`[Fixtures] Service type insert warning (${st.name}):`, stError.message);
  }

  // Create knowledge base entries
  for (const kb of def.kbEntries) {
    const { error: kbError } = await supabase.from("knowledge_bases").insert({
      organization_id: orgId,
      assistant_id: null, // org-level KB
      title: kb.title,
      source_type: kb.source_type,
      content: kb.content,
      is_active: true,
    });
    if (kbError) console.warn(`[Fixtures] KB insert warning (${kb.title}):`, kbError.message);
  }

  console.log(`[Fixtures] Created ${industry} fixture: org=${orgId}, assistant=${assistantId}`);
  return { orgId, assistantId, status: "created" };
}

/**
 * Create all fixtures or a subset.
 * @param {string[]} [industries] - Which industries to create. Defaults to all.
 * @returns {Promise<object[]>}
 */
async function createAllFixtures(industries) {
  const keys = industries || Object.keys(FIXTURE_DEFS);
  const results = [];
  for (const industry of keys) {
    try {
      const result = await createFixture(industry);
      results.push({ industry, ...result });
    } catch (err) {
      console.error(`[Fixtures] Failed to create ${industry}:`, err.message);
      results.push({ industry, status: "failed", error: err.message });
    }
  }
  return results;
}

/**
 * Get the test assistant ID for an industry.
 * @param {string} industry
 * @returns {string}
 */
function getTestAssistantId(industry) {
  return deterministicUuid(`outbound-test-assistant-${industry}`);
}

/**
 * Swap the assistant AND organization on a phone number. Returns the previous
 * { assistant_id, organization_id } pair for restoration.
 *
 * IMPORTANT: `loadCallContext` reads the org from `phone_numbers.organization_id`,
 * not from the assistant's own org. So the swap MUST update both fields
 * atomically, otherwise the call loads: new assistant + OLD org's KB/services/
 * prompt which reverts the business name in the greeting.
 *
 * @param {string} phoneNumber - E.164 phone number
 * @param {string} newAssistantId - The assistant to swap in
 * @returns {Promise<{assistantId: string, organizationId: string}|null>} Previous pair, or null
 */
async function swapAssistant(phoneNumber, newAssistantId) {
  const supabase = getSupabase();

  // Get current assistant + org
  const { data: phone, error: lookupError } = await supabase
    .from("phone_numbers")
    .select("id, assistant_id, organization_id")
    .eq("phone_number", phoneNumber)
    .eq("is_active", true)
    .single();

  if (lookupError || !phone) {
    console.error("[Fixtures] Phone lookup failed:", lookupError?.message);
    return null;
  }

  const previous = {
    assistantId: phone.assistant_id,
    organizationId: phone.organization_id,
  };

  // Look up the new assistant's organization so we can update both fields
  const { data: newAssistant, error: assistantLookupErr } = await supabase
    .from("assistants")
    .select("organization_id")
    .eq("id", newAssistantId)
    .single();
  if (assistantLookupErr || !newAssistant) {
    throw new Error(`Failed to look up new assistant ${newAssistantId}: ${assistantLookupErr?.message || "not found"}`);
  }

  // Swap BOTH assistant_id and organization_id atomically
  const { error: updateError } = await supabase
    .from("phone_numbers")
    .update({
      assistant_id: newAssistantId,
      organization_id: newAssistant.organization_id,
    })
    .eq("id", phone.id);

  if (updateError) {
    throw new Error(`Failed to swap assistant: ${updateError.message}`);
  }

  console.log(`[Fixtures] Swapped on ${phoneNumber}: assistant ${previous.assistantId} → ${newAssistantId}, org ${previous.organizationId} → ${newAssistant.organization_id}`);
  return previous;
}

/**
 * Restore the assistant AND organization on a phone number.
 * Accepts either a string assistantId (legacy) or an object { assistantId, organizationId }.
 *
 * @param {string} phoneNumber - E.164 phone number
 * @param {string|{assistantId: string, organizationId: string}} previous
 */
async function restoreAssistant(phoneNumber, previous) {
  const supabase = getSupabase();
  const update = { assistant_id: null, organization_id: null };

  if (typeof previous === "string") {
    // Legacy: caller only saved the assistant ID. Look up the org.
    const { data: a, error: e } = await supabase
      .from("assistants")
      .select("organization_id")
      .eq("id", previous)
      .single();
    if (e || !a) {
      console.error(`[Fixtures] Failed to look up org for legacy restore: ${e?.message || "not found"}`);
      return;
    }
    update.assistant_id = previous;
    update.organization_id = a.organization_id;
  } else if (previous && typeof previous === "object") {
    update.assistant_id = previous.assistantId;
    update.organization_id = previous.organizationId;
  } else {
    console.error("[Fixtures] restoreAssistant called with invalid `previous`:", previous);
    return;
  }

  const { error } = await supabase
    .from("phone_numbers")
    .update(update)
    .eq("phone_number", phoneNumber)
    .eq("is_active", true);

  if (error) {
    console.error(`[Fixtures] Failed to restore on ${phoneNumber}:`, error.message);
    throw error;
  }
  console.log(`[Fixtures] Restored on ${phoneNumber}: assistant=${update.assistant_id}, org=${update.organization_id}`);
}

module.exports = {
  createFixture,
  createAllFixtures,
  getTestAssistantId,
  swapAssistant,
  restoreAssistant,
  FIXTURE_DEFS,
  deterministicUuid,
};
