import type { PromptConfig, CollectionField, TonePreset, VerificationMethod, FieldType, AfterHoursConfig } from "./types";

export interface PromptContext {
  businessName: string;
  industry: string;
  knowledgeBase?: string;
  timezone?: string;
  businessHours?: Record<string, { open: string; close: string } | null>;
  defaultAppointmentDuration?: number;
  isAfterHours?: boolean;
  afterHoursConfig?: AfterHoursConfig | null;
}

const toneDescriptions: Record<TonePreset, string> = {
  professional:
    "You speak in a polished, formal, and business-like manner. Use complete sentences and professional language.",
  friendly:
    "You are warm, approachable, and conversational while remaining professional. You use a natural, helpful tone.",
  casual:
    "You are relaxed and approachable, like a helpful neighbor. Keep things light and easy-going while still being competent.",
};

const tonePreambles: Record<TonePreset, string> = {
  professional: "professional and courteous",
  friendly: "friendly and warm",
  casual: "casual and approachable",
};

function getVerificationInstruction(verification: VerificationMethod, label: string): string {
  switch (verification) {
    case "read-back-digits":
      return `After collecting ${label}, read it back digit by digit to confirm (e.g., "Let me confirm that — 5-5-5, 1-2-3, 4-5-6-7").`;
    case "spell-out":
      return `After collecting ${label}, spell it out letter by letter to confirm (e.g., "Let me verify — that's J-O-H-N at G-M-A-I-L dot C-O-M").`;
    case "repeat-confirm":
      return `After collecting ${label}, repeat it back and ask the caller to confirm.`;
    case "read-back-characters":
      return `After collecting ${label}, read it back character by character to confirm accuracy.`;
    case "none":
      return "";
  }
}

function formatHourForPrompt(time: string): string {
  const parts = time.split(":");
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return time; // return raw value if unparseable
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  const mins = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
  return `${hour12}${mins} ${period}`;
}

/**
 * Build the scheduling section for the system prompt.
 * Always includes the datetime tool instruction, regardless of whether
 * timezone or business hours are available.
 */
export function buildSchedulingSection(
  timezone?: string,
  businessHours?: Record<string, { open: string; close: string } | null>,
  defaultAppointmentDuration?: number
): string {
  const lines: string[] = [];
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

  lines.push(
    `CRITICAL: Before interpreting ANY relative date or time reference (such as "today", "tomorrow", "next week", "this afternoon", etc.), you MUST call the get_current_datetime tool FIRST to get the actual current date and time. ` +
    `NEVER guess or assume what today's date is. Always call the tool. Use the YYYY-MM-DD date returned by the tool when calling check_availability or book_appointment.`
  );

  return lines.join("\n");
}

