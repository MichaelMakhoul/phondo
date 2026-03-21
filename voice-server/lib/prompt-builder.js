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

    case "accounting":
      return `
Accounting / Bookkeeping Guidelines:
- Determine the service needed early (tax return, BAS, bookkeeping, advisory, payroll)
- Collect ABN/ACN if the caller has it \u2014 this helps the accountant prepare
- For tax-related calls, ask about the relevant financial year and any upcoming deadlines
- Never provide specific tax advice or estimates \u2014 always defer to the accountant
- For urgent matters (ATO notices, overdue BAS, audit letters), flag for immediate attention`;

    case "insurance":
      return `
Insurance Guidelines:
- Determine early if the caller is making a new enquiry, filing a claim, or managing an existing policy
- Collect policy number or claim number if the caller has it
- For new claims, capture incident date, brief description, and any immediate needs (temporary accommodation, rental car, etc.)
- Never provide coverage opinions or claim assessments \u2014 always defer to the broker or agent
- For urgent matters (accidents, property damage, theft in progress), prioritise transfer to a live agent`;

    case "fitness":
      return `
Fitness / Gym / Studio Guidelines:
- Be energetic and encouraging \u2014 make callers excited about getting started
- For new member enquiries, ask about their fitness goals and preferred visit times to recommend the right membership
- Mention trial offers or introductory deals when speaking with prospective members
- For class bookings, confirm the class type, date, and time
- Note any health conditions or injuries \u2014 the trainer needs to know before the first session`;

    case "childcare":
      return `
Childcare / Daycare Guidelines:
- Be warm, patient, and reassuring \u2014 parents are trusting you with their most important decision
- Collect the child's name, age, and which days care is needed
- Ask about allergies, dietary requirements, and any additional needs
- For waitlist enquiries, capture the desired start date and preferred days
- For existing parents calling about their child, take a detailed message and assure them a staff member will call back promptly
- Never share information about other children or families`;

    case "funeral_services":
      return `
IMPORTANT \u2014 Funeral Services Guidelines:
- Be deeply compassionate, gentle, and respectful at all times \u2014 callers are grieving
- Speak slowly and calmly; never rush the caller
- Collect the name of the deceased and the caller's relationship sensitively
- Ask if they need immediate assistance (collection of the deceased) or are planning ahead
- For immediate needs (recent passing), prioritise connecting them with a funeral director \u2014 offer to transfer or have someone call back within the hour
- Never discuss pricing in detail \u2014 offer to have a director provide a personalised quote
- For pre-planning enquiries, schedule a consultation at their convenience
- Handle after-hours calls with the same care \u2014 bereavement does not follow business hours`;

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

  lines.push(
    "- CALLBACKS: You can schedule callback requests using the schedule_callback function. Use this when a caller wants someone to call them back, when the person they need is unavailable, or when you cannot resolve their issue directly."
  );

  // Caller ID awareness — prevents AI from repeatedly asking for the phone number
  lines.push(
    '- CALLER ID: You already have the caller\'s phone number from caller ID. If the caller says "it\'s the number I\'m calling from" or similar, accept that and do NOT ask again. Only ask for a phone number if you need a different contact number.'
  );

  // Language boundaries
  lines.push(
    "- LANGUAGE: You must only speak in the language you were configured for. If the caller speaks a different language, politely let them know you can only assist in your configured language and offer to have someone who speaks their language call them back. Do NOT attempt to respond in languages you are not configured for."
  );

  if (behaviors.afterHoursHandling) {
    if (options && options.isAfterHours) {
      lines.push(
        "- AFTER HOURS (ACTIVE): The office is currently CLOSED. You MUST inform the caller that the office is closed. " +
        "Take a detailed message including their name, callback number, and reason for calling. " +
        "Assure them someone will return their call during business hours."
      );
      if (options.afterHoursConfig?.customInstructions) {
        lines.push(`- AFTER-HOURS INSTRUCTIONS: ${options.afterHoursConfig.customInstructions}`);
      }
    } else {
      lines.push(
        "- AFTER HOURS: If calling outside business hours, let the caller know, take a message, and assure them someone will return their call during business hours."
      );
    }
  }

  return lines.join("\n");
}

