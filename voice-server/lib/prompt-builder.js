/**
 * Plain JS port of src/lib/prompt-builder/generate-prompt.ts
 * and legacy prompt handling from src/lib/knowledge-base/aggregate.ts.
 *
 * Only includes functions needed at runtime (no Zod, no UI presets, no analysis plan).
 *
 * Scheduling instructions are controlled by a `calendarEnabled` parameter.
 * When true, real tool-calling instructions are included; when false,
 * message-taking guidance is used instead.
 */

const toneDescriptions = {
  professional:
    "You speak in a polished, formal, and business-like manner. Use complete sentences and professional language.",
  friendly:
    "You are warm, approachable, and conversational while remaining professional. You use a natural, helpful tone.",
  casual:
    "You are relaxed and approachable, like a helpful neighbor. Keep things light and easy-going while still being competent.",
};

const tonePreambles = {
  professional: "professional and courteous",
  friendly: "friendly and warm",
  casual: "casual and approachable",
};

function getVerificationInstruction(verification, label) {
  switch (verification) {
    case "read-back-digits":
      return `After collecting ${label}, read it back digit by digit to confirm (e.g., "Let me confirm that \u2014 5-5-5, 1-2-3, 4-5-6-7").`;
    case "spell-out":
      return `After collecting ${label}, spell it out letter by letter to confirm (e.g., "Let me verify \u2014 that's J-O-H-N at G-M-A-I-L dot C-O-M").`;
    case "repeat-confirm":
      return `After collecting ${label}, repeat it back and ask the caller to confirm.`;
    case "read-back-characters":
      return `After collecting ${label}, read it back character by character to confirm accuracy.`;
    case "none":
    default:
      return "";
  }
}

function formatHourForPrompt(time) {
  const parts = time.split(":");
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return time;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  const mins = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
  return `${hour12}${mins} ${period}`;
}

/**
 * Build the scheduling/timezone section appended to every prompt.
 * When calendarEnabled is true, includes real tool-calling instructions;
 * otherwise falls back to message-taking guidance.
 *
 * @param {string} [timezone]
 * @param {object} [businessHours]
 * @param {number} [defaultAppointmentDuration]
 * @param {boolean} [calendarEnabled=false]
 */
function buildSchedulingSection(timezone, businessHours, defaultAppointmentDuration, calendarEnabled) {
  const lines = [];
  lines.push("TIMEZONE & SCHEDULING:");

  if (timezone) {
    lines.push(`The business is in the ${timezone} timezone.`);
  }

  if (businessHours) {
    lines.push("");
    lines.push("Business Hours:");
    const dayOrder = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    for (const day of dayOrder) {
      const h = businessHours[day];
      const label = day.charAt(0).toUpperCase() + day.slice(1);
      if (h && h.open && h.close) {
        lines.push(`- ${label}: ${formatHourForPrompt(h.open)} \u2013 ${formatHourForPrompt(h.close)}`);
      } else {
        lines.push(`- ${label}: Closed`);
      }
    }
    lines.push("");
    lines.push("Do NOT suggest appointment times outside of these business hours.");
  }

  if (defaultAppointmentDuration && defaultAppointmentDuration !== 30) {
    lines.push(`Standard appointment duration is ${defaultAppointmentDuration} minutes.`);
  }

  if (calendarEnabled) {
    lines.push(
      "SCHEDULING TOOLS:",
      "You have access to the following scheduling functions. Use them to help callers with appointments:",
      "- get_current_datetime: Call this FIRST to know today's date before checking availability or booking.",
      "- check_availability: Check available appointment slots for a specific date (YYYY-MM-DD format).",
      "- book_appointment: Book an appointment. Requires datetime (ISO format), caller name, and phone number.",
      "- cancel_appointment: Cancel an existing appointment by the caller's phone number.",
      "",
      "SCHEDULING WORKFLOW:",
      "1. When a caller wants to book, first call get_current_datetime to know today's date.",
      "2. Ask what date they prefer, then call check_availability for that date.",
      "3. Present the available times and let the caller choose.",
      "4. Collect their name and phone number, then call book_appointment.",
      "5. Confirm the booking details with the caller."
    );
  } else {
    lines.push(
      "You do NOT have the ability to book appointments directly. " +
      "If the caller wants to schedule, collect their preferred date/time, " +
      "confirm the details, and let them know someone will confirm the appointment."
    );
  }

  return lines.join("\n");
}

