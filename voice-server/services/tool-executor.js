/**
 * Routes tool calls to appropriate handlers.
 *
 * Calendar tools (check_availability, book_appointment, cancel_appointment,
 * get_current_datetime) are delegated to the Next.js app via internal API.
 * Transfer tool (transfer_call) is handled locally via Twilio REST API.
 */

const twilioTransfer = require("./twilio-transfer");
const telnyxTransfer = require("./telnyx-transfer");

// Route transfer calls to the correct provider
function getTransferService(context) {
  if (context.telephonyProvider === "telnyx") return telnyxTransfer;
  return twilioTransfer;
}
const { isWithinBusinessHours } = require("../lib/business-hours");
const { Sentry } = require("../lib/sentry");

const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const CALENDAR_FUNCTIONS = [
  "get_current_datetime",
  "check_availability",
  "book_appointment",
  "cancel_appointment",
  "list_service_types",
  "lookup_appointment",
];

/**
 * OpenAI-compatible tool definition for scheduling a callback.
 * Always available — callbacks are a universal fallback.
 */
const callbackToolDefinition = {
  type: "function",
  function: {
    name: "schedule_callback",
    description:
      "Schedule a callback request when a caller wants the business to call them back. Use this when the caller requests a callback, when you cannot resolve their issue, or when the person they need is unavailable.",
    parameters: {
      type: "object",
      properties: {
        caller_name: {
          type: "string",
          description: "The caller's full name",
        },
        caller_phone: {
          type: "string",
          description: "The caller's phone number for the callback",
        },
        reason: {
          type: "string",
          description:
            "Why the caller wants a callback (e.g., 'needs to discuss billing', 'wants a quote for plumbing repair')",
        },
        preferred_time: {
          type: "string",
          description:
            "When the caller would like to be called back (e.g., 'tomorrow morning', '2026-03-15T14:00:00', 'anytime after 3pm'). Optional.",
        },
        urgency: {
          type: "string",
          enum: ["low", "medium", "high"],
          description:
            "The urgency level: low (general inquiry), medium (needs attention soon), high (urgent/time-sensitive)",
        },
      },
      required: ["caller_name", "caller_phone", "reason"],
    },
  },
};

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
        "Check available appointment slots for a specific date. Returns a list of available times. If the business has service types configured, pass the service_type_id to get slots with the correct duration.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "The date to check in YYYY-MM-DD format",
          },
          service_type_id: {
            type: "string",
            description:
              "The ID of the service/appointment type. Use this to get availability with the correct duration for that service.",
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
        "Book an appointment at a specific date and time. Requires the caller's name and phone number. If the business has service types, include the service_type_id.",
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
          service_type_id: {
            type: "string",
            description:
              "The ID of the service/appointment type being booked. Include this when the business has service types configured.",
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
  {
    type: "function",
    function: {
      name: "lookup_appointment",
      description:
        "Look up an existing appointment to check its details (date, time, practitioner). Requires the caller's name and phone number for identity verification. Use this when a caller asks about their existing appointment, wants to check the time, or needs to confirm details.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The caller's full name (for identity verification)",
          },
          phone: {
            type: "string",
            description: "The caller's phone number (for identity verification)",
          },
          email: {
            type: "string",
            description: "The caller's email address (optional, for additional verification)",
          },
          date_of_birth: {
            type: "string",
            description: "The caller's date of birth (optional, for additional verification)",
          },
        },
        required: ["name", "phone"],
      },
    },
  },
];

/**
 * OpenAI-compatible tool definition for listing service/appointment types.
 * Passed to the LLM when the org has service types configured.
 */
const listServiceTypesToolDefinition = {
  type: "function",
  function: {
    name: "list_service_types",
    description:
      "List the available appointment/service types offered by the business. Use this when the caller asks what types of appointments are available.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

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
        confirmed: {
          type: "boolean",
          description:
            "Set to true after the caller has verbally confirmed the transfer. Only use this after explicitly asking the caller and receiving a positive response.",
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
 * @param {{ organizationId: string, assistantId: string, callSid?: string, callId?: string, transferRules?: object[], testMode?: boolean, organization?: { timezone?: string, businessHours?: object }, callerPhone?: string, orgPhoneNumber?: string }} context
 * @returns {Promise<{ message: string, action?: string, transferTo?: string, transferAttempt?: object }>}
 */
async function executeToolCall(functionName, args, context) {
  // ── Transfer call (handled locally via Twilio) ──
  if (functionName === "transfer_call") {
    return executeTransferCall(args, context);
  }

  // ── Schedule callback ──
  if (functionName === "schedule_callback") {
    if (context.testMode) {
      return simulateCallbackWrite(args);
    }
    return executeCalendarCall(functionName, args, context);
  }

  if (CALENDAR_FUNCTIONS.includes(functionName)) {
    // In test mode, simulate write operations instead of hitting the real API
    if (context.testMode && (functionName === "book_appointment" || functionName === "cancel_appointment")) {
      return simulateCalendarWrite(functionName, args);
    }
    // list_service_types is always a read — no simulation needed
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
    Sentry.withScope((scope) => {
      scope.setTag("service", "tool-executor");
      scope.setTag("tool_function", functionName);
      scope.setExtra("organizationId", context.organizationId);
      scope.setExtra("assistantId", context.assistantId);
      scope.setExtra("callId", context.callId);
      Sentry.captureException(new Error(`ToolExecutor: missing INTERNAL_API_URL or INTERNAL_API_SECRET for ${functionName}`));
    });
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
        ...(context.callId && { callId: context.callId }),
      }),
    });

    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      console.error(`[ToolExecutor] Internal API error ${res.status}:`, text);
      Sentry.withScope((scope) => {
        scope.setTag("service", "tool-executor");
        scope.setTag("tool_function", functionName);
        scope.setExtra("organizationId", context.organizationId);
        scope.setExtra("assistantId", context.assistantId);
        scope.setExtra("callId", context.callId);
        scope.setExtra("httpStatus", res.status);
        scope.setExtra("responseBody", text);
        Sentry.captureException(new Error(`ToolExecutor: internal API error ${res.status} for ${functionName}`));
      });
      return {
        message:
          "I'm having trouble with that right now. Would you like me to take your information instead?",
      };
    }

    const data = await res.json();
    return { message: data.message || "The operation completed but returned no message." };
  } catch (err) {
    console.error(`[ToolExecutor] Failed to execute ${functionName}:`, err.message);
    Sentry.withScope((scope) => {
      scope.setTag("service", "tool-executor");
      scope.setTag("tool_function", functionName);
      scope.setExtra("organizationId", context.organizationId);
      scope.setExtra("assistantId", context.assistantId);
      scope.setExtra("callId", context.callId);
      Sentry.captureException(err);
    });
    return { message: "I'm having a little trouble right now. Could you give me a moment?" };
  }
}

