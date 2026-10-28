"use strict";
/**
 * SCRUM-587 — the owner session's tool path (spec §5).
 *
 * ONE early return in each pipeline's tool loop (server.js) hands owner tool
 * calls here — which is how every customer guard is skipped at once:
 * RebookGuard, the cancel-confirmation gate, the end_call booking funnel
 * (check_availability is a "funnel step" there, so an owner who checked slots
 * and then said goodbye would be refused), the confirmed-bookings ledger and
 * reschedule-ledger moves, the cache deltas and the loop-cap directives. All
 * of them key on customer tool names and receptionist phrasing and would mark
 * the owner's own call failed, then email the owner about it.
 *
 * Kept: a per-call tool cap, the audit trail (feeds the deterministic post-
 * call summary), schedule-cache invalidation after a REAL change, and the
 * [ALERT:error] forwarding executeCalendarCall already does on tool faults.
 *
 * Added here, because this is the one place that decides what the model hears:
 * - A STRUCTURAL confirmation gate. Customer-written text (callback reasons,
 *   notes, names) comes back through the read tools into the same model that
 *   holds the write tools, so the model's own `confirmed: true` is not enough.
 *   A confirmed write goes through only when PR B handed back a read-back for
 *   that exact change, exactly ONE assistant turn (the read-back) has ended
 *   since, assistant audio was heard after the arm, and the owner spoke after
 *   that turn, with an utterance that hasn't already confirmed another write.
 *   When the owner's speech is the ONLY thing missing, the confirm waits up to
 *   CONFIRM_SETTLE_MS for it (the "yes" transcript can trail the model's tool
 *   call). Anything else is sent on as confirmed:false at once, which makes
 *   PR B answer with the read-back again.
 * - Owner wording for failures. The shared executor's receptionist lines (the
 *   "take your information" callback offer, the "give me a moment" stall) are
 *   never said to the owner, and nothing without its result counts as done.
 * - PR B's data is the verdict. Its messages quote customer-written text, so
 *   prose is only ever judged on a result that came back without data.
 *
 * Logs carry tool names, ids of the call and outcome codes only — never tool
 * arguments, customer text or results.
 */
const { OWNER_TOOL_NAMES, OWNER_WRITE_TOOL_NAMES, OWNER_CHANGE_TOOL_NAMES, OWNER_ALLOWED_TOOL_NAMES, OWNER_SUCCESS_OUTCOMES } = require("./owner-tools");

/**
 * Owner tool calls per CALL. SCRUM-599: a normal admin call (the messages, a callback
 * ticked off, a booking — a read-back and a yes each — a block, then moving the job
 * in its way) is well past 10, so the call budget is 30; the cap is only a runaway
 * net (every write still needs the owner's own yes).
 */
const OWNER_MAX_TOOL_CALLS = 30;
/** Tool rounds per classic-pipeline TURN (server.js): an owner's list → check → read-back fits in a few. */
const OWNER_MAX_TOOL_ROUNDS = 10;

/** Every failed check_availability, whatever the cause (controller ruling). */
const DIARY_UNAVAILABLE_MESSAGE = "I couldn't check the diary just now — try another time, or check the dashboard.";
/** Every owner_* call when the session has no call record: PR B needs the callId (controller ruling). */
const NO_CALL_RECORD_MESSAGE = "I can't reach your bookings on this call — please ring back in a minute.";
/** A read that came back without its result (same words as the executor's owner non-2xx line). */
const READ_FAILED_MESSAGE = "I'm having trouble with that right now — please try again in a moment, or check the dashboard.";
/** A write that failed in transit may still have gone through, so it is never called a failure (same words as the executor's). */
const WRITE_UNCONFIRMED_MESSAGE =
  "I'm having trouble with that right now, so I can't confirm the change went through. Please check the dashboard, or try again in a moment.";
/** What a session that is not an owner session hears (PR B's refusal wording). */
const NOT_AN_OWNER_CALL_MESSAGE = "That isn't available on this call.";
/** A write Gemini cancelled before it went out (Gemini drops this response; it is the record). */
const CANCELLED_BEFORE_SENT_MESSAGE = "Not done: that call was cancelled before it went out, so nothing was changed.";

/**
 * The receptionist's failure lines that reach an owner session through the
 * shared executor and the customer calendar handlers: the callback offer
 * ("…take your information instead?") of a missing config, a non-2xx for a
 * shared tool, or a calendar fault; and the "having a little trouble right
 * now. Could you give me a moment?" stall of a timeout or fetch error. None of
 * them carries data, and PR B's messages quote customers, so this is only ever
 * tested on a result without data (failedInTransit).
 */
const CUSTOMER_FAILURE_LINE = /take your information|having a little trouble right now/i;

/**
 * PR B ends every successful write's message with a sentence about the customer
 * (contactOutcomeSentence in src/lib/owner-assistant/customer-contact.ts; before
 * SCRUM-597 the fixed "The customer has NOT been notified"); the change is what
 * precedes it. Cutting there, not at the first full stop, keeps "Dr. Jane Smith"
 * whole.
 */