function getIndustryGuidelines(industry: string): string {
  switch (industry) {
    case "medical":
      return `
IMPORTANT — HIPAA & Medical Guidelines:
- Maintain strict patient confidentiality at all times
- Never discuss patient information with anyone other than the verified patient
- For existing patients, verify identity with name and date of birth before discussing any details
- Never provide medical advice — always defer to clinical staff
- For symptoms that could be emergencies (chest pain, difficulty breathing, severe bleeding, stroke symptoms), instruct the caller to call 911 immediately
- For prescription refill requests, collect patient name, DOB, medication name, and pharmacy information`;

    case "dental":
      return `
Dental Practice Guidelines:
- Be warm and reassuring — many callers have dental anxiety
- For dental emergencies (severe pain, knocked-out tooth, broken tooth with pain), prioritize same-day scheduling
- Never provide clinical dental advice — suggest speaking with the dentist
- If asked about costs, provide general ranges but recommend confirming with insurance
- For new patients, ensure all intake information is collected`;

    case "legal":
      return `
IMPORTANT — Legal Practice Guidelines:
- Maintain strict attorney-client confidentiality
- Never provide legal advice or opinions on cases
- Be careful with information — confirm you are speaking with the correct person before discussing case details
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
- Collect vehicle details (make, model, year) early — this helps with scheduling and parts
- For safety-related issues (brakes, steering, tires), prioritize scheduling
- If the vehicle is undriveable, offer towing information if available
- For insurance claims, note the claim number and insurance provider`;

    case "veterinary":
      return `
Veterinary / Pet Care Guidelines:
- For potential emergencies (difficulty breathing, seizures, poisoning, trauma), advise going to the nearest emergency vet immediately
- Collect pet details (species, breed, age) to help the vet prepare
- Be compassionate — pet owners are often worried
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

function buildFieldCollectionSection(fields: CollectionField[]): string {
  if (fields.length === 0) return "";

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

function buildBehaviorsSection(
  behaviors: PromptConfig["behaviors"],
  options?: { isAfterHours?: boolean; afterHoursConfig?: AfterHoursConfig | null }
): string {
  const lines: string[] = [];

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
    lines.push(
      "- TRANSFERS: If a caller requests to speak with a person, or if the situation requires human attention, offer to transfer the call."
    );
  }

  lines.push(
    "- CALLBACKS: You can schedule callback requests using the schedule_callback function. Use this when a caller wants someone to call them back, when the person they need is unavailable, or when you cannot resolve their issue directly."
  );

  if (behaviors.afterHoursHandling) {
    if (options?.isAfterHours) {
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

export function buildPromptFromConfig(config: PromptConfig, context: PromptContext): string {
  const sections: string[] = [];

  // 1. Role & tone preamble
  sections.push(
    `You are a ${tonePreambles[config.tone]} AI receptionist for ${context.businessName || "{business_name}"}.`
  );
  sections.push(toneDescriptions[config.tone]);

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
    isAfterHours: context.isAfterHours,
    afterHoursConfig: context.afterHoursConfig,
  }));

  // 5. Timezone, business hours & scheduling instructions (always included)
  sections.push(buildSchedulingSection(context.timezone, context.businessHours, context.defaultAppointmentDuration));

  // 6. Industry guidelines
  const guidelines = getIndustryGuidelines(context.industry);
  if (guidelines) {
    sections.push(guidelines.trim());
  }

  // 7. Custom instructions
  if (config.customInstructions.trim()) {
    sections.push(`ADDITIONAL INSTRUCTIONS:\n${config.customInstructions.trim()}`);
  }

  return sections.filter(Boolean).join("\n\n");
}

export function generateGreeting(
  tone: TonePreset,
  businessName: string
): string {
  const name = businessName || "{business_name}";
  switch (tone) {
    case "professional":
      return `Thank you for calling ${name}. How may I assist you today?`;
    case "friendly":
      return `Hi there! Thanks for calling ${name}. How can I help you today?`;
    case "casual":
      return `Hey! You've reached ${name}. What can I do for you?`;
  }
}

// Maps FieldType to JSON Schema type
function fieldTypeToJsonSchema(fieldType: FieldType): string {
  switch (fieldType) {
    case "number":
      return "string"; // Caller-provided numbers (insurance IDs, etc.) are best stored as strings
    case "date":
      return "string";
    case "phone":
      return "string";
    case "email":
      return "string";
    case "address":
      return "string";
    case "select":
      return "string";
    case "text":
    default:
      return "string";
  }
}

// Converts a field label to a snake_case key for the JSON schema
function labelToKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export interface AnalysisPlan {
  structuredDataPrompt: string;
  structuredDataSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  successEvaluationRubric: "PassFail";
}

export function buildAnalysisPlan(config: PromptConfig): AnalysisPlan | null {
  if (!config.fields || config.fields.length === 0) {
    return null;
  }

  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  const fieldDescriptions: string[] = [];

  for (const field of config.fields) {
    const key = labelToKey(field.label);
    if (!key) continue;

    const jsonType = fieldTypeToJsonSchema(field.type);
    const description = field.description || field.label;

    properties[key] = {
      type: jsonType,
      description,
    };

    if (field.required) {
      required.push(key);
    }

    fieldDescriptions.push(`- ${field.label} (${key}): ${description}`);
  }

  if (Object.keys(properties).length === 0) {
    return null;
  }

  const structuredDataPrompt = [
    "Extract the following caller-provided data from the transcript.",
    "Only include fields that the caller actually provided. Leave out fields that were not mentioned or collected.",
    "",
    ...fieldDescriptions,
  ].join("\n");

  return {
    structuredDataPrompt,
    structuredDataSchema: {
      type: "object",
      properties,
      ...(required.length > 0 && { required }),
    },
    successEvaluationRubric: "PassFail",
  };
}
