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
      "Schedule a callback request in the database. You MUST call this function to actually schedule a callback — do NOT tell the caller a callback is scheduled until this tool returns success. Use when the caller requests a callback, when you cannot resolve their issue, or when the person they need is unavailable.",
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
        "Check available appointment slots for a specific date. Returns a list of available times. If the business has service types configured, pass the service_type_id to get slots with the correct duration. If the caller has explicitly requested a SPECIFIC practitioner by name, pass their practitioner_id to get ONLY that practitioner's available slots (respecting their blocked times and existing appointments).",
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
          practitioner_id: {
            type: "string",
            description:
              "The ID of a specific practitioner. Use this ONLY when the caller has explicitly named a practitioner and you have their ID from the PRACTITIONERS ON STAFF list. Returns slots where THIS practitioner is free (honors their personal blocked times). Omit for aggregate availability across all practitioners.",
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
        "Executes the actual booking in the database. You MUST call this function to secure a time slot — it is IMPOSSIBLE to book an appointment without calling this tool. Do NOT verbally confirm a booking to the caller until this tool returns a success response. Collect first name, last name, phone, and datetime BEFORE calling.",
      parameters: {
        type: "object",
        properties: {
          datetime: {
            type: "string",
            description:
              "The appointment date and time in ISO format (e.g., 2026-03-15T14:00:00)",
          },
          first_name: {
            type: "string",
            description: "The caller's first name in English letters — MUST be stated by the caller.",
          },
          last_name: {
            type: "string",
            description: "The caller's last name/surname in English letters — MUST be stated by the caller.",
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
          practitioner_id: {
            type: "string",
            description:
              "The ID of the specific practitioner to book with. Only use this when the caller has explicitly requested a specific practitioner by name and you have confirmed their ID from the PRACTITIONERS ON STAFF list in your context. Omit for auto-assignment.",
          },
        },
        required: ["datetime", "first_name", "last_name", "phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description:
        "Cancel an existing appointment in the database. You MUST call this function to actually cancel — do NOT tell the caller the appointment is cancelled until this tool returns success. Use phone + datetime for precise match, or phone + date.",
      parameters: {
        type: "object",
        properties: {
          phone: {
            type: "string",
            description: "The phone number used when the appointment was booked",
          },
          datetime: {
            type: "string",
            description: "Exact date+time of the appointment in ISO format, e.g. '2026-04-21T10:15:00'. Use this when cancelling an appointment you just booked — it's the most precise.",
          },
          date: {
            type: "string",
            description: "The date only (YYYY-MM-DD) if you don't know the exact time. Less precise — use datetime when possible.",
          },
          reason: {
            type: "string",
            description: "Reason for cancellation (optional)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_appointment",
      description:
        "Look up an existing appointment. Use the caller's name and phone number (from caller ID or ask). You can also add date or email for more precise results.",
      parameters: {
        type: "object",
        properties: {
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
            description: "The caller's email address (optional, additional verification)",
          },
        },
        required: [],
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

const endCallToolDefinition = {
  type: "function",
  function: {
    name: "end_call",
    description:
      "End the phone call cleanly after the conversation has naturally concluded. Call this immediately AFTER you say a farewell like 'goodbye' or 'have a great day' and the caller has acknowledged. Only call this once per conversation — subsequent calls do nothing.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Brief reason for ending the call (e.g., 'booking complete', 'caller finished', 'message captured').",
        },
      },
      required: [],
    },
  },
};

/**
 * Resolve get_current_datetime locally from the organization timezone.
 * Eliminates an HTTP round-trip — timezone is already in the call context.
 *
 * @param {string} timezone - IANA timezone string (e.g. "Australia/Sydney")
 * @returns {{ message: string }}
 */
function resolveCurrentDatetime(timezone) {
  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h12",
    timeZone: timezone,
  });
  const isoDateFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  });
  return {
    message: `Current date and time: ${dateFormatter.format(now)}, ${timeFormatter.format(now)} (${timezone}). Today's date in YYYY-MM-DD format: ${isoDateFormatter.format(now)}.`,
  };
}

/**
 * Resolve check_availability from the pre-fetched schedule snapshot.
 * Returns a formatted response if the requested date is in the cache,
 * or null on cache miss so the caller falls through to the API.
 *
 * @param {{ date: string, service_type_id?: string }} args
 * @param {{ slots: Record<string, Array<{ start: string, end: string }>>, timezone: string, generatedAt: string }} snapshot
 * @returns {{ message: string } | null}
 */