/**
 * Execute a call transfer using Twilio REST API.
 * Matches transfer rules by reason/keywords to find the right destination.
 * Checks business hours before attempting transfer.
 */
async function executeTransferCall(args, context) {
  const { reason, urgency, summary, confirmed } = args;
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

  // Confirmation gate — if rule requires confirmation and caller hasn't confirmed yet
  if (matchedRule.requireConfirmation && confirmed !== true) {
    return {
      message: `Please ask the caller to confirm: "I'd like to connect you with ${targetName}. Would that be okay?" If they agree, call transfer_call again with confirmed set to true and the same reason. If they decline, continue helping them.`,
      transferAttempt: {
        ...transferAttempt,
        outcome: "awaiting_confirmation",
      },
    };
  }

  if (!matchedRule.transferToPhone) {
    console.error(`[ToolExecutor] Transfer rule "${matchedRule.transferToName || "unnamed"}" has no transferToPhone configured`);
    Sentry.withScope((scope) => {
      scope.setTag("service", "tool-executor");
      scope.setTag("tool_function", "transfer_call");
      scope.setExtra("organizationId", context.organizationId);
      scope.setExtra("assistantId", context.assistantId);
      scope.setExtra("callId", context.callId);
      scope.setExtra("ruleName", matchedRule.transferToName || "unnamed");
      Sentry.captureException(new Error(`Transfer rule "${matchedRule.transferToName || "unnamed"}" has no transferToPhone configured`));
    });
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

  // Build full destination chain: primary + fallbacks (used by both test and production paths)
  const allDestinations = [
    { phone: matchedRule.transferToPhone, name: targetName },
    ...(matchedRule.destinations || []).filter((d) => d.phone),
  ];

  if (!context.callSid) {
    return {
      message: announcement,
      action: "transfer",
      transferTo: matchedRule.transferToPhone,
      transferTargetName: targetName,
      allDestinations,
      destinationIndex: 0,
      transferAttempt,
    };
  }

  // Pass action URL so Twilio POSTs dial outcome for no-answer fallback
  const PUBLIC_URL = process.env.PUBLIC_URL;
  const transferOptions = {};
  if (PUBLIC_URL) {
    const transferPrefix = context.telephonyProvider === "telnyx" ? "texml" : "twiml";
    transferOptions.actionUrl = `${PUBLIC_URL}/${transferPrefix}/transfer-status`;
  } else {
    console.error("[Transfer] PUBLIC_URL not set — no-answer fallback DISABLED");
    Sentry.withScope((scope) => {
      scope.setTag("service", "tool-executor");
      scope.setTag("tool_function", "transfer_call");
      scope.setExtra("organizationId", context.organizationId);
      scope.setExtra("callId", context.callId);
      Sentry.captureException(new Error("PUBLIC_URL not set — no-answer fallback DISABLED"));
    });
  }

  const transferService = getTransferService(context);
  const result = await transferService.transferCall(
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

    transferService.sendTransferSMS(matchedRule.transferToPhone, context.orgPhoneNumber, smsBody)
      .catch((err) => console.warn("[Transfer] SMS to transfer target failed (non-fatal):", err.message));
  }

  return {
    message: result.message,
    action: result.success ? "transfer" : "callback",
    transferTo: matchedRule.transferToPhone,
    transferTargetName: targetName,
    allDestinations,
    destinationIndex: 0,
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

/**
 * Return a simulated response for callback scheduling during test calls.
 */
function simulateCallbackWrite(args) {
  const timeNote = args.preferred_time
    ? ` They'd like to be called back ${args.preferred_time}.`
    : "";
  return {
    message: `Got it! I've scheduled a callback request for ${args.caller_name} at ${args.caller_phone}. Reason: ${args.reason}.${timeNote} Someone from the team will reach out soon.`,
  };
}

module.exports = {
  calendarToolDefinitions,
  listServiceTypesToolDefinition,
  transferToolDefinition,
  callbackToolDefinition,
  executeToolCall,
  _test: { getTransferService },
};