/**
 * Build a full system prompt from a guided PromptConfig + context.
 *
 * @param {object} config
 * @param {{ businessName?: string, industry?: string, knowledgeBase?: string, timezone?: string, businessHours?: object, defaultAppointmentDuration?: number, calendarEnabled?: boolean, isAfterHours?: boolean, afterHoursConfig?: object }} context
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

  // 4. Behaviors (with after-hours awareness)
  sections.push(buildBehaviorsSection(config.behaviors, {
    hasTransferRules: context.transferRules && context.transferRules.length > 0,
    isAfterHours: context.isAfterHours,
    afterHoursConfig: context.afterHoursConfig,
  }));

  // 5. Timezone, business hours & scheduling
  // calendarEnabled is already adjusted by the caller (server.js resolveAfterHoursState)
  // when after-hours + disableScheduling apply
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

  // 8. Language instruction (must be last to override any English defaults above)
  if (context.language && context.language !== "en" && LANGUAGE_INSTRUCTIONS[context.language]) {
    sections.push(LANGUAGE_INSTRUCTIONS[context.language]);
  }

  return sections.filter(Boolean).join("\n\n");
}

/**
 * Generate a greeting based on tone, business name, and language.
 */
function generateGreeting(tone, businessName, language) {
  const name = businessName || "{business_name}";

  if (language === "es") {
    switch (tone) {
      case "professional":
        return `Gracias por llamar a ${name}. ¿En qué puedo asistirle hoy?`;
      case "casual":
        return `¡Hola! Ha llamado a ${name}. ¿En qué puedo ayudarle?`;
      case "friendly":
      default:
        return `¡Hola! Gracias por llamar a ${name}. ¿En qué puedo ayudarle hoy?`;
    }
  }

  switch (tone) {
    case "professional":
      return `Thank you for calling ${name}. How may I assist you today?`;
    case "casual":
      return `Hey! You've reached ${name}. What can I do for you?`;
    case "friendly":
    default:
      return `Hi there! Thanks for calling ${name}. How can I help you today?`;
  }
}

/**
 * Language instruction appended to prompts for non-English assistants.
 */
const LANGUAGE_INSTRUCTIONS = {
  es: `LANGUAGE:
You MUST conduct the entire conversation in Spanish. All responses, greetings, questions, confirmations, and error messages must be in Spanish.
If the caller speaks English, still respond in Spanish but accommodate code-switching naturally (e.g., if they say an English name or address, accept it without translation).
Use formal Spanish ("usted") by default unless the caller uses informal ("tú") first.`,
};

/**
 * Build system prompt for an assistant — handles both guided (prompt_config) and legacy prompts.
 * Mirrors the KB aggregation and placeholder replacement logic in src/lib/knowledge-base/aggregate.ts.
 *
 * @param {object} assistant
 * @param {object} organization
 * @param {string} knowledgeBase
 * @param {{ calendarEnabled?: boolean, transferRules?: object[], isAfterHours?: boolean, afterHoursConfig?: object }} [options]
 */
