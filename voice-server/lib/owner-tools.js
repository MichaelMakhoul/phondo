"use strict";
/**
 * SCRUM-587 — owner tool declarations (spec §2 table). The argument formats
 * and outcome vocabularies are PR B's contract (src/lib/owner-assistant/
 * tool-handlers.ts and the internal tool-call route) and are declared VERBATIM
 * here so the model sends what the handlers parse. Flat scalar parameters
 * only: the Gemini converter (services/gemini-live.js convertSchemaToGemini)
 * drops nesting. `confirmed` is a JSON boolean — PR B treats the string
 * "true" as needs_confirmation.
 *
 * No authority is declared here. The owner's powers come only from the
 * top-level `ownerVerified` envelope field, which executeCalendarCall sets from
 * the session (context.ownerMode) — never from anything the model sends.
 */

const OWNER_TOOL_NAMES = Object.freeze([
  "owner_list_appointments",
  "owner_list_messages",
  "owner_reschedule_appointment",
  "owner_cancel_appointment",
  "owner_call_customer",
  "owner_book_appointment",
  "owner_block_time",
  "owner_mark_callback_done",
]);
/**
 * Every owner tool that acts (and so goes through the confirmation gate). SCRUM-598:
 * placing a call to a customer is one; SCRUM-599: booking, blocking time and marking
 * a callback done.
 */
const OWNER_WRITE_TOOL_NAMES = Object.freeze([
  "owner_reschedule_appointment",
  "owner_cancel_appointment",
  "owner_call_customer",
  "owner_book_appointment",
  "owner_block_time",
  "owner_mark_callback_done",
]);
/**
 * The writes that change what's free in the diary (the schedule cache is refreshed);
 * a call or a callback marked done changes nothing there.
 */
const OWNER_CHANGE_TOOL_NAMES = Object.freeze(["owner_reschedule_appointment", "owner_cancel_appointment", "owner_book_appointment", "owner_block_time"]);
const OWNER_SHARED_TOOL_NAMES = Object.freeze(["get_current_datetime", "check_availability", "end_call"]);
const OWNER_ALLOWED_TOOL_NAMES = new Set([...OWNER_TOOL_NAMES, ...OWNER_SHARED_TOOL_NAMES]);
/**
 * data.outcome values that mean a write actually happened. Everything else —
 * needs_confirmation, not_found, slot_taken, not_booked, invalid_time,
 * invalid_details, not_available, rate_limited, external_calendar — is a business
 * non-success.
 */
const OWNER_SUCCESS_OUTCOMES = new Set(["rescheduled", "cancelled", "calling", "booked", "blocked", "callback_done"]);

/**
 * SCRUM-597: the owner's answer on letting the customer know, sent with the
 * confirm. PR B changes nothing without one of the three; "none" = don't tell them.
 */
const NOTIFY_CUSTOMER_PARAM = Object.freeze({
  type: "string",
  enum: ["text", "call", "none"],
  description:
    "With confirmed=true: the owner's answer on letting the customer know — one of data.contact_options from the read-back (\"call\" means the assistant phones them right after the change; \"none\" means don't tell them). Without it nothing changes.",
});

/** SCRUM-599: a new booking can be texted or not — a call isn't offered for one. */
const NOTIFY_BOOKED_PARAM = Object.freeze({
  type: "string",
  enum: ["text", "none"],
  description:
    "With confirmed=true: the owner's answer on texting the customer about the new booking — one of data.contact_options from the read-back (\"none\" means don't tell them). Without it nothing is booked.",
});

/** The confirm flag every owner write takes. */
const CONFIRMED_PARAM = Object.freeze({
  type: "boolean",
  description: "The boolean true ONLY after the owner clearly said yes to your read-back. Leave it out to get the read-back to give.",
});

/** A local wall time, as every owner write takes it. */
const LOCAL_TIME = "in the business's LOCAL time as YYYY-MM-DDTHH:mm — no seconds, no time-zone offset, no trailing Z";

