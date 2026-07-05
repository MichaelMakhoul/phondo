/**
 * Routes tool calls to appropriate handlers.
 *
 * Calendar tools (check_availability, book_appointment, cancel_appointment,
 * get_current_datetime) are delegated to the Next.js app via internal API.
 * Transfer tool (transfer_call) is handled locally via Twilio REST API.
 */

const twilioTransfer = require("./twilio-transfer");
const telnyxTransfer = require("./telnyx-transfer");

/** Mask PII phone numbers in logs: "+61412345678" → "+61***678" */
function maskPhone(phone) {
  if (!phone || phone.length < 6) return phone || "unknown";
  return phone.slice(0, 3) + "***" + phone.slice(-3);
}

// Route transfer calls to the correct provider
function getTransferService(context) {
  if (context.telephonyProvider === "telnyx") return telnyxTransfer;
  return twilioTransfer;
}
const { isWithinBusinessHours } = require("../lib/business-hours");
const { requiresRecordingDisclosureHybrid, getRecordingDisclosureText } = require("../lib/recording-consent");
const { Sentry } = require("../lib/sentry");
const { SENTRY_REASONS, setReasonTag } = require("../lib/sentry-reasons");

const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const CALENDAR_FUNCTIONS = [
  "get_current_datetime",
  "check_availability",
  "book_appointment",
  "cancel_appointment",
  "reschedule_appointment",
  "list_service_types",
  "lookup_appointment",
];