function buildSystemPrompt(assistant, organization, knowledgeBase, options) {
  const calendarEnabled = options?.calendarEnabled ?? false;
  const transferRules = options?.transferRules ?? [];
  const isAfterHours = options?.isAfterHours ?? false;
  const afterHoursConfig = options?.afterHoursConfig ?? null;

  // Cap knowledge base to a reasonable size for cost efficiency
  const MAX_KB_CHARS = 12_000;
  let trimmedKB = knowledgeBase;
  if (trimmedKB && trimmedKB.length > MAX_KB_CHARS) {
    trimmedKB = trimmedKB.slice(0, MAX_KB_CHARS) + "\n\n[Knowledge base truncated for brevity]";
  }

  const language = assistant.language || "en";

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
      language,
      isAfterHours,
      afterHoursConfig,
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

  // Append caller ID and language rules
  systemPrompt += `\n\nIMPORTANT RULES:`;
  systemPrompt += `\n- CALLER ID: You already have the caller's phone number from caller ID. If the caller says "it's the number I'm calling from" or similar, accept that and do NOT ask again.`;
  systemPrompt += `\n- LANGUAGE: Only respond in the language you are configured for. If a caller speaks a different language, politely tell them you can only assist in your configured language and offer to have someone call them back.`;

  // Append language instruction for non-English assistants
  if (language !== "en" && LANGUAGE_INSTRUCTIONS[language]) {
    systemPrompt += `\n\n${LANGUAGE_INSTRUCTIONS[language]}`;
  }

  return systemPrompt;
}

/**
 * Generate an after-hours greeting based on tone, business name, and language.
 */
function generateAfterHoursGreeting(tone, businessName, language) {
  const name = businessName || "{business_name}";

  if (language === "es") {
    switch (tone) {
      case "professional":
        return `Gracias por llamar a ${name}. Nuestras oficinas están actualmente cerradas. Por favor, deje un mensaje y nos pondremos en contacto con usted durante el horario de atención.`;
      case "casual":
        return `¡Hola! Ha llamado a ${name}. Estamos cerrados en este momento, pero deje un mensaje y le llamaremos pronto.`;
      case "friendly":
      default:
        return `¡Hola! Gracias por llamar a ${name}. Nuestras oficinas están cerradas en este momento. Deje un mensaje y le responderemos lo antes posible.`;
    }
  }

  switch (tone) {
    case "professional":
      return `Thank you for calling ${name}. Our office is currently closed. Please leave a message and we'll return your call during business hours.`;
    case "casual":
      return `Hey! You've reached ${name}. We're closed right now, but leave a message and we'll get back to you soon.`;
    case "friendly":
    default:
      return `Hi there! Thanks for calling ${name}. We're currently closed, but I'd be happy to take a message and make sure someone gets back to you.`;
  }
}

/**
 * Get the greeting for a call — uses first_message if set, otherwise generates from tone + language.
 * When isAfterHours is true, uses after-hours greeting (custom or auto-generated).
 *
 * @param {object} assistant
 * @param {string} organizationName
 * @param {{ isAfterHours?: boolean, afterHoursConfig?: object }} [options]
 */
function getGreeting(assistant, organizationName, options) {
  const language = assistant.language || "en";
  const isAfterHours = options?.isAfterHours ?? false;
  const afterHoursConfig = options?.afterHoursConfig ?? null;
  const tone = assistant.promptConfig?.tone || "friendly";

  // After-hours greeting takes priority when active + afterHoursHandling is enabled
  if (isAfterHours && assistant.promptConfig?.behaviors?.afterHoursHandling) {
    // Custom after-hours greeting
    if (afterHoursConfig?.greeting) {
      let greeting = afterHoursConfig.greeting;
      if (greeting.includes("{business_name}")) {
        greeting = greeting.replace(/{business_name}/g, organizationName);
      }
      return greeting;
    }
    // Auto-generated after-hours greeting
    return generateAfterHoursGreeting(tone, organizationName, language);
  }

  // Normal greeting: explicit first_message or auto-generated
  if (assistant.firstMessage) {
    let greeting = assistant.firstMessage;
    if (greeting.includes("{business_name}")) {
      greeting = greeting.replace(/{business_name}/g, organizationName);
    }
    return greeting;
  }

  return generateGreeting(tone, organizationName, language);
}

module.exports = {
  buildPromptFromConfig,
  buildSchedulingSection,
  buildSystemPrompt,
  generateGreeting,
  generateAfterHoursGreeting,
  getGreeting,
};