function getIndustryGuidelines(industry) {
  switch (industry) {
    case "medical":
      return `
IMPORTANT \u2014 HIPAA & Medical Guidelines:
- Maintain strict patient confidentiality at all times
- Never discuss patient information with anyone other than the verified patient
- For existing patients, verify identity with name and date of birth before discussing any details
- Never provide medical advice \u2014 always defer to clinical staff
- For symptoms that could be emergencies (chest pain, difficulty breathing, severe bleeding, stroke symptoms), instruct the caller to call 911 immediately
- For prescription refill requests, collect patient name, DOB, medication name, and pharmacy information`;

    case "dental":
      return `
Dental Practice Guidelines:
- Be warm and reassuring \u2014 many callers have dental anxiety
- For dental emergencies (severe pain, knocked-out tooth, broken tooth with pain), prioritize same-day scheduling
- Never provide clinical dental advice \u2014 suggest speaking with the dentist
- If asked about costs, provide general ranges but recommend confirming with insurance
- For new patients, ensure all intake information is collected`;

    case "legal":
      return `
IMPORTANT \u2014 Legal Practice Guidelines:
- Maintain strict attorney-client confidentiality
- Never provide legal advice or opinions on cases
- Be careful with information \u2014 confirm you are speaking with the correct person before discussing case details
- For urgent matters (court dates, time-sensitive filings), flag for immediate attorney attention
- Do not make any promises about case outcomes`;

    case "home_services":
      return `
Home Services Guidelines:
- For emergencies (gas leaks, flooding, electrical hazards), advise calling 911 first if there is immediate danger, then prioritize urgent dispatch
- Collect the service address early in the conversation
- Clarify urgency level to help with scheduling priority
- If quoting prices, always note that final pricing may vary after on-site assessment`;

    case "real_estate":
      return `
Real Estate Guidelines:
- Determine early if the caller is buying, selling, or renting
- Collect property preferences and budget range to match with available listings
- Be knowledgeable about the general process but defer specific market advice to the agent
- For showing requests, collect availability and property preferences`;

    case "salon":
      return `
Salon / Spa Guidelines:
- Ask about service preferences and any specific stylist/technician requests
- Note any allergies or sensitivities to products
- Confirm appointment duration based on the services requested
- For new clients, mention any first-visit specials or policies`;

    case "automotive":
      return `
Automotive / Mechanic Guidelines:
- Collect vehicle details (make, model, year) early \u2014 this helps with scheduling and parts
- For safety-related issues (brakes, steering, tires), prioritize scheduling
- If the vehicle is undriveable, offer towing information if available
- For insurance claims, note the claim number and insurance provider`;

    case "veterinary":
      return `
Veterinary / Pet Care Guidelines:
- For potential emergencies (difficulty breathing, seizures, poisoning, trauma), advise going to the nearest emergency vet immediately
- Collect pet details (species, breed, age) to help the vet prepare
- Be compassionate \u2014 pet owners are often worried
- Note vaccination status for scheduling purposes`;

    case "restaurant":
      return `
Restaurant / Hospitality Guidelines:
- Confirm party size and preferred date/time for reservations
- Ask about dietary restrictions or allergies proactively
- For large parties or events, offer to have a manager follow up with details
- Note any special occasion details for the team to prepare`;

    default:
      return `
General Guidelines:
- Be helpful and professional at all times
- Collect relevant contact information for follow-up
- Take detailed messages when the appropriate person is unavailable`;
  }
}