function resolveAvailabilityFromCache(args, snapshot) {
  const date = args.date;
  if (!date || !snapshot.slots || !(date in snapshot.slots)) {
    return null; // Cache miss — let the API handle it
  }

  const dateSlots = snapshot.slots[date];
  // SCRUM-237: if caller specified a practitioner, return THAT practitioner's
  // slots (which respect their personal blocked_times). Otherwise aggregate.
  let daySlots;
  if (args.practitioner_id && !Array.isArray(dateSlots) && dateSlots?.[args.practitioner_id] !== undefined) {
    daySlots = dateSlots[args.practitioner_id] || [];
  } else {
    daySlots = Array.isArray(dateSlots) ? dateSlots : (dateSlots?._any || []);
  }

  // Nice readable date label (e.g. "Monday, April 12")
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: snapshot.timezone || "UTC",
  }).format(new Date(date + "T12:00:00")); // noon to avoid DST edge cases

  // Fall through to API when requested service has non-default duration
  if (args.service_type_id && snapshot.serviceTypes) {
    const st = snapshot.serviceTypes.find(s => s.id === args.service_type_id);
    if (st && st.duration_minutes !== snapshot.defaultDuration) {
      return null; // Duration mismatch — fall through to API
    }
  }

  // Re-filter past slots for today (cache was built at snapshot time, may be stale)
  const tz = snapshot.timezone;
  if (tz) {
    const nowInTz = new Date();
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(nowInTz);
    if (date === todayStr) {
      const nowParts = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(nowInTz);
      const [nowH, nowM] = nowParts.split(":").map(Number);
      const nowMinutes = nowH * 60 + nowM;
      daySlots = daySlots.filter(slot => {
        const s = typeof slot === "string" ? slot : slot;
        const [, timeStr] = s.split("T");
        if (!timeStr) return true;
        const [h, m] = timeStr.split(":").map(Number);
        return h * 60 + m > nowMinutes;
      });
    }
  }

  if (daySlots.length === 0) {
    return {
      message: `No available slots on ${dateLabel}. Fully booked.`,
    };
  }

  // Format each slot start time as "h:mm AM/PM"
  // Slots can be plain ISO strings or {start, end} objects
  const times = daySlots.map((slot) => {
    const s = typeof slot === "string" ? slot : (slot.start || slot);
    const [, timeStr] = s.split("T");
    if (!timeStr) return null;
    const [h, m] = timeStr.split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${displayH}:${String(m).padStart(2, "0")} ${period}`;
  }).filter(Boolean);

  // Use snapshot defaultDuration for the duration note
  let durationNote = "";
  if (snapshot.defaultDuration && snapshot.defaultDuration > 0) {
    durationNote = ` (${snapshot.defaultDuration}-minute slots)`;
  }

  return {
    message: `${daySlots.length} available slot${daySlots.length === 1 ? "" : "s"} on ${dateLabel}${durationNote}: ${times.join(", ")}.`,
  };
}

/**
 * Execute a tool call by routing to the appropriate handler.
 *
 * @param {string} functionName
 * @param {object} args - parsed arguments from the LLM
 * @param {{ organizationId: string, assistantId: string, callSid?: string, callId?: string, transferRules?: object[], testMode?: boolean, organization?: { timezone?: string, businessHours?: object }, callerPhone?: string, orgPhoneNumber?: string, scheduleSnapshot?: object }} context
 * @returns {Promise<{ message: string, action?: string, transferTo?: string, transferAttempt?: object }>}
 */
async function executeToolCall(functionName, args, context) {
  // ── End call (handled by caller of executeToolCall — e.g. gemini-live.js)──
  // This is a sentinel: we just acknowledge, the session owner closes the socket.
  if (functionName === "end_call") {
    return { message: "Ending the call. Goodbye.", __endCall: true };
  }

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

  // ── Cache-resolved reads (no HTTP round-trip) ──
  if (functionName === "get_current_datetime" && context.organization?.timezone) {
    return resolveCurrentDatetime(context.organization.timezone);
  }

  if (functionName === "check_availability" && context.scheduleSnapshot) {
    const cached = resolveAvailabilityFromCache(args, context.scheduleSnapshot);
    if (cached) return cached; // Cache hit
    // Cache miss — fall through to API
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
      message: `Appointment confirmed for ${[args.first_name, args.last_name].filter(Boolean).join(" ") || args.name || "the caller"} at ${args.datetime}. A confirmation will be sent shortly.`,
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
  endCallToolDefinition,
  executeToolCall,
  _test: { getTransferService, resolveCurrentDatetime, resolveAvailabilityFromCache },
};
