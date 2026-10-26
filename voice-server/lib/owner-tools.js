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

const OWNER_TOOL_NAMES = Object.freeze(["owner_list_appointments", "owner_list_messages", "owner_reschedule_appointment", "owner_cancel_appointment", "owner_call_customer"]);
/** Every owner tool that acts (and so goes through the confirmation gate). SCRUM-598: placing a call to a customer is one. */
const OWNER_WRITE_TOOL_NAMES = Object.freeze(["owner_reschedule_appointment", "owner_cancel_appointment", "owner_call_customer"]);
/** The writes that change the diary (the schedule cache is refreshed and the dashboard told); a call changes nothing by itself. */
const OWNER_CHANGE_TOOL_NAMES = Object.freeze(["owner_reschedule_appointment", "owner_cancel_appointment"]);
const OWNER_SHARED_TOOL_NAMES = Object.freeze(["get_current_datetime", "check_availability", "end_call"]);
const OWNER_ALLOWED_TOOL_NAMES = new Set([...OWNER_TOOL_NAMES, ...OWNER_SHARED_TOOL_NAMES]);
/**
 * data.outcome values that mean a write actually happened. Everything else —
 * needs_confirmation, not_found, slot_taken, invalid_time, rate_limited,
 * external_calendar — is a business non-success.
 */
const OWNER_SUCCESS_OUTCOMES = new Set(["rescheduled", "cancelled", "calling"]);

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
          confirmed: {
            type: "boolean",
            description: "The boolean true ONLY after the owner clearly said yes to your read-back. Leave it out to get the read-back to give.",
          },
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
          confirmed: {
            type: "boolean",
            description: "The boolean true ONLY after the owner clearly said yes to your read-back. Leave it out to get the read-back to give.",
          },
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
          confirmed: {
            type: "boolean",
            description: "The boolean true ONLY after the owner clearly said yes to your read-back. Leave it out to get the read-back to give.",
          },
        },
        required: ["appointment_id", "purpose"],
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
 * The owner session's complete tool list: the five owner tools, then the
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