function buildFieldCollectionSection(fields) {
  if (!fields || fields.length === 0) return "";

  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);

  let section = "DATA COLLECTION:\nCollect the following information from the caller:\n\n";

  if (required.length > 0) {
    section += "Required information:\n";
    for (const field of required) {
      section += `- ${field.label}`;
      const verifyNote = getVerificationInstruction(field.verification, field.label);
      if (verifyNote) {
        section += `\n  ${verifyNote}`;
      }
      section += "\n";
    }
  }

  if (optional.length > 0) {
    section += "\nOptional (collect if relevant):\n";
    for (const field of optional) {
      section += `- ${field.label}`;
      const verifyNote = getVerificationInstruction(field.verification, field.label);
      if (verifyNote) {
        section += `\n  ${verifyNote}`;
      }
      section += "\n";
    }
  }

  return section;
}

function buildBehaviorsSection(behaviors, options) {
  const lines = [];
  lines.push("CAPABILITIES:");

  if (behaviors.scheduleAppointments) {
    lines.push(
      "- SCHEDULING: You can help callers schedule, reschedule, or cancel appointments. Offer available times and confirm all details."
    );
  }

  if (behaviors.handleEmergencies) {
    lines.push(
      "- EMERGENCIES: If a caller describes an emergency, take it seriously. Provide appropriate urgent guidance (e.g., call 911) and escalate immediately."
    );
  }

  if (behaviors.providePricingInfo) {
    lines.push(
      "- PRICING: You may provide general pricing information when asked. Always note that final pricing may vary and recommend confirming specifics."
    );
  }

  if (behaviors.takeMessages) {
    lines.push(
      "- MESSAGES: Take detailed messages including the caller's name, callback number, reason for calling, and best time to reach them."
    );
  }

  if (behaviors.transferToHuman) {
    if (options && options.hasTransferRules) {
      lines.push(
        "- TRANSFERS: You can transfer calls using the transfer_call function. Use it when a caller requests to speak with a person, has a complex issue you cannot resolve, or when there is an emergency. Some transfers require confirmation — if the tool tells you to confirm with the caller first, ask them and call the function again with confirmed set to true."
      );
    } else {
      lines.push(
        "- TRANSFERS: If a caller requests to speak with a person, or if the situation requires human attention, offer to transfer the call."
      );
    }
  }

  if (behaviors.afterHoursHandling) {
    lines.push(
      "- AFTER HOURS: If calling outside business hours, let the caller know, take a message, and assure them someone will return their call during business hours."
    );
  }

  return lines.join("\n");
}

/**
 * Build a full system prompt from a guided PromptConfig + context.
 *
 * @param {object} config
 * @param {{ businessName?: string, industry?: string, knowledgeBase?: string, timezone?: string, businessHours?: object, defaultAppointmentDuration?: number, calendarEnabled?: boolean }} context
 */
function buildPromptFromConfig(config, context) {
  const sections = [];

  // 1. Role & tone preamble
  const preamble = tonePreambles[config.tone] || tonePreambles.friendly;
  sections.push(
    `You are a ${preamble} AI receptionist for ${context.businessName || "{business_name}"}.`
  );
  sections.push(toneDescriptions[config.tone] || toneDescriptions.friendly);

  // 2. Business knowledge base
  const kb = context.knowledgeBase || "No additional business information provided yet.";
  sections.push(`Business Information:\n${kb}`);

  // 3. Data collection with verification
  const fieldSection = buildFieldCollectionSection(config.fields);
  if (fieldSection) {
    sections.push(fieldSection);
  }

  // 4. Behaviors
  sections.push(buildBehaviorsSection(config.behaviors, {
    hasTransferRules: context.transferRules && context.transferRules.length > 0,
  }));

  // 5. Timezone, business hours & scheduling
  sections.push(buildSchedulingSection(context.timezone, context.businessHours, context.defaultAppointmentDuration, context.calendarEnabled));

  // 6. Industry guidelines
  const guidelines = getIndustryGuidelines(context.industry);
  if (guidelines) {
    sections.push(guidelines.trim());
  }

  // 7. Custom instructions
  if (config.customInstructions && config.customInstructions.trim()) {
    sections.push(`ADDITIONAL INSTRUCTIONS:\n${config.customInstructions.trim()}`);
  }

  return sections.filter(Boolean).join("\n\n");
}