// SCRUM-452: calendar tools that MUTATE appointment rows. Test/demo calls run
// against the user's REAL organization, so in test mode every one of these must
// be simulated — a fall-through to the internal API would alter real bookings
// (reschedule_appointment previously did exactly that). Reads stay real so the
// LLM gets realistic data.
const CALENDAR_WRITE_FUNCTIONS = [
  "book_appointment",
  "cancel_appointment",
  "reschedule_appointment",
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
        "Executes the actual booking in the database. You MUST call this function to secure a time slot — it is IMPOSSIBLE to book an appointment without calling this tool. Do NOT verbally confirm a booking to the caller until this tool returns a success response. Collect first name, last name, and datetime BEFORE calling. The phone number defaults to the number the caller is calling from (caller ID) — do NOT ask the caller for a phone number unless they want to be reached on a DIFFERENT number.",
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
            description:
              "Optional. Defaults to the caller's own number from caller ID — leave it out and the system fills it in. Only provide a value if the caller explicitly asks to be reached on a DIFFERENT number.",
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
        // SCRUM-366: `phone` is no longer required — it defaults to caller ID
        // server-side (see applyCallerIdPhoneFallback). Keeping it required made
        // the model compulsively ask the caller for a number we already have,
        // which dead-ended bookings when the model couldn't extract it.
        required: ["datetime", "first_name", "last_name"],
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
          name: {
            type: "string",
            description: "The caller's name as it appears on the booking. Include it when you know it — some businesses require it to verify identity before cancelling, and the tool will ask for it if needed.",
          },
          email: {
            type: "string",
            description: "The email address on the booking, if the caller provides it. Some businesses require it to verify identity before cancelling.",
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
        "Look up the caller's existing appointment(s). The caller's phone number is taken AUTOMATICALLY from caller ID — do NOT ask them to read out their own number. Just confirm the name the booking is under (some businesses also ask for a date of birth), then call this. Only ask the caller for a phone number if they say the booking is under a DIFFERENT number, or if their caller ID is withheld/blocked (then ask for the name and phone number on the booking, or a 6-digit confirmation code if they have one). If the lookup returns no match, ask the caller to SPELL their last name letter by letter and call this again with the spelled name before offering a callback — phone audio often mishears unusual names.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The full name the appointment is booked under (used to confirm identity).",
          },
          phone: {
            type: "string",
            description: "Usually unnecessary — the caller's number comes from caller ID automatically. Only set this if the caller says the booking is under a DIFFERENT number than the one they're calling from.",
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
  {
    type: "function",
    function: {
      name: "reschedule_appointment",
      description:
        "Atomically MOVE an existing appointment to a new date/time in ONE step — it books the new slot and cancels the old one together, verified server-side. ALWAYS use this for a reschedule / change-of-time request. NEVER reschedule by calling cancel_appointment and book_appointment separately — that can leave a duplicate. Identify the existing appointment by the caller's phone plus its current date (or the confirmation code), and provide the new_datetime.",
      parameters: {
        type: "object",
        properties: {
          phone: {
            type: "string",
            description: "The phone number on the existing booking (use the caller-ID number if they say 'the same number').",
          },
          confirmation_code: {
            type: "string",
            description: "The existing appointment's confirmation code, if the caller has it (optional when phone + current date are given).",
          },
          current_datetime: {
            type: "string",
            description: "The EXACT current date+time of the existing appointment in ISO format, e.g. '2026-06-18T10:00:00'. Preferred when you know it (e.g. you just looked it up).",
          },
          current_date: {
            type: "string",
            description: "The current appointment's date only (YYYY-MM-DD), if the exact time isn't known. Less precise — use current_datetime when possible.",
          },
          new_datetime: {
            type: "string",
            description: "REQUIRED. The NEW date+time to move the appointment to, in ISO format, e.g. '2026-06-17T10:15:00'.",
          },
          first_name: {
            type: "string",
            description: "Caller's first name in English letters (optional — defaults to the name on the existing booking).",
          },
          last_name: {
            type: "string",
            description: "Caller's last name in English letters (optional — defaults to the name on the existing booking).",
          },
          name: {
            type: "string",
            description: "The name on the EXISTING booking, for identity verification only — some businesses require it before moving an appointment. To CHANGE the name on the booking use first_name and last_name instead.",
          },
          email: {
            type: "string",
            description: "The email address on the existing booking, if the caller provides it. Some businesses require it to verify identity before moving an appointment.",
          },
          service_type_id: {
            type: "string",
            description: "Service type for the new appointment (optional — defaults to the existing appointment's service type).",
          },
          practitioner_id: {
            type: "string",
            description: "Preferred practitioner for the new appointment (optional).",
          },
        },
        required: ["new_datetime"],
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
 * @param {{ date: string, service_type_id?: string, practitioner_id?: string }} args
 * @param {{ slots: Record<string, Array<string | { start: string, end: string }> | Record<string, Array<string | { start: string, end: string }>>>, timezone: string, generatedAt: string, serviceTypes?: Array<{ id: string, duration_minutes?: number }>, defaultDuration?: number }} snapshot
 *   `slots[date]` is EITHER a flat slot array (aggregated) OR a per-
 *   practitioner record keyed by practitioner id (with an `_any`
 *   bucket) — SCRUM-237. The code branches on `Array.isArray`. Each
 *   slot is EITHER a plain ISO string OR a `{ start, end }` object.
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
        // SCRUM-317: was `typeof slot === "string" ? slot : slot` — a
        // no-op that passed the {start,end} OBJECT to .split() (latent
        // bug; checkJs surfaced it, and object slots DO reach here via
        // per-practitioner `_any` buckets — SCRUM-237). Extract `.start`
        // for object slots; `|| ""` guards a malformed missing start.
        const s = (typeof slot === "string" ? slot : slot.start) || "";
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
    // SCRUM-317: drop the `|| slot` fallback — it made `s` possibly the
    // object (then .split would throw). An object slot always has a
    // string `.start`; `|| ""` guards a malformed missing start so the
    // `if (!timeStr) return null` below filters it out cleanly.
    const s = (typeof slot === "string" ? slot : slot.start) || "";
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
 * @param {{ organizationId: string, assistantId: string, callSid?: string, callId?: string, transferRules?: object[], testMode?: boolean, organization?: { timezone?: string, businessHours?: object }, callerPhone?: string, orgPhoneNumber?: string, userPhoneNumber?: string, forwardingStatus?: string, sourceType?: string, transferToForwardedNumber?: boolean, scheduleSnapshot?: object, telephonyProvider?: string }} context
 * @returns {Promise<{ message: string, action?: string, transferTo?: string, transferAttempt?: object, __endCall?: boolean } & Record<string, any>>}
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
    if (context.testMode && CALENDAR_WRITE_FUNCTIONS.includes(functionName)) {
      return simulateCalendarWrite(functionName, args);
    }
    // list_service_types / lookup_appointment are always reads — no simulation needed
    return executeCalendarCall(functionName, args, context);
  }

  console.warn(`[ToolExecutor] Unknown function: ${functionName}`);
  return { message: `Unknown function: ${functionName}` };
}

/**
 * SCRUM-366: default a booking's `phone` from caller ID.
 *
 * The caller's number is known from caller ID (`context.callerPhone`) but was
 * never forwarded to the booking handler, so the model was the only thing that
 * could populate `phone`. Under language stress it kept asking the caller for a
 * number we already had, dead-ending the booking. When the model omits `phone`
 * (or sends an empty one) for `book_appointment`, substitute caller ID.
 *
 * Scoped to `book_appointment` and `reschedule_appointment`. For raw
 * cancel/lookup, `phone` is a *match key* and silently substituting caller ID
 * could match the wrong record, so it's intentionally excluded. reschedule IS
 * included because the prompts tell the model to identify the appointment by the
 * caller's phone ("the same number"), and the reschedule handler narrows by exact
 * datetime / sole-upcoming before cancelling — so caller-ID substitution there
 * resolves to the caller's OWN appointment, the same safe semantics as booking.
 *
 * Only substitutes when caller ID is actually dialable. For a withheld/blocked
 * caller ID, Twilio sends a non-numeric sentinel ("anonymous", "Restricted",
 * "unavailable") or a SIP URI — substituting that would just trip the handler's
 * `isValidPhoneNumber` reject ("I didn't catch that number"), which is more
 * confusing than letting the model ask for a number.
 *
 * @param {string} functionName
 * @param {object} args - parsed LLM arguments
 * @param {string|undefined} callerPhone - caller ID number, if known
 * @returns {object} args, with `phone` defaulted from caller ID when applicable
 */
function applyCallerIdPhoneFallback(functionName, args, callerPhone) {
  if (functionName !== "book_appointment" && functionName !== "reschedule_appointment") return args;
  if (!isDialableCallerId(callerPhone)) return args; // unknown / withheld / SIP
  const hasPhone =
    args && typeof args.phone === "string" && args.phone.trim() !== "";
  if (hasPhone) return args;
  return { ...(args || {}), phone: callerPhone };
}

/**
 * Twilio's NUMERIC sentinel for a withheld caller ID — "+266696687" spells
 * "ANONYMOUS" on a phone keypad. It is 9 digits, so without an explicit check
 * it would pass the dialable window and become a never-matching "verified"
 * phone downstream, hard-blocking the caller's mutations. Both sentinel forms
 * (textual "anonymous" and this numeric one) must behave identically.
 */
const ANONYMOUS_CALLER_SENTINEL_DIGITS = "266696687";

/**
 * True when the caller ID looks like a real dialable number rather than a
 * withheld-ID sentinel ("anonymous", "Restricted", Twilio's numeric
 * "+266696687") or SIP URI. The 8–15 digit window mirrors
 * `isValidPhoneNumber` (src/lib/security/validation.ts), so anything that
 * passes here also passes that downstream check.
 *
 * @param {string|undefined} callerPhone
 * @returns {boolean}
 */
function isDialableCallerId(callerPhone) {
  const digits = typeof callerPhone === "string" ? callerPhone.replace(/\D/g, "") : "";
  if (digits === ANONYMOUS_CALLER_SENTINEL_DIGITS) return false;
  return digits.length >= 8 && digits.length <= 15;
}

/**
 * SCRUM-438 (review fix): the trusted caller-ID fields for the internal API,
 * sent as TOP-LEVEL payload fields the model can never reach. Tri-state:
 *  - `{ callerIdState: "verified", callerPhone }` — production call with a
 *    dialable From; possession is verified against THAT number only.
 *  - `{ callerIdState: "withheld" }` — production call whose From is a
 *    withheld-ID sentinel ("anonymous", "Restricted", "unavailable",
 *    "+266696687") or SIP URI. Sent EXPLICITLY so the Next.js handlers refuse
 *    mutations instead of silently falling back to the model-controlled phone
 *    argument (which would re-open the #31# caller-ID-withheld spoof).
 *  - `{}` — genuine test/browser sessions only (no caller ID can exist).
 *
 * @param {{ testMode?: boolean, callerPhone?: string }} context
 * @returns {{ callerIdState?: string, callerPhone?: string }}
 */
function resolveCallerIdFields(context) {
  if (context.testMode) return {};
  if (isDialableCallerId(context.callerPhone)) {
    return { callerIdState: "verified", callerPhone: context.callerPhone };
  }
  return { callerIdState: "withheld" };
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

  const effectiveArgs = applyCallerIdPhoneFallback(functionName, args, context.callerPhone);

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
        arguments: effectiveArgs,
        ...(context.callId && { callId: context.callId }),
        // SCRUM-438: the session's caller-ID state (+ the VERIFIED inbound
        // caller ID, the call's real From) as TOP-LEVEL trusted fields — never
        // inside `arguments`, which the model controls. Cancel/reschedule
        // ownership is verified against these. 'withheld' is sent explicitly
        // for production calls with no usable caller ID; both fields are
        // omitted only for test/browser sessions.
        ...resolveCallerIdFields(context),
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

    const data = /** @type {{ message?: string, success?: boolean }} */ (await res.json());
    // SCRUM-367: preserve the handler's authoritative `success` boolean
    // (additive — other call sites read only `.message`/`.error`) so the
    // book-loop cap keys off it rather than re-deriving success from prose.
    return {
      message: data.message || "The operation completed but returned no message.",
      ...(typeof data.success === "boolean" && { success: data.success }),
    };
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
  let transferRules = context.transferRules || [];

  // SCRUM-260: if no explicit transfer rules are configured but the business
  // has forwarding set up (their own number redirects into Phondo), fall back
  // to their user_phone_number as the transfer destination. Matches the
  // intuitive expectation: "caller asked for a human → send them to the
  // business's published line."
  //
  // Guards:
  //   - transferToForwardedNumber must be the org's explicit opt-in (SCRUM-327,
  //     default off). SCRUM-328: re-checked HERE too (defense-in-depth), not
  //     only at the registration gate — so even if a future change offered
  //     transfer_call in the no-rules case by another path, we never dial the
  //     forwarded number for an org that never opted in.
  //   - sourceType must be "forwarded" (not a purchased Phondo-pool number)
  //   - forwarding_status must be "active" (not "pending_setup" or "paused")
  //   - userPhoneNumber must not equal orgPhoneNumber (loop prevention — if
  //     they match, dialing user_phone_number routes back into Phondo and
  //     burns both legs until Twilio cuts off)
  //
  // Users on UNCONDITIONAL carrier forwarding can still loop via the carrier
  // side (their number → Phondo → back to their number → Phondo again). The
  // setup UI warns about this and recommends conditional forwarding.
  if (
    transferRules.length === 0 &&
    context.transferToForwardedNumber === true &&
    context.userPhoneNumber &&
    context.forwardingStatus === "active" &&
    context.sourceType === "forwarded"
  ) {
    const normalized = (s) => (s || "").replace(/[^\d+]/g, "");
    const userNorm = normalized(context.userPhoneNumber);
    const orgNorm = normalized(context.orgPhoneNumber);
    if (userNorm && userNorm === orgNorm) {
      console.error(`[Transfer] user_phone_number equals Phondo number — refusing fallback to avoid loop. callSid=${context.callSid}`);
      Sentry.withScope((scope) => {
        scope.setTag("service", "transfer_call");
        setReasonTag(scope, SENTRY_REASONS.USER_PHONE_EQUALS_PHONDO);
        scope.setExtras({ callSid: context.callSid, organizationId: context.organizationId });
        Sentry.captureMessage("Transfer fallback refused — user_phone_number equals Phondo number", "warning");
      });
      // Fall through without synthesizing the fallback rule.
    } else {
      console.log(`[Transfer] No explicit rules; using forwarded user_phone_number ${maskPhone(context.userPhoneNumber)} as fallback destination`);
      transferRules = [{
        id: null,
        name: "forwarding_fallback",
        triggerKeywords: [],
        triggerIntent: null,
        transferToPhone: context.userPhoneNumber,
        transferToName: "a team member",
        announcementMessage: null,
        priority: 0,
        destinations: [],
        requireConfirmation: false,
      }];
    }
  }

  if (transferRules.length === 0) {
    // SCRUM-260: if forwarding exists but is still "pending_setup" (business
    // hasn't completed the carrier setup yet), the team isn't actually
    // reachable by transfer. Take a message instead and note the status.
    const forwardingPending =
      context.sourceType === "forwarded" &&
      context.forwardingStatus === "pending_setup";
    return {
      message:
        "I apologize, but I'm not able to transfer your call right now. Let me take your information and have someone call you back. Can you confirm your name and phone number?",
      transferAttempt: {
        ruleId: null, ruleName: null, targetPhone: null, targetName: null,
        reason: reason || null, urgency: urgency || "low",
        outcome: forwardingPending ? "forwarding_pending_setup" : "no_rules_configured",
        outsideBusinessHours: false,
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

  // Build whisper text the RECIPIENT hears when they pick up — combines the
  // configured announcement message AND (if the org requires it) a recording
  // disclosure. AU law requires every party to know they're being recorded;
  // before this change the recipient was bridged in cold.
  const whisperParts = [];
  if (matchedRule.announcementMessage && typeof matchedRule.announcementMessage === "string") {
    whisperParts.push(matchedRule.announcementMessage.trim());
  }
  try {
    const org = context.organization || {};
    const consent = requiresRecordingDisclosureHybrid(
      org.country,
      org.businessState,
      org.recording_consent_mode || "auto",
      context.callerPhone || null
    );
    if (consent?.required) {
      const disclosure = getRecordingDisclosureText(
        org.country,
        org.recording_disclosure_text,
        org.name
      );
      if (disclosure) whisperParts.push(disclosure);
    }
  } catch (err) {
    // Non-fatal — log and skip the disclosure leg of the whisper. The
    // transfer itself still proceeds; this just means the recipient won't
    // hear the disclosure for this one call.
    console.warn("[Transfer] Failed to compute disclosure for whisper:", err.message);
  }
  const whisperText = whisperParts.filter(Boolean).join(" ") || undefined;

  // Pass action URL so Twilio POSTs dial outcome for no-answer fallback
  const PUBLIC_URL = process.env.PUBLIC_URL;
  const transferOptions = { whisperText };
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

  // SCRUM-317: twilio's transferCall returns { success, message } but
  // telnyx returns { success, outcome? } (no message) — divergent
  // contracts. Normalise to a caller-facing string so a telnyx transfer
  // doesn't surface `message: undefined` (latent gap pre-checkJs).
  const resultMessage = "message" in result && result.message
    ? result.message
    : result.success
      ? "Connecting you now."
      : "I wasn't able to complete the transfer.";

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
    message: resultMessage,
    action: result.success ? "transfer" : "callback",
    transferTo: matchedRule.transferToPhone,
    transferTargetName: targetName,
    allDestinations,
    destinationIndex: 0,
    transferAttempt,
  };
}

/**
 * Return a simulated response for booking/cancellation/reschedule during test
 * calls. Reads (get_current_datetime, check_availability) still hit the real
 * API so the LLM gets realistic data, but writes are faked.
 */
function simulateCalendarWrite(functionName, args) {
  if (functionName === "book_appointment") {
    // SCRUM-282/368: no confirmation text/email is actually sent — don't promise
    // one (and don't feed the model an English promise string to translate+speak).
    return {
      message: `Appointment confirmed for ${[args.first_name, args.last_name].filter(Boolean).join(" ") || args.name || "the caller"} at ${args.datetime}.`,
    };
  }
  if (functionName === "cancel_appointment") {
    return {
      message: `The appointment associated with ${args.phone} has been cancelled successfully.`,
    };
  }
  if (functionName === "reschedule_appointment") {
    // SCRUM-452: reschedule previously fell through to the REAL internal API —
    // a test caller saying "move my appointment" created a real reschedule leg
    // and freed the real slot. Mirror the real handler's confirmation wording
    // ("Done — I've moved your appointment from X. …" in tool-handlers.ts) so
    // the model speaks a plausible confirmation of the new time.
    const oldRef = args.current_datetime || args.current_date;
    return {
      message: `Done — I've moved your appointment${oldRef ? ` from ${oldRef}` : ""} to ${args.new_datetime || "the new time"}.`,
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
  _test: {
    getTransferService, resolveCurrentDatetime, resolveAvailabilityFromCache, applyCallerIdPhoneFallback,
    isDialableCallerId, resolveCallerIdFields,
    CALENDAR_FUNCTIONS, CALENDAR_WRITE_FUNCTIONS,
  },
};
