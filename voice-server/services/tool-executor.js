/**
 * Routes tool calls to appropriate handlers.
 *
 * Calendar tools (check_availability, book_appointment, cancel_appointment,
 * get_current_datetime) are delegated to the Next.js app via internal API.
 * Transfer tool (transfer_call) is handled locally via Twilio REST API.
 */

const { transferCall, sendTransferSMS } = require("./twilio-transfer");

const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

/**
 * Check if the current time is within configured business hours.
 * Fails open (returns true) if no timezone or hours are configured.
 *
 * @param {string|undefined} timezone - IANA timezone (e.g. "Australia/Sydney")
 * @param {object|undefined} businessHours - Map of day name → { open, close } or null
 * @returns {boolean}
 */
function isWithinBusinessHours(timezone, businessHours) {
  if (!timezone || !businessHours || Object.keys(businessHours).length === 0) {
    return true; // fail open
  }

  try {
    const now = new Date();
    // Get current day and time in the business timezone
    const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone });
    const hourFormatter = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });

    const dayName = dayFormatter.format(now).toLowerCase();
    const timeStr = hourFormatter.format(now); // "HH:MM" in 24h format
    const [hours, minutes] = timeStr.split(":").map(Number);
    const currentMinutes = hours * 60 + minutes;

    const dayHours = businessHours[dayName];
    if (!dayHours || dayHours.closed) {
      return false; // closed today
    }

    const openParts = (dayHours.open || "09:00").split(":").map(Number);
    const closeParts = (dayHours.close || "17:00").split(":").map(Number);
    const openMinutes = openParts[0] * 60 + (openParts[1] || 0);
    const closeMinutes = closeParts[0] * 60 + (closeParts[1] || 0);

    if (Number.isNaN(openMinutes) || Number.isNaN(closeMinutes)) {
      console.error("[BusinessHours] Malformed open/close time — failing open:", {
        dayName, open: dayHours.open, close: dayHours.close,
      });
      return true;
    }

    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  } catch (err) {
    console.error("[BusinessHours] Failed to check business hours — failing open:", {
      error: err.message, timezone, businessHours,
    });
    return true; // fail open on error
  }
}

const CALENDAR_FUNCTIONS = [
  "get_current_datetime",
  "check_availability",
  "book_appointment",
  "cancel_appointment",
];

/**
 * OpenAI-compatible tool definitions for calendar functions.
 * Passed to the LLM when the org has calendar capabilities.
 */
const calendarToolDefinitions = [
  {
    type: "function",
    function: {
      name: "get_current_datetime",
      description:
        "Get the current date and time in the business timezone. Call this before checking availability or booking an appointment so you know today's date.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Check available appointment slots for a specific date. Returns a list of available times.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "The date to check in YYYY-MM-DD format",
          },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book an appointment at a specific date and time. Requires the caller's name and phone number.",
      parameters: {
        type: "object",
        properties: {
          datetime: {
            type: "string",
            description:
              "The appointment date and time in ISO format (e.g., 2026-03-15T14:00:00)",
          },
          name: {
            type: "string",
            description: "The caller's full name",
          },
          phone: {
            type: "string",
            description: "The caller's phone number",
          },
          email: {
            type: "string",
            description: "The caller's email address (optional)",
          },
          notes: {
            type: "string",
            description:
              "Any additional notes about the appointment (optional)",
          },
        },
        required: ["datetime", "name", "phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description:
        "Cancel an existing appointment. Looks up the appointment by the caller's phone number.",
      parameters: {
        type: "object",
        properties: {
          phone: {
            type: "string",
            description:
              "The phone number used when the appointment was booked",
          },
          reason: {
            type: "string",
            description: "Reason for cancellation (optional)",
          },
        },
        required: ["phone"],
      },
    },
  },
];

/**
 * OpenAI-compatible tool definition for call transfer.
 * Passed to the LLM when the assistant has transfer rules configured.
 */
const transferToolDefinition = {
  type: "function",
  function: {
    name: "transfer_call",
    description:
      "Transfer the call to a human when the AI cannot adequately help. Use this when the caller asks to speak to a person, has a complex issue, or when there's an emergency.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "The reason for the transfer (e.g., 'caller requested human', 'emergency', 'complex question')",
        },
        urgency: {
          type: "string",
          enum: ["low", "medium", "high"],
          description:
            "The urgency level: low (general inquiry), medium (needs attention soon), high (emergency/urgent)",
        },
        summary: {
          type: "string",
          description:
            "A brief summary of the conversation and what the caller needs",
        },
      },
      required: ["reason"],
    },
  },
};