/**
 * Generate a greeting based on tone and business name.
 */
function generateGreeting(tone, businessName) {
  const name = businessName || "{business_name}";
  switch (tone) {
    case "professional":
      return `Thank you for calling ${name}. How may I assist you today?`;
    case "friendly":
      return `Hi there! Thanks for calling ${name}. How can I help you today?`;
    case "casual":
      return `Hey! You've reached ${name}. What can I do for you?`;
    default:
      return `Hi there! Thanks for calling ${name}. How can I help you today?`;
  }
}

/**
 * Build system prompt for an assistant — handles both guided (prompt_config) and legacy prompts.
 * Mirrors the KB aggregation and placeholder replacement logic in src/lib/knowledge-base/aggregate.ts.
 *
 * @param {object} assistant
 * @param {object} organization
 * @param {string} knowledgeBase
 * @param {{ calendarEnabled?: boolean, transferRules?: object[] }} [options]
 */
function buildSystemPrompt(assistant, organization, knowledgeBase, options) {
  const calendarEnabled = options?.calendarEnabled ?? false;
  const transferRules = options?.transferRules ?? [];

  // Cap knowledge base to a reasonable size for cost efficiency
  const MAX_KB_CHARS = 12_000;
  let trimmedKB = knowledgeBase;
  if (trimmedKB && trimmedKB.length > MAX_KB_CHARS) {
    trimmedKB = trimmedKB.slice(0, MAX_KB_CHARS) + "\n\n[Knowledge base truncated for brevity]";
  }

  if (assistant.promptConfig) {
    // Guided prompt builder
    const context = {
      businessName: organization.name,
      industry: organization.industry,
      knowledgeBase: trimmedKB || undefined,
      timezone: organization.timezone,
      businessHours: organization.businessHours,
      defaultAppointmentDuration: organization.defaultAppointmentDuration,
      calendarEnabled,
      transferRules,
    };
    return buildPromptFromConfig(assistant.promptConfig, context);
  }

  // Legacy prompt — replace placeholders or append KB
  let systemPrompt = assistant.systemPrompt;

  if (systemPrompt.includes("{knowledge_base}")) {
    systemPrompt = systemPrompt.replace(
      /{knowledge_base}/g,
      trimmedKB || "No additional business information provided yet."
    );
  } else if (trimmedKB) {
    systemPrompt = `${systemPrompt}\n\nBusiness Information:\n${trimmedKB}`;
  }

  if (systemPrompt.includes("{business_name}")) {
    systemPrompt = systemPrompt.replace(/{business_name}/g, organization.name);
  }

  // Append scheduling section
  systemPrompt += `\n\n${buildSchedulingSection(organization.timezone, organization.businessHours, organization.defaultAppointmentDuration, calendarEnabled)}`;

  return systemPrompt;
}

/**
 * Get the greeting for a call — uses first_message if set, otherwise generates from tone.
 */
function getGreeting(assistant, organizationName) {
  if (assistant.firstMessage) {
    let greeting = assistant.firstMessage;
    if (greeting.includes("{business_name}")) {
      greeting = greeting.replace(/{business_name}/g, organizationName);
    }
    return greeting;
  }

  if (assistant.promptConfig) {
    return generateGreeting(assistant.promptConfig.tone, organizationName);
  }

  return `Hi there! Thanks for calling ${organizationName}. How can I help you today?`;
}

module.exports = {
  buildPromptFromConfig,
  buildSchedulingSection,
  buildSystemPrompt,
  generateGreeting,
  getGreeting,
};
