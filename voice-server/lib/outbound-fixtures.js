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
        source_type: "text",
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
        source_type: "text",
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
        source_type: "text",
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
        source_type: "text",
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
        source_type: "text",
        content: "Cut & Style: $85 (short), $110 (long). Colour: from $150. Cut & Colour: from $220. All services include a complimentary scalp massage and Olaplex treatment. Closed Mondays and Sundays.",
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
    return { orgId, assistantId, status: "already_exists" };
  }

  // Generate URL-safe slug from org name (e.g., "Smile Hub Dental" → "smile-hub-dental-test")
  const slug = def.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-test";

  // Create organization
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
  const { error: assistantError } = await supabase.from("assistants").insert({
    id: assistantId,
    organization_id: orgId,
    name: `${def.orgName} Receptionist`,
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
 * Swap the assistant on a phone number. Returns the previous assistant_id for restoration.
 * @param {string} phoneNumber - E.164 phone number
 * @param {string} newAssistantId - The assistant to swap in
 * @returns {Promise<string|null>} Previous assistant_id, or null if phone not found
 */
async function swapAssistant(phoneNumber, newAssistantId) {
  const supabase = getSupabase();

  // Get current assistant
  const { data: phone, error: lookupError } = await supabase
    .from("phone_numbers")
    .select("id, assistant_id")
    .eq("phone_number", phoneNumber)
    .eq("is_active", true)
    .single();

  if (lookupError || !phone) {
    console.error("[Fixtures] Phone lookup failed:", lookupError?.message);
    return null;
  }

  const previousAssistantId = phone.assistant_id;

  // Swap
  const { error: updateError } = await supabase
    .from("phone_numbers")
    .update({ assistant_id: newAssistantId })
    .eq("id", phone.id);

  if (updateError) {
    throw new Error(`Failed to swap assistant: ${updateError.message}`);
  }

  console.log(`[Fixtures] Swapped assistant on ${phoneNumber}: ${previousAssistantId} → ${newAssistantId}`);
  return previousAssistantId;
}

/**
 * Restore the assistant on a phone number.
 * @param {string} phoneNumber - E.164 phone number
 * @param {string} assistantId - The assistant to restore
 */
async function restoreAssistant(phoneNumber, assistantId) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("phone_numbers")
    .update({ assistant_id: assistantId })
    .eq("phone_number", phoneNumber)
    .eq("is_active", true);

  if (error) {
    console.error(`[Fixtures] Failed to restore assistant on ${phoneNumber}:`, error.message);
    throw error;
  }
  console.log(`[Fixtures] Restored assistant on ${phoneNumber}: ${assistantId}`);
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