/**
 * Execute a tool call by routing to the appropriate handler.
 *
 * @param {string} functionName
 * @param {object} args - parsed arguments from the LLM
 * @param {{ organizationId: string, assistantId: string, callSid?: string, transferRules?: object[], testMode?: boolean, organization?: { timezone?: string, businessHours?: object }, callerPhone?: string, orgPhoneNumber?: string }} context
 * @returns {Promise<{ message: string, action?: string, transferTo?: string, transferAttempt?: object }>}
 */
async function executeToolCall(functionName, args, context) {
  // ── Transfer call (handled locally via Twilio) ──
  if (functionName === "transfer_call") {
    return executeTransferCall(args, context);
  }

  if (CALENDAR_FUNCTIONS.includes(functionName)) {
    // In test mode, simulate write operations instead of hitting the real API
    if (context.testMode && (functionName === "book_appointment" || functionName === "cancel_appointment")) {
      return simulateCalendarWrite(functionName, args);
    }
    return executeCalendarCall(functionName, args, context);
  }

  console.warn(`[ToolExecutor] Unknown function: ${functionName}`);
  return { message: `Unknown function: ${functionName}` };
}

/**
 * Execute a calendar tool call via the Next.js internal API.
 */
async function executeCalendarCall(functionName, args, context) {
  if (!INTERNAL_API_URL || !INTERNAL_API_SECRET) {
    console.error(`[ToolExecutor] Cannot execute ${functionName} — INTERNAL_API_URL or INTERNAL_API_SECRET not configured`);
    return {
      message:
        "I'm sorry, I'm unable to access the calendar system right now. Would you like me to take your information instead?",
    };
  }

  try {
    const res = await fetch(`${INTERNAL_API_URL}/api/internal/tool-call`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_API_SECRET,
      },
      body: JSON.stringify({
        organizationId: context.organizationId,
        assistantId: context.assistantId,
        functionName,
        arguments: args,
      }),
    });

    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      console.error(`[ToolExecutor] Internal API error ${res.status}:`, text);
      return {
        message:
          "I'm having trouble with that right now. Would you like me to take your information instead?",
      };
    }

    const data = await res.json();
    return { message: data.message || "The operation completed but returned no message." };
  } catch (err) {
    console.error(`[ToolExecutor] Failed to execute ${functionName}:`, err.message);
    return { message: "I'm having a little trouble right now. Could you give me a moment?" };
  }
}

/**
 * Execute a call transfer using Twilio REST API.
 * Matches transfer rules by reason/keywords to find the right destination.
 * Checks business hours before attempting transfer.
 */