const CONTACT_SENTENCE = /\s+(?:The customer has NOT been notified\b|I've texted |I couldn't text |I can't call customers yet\b|I haven't let |I'm calling |I couldn't call |I'm not sure the call )/i;

/**
 * SCRUM-597: what happened to the customer, for the stored summary, from PR B's
 * data.customer_contact (never from its prose).
 * @param {unknown} data
 * @returns {string} "" when the result says nothing about the customer
 */
function contactSummary(data) {
  const contact = data && typeof data === "object" ? /** @type {any} */ (data).customer_contact : undefined;
  if (!contact || typeof contact !== "object") return "";
  if (contact.status === "sent") return " — customer texted";
  if (contact.method === "text" && contact.status === "not_sent") return " — customer not texted";
  // SCRUM-598: a placed call isn't a told customer yet — the outcome email says how it went.
  if (contact.status === "calling") return " — calling the customer";
  if (contact.method === "call") return " — customer not called";
  return " — customer not told";
}
/**
 * The in-flight notice's words for the customer, from data.customer_contact.status.
 * @param {unknown} status
 */
function inFlightContact(status) {
  if (status === "sent") return "WAS texted";
  if (status === "calling") return "IS being called";
  // SCRUM-599: a booking handed back as a repeat whose text log couldn't be read says nothing about the customer.
  if (status === undefined) return "may or may not have been told — say you couldn't check";
  return "was NOT told";
}

/**
 * How to find out whether an interrupted write whose result never came back went
 * through. SCRUM-599: owner_list_appointments shows neither a block nor a callback.
 * @param {string} name
 */
function inFlightUnknownAdvice(name) {
  if (name === "owner_block_time") return "trying the same block again (the same start and end) never doubles it — the one already made is handed back";
  if (name === "owner_mark_callback_done") return "check with owner_list_messages — a callback marked done is no longer waiting";
  return "check with owner_list_appointments before changing anything else";
}

/**
 * What an interrupted write that went through did, for the notice to the model.
 * SCRUM-599: a block or a callback marked done has no customer to tell.
 * @param {string} name
 * @param {unknown} data
 */
function inFlightWhat(name, data) {
  if (name === "owner_call_customer") return "the call to the customer IS being placed";
  if (name === "owner_block_time" || name === "owner_mark_callback_done") return "the change HAS been made";
  return `the change HAS been made, and the customer ${inFlightContact(/** @type {any} */ (data)?.customer_contact?.status)}`;
}

/** Fits PR B's longest success line (an 80-character name and two spoken times). */
const DETAIL_MAX = 200;

const RANGE_LABEL = new Map([
  ["today", "today's jobs"],
  ["tomorrow", "tomorrow's jobs"],
  ["this_week", "this week's jobs"],
]);

/**
 * How long a confirm may wait for the owner's "yes" to be stamped, and how
 * often it looks (controller ruling). Gemini's input transcription has no
 * guaranteed order against its tool calls, so the transcript of the "yes" the
 * model just acted on can land a beat AFTER the confirm call. Only that waits.
 */
const CONFIRM_SETTLE_MS = 1500;
const CONFIRM_POLL_MS = 100;

/**
 * How long cleanup waits for owner tool calls still running when the call
 * ends (the owner hung up right after "yes"): the settle wait plus a slow PR B
 * round trip, well inside the executor's own 15 s timeout.
 */
const OWNER_CLEANUP_WAIT_MS = 8000;

/** What the summary says when a confirmed change's result never came back (it may have gone through). */
const UNCONFIRMED_CHANGE_SUMMARY = "a change could not be confirmed — check the dashboard";

/** An outcome code that is safe to log (PR B's vocabulary is snake_case words). @param {unknown} outcome */
function outcomeLabel(outcome) {
  return typeof outcome === "string" && /^[a-z_]{1,32}$/.test(outcome) ? outcome : "unknown";
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Owner sessions whose missing call record has already been alerted on (one alert per call). */
const noCallRecordAlerted = new WeakSet();

/**
 * Replies written for the model, not for the owner's ears (the tool cap, a
 * blocked name, a cancelled write): the classic loop's fallback never reads
 * one out. Kept off the object itself, which reaches the model whole.
 * @type {WeakSet<object>}
 */
const modelOnlyReplies = new WeakSet();
/** @param {string} message */
function modelOnly(message) {
  const ret = { message };
  modelOnlyReplies.add(ret);
  return ret;
}

/** What an owner hears when the classic tool loop runs out with no tool message fit to say. */
const LOOP_EXHAUSTED_MESSAGE = "Sorry — I couldn't finish that just now. Please check the dashboard.";

/**
 * A model-supplied tool name, made safe to log and to echo: no line breaks and
 * no brackets, so it can never forge a second log line or an [ALERT:…] tag.
 * @param {unknown} name
 */
function safeToolName(name) {
  return String(name ?? "").replace(/[^\w.-]/g, "?").slice(0, 64) || "unnamed";
}

/** @param {unknown} err */
function messageOf(err) {
  const message = err && typeof err === "object" ? /** @type {{ message?: unknown }} */ (err).message : undefined;
  return typeof message === "string" && message ? message.replace(/\s+/g, " ").slice(0, 200) : "unknown error";
}

/**
 * The executor's result as an object with a string message (the executor
 * always returns one; anything else is treated as an empty, failed result).
 * @param {unknown} result
 * @returns {{ message: string, success?: unknown, error?: unknown, data?: any, __endCall?: unknown }}
 */
function asResult(result) {
  if (typeof result === "string") return { message: result };
  if (result && typeof result === "object") {
    const r = /** @type {Record<string, any>} */ (result);
    return { ...r, message: typeof r.message === "string" ? r.message : "" };
  }
  return { message: "" };
}

/** @param {{ data?: any }} r */
function outcomeOf(r) {
  return r.data && typeof r.data === "object" ? r.data.outcome : undefined;
}

/**
 * A result that came back without data and is empty or one of the
 * receptionist's failure lines — a fault on the way, never PR B's answer.
 * @param {{ message: string, data?: any }} r
 */
function failedInTransit(r) {
  return r.data === undefined && (!r.message.trim() || CUSTOMER_FAILURE_LINE.test(r.message));
}

/**
 * Did this tool call do what it was asked? PR B's write results carry their
 * verdict in data.outcome and an owner read is only a read with its data —
 * prose never overrules either (it quotes customers). The shared tools carry
 * no data, so for them the receptionist's failure lines are the signal.
 * @param {string} name
 * @param {unknown} result
 * @returns {boolean}
 */
function ownerResultSucceeded(name, result) {
  const r = asResult(result);
  if (r.error === true || r.success === false) return false;
  if (OWNER_WRITE_TOOL_NAMES.includes(name)) return OWNER_SUCCESS_OUTCOMES.has(outcomeOf(r));
  if (OWNER_TOOL_NAMES.includes(name)) return r.data !== null && typeof r.data === "object";
  return !failedInTransit(r);
}

/**
 * The words the model gets back for this call.
 * @param {string} name
 * @param {{ message: string, success?: unknown, error?: unknown, data?: any }} r
 * @param {boolean} successful
 */
function ownerFacingMessage(name, r, successful) {
  if (successful) return r.message;
  if (name === "check_availability") return r.error === true || failedInTransit(r) ? DIARY_UNAVAILABLE_MESSAGE : r.message;
  const isWrite = OWNER_WRITE_TOOL_NAMES.includes(name);
  if (failedInTransit(r)) return isWrite ? WRITE_UNCONFIRMED_MESSAGE : READ_FAILED_MESSAGE;
  // An owner read that came back without its data failed, whatever the prose
  // says — unless PR B (or the executor's owner-worded non-2xx line) flagged
  // its own non-success, whose words fit ("Which date? …").
  if (OWNER_TOOL_NAMES.includes(name) && !isWrite && r.data === undefined && r.success !== false) return READ_FAILED_MESSAGE;
  return r.message;
}

/**
 * The pending-confirmation key: every field the read-back gave. For a change or a
 * call, `tool|appointment_id`, plus `|new_datetime` for a reschedule and the window
 * for a call; null when a part is not a non-empty string or contains "|" — such a
 * call can never be confirmed, and the key stays unambiguous. SCRUM-599: the new
 * writes (a booking, a block, a callback marked done) key on their read-back's fields
 * JSON-encoded, so their free text may hold anything.
 * @param {string} name
 * @param {Record<string, any>} args
 * @returns {string|null}
 */
function confirmationKey(name, args) {
  /** @param {unknown} v */
  const part = (v) => (typeof v === "string" && v !== "" && !v.includes("|") ? v : null);
  /** @param {unknown} v an optional field: absent is "", a malformed one is null */
  const optional = (v) => (v === undefined || v === null || v === "" ? "" : part(v));
  /** @param {unknown} v words the model may space or case differently between the two calls (any text: the fields are JSON-encoded) */
  const words = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").toLowerCase() || null : null);
  /** @param {unknown} v optional words: absent or blank is "" (the website reads a blank one as none) */
  const optionalWords = (v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? "" : words(v));
  /** @param {unknown} v a phone number, digits only, an AU +61 number written as 0… */
  /** An email however it's cased or spaced; "" when none. */
  const optionalEmail = (v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? "" : typeof v === "string" ? v.replace(/\s+/g, "").toLowerCase() : null);
  /**
   * "field=value; field=value" → one JSON list of [field, words] pairs sorted by field
   * (a colon after the field works too, as PR B reads it). Unreadable → null (never
   * confirmable), and so is a field named twice: PR B refuses that, and a key that
   * sorted the two could match a string PR B reads the other way round.
   */
  const detailsKey = (v) => {
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return "";
    if (typeof v !== "string") return null; // not what PR B reads as "none" — never confirmable
    const pairs = [];
    const seen = new Set();
    // Read as PR B reads it (sanitizeCustomerText, after its line-break rule): a line
    // break separates like ";", NFKC, tabs are spaces, controls and invisible marks go,
    // spaces collapse — so a string PR B accepted is never left unconfirmable here, and a
    // string PR B refuses is never armed.
    const text = v
      .replace(/[\r\n\u2028\u2029]+/g, ";")
      .normalize("NFKC")
      .replace(/\t/g, " ")
      .replace(/\p{C}/gu, "")
      .replace(/[\p{Default_Ignorable_Code_Point}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    for (const part of text.split(";")) {
      if (!part.trim()) continue;
      const m = /^\s*([^=:]+?)\s*[=:]\s*(.*)$/.exec(part);
      if (!m) return null;
      let field = m[1].normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
      // The booking's own fields under either spelling PR B accepts.
      if (field === "surname") field = "lastname";
      if (field === "emailaddress") field = "email";
      if (seen.has(field)) return null;
      seen.add(field);
      const value = words(m[2]);
      if (value) pairs.push([field, value]);
    }
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return JSON.stringify(pairs);
  };
  const phoneDigits = (v) => {
    if (typeof v !== "string") return null;
    const d = v.replace(/\D/g, "");
    if (!d) return null;
    const plus = v.trim().startsWith("+");
    // One number however it's written — the forms the booking path saves as one
    // (parsePhoneToE164): +61 4…, 61 4…, 04… and 4… are 04…; +1 415…, 1 415… and
    // 415… are 415…. The read-back gives the national form, which the model may
    // copy into its confirm. Anything else keeps its +, so +64 9 555 1234 is never
    // (649) 555-1234, and "1 0412 345 678" stays apart from 0412 345 678.
    if (/^61[23478]\d{8}$/.test(d)) return `0${d.slice(2)}`;
    if (!plus && /^[23478]\d{8}$/.test(d)) return `0${d}`;
    if (/^1[2-9]\d{9}$/.test(d)) return d.slice(1);
    return plus ? `+${d}` : d;
  };
  // SCRUM-599: the new writes name no existing booking — every field the read-back gave
  // is the key, so a yes to one booking, block or note never makes another. JSON keeps
  // the fields apart: a "|" in a name, note or reason neither joins two keys nor makes
  // one that can never be confirmed.
  /** @param {Array<string|null>} fields */
  const keyOf = (fields) => (fields.includes(null) ? null : `${name}|${JSON.stringify(fields)}`);
  if (name === "owner_book_appointment") {
    // SCRUM-602: the email and the business's other details are read back too, so a yes
    // to one set never books another. The details are keyed by field, in field order,
    // however the model spaced or ordered them.
    return keyOf([words(args.customer_name), phoneDigits(args.customer_phone), part(args.start), optional(args.service_type_id), optionalWords(args.notes), optionalEmail(args.customer_email), detailsKey(args.details)]);
  }
  if (name === "owner_block_time") return keyOf([part(args.start), part(args.end), optionalWords(args.reason)]);
  if (name === "owner_mark_callback_done") return keyOf([part(args.callback_id), optionalWords(args.note)]);
  const id = part(args.appointment_id);
  if (id === null) return null;
  // SCRUM-598: a yes to "call to confirm" never places a "find a new time" call, and a
  // yes to one window for the new time never places a call with another (security
  // lens F2) — every field the read-back gave is in the key, as new_datetime is for a move.
  if (name === "owner_call_customer") {
    const purpose = part(args.purpose);
    const earliest = optional(args.earliest_date);
    const latest = optional(args.latest_date);
    // "any" constrains nothing, as the website reads it: the same key as no time of day (code lens R2-N2).
    const timeOfDay = args.time_of_day === "any" ? "" : optional(args.time_of_day);
    if (purpose === null || earliest === null || latest === null || timeOfDay === null) return null;
    return `${name}|${id}|${purpose}|${earliest}|${latest}|${timeOfDay}`;
  }
  if (name !== "owner_reschedule_appointment") return `${name}|${id}`;
  const when = part(args.new_datetime);
  return when === null ? null : `${name}|${id}|${when}`;
}

/**
 * Pending read-backs: `at` is Date.now() when PR B's needs_confirmation came
 * back, `seq` the session's assistant turn count at that moment.
 * @param {any} session
 * @returns {Map<string, { at: number, seq: unknown }>}
 */
function pendingConfirmations(session) {
  if (!(session.ownerPendingConfirmations instanceof Map)) session.ownerPendingConfirmations = new Map();
  return session.ownerPendingConfirmations;
}

/**
 * Keys the gate has refused a confirm for, each mapped to whether PR B's
 * read-back has re-armed it since — so a refusal after that re-arm can page.
 * @param {any} session
 * @returns {Map<string, boolean>}
 */
function confirmRefusals(session) {
  if (!(session.ownerConfirmRefusals instanceof Map)) session.ownerConfirmRefusals = new Map();
  return session.ownerConfirmRefusals;
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isStamp(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Has the owner answered THIS read-back? server.js (Task 10, lib/owner-turn-
 * stamps.js) stamps the session: `assistantTurnSeq` + `lastAssistantTurnAt`
 * when an assistant turn that produced audio completes or is interrupted,
 * `lastAssistantSpeechAt` on assistant audio, `lastOwnerSpeechAt` when the
 * owner starts an utterance — all Date.now() based, like the entry. A stamp
 * that is not a finite number refuses.
 * - Exactly one assistant turn since the arm: that turn is the read-back, and
 *   any later turn ("OK, I'll leave it") expires the entry, so a declined
 *   read-back can't be confirmed afterwards.
 * - Assistant audio after the arm: a turn whose only audio came before PR B
 *   handed back the read-back (a filler) was not the read-back.
 * - The owner spoke after that turn ended (and after the arm itself): a late
 *   transcription, an echo or a barge-in from before the read-back is no
 *   answer. This one alone is "awaiting-speech" — the only verdict a confirm
 *   waits on (CONFIRM_SETTLE_MS).
 * - That utterance hasn't already confirmed another write.
 * @param {any} session
 * @param {{ at: unknown, seq: unknown }|undefined} entry - the pending read-back, if any
 * @returns {"answered"|"awaiting-speech"|"refused"}
 */
function readBackVerdict(session, entry) {
  if (!entry) return "refused";
  const turn = session.assistantTurnSeq;
  const turnEndedAt = session.lastAssistantTurnAt;
  const heardAt = session.lastAssistantSpeechAt;
  const spokeAt = session.lastOwnerSpeechAt;
  const spent = session.ownerConfirmSpentSpeechAt;
  const { at, seq } = entry;
  if (!isStamp(turn) || !isStamp(turnEndedAt) || !isStamp(heardAt) || !isStamp(spokeAt) || !isStamp(seq) || !isStamp(at)) return "refused";
  if (turn !== seq + 1) return "refused";
  if (!(heardAt > at)) return "refused";
  if (!(spokeAt > turnEndedAt)) return "awaiting-speech";
  if (!(spokeAt > at)) return "refused";
  if (spent === undefined || spent === null) return "answered";
  return isStamp(spent) && spokeAt > spent ? "answered" : "refused";
}

/**
 * The structural confirmation gate (security ruling). Only the boolean true is
 * a yes (PR B's own predicate), so any other `confirmed` goes on as false. A
 * write arriving with `confirmed: true` is forwarded unchanged only when PR B
 * handed back a read-back (needs_confirmation) for this exact key and the
 * owner has answered it (readBackVerdict). If the owner's speech is the only
 * thing missing, it re-checks the whole gate every CONFIRM_POLL_MS for up to
 * CONFIRM_SETTLE_MS. The entry and the utterance are spent in the same
 * synchronous step as the passing check — before the executor is awaited —
 * so confirmations Gemini runs in parallel (waiting or not) can't share
 * either. Otherwise it goes on as confirmed:false and PR B answers with the
 * read-back; a key refused again after that re-arm pages (once per call —
 * later ones in that call warn).
 * @param {any} session
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {Array<Record<string, any>>} audit
 * @param {() => number} now - audit clock
 * @returns {Promise<Record<string, any>>} the arguments to forward
 */
async function applyConfirmationGate(session, name, args, audit, now) {
  if (!OWNER_WRITE_TOOL_NAMES.includes(name) || args.confirmed === undefined) return args;
  if (args.confirmed !== true) return { ...args, confirmed: false };
  const key = confirmationKey(name, args);
  const pendingEntry = () => (key === null ? undefined : pendingConfirmations(session).get(key));
  let verdict = readBackVerdict(session, pendingEntry());
  let waited = 0;
  while (verdict === "awaiting-speech" && waited < CONFIRM_SETTLE_MS) {
    await sleep(CONFIRM_POLL_MS);
    waited += CONFIRM_POLL_MS;
    verdict = readBackVerdict(session, pendingEntry());
  }
  if (verdict === "answered" && key !== null) {
    pendingConfirmations(session).delete(key);
    confirmRefusals(session).delete(key); // the re-arm, if any, has been answered
    session.ownerConfirmSpentSpeechAt = session.lastOwnerSpeechAt;
    if (waited > 0) console.log(`[OwnerTools] ${name}: the owner's answer was stamped within ${waited} ms of the confirm — forwarded as confirmed. callSid=${session.callSid}`);
    return args;
  }
  audit.push({ name: "owner_confirm_gate", tool: name, successful: false, at: now() });
  // A first refusal is the model confirming without a read-back, or a "yes"
  // that was never stamped: PR B answers confirmed:false with the read-back
  // again, which re-arms the key. Refused AGAIN after that re-arm, the gate
  // may be turning away a change the owner did confirm (a broken turn clock,
  // as on a pipeline failover) — that pages, ids only.
  // SCRUM-601: once per call. The 27 Oct session paged twice, each time for
  // the model confirming after it talked past its own read-back. The stamps
  // can't tell that apart from a miscounted turn on every pipeline (a
  // filler counted with the confirm looks the same — SF1), so this never
  // guesses: the one page names both, and the call's transcript decides.
  // The owner prompt has the model read back again after any other reply,
  // which is what keeps talk-past refusals rare.
  const reArmed = key !== null && confirmRefusals(session).get(key) === true;
  if (reArmed && session.ownerConfirmGatePaged !== true) {
    session.ownerConfirmGatePaged = true;
    console.error(`[ALERT:error] [OwnerTools] ${name}: a confirmation re-armed by PR B's read-back was refused again — the gate may be blocking a change the owner confirmed, or the model confirmed after talking past its read-back; the call's transcript tells which (org=${session.organizationId}, callSid=${session.callSid})`);
  } else if (reArmed) {
    console.warn(`[OwnerTools] ${name}: a confirmation re-armed by PR B's read-back was refused again — this call has paged already. callSid=${session.callSid}`);
  } else {
    console.warn(`[OwnerTools] ${name} came with confirmed=true but no read-back of that change has been answered by the owner — forwarded as confirmed=false. callSid=${session.callSid}`);
  }
  if (key !== null) confirmRefusals(session).set(key, false);
  return { ...args, confirmed: false };
}

/**
 * The change itself, from PR B's success message: everything before its
 * not-notified sentence (else the first line), at most DETAIL_MAX characters.
 * @param {unknown} message
 */
function changeDetail(message) {
  const line = String(message || "").trim().split(/\r?\n/)[0].trim();
  const cut = line.search(CONTACT_SENTENCE);
  const chars = Array.from(cut > 0 ? line.slice(0, cut) : line);
  return chars.length > DETAIL_MAX ? `${chars.slice(0, DETAIL_MAX - 1).join("")}…` : chars.join("");
}

/**
 * A write's change, plus what happened to the customer when PR B's data says
 * ("Cancelled Bob's job on Friday at 3 PM — customer not told").
 * @param {unknown} message
 * @param {string} fallback
 * @param {unknown} data
 */
function writeDetail(message, fallback, data) {
  const detail = changeDetail(message) || fallback;
  const contact = contactSummary(data);
  return contact ? `${detail.replace(/[.!?]+$/, "")}${contact}` : detail;
}

/**
 * SCRUM-598: a call placed to a customer, from PR B's data ("Called Jane Smith to
 * confirm Wednesday, October 28 at 2:30 PM"). PR B's values are already one capped line.
 * @param {unknown} data
 */
function callDetail(data) {
  const d = data && typeof data === "object" ? /** @type {any} */ (data) : {};
  const who = typeof d.customer_name === "string" && d.customer_name ? d.customer_name : "a customer";
  const when = typeof d.when === "string" && d.when ? ` ${d.when}` : " their booking";
  // PR B's data, read at runtime: a purpose this side doesn't know is said plainly, never guessed.
  const why = d.purpose === "find_new_time" ? `to find a new time for${when}` : d.purpose === "confirm" ? `to confirm${when}` : `about${when}`;
  const line = Array.from(`Called ${who} ${why}`);
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1).join("")}…` : line.join("");
}

/**
 * What this call did, in the owner's terms — null for calls the summary ignores.
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {string} message - the tool's own message (PR B's, for a write)
 * @param {boolean} successful
 * @param {unknown} [data] - the tool's data (PR B's, for a write: customer_contact)
 * @returns {string|null}
 */
function describeOwnerToolCall(name, args, message, successful, data) {
  if (!successful) return null;
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "owner_list_appointments":
      if (a.range === "date") {
        // The model's own text goes into the stored summary only as a real YYYY-MM-DD.
        const d = typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : null;
        return d ? `Checked jobs on ${d}` : "Checked jobs on a date";
      }
      return `Checked ${RANGE_LABEL.get(a.range) || "the jobs"}`;
    case "owner_list_messages":
      return "Checked messages";
    case "owner_reschedule_appointment":
      return writeDetail(message, "Moved a job", data);
    case "owner_cancel_appointment":
      return writeDetail(message, "Cancelled a job", data);
    case "owner_call_customer":
      return callDetail(data);
    // SCRUM-599: PR B's success line (one capped line of its own values), plus what
    // happened to the customer for a booking.
    case "owner_book_appointment":
      return writeDetail(message, "Booked a job", data);
    case "owner_block_time":
      return changeDetail(message) || "Blocked out time";
    case "owner_mark_callback_done":
      return changeDetail(message) || "Marked a callback done";
    default:
      return null;
  }
}

/**
 * Gemini cancels the tool calls the owner talks over (toolCallCancellation;
 * server.js hands the ids here). A write whose id is recorded is never sent;
 * one already on its way gets its real result told to the model, which has
 * dropped the function response and would answer as if nothing changed.
 * @param {any} session
 * @param {unknown} ids
 */
function noteCancelledOwnerToolCalls(session, ids) {
  if (!session || session.ownerMode !== true || !Array.isArray(ids)) return;
  if (!(session.ownerCancelledToolCallIds instanceof Set)) session.ownerCancelledToolCallIds = new Set();
  for (const id of ids) if (typeof id === "string" && id) session.ownerCancelledToolCallIds.add(id);
}

/**
 * @param {any} session
 * @param {string|null} id - the model's tool call id (Gemini's; the classic loop passes none)
 */
function wasCancelled(session, id) {
  return id !== null && session.ownerCancelledToolCallIds instanceof Set && session.ownerCancelledToolCallIds.has(id);
}

/**
 * The session's owner tool calls still running (lazily created).
 * @param {any} session
 * @returns {Set<Promise<unknown>>}
 */
function ownerToolRunsInFlight(session) {
  if (!(session.ownerToolRunsInFlight instanceof Set)) session.ownerToolRunsInFlight = new Set();
  return session.ownerToolRunsInFlight;
}

/**
 * Run one model tool call of an owner session. Every call is tracked on the
 * session while it runs, so cleanup can let one the owner hung up on land
 * before it writes the call's summary (settleOwnerToolRuns).
 * @param {any} session - CallSession with ownerMode === true (set only from a PIN-verified stream token)
 * @param {{ id?: string, name: string, args?: Record<string, any> }} toolCall - `id`: the model's call id (Gemini), for cancellations
 * @param {{ executeToolCall: Function, scheduleCache: { invalidate: (orgId: string) => void }, now?: () => number, sendText?: (text: string) => void }} deps
 *   `now` stamps the audit entries (default Date.now); `sendText` tells the model something mid-call
 *   (the Gemini session's), used when a write it cancelled had already gone out.
 * @returns {Promise<{ message: string, data?: unknown, __endCall?: true }>} the WHOLE result the model
 *   gets (message + PR B's data) — gemini-live.js sends the object, the classic loop JSON-encodes it.
 */
async function runOwnerToolCall(session, toolCall, deps) {
  const run = runOneOwnerToolCall(session, toolCall, deps);
  const runs = ownerToolRunsInFlight(session);
  runs.add(run);
  try {
    return await run;
  } finally {
    runs.delete(run);
  }
}

/**
 * Cleanup's wait for the owner tool calls still running when the call ends:
 * until they all finish (calls started meanwhile included) or timeoutMs
 * passes. Then the session is marked settled — a confirmed write that
 * finishes after this missed the stored summary, and pages.
 * @param {any} session
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function settleOwnerToolRuns(session, timeoutMs = OWNER_CLEANUP_WAIT_MS) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const budget = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
  try {
    for (;;) {
      const runs = session.ownerToolRunsInFlight instanceof Set ? [...session.ownerToolRunsInFlight] : [];
      if (!runs.length) break;
      const outcome = await Promise.race([Promise.allSettled(runs).then(() => "settled"), budget]);
      if (outcome === "timeout") {
        console.warn(`[OwnerTools] ${runs.length} owner tool call(s) still running ${timeoutMs} ms after the call ended — the summary is written without them (org=${session.organizationId}, callSid=${session.callSid})`);
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    session.ownerToolRunsSettled = true;
  }
}

/**
 * @param {any} session
 * @param {{ id?: string, name: string, args?: Record<string, any> }} toolCall
 * @param {{ executeToolCall: Function, scheduleCache: { invalidate: (orgId: string) => void }, now?: () => number, sendText?: (text: string) => void }} deps
 * @returns {Promise<{ message: string, data?: unknown, __endCall?: true }>}
 */
async function runOneOwnerToolCall(session, toolCall, deps) {
  const { executeToolCall, scheduleCache, now = Date.now } = deps;
  const name = typeof toolCall?.name === "string" ? toolCall.name : "";
  const rawArgs = toolCall?.args;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
  if (!Array.isArray(session.toolCallAudit)) session.toolCallAudit = [];
  const audit = session.toolCallAudit;

  // Authority lives on the session (a PIN-verified stream token), never in
  // how this function was reached: a wiring slip must not hand a customer
  // session the owner tools.
  if (session.ownerMode !== true) {
    console.error(`[ALERT:error] [OwnerTools] owner tool path reached by a session that is not an owner session — refused ${safeToolName(name)}. callSid=${session.callSid}`);
    return { message: NOT_AN_OWNER_CALL_MESSAGE };
  }

  if (!OWNER_ALLOWED_TOOL_NAMES.has(name)) {
    // Not declared to the model, so only a hallucinated name lands here.
    const tool = safeToolName(name);
    console.warn(`[OwnerTools] Blocked non-owner tool ${tool}. callSid=${session.callSid}`);
    audit.push({ name: "owner_tool_blocked", successful: false, at: now(), tool });
    return modelOnly(`${tool} isn't available on an owner call. Use the owner tools, or tell the owner what you can't do on this call.`);
  }

  if (name !== "end_call") {
    session.ownerToolCalls = (Number.isInteger(session.ownerToolCalls) ? session.ownerToolCalls : 0) + 1;
    if (session.ownerToolCalls > OWNER_MAX_TOOL_CALLS) {
      // The first call over the cap pages (ids only): from here on the owner
      // can't do anything more on this call. Later ones only warn.
      if (session.ownerToolCalls === OWNER_MAX_TOOL_CALLS + 1) {
        console.error(`[ALERT:error] [OwnerTools] owner tool cap (${OWNER_MAX_TOOL_CALLS}) hit — no more owner tools on this call (org=${session.organizationId}, callSid=${session.callSid})`);
      } else {
        console.warn(`[OwnerTools] Tool cap (${OWNER_MAX_TOOL_CALLS}) reached. callSid=${session.callSid}`);
      }
      audit.push({ name: "owner_tool_cap", successful: false, at: now() });
      return modelOnly("TOOL LIMIT REACHED for this call. Do not call any more tools. Tell the owner you've hit the limit for this call and they can ring back for anything else, then say goodbye and call end_call.");
    }
  }

  // No call record (its insert failed) ⇒ the executor would send no callId and
  // PR B would refuse every owner_* call with a 403 and a false security page.
  // The fault is ours: say so once per call, and spare PR B the requests.
  if (OWNER_TOOL_NAMES.includes(name) && !session.callRecordId) {
    if (!noCallRecordAlerted.has(session)) {
      noCallRecordAlerted.add(session);
      console.error(`[ALERT:error] [OwnerTools] owner call has no call record — the owner tools are unavailable for the rest of this call (org=${session.organizationId}, callSid=${session.callSid})`);
    }
    audit.push({ name, successful: false, at: now(), ownerDetail: null });
    return { message: NO_CALL_RECORD_MESSAGE };
  }

  // A write the owner talked over (Gemini cancelled it) is never sent — checked
  // again after the gate, whose settle wait is exactly when a barge-in lands.
  const callId = typeof toolCall?.id === "string" && toolCall.id ? toolCall.id : null;
  const isWrite = OWNER_WRITE_TOOL_NAMES.includes(name);
  const refuseCancelled = () => {
    console.warn(`[OwnerTools] ${name} was cancelled (the owner talked over it) before it went out — not sent. callSid=${session.callSid}`);
    audit.push({ name: "owner_tool_cancelled", tool: name, successful: false, at: now() });
    return modelOnly(CANCELLED_BEFORE_SENT_MESSAGE);
  };
  if (isWrite && wasCancelled(session, callId)) return refuseCancelled();
  const forwardArgs = await applyConfirmationGate(session, name, args, audit, now);
  if (isWrite && wasCancelled(session, callId)) return refuseCancelled();

  /** @type {unknown} */
  let result;
  try {
    result = await executeToolCall(name, forwardArgs, {
      organizationId: session.organizationId,
      assistantId: session.assistantId,
      callSid: session.callSid,
      callId: session.callRecordId,
      organization: session.organization,
      callerPhone: session.callerPhone,
      orgPhoneNumber: session.orgPhoneNumber,
      telephonyProvider: session.telephonyProvider || "twilio",
      ownerMode: true,
    });
  } catch (err) {
    console.error(`[ALERT:error] [OwnerTools] ${name} threw (org=${session.organizationId}, callSid=${session.callSid}): ${messageOf(err)}`);
    result = undefined; // an empty result: failed, owner-worded below
  }

  const r = asResult(result);
  const successful = ownerResultSucceeded(name, r);
  // A confirmed write whose answer never came back (no data: a throw, a
  // timeout, a non-2xx) may still have gone through: the summary says so
  // instead of "no changes made". An unconfirmed one can't have changed anything.
  const outcomeUnknown = OWNER_WRITE_TOOL_NAMES.includes(name) && forwardArgs.confirmed === true && !successful
    && r.data === undefined && (failedInTransit(r) || r.message === WRITE_UNCONFIRMED_MESSAGE);
  audit.push({ name, successful, at: now(), ownerDetail: describeOwnerToolCall(name, forwardArgs, r.message, successful, r.data), ...(outcomeUnknown && { outcomeUnknown: true }) });
  if (session.ownerToolRunsSettled === true && OWNER_WRITE_TOOL_NAMES.includes(name) && forwardArgs.confirmed === true) {
    // The owner hung up and cleanup stopped waiting: the stored summary does not have this.
    console.error(`[ALERT:error] [OwnerTools] ${name} finished after the call record was completed — outcome=${outcomeUnknown ? "unknown" : outcomeLabel(outcomeOf(r))} is not in the stored summary (org=${session.organizationId}, callSid=${session.callSid})`);
  }

  // Gemini cancelled this call while it was out: it dropped the response, so it
  // never heard this read-back — and a confirmed change it would think undone
  // is told to it (tool name and outcome code only: PR B's prose quotes customers).
  const cancelledInFlight = isWrite && wasCancelled(session, callId);
  if (cancelledInFlight && forwardArgs.confirmed === true && (successful || outcomeUnknown)) {
    const outcome = outcomeUnknown ? "unknown" : outcomeLabel(outcomeOf(r));
    const notice = successful
      ? `SYSTEM NOTICE (not the owner speaking): the ${name} call that was interrupted had already gone through — data.outcome is "${outcome}", so ${inFlightWhat(name, r.data)}. Tell the owner it went through.`
      : `SYSTEM NOTICE (not the owner speaking): the ${name} call that was interrupted had already been sent and its result never came back, so it may have gone through. Tell the owner, and ${inFlightUnknownAdvice(name)}.`;
    try {
      if (typeof deps.sendText !== "function") throw new Error("no way to reach the model");
      deps.sendText(notice);
      console.warn(`[OwnerTools] ${name} was cancelled after it had gone out (outcome=${outcome}) — told the model the real result. callSid=${session.callSid}`);
    } catch (err) {
      console.error(`[ALERT:error] [OwnerTools] ${name} was cancelled after it had gone out (outcome=${outcome}) and the model could not be told — the owner may think nothing changed (org=${session.organizationId}, callSid=${session.callSid}): ${messageOf(err)}`);
    }
  }

  if (OWNER_WRITE_TOOL_NAMES.includes(name) && outcomeOf(r) === "needs_confirmation" && !cancelledInFlight) {
    const key = confirmationKey(name, forwardArgs);
    if (key !== null) {
      pendingConfirmations(session).set(key, { at: Date.now(), seq: session.assistantTurnSeq });
      // A key the gate refused is re-armed by this read-back (see applyConfirmationGate).
      if (confirmRefusals(session).has(key)) confirmRefusals(session).set(key, true);
    }
  }

  // A real change frees/takes a slot that OTHER sessions for this org may have
  // pre-loaded — owner sessions carry no snapshot themselves. The change has
  // happened either way, so a cache fault must not keep it from the model.
  if (successful && OWNER_CHANGE_TOOL_NAMES.includes(name) && session.organizationId) {
    try {
      scheduleCache.invalidate(session.organizationId);
    } catch (err) {
      console.error(`[ALERT:error] [OwnerTools] schedule-cache invalidation failed after ${name} — other calls may offer stale times (org=${session.organizationId}, callSid=${session.callSid}): ${messageOf(err)}`);
    }
  }

  /** @type {{ message: string, data?: unknown, __endCall?: true }} */
  const ret = { message: ownerFacingMessage(name, r, successful) };
  if (r.data !== undefined) ret.data = r.data;
  if (r.__endCall === true) ret.__endCall = true;
  return ret;
}

/**
 * SF5: the classic loop's reply when an owner turn uses up its tool rounds
 * (OWNER_MAX_TOOL_ROUNDS) — never the receptionist's "could you repeat that?",
 * which after a change invites a second, duplicate request. The owner hears
 * the last owner tool's own message (a cancel's result, say), unless it was
 * written for the model (PR B's read-back request, the cap, a refusal): then a
 * plain line. Logged at error level when that last call was a successful
 * write — the owner heard the change only through this fallback.
 * @param {any} session
 * @param {{ name: string, ret: { message: string, data?: any } } | null} last - the turn's last owner tool call
 * @returns {string}
 */
function ownerToolLoopReply(session, last) {
  const ret = last ? last.ret : null;
  const speakable = Boolean(ret) && typeof ret.message === "string" && ret.message.trim() !== ""
    && !modelOnlyReplies.has(ret) && outcomeOf(ret) !== "needs_confirmation";
  const wroteChange = Boolean(last) && OWNER_WRITE_TOOL_NAMES.includes(last.name) && ownerResultSucceeded(last.name, ret);
  if (wroteChange) {
    console.error(`[OwnerTools] the classic tool loop ran out (${OWNER_MAX_TOOL_ROUNDS} rounds) right after a successful ${last.name} — the owner heard its result, not a model reply (org=${session.organizationId}, callSid=${session.callSid})`);
  } else {
    console.warn(`[OwnerTools] the classic tool loop ran out (${OWNER_MAX_TOOL_ROUNDS} rounds) — the owner heard ${speakable ? "the last tool's message" : "the fallback line"}. callSid=${session.callSid}`);
  }
  return speakable ? ret.message : LOOP_EXHAUSTED_MESSAGE;
}

/**
 * Deterministic post-call summary (no LLM): successful, described calls in
 * order, consecutive repeats collapsed — and, when a confirmed change's result
 * never came back, that it could not be confirmed (never "no changes made").
 * @param {Array<{ successful?: boolean, ownerDetail?: string|null, outcomeUnknown?: boolean }>|undefined} audit
 * @returns {string}
 */
function buildOwnerCallSummary(audit) {
  /** @type {string[]} */
  const parts = [];
  let unconfirmed = false;
  for (const e of Array.isArray(audit) ? audit : []) {
    if (e && e.outcomeUnknown === true) unconfirmed = true;
    if (!e || !e.successful || !e.ownerDetail) continue;
    const detail = String(e.ownerDetail).replace(/[.!?]+$/, "");
    if (parts[parts.length - 1] !== detail) parts.push(detail);
  }
  if (unconfirmed) parts.push(UNCONFIRMED_CHANGE_SUMMARY);
  return parts.length ? `Owner call: ${parts.join("; ")}.` : "Owner call: no changes made.";
}

module.exports = {
  OWNER_MAX_TOOL_CALLS,
  OWNER_MAX_TOOL_ROUNDS,
  CANCELLED_BEFORE_SENT_MESSAGE,
  LOOP_EXHAUSTED_MESSAGE,
  CONFIRM_SETTLE_MS,
  CONFIRM_POLL_MS,
  OWNER_CLEANUP_WAIT_MS,
  runOwnerToolCall,
  settleOwnerToolRuns,
  noteCancelledOwnerToolCalls,
  ownerToolLoopReply,
  buildOwnerCallSummary,
  describeOwnerToolCall,
  ownerResultSucceeded,
};