const ownerToolDefinitions = [
  {
    type: "function",
    function: {
      name: "owner_list_appointments",
      description:
        "List the business's booked jobs. Call this BEFORE any change to get the job's appointment_id. Returns up to 20 active jobs (each with its appointment_id, the customer's name and phone, start and end time, service and practitioner) plus the count of all jobs in the period.",
      parameters: {
        type: "object",
        properties: {
          range: {
            type: "string",
            enum: ["today", "tomorrow", "this_week", "date"],
            description: "today | tomorrow | this_week (the next 7 days) | date (then also pass date).",
          },
          date: { type: "string", description: "YYYY-MM-DD in the business's timezone. Only with range=date." },
        },
        required: ["range"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "owner_list_messages",
      description: "Pending callback requests (newest first, up to 10) and today's customer calls with a one-line summary each (up to 10).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "owner_reschedule_appointment",
      description:
        "Move ONE existing job to a new time, in two calls. First call WITHOUT confirmed: nothing changes, and data.outcome is needs_confirmation with the read-back — the job's current and new times in data.from and data.to, and data.contact_options (how the customer can be told). Read that back to the owner, ask in the same question whether to let the customer know (offer only data.contact_options), and get a clear yes, THEN call again with confirmed=true and notify_customer set to their answer. The result's data.outcome is rescheduled | needs_confirmation | not_found | slot_taken | invalid_time | rate_limited | external_calendar — only 'rescheduled' means it happened; after it, use data.new_appointment_id for any further change to that job. data.customer_contact says whether the customer was actually told.",
      parameters: {
        type: "object",
        properties: {
          appointment_id: { type: "string", description: "The appointment_id from owner_list_appointments." },
          new_datetime: {
            type: "string",
            description: "The new start in the business's LOCAL time as YYYY-MM-DDTHH:mm — no seconds, no time-zone offset, no trailing Z.",
          },
          confirmed: CONFIRMED_PARAM,
          notify_customer: NOTIFY_CUSTOMER_PARAM,
        },
        required: ["appointment_id", "new_datetime"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "owner_cancel_appointment",
      description:
        "Cancel ONE existing job, in two calls. First call WITHOUT confirmed: nothing changes, and data.outcome is needs_confirmation with the read-back — the job's time in data.when, and data.contact_options (how the customer can be told). Read that back to the owner, ask in the same question whether to let the customer know (offer only data.contact_options), and get a clear yes, THEN call again with confirmed=true and notify_customer set to their answer. The result's data.outcome is cancelled | needs_confirmation | not_found | rate_limited | external_calendar — only 'cancelled' means it happened. data.customer_contact says whether the customer was actually told.",
      parameters: {
        type: "object",
        properties: {
          appointment_id: { type: "string", description: "The appointment_id from owner_list_appointments." },
          confirmed: CONFIRMED_PARAM,
          reason: { type: "string", description: "Optional short reason, in the owner's words." },
          notify_customer: NOTIFY_CUSTOMER_PARAM,
        },
        required: ["appointment_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "owner_call_customer",
      description:
        "Have the assistant phone a customer about ONE of their bookings WITHOUT changing it: purpose \"confirm\" checks they're still OK for it; purpose \"find_new_time\" agrees a new time with them and moves it (it stays as it is until they pick one). To tell a customer about a cancel or a move, use notify_customer \"call\" on that change instead. In two calls. First call WITHOUT confirmed: nothing happens, and data.outcome is needs_confirmation with the read-back (data.customer_name, data.when), or not_available with the reason in the message. Read it back to the owner and get a clear yes, THEN call again with confirmed=true. The result's data.outcome is calling | needs_confirmation | not_available | not_found | external_calendar — only 'calling' means the call is being placed; the owner gets an email when it ends. For find_new_time, only a date range and a time of day reach the call: anything else the owner asks for (a day to skip, \"after 3\", a particular person) can't be passed on — say so in the read-back.",
      parameters: {
        type: "object",
        properties: {
          appointment_id: { type: "string", description: "The appointment_id from owner_list_appointments." },
          purpose: {
            type: "string",
            enum: ["confirm", "find_new_time"],
            description: "confirm: check they're still OK for the booking. find_new_time: agree a new time with them and move it.",
          },
          earliest_date: {
            type: "string",
            description: "find_new_time only, optional: the first day the new time may be on, as YYYY-MM-DD in the business's timezone (\"next week\" starts next Monday).",
          },
          latest_date: {
            type: "string",
            description: "find_new_time only, optional: the last day the new time may be on, as YYYY-MM-DD. Set it whenever the owner's words have an end (\"next week\" ends next Sunday; \"before Friday\" is Thursday): without it the call may book any day from earliest_date on.",
          },
          time_of_day: {
            type: "string",
            enum: ["morning", "afternoon", "evening", "any"],
            description: "find_new_time only, optional: when in the day the owner wants the new time.",
          },
          confirmed: CONFIRMED_PARAM,
        },
        required: ["appointment_id", "purpose"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "owner_book_appointment",
      description:
        "Book a NEW job for a customer, in two calls. Each business sets which details its bookings need (a last name, an email, an address, how urgent it is…): when some are missing the first call answers invalid_details with data.missing_fields naming them — ask the owner for exactly those, then call again with them; never ask for anything it didn't name. First call WITHOUT confirmed: nothing is booked, and data.outcome is needs_confirmation with the read-back (data.customer_name, data.customer_phone, data.when, data.service, data.customer_email, data.details) and data.contact_options — whether the customer can be texted about it (a call isn't offered for a new booking). Read it back, ask in the same question whether to text them (offer only data.contact_options), and get a clear yes, THEN call again with confirmed=true, the SAME details, and notify_customer set to their answer. The result's data.outcome is booked | needs_confirmation | invalid_details | invalid_time | not_booked | rate_limited | external_calendar — only 'booked' means it happened. not_booked: the diary refused it (outside hours, a block, a clash) — say why in a few words and offer another time (check_availability lists the free times). After it, use data.appointment_id for any change to that job. data.customer_contact says whether the customer was actually told.",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string", description: "The customer's name as the owner said it. A first name alone is fine unless this business needs a last name — the tool says so (data.missing_fields)." },
          customer_phone: { type: "string", description: "The customer's phone number. Ask the owner for it if they didn't say it — never make one up. The read-back says it back digit by digit, so a misheard digit is caught." },
          start: { type: "string", description: `The start ${LOCAL_TIME}.` },
          service_type_id: { type: "string", description: "Optional: the ID of the service from the SERVICE TYPES list in your instructions. Never a name." },
          notes: { type: "string", description: "Optional short note for the job in the owner's words — what's wrong, and the address if they give one (for example \"hot water unit leaking, 12 Smith St\")." },
          customer_email: { type: "string", description: "The customer's email address, when this business collects one (the tool asks for it when it's required). Spelled back letter by letter in the read-back." },
          details: { type: "string", description: "The business's other caller details for this booking, as \"field=value; field=value\" using the field names the tool gives (for example \"service address=12 Smith St, Wyong; urgency level=today\"). Only the fields this business has — the tool names them." },
          confirmed: CONFIRMED_PARAM,
          notify_customer: NOTIFY_BOOKED_PARAM,
        },
        required: ["customer_name", "customer_phone", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "owner_block_time",
      description:
        "Block out time in the WHOLE diary so no one can be booked then (it is for everyone — one person's time off is done in the dashboard), in two calls. First call WITHOUT confirmed: nothing changes, and data.outcome is needs_confirmation with the read-back (data.when, data.title; data.jobs_in_the_way counts jobs already booked then, and the message names them). Read it back and get a clear yes, THEN call again with confirmed=true and the SAME start, end and reason. Blocking never moves or cancels a job: jobs already booked then STAY booked — if the owner wants one out of the way, that's owner_reschedule_appointment or owner_cancel_appointment, one at a time. The result's data.outcome is blocked | needs_confirmation | invalid_time | rate_limited | external_calendar — only 'blocked' means it happened. Up to two weeks at a time.",
      parameters: {
        type: "object",
        properties: {
          start: { type: "string", description: `When the block starts, ${LOCAL_TIME}. A whole day starts at T00:00.` },
          end: { type: "string", description: `When it ends, ${LOCAL_TIME}. A whole day ends at T00:00 the NEXT day.` },
          reason: { type: "string", description: "Optional short title in the owner's words (for example \"Quote visit\" or \"Day off\")." },
          confirmed: CONFIRMED_PARAM,
        },
        required: ["start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "owner_mark_callback_done",
      description:
        "Mark ONE waiting callback request as done, so it comes off the owner's callback list, in two calls. Use the callback_id from owner_list_messages. First call WITHOUT confirmed: nothing changes, and data.outcome is needs_confirmation with the read-back (data.caller_name, data.reason, data.received, and data.note when there is one). Read it back and get a clear yes, THEN call again with confirmed=true and the same callback_id and note. The result's data.outcome is callback_done | needs_confirmation | not_found | rate_limited — only 'callback_done' means it happened.",
      parameters: {
        type: "object",
        properties: {
          callback_id: { type: "string", description: "The callback_id from owner_list_messages." },
          note: { type: "string", description: "Optional short note in the owner's words (for example \"rang them back, sorted\"). It is read back with the rest, so keep the SAME note for the confirm." },
          confirmed: CONFIRMED_PARAM,
        },
        required: ["callback_id"],
      },
    },
  },
];

/**
 * check_availability for the owner session. Same parameter schema as the
 * receptionist declaration in services/tool-executor.js, so the cache path and
 * PR B's handler are unchanged; worded for the owner instead. The receptionist
 * text talks about "the caller" and takes practitioner_id from a PRACTITIONERS
 * ON STAFF list that the owner prompt never prints. Service IDs come from the
 * owner prompt's SERVICE TYPES list (lib/owner-prompt.js).
 */
const ownerCheckAvailabilityDefinition = {
  type: "function",
  function: {
    name: "check_availability",
    description:
      "Check the free appointment times on one date — for example to find a new time for one of the owner's jobs. Returns the free times that day. When the job's service is in the SERVICE TYPES list in your instructions, pass its ID as service_type_id so the times fit that service; without it the tool may ask which type instead of listing times.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "The date to check, as YYYY-MM-DD." },
        service_type_id: {
          type: "string",
          description: "Optional. The ID of the service from the SERVICE TYPES list in your instructions — for a job being moved, that job's service.",
        },
        practitioner_id: {
          type: "string",
          description: "Optional. Leave this out to see free times across all staff. Never put a name here.",
        },
      },
      required: ["date"],
    },
  },
};

/**
 * The owner session's complete tool list: the owner tools, then the
 * shared get_current_datetime, the owner-worded check_availability and
 * end_call. Lazy require: tool-executor imports the NAME lists from this
 * module, so a top-level require would be circular.
 * @returns {object[]} OpenAI-style definitions (converted per pipeline as usual)
 */
function buildOwnerTools() {
  const { calendarToolDefinitions, endCallToolDefinition } = require("../services/tool-executor");
  const datetime = calendarToolDefinitions.find((t) => t.function.name === "get_current_datetime");
  if (!datetime) throw new Error("owner tools: shared get_current_datetime declaration missing from calendarToolDefinitions");
  return [...ownerToolDefinitions, datetime, ownerCheckAvailabilityDefinition, endCallToolDefinition];
}

module.exports = {
  OWNER_TOOL_NAMES,
  OWNER_WRITE_TOOL_NAMES,
  OWNER_CHANGE_TOOL_NAMES,
  OWNER_SHARED_TOOL_NAMES,
  OWNER_ALLOWED_TOOL_NAMES,
  OWNER_SUCCESS_OUTCOMES,
  ownerToolDefinitions,
  buildOwnerTools,
};