async function executeTransferCall(args, context) {
  const { reason, urgency, summary } = args;
  const transferRules = context.transferRules || [];

  if (transferRules.length === 0) {
    return {
      message:
        "I apologize, but I'm not able to transfer your call right now. Let me take your information and have someone call you back. Can you confirm your name and phone number?",
      transferAttempt: {
        ruleId: null, ruleName: null, targetPhone: null, targetName: null,
        reason: reason || null, urgency: urgency || "low",
        outcome: "no_rules_configured", outsideBusinessHours: false,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Find matching rule by keywords or intent, defaulting to highest priority
  const lowerReason = (reason || "").toLowerCase();

  const matchedRule = transferRules.find((rule) => {
    if (rule.triggerKeywords?.length > 0) {
      return rule.triggerKeywords.some((kw) => lowerReason.includes(kw.toLowerCase()));
    }
    if (rule.triggerIntent) {
      return lowerReason.includes(rule.triggerIntent.toLowerCase());
    }
    return false;
  }) || transferRules[0];

  const targetName = matchedRule.transferToName || "a team member";
  const announcement =
    matchedRule.announcementMessage ||
    (urgency === "high"
      ? `I understand this is urgent. Let me connect you with ${targetName} right away. Please hold.`
      : `Let me connect you with ${targetName} who can better assist you. Please hold for just a moment.`);

  // Build transfer attempt tracking object
  const transferAttempt = {
    ruleId: matchedRule.id || null,
    ruleName: matchedRule.name || null,
    targetPhone: matchedRule.transferToPhone || null,
    targetName,
    reason: reason || null,
    urgency: urgency || "low",
    outcome: "initiated",
    outsideBusinessHours: false,
    timestamp: new Date().toISOString(),
  };

  if (!matchedRule.transferToPhone) {
    console.error(`[ToolExecutor] Transfer rule "${matchedRule.transferToName || "unnamed"}" has no transferToPhone configured`);
    transferAttempt.outcome = "failed";
    return {
      message: "I'm sorry, I'm unable to transfer your call right now. Let me take your information and have someone call you back.",
      action: "callback",
      transferAttempt,
    };
  }

  // Check business hours — skip transfer if outside hours (unless high urgency)
  const org = context.organization || {};
  const withinHours = isWithinBusinessHours(org.timezone, org.businessHours);
  if (!withinHours && urgency !== "high") {
    console.log(`[Transfer] Outside business hours — skipping transfer to ${targetName}`);
    transferAttempt.outcome = "outside_hours";
    transferAttempt.outsideBusinessHours = true;
    return {
      message: `${targetName} is not available right now. Can I take a message or schedule a callback for you?`,
      action: "callback",
      transferAttempt,
    };
  }
  if (!withinHours && urgency === "high") {
    console.log(`[Transfer] Outside business hours but urgency=high — proceeding with transfer to ${targetName}`);
    transferAttempt.outsideBusinessHours = true;
  }

  if (!context.callSid) {
    return {
      message: announcement,
      action: "transfer",
      transferTo: matchedRule.transferToPhone,
      transferAttempt,
    };
  }

  // Pass action URL so Twilio POSTs dial outcome for no-answer fallback
  const PUBLIC_URL = process.env.PUBLIC_URL;
  const transferOptions = {};
  if (PUBLIC_URL) {
    transferOptions.actionUrl = `${PUBLIC_URL}/twiml/transfer-status`;
  } else {
    console.error("[Transfer] PUBLIC_URL not set — no-answer fallback DISABLED");
  }

  const result = await transferCall(
    context.callSid,
    matchedRule.transferToPhone,
    announcement,
    transferOptions
  );

  transferAttempt.outcome = result.success ? "initiated" : "failed";

  // Send SMS context to transfer target (fire-and-forget)
  if (result.success && context.orgPhoneNumber) {
    const smsBody = [
      `Incoming transfer from ${context.callerPhone || "unknown caller"}`,
      reason ? `Reason: ${reason}` : null,
      summary ? `Summary: ${summary}` : null,
    ].filter(Boolean).join(". ") + ".";

    sendTransferSMS(matchedRule.transferToPhone, context.orgPhoneNumber, smsBody)
      .catch((err) => console.warn("[Transfer] SMS to transfer target failed (non-fatal):", err.message));
  }

  return {
    message: result.message,
    action: result.success ? "transfer" : "callback",
    transferTo: matchedRule.transferToPhone,
    transferTargetName: targetName,
    transferAttempt,
  };
}

/**
 * Return a simulated response for booking/cancellation during test calls.
 * Reads (get_current_datetime, check_availability) still hit the real API
 * so the LLM gets realistic data, but writes are faked.
 */
function simulateCalendarWrite(functionName, args) {
  if (functionName === "book_appointment") {
    return {
      message: `Appointment confirmed for ${args.name} at ${args.datetime}. A confirmation will be sent shortly.`,
    };
  }
  if (functionName === "cancel_appointment") {
    return {
      message: `The appointment associated with ${args.phone} has been cancelled successfully.`,
    };
  }
  return { message: "Done." };
}

module.exports = {
  calendarToolDefinitions,
  transferToolDefinition,
  executeToolCall,
};
