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
 *   since, and the owner spoke after that turn, with an utterance that hasn't
 *   already confirmed another write. Anything else is sent on as
 *   confirmed:false, which makes PR B answer with the read-back again.
 * - Owner wording for failures. The shared executor's receptionist lines (the
 *   "take your information" callback offer, the "give me a moment" stall) are
 *   never said to the owner, and nothing without its result counts as done.
 * - PR B's data is the verdict. Its messages quote customer-written text, so
 *   prose is only ever judged on a result that came back without data.
 *
 * Logs carry tool names, ids of the call and outcome codes only — never tool
 * arguments, customer text or results.
 */
const { OWNER_TOOL_NAMES, OWNER_WRITE_TOOL_NAMES, OWNER_ALLOWED_TOOL_NAMES, OWNER_SUCCESS_OUTCOMES } = require("./owner-tools");

const OWNER_MAX_TOOL_CALLS = 10;

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
 * PR B ends every successful write's message with this sentence (NOT_NOTIFIED
 * in src/lib/owner-assistant/tool-handlers.ts); the change is what precedes it.
 * Cutting there, not at the first full stop, keeps "Dr. Jane Smith" whole.
 */
const NOT_NOTIFIED_SENTENCE = /\s+The customer has NOT been notified\b/i;
/** Fits PR B's longest success line (an 80-character name and two spoken times). */
const DETAIL_MAX = 200;

const RANGE_LABEL = new Map([
  ["today", "today's jobs"],
  ["tomorrow", "tomorrow's jobs"],
  ["this_week", "this week's jobs"],
]);

/** Owner sessions whose missing call record has already been alerted on (one alert per call). */
const noCallRecordAlerted = new WeakSet();

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
 * The pending-confirmation key: `tool|appointment_id`, plus `|new_datetime`
 * for a reschedule. null when a part is not a non-empty string or contains
 * "|" — such a call can never be confirmed, and the key stays unambiguous.
 * @param {string} name
 * @param {Record<string, any>} args
 * @returns {string|null}
 */
function confirmationKey(name, args) {
  /** @param {unknown} v */
  const part = (v) => (typeof v === "string" && v !== "" && !v.includes("|") ? v : null);
  const id = part(args.appointment_id);
  if (id === null) return null;
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
 * @param {unknown} v
 * @returns {v is number}
 */
function isStamp(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Has the owner answered THIS read-back? server.js (Task 10) stamps the session:
 * `assistantTurnSeq` + `lastAssistantTurnAt` when an assistant turn completes
 * or is interrupted, `lastOwnerSpeechAt` when the owner speaks — all Date.now()
 * based, like the entry. A stamp that is not a finite number refuses.
 * - Exactly one assistant turn since the arm: that turn is the read-back, and
 *   any later turn ("OK, I'll leave it") expires the entry, so a declined
 *   read-back can't be confirmed afterwards.
 * - The owner spoke after that turn ended (and after the arm itself): a late
 *   transcription, an echo or a barge-in from before the read-back is no answer.
 * - That utterance hasn't already confirmed another write.
 * @param {any} session
 * @param {{ at: unknown, seq: unknown }} entry
 * @returns {boolean}
 */
function readBackAnswered(session, entry) {
  const turn = session.assistantTurnSeq;
  const turnEndedAt = session.lastAssistantTurnAt;
  const spokeAt = session.lastOwnerSpeechAt;
  const spent = session.ownerConfirmSpentSpeechAt;
  const { at, seq } = entry;
  if (!isStamp(turn) || !isStamp(turnEndedAt) || !isStamp(spokeAt) || !isStamp(seq) || !isStamp(at)) return false;
  if (turn !== seq + 1) return false;
  if (!(spokeAt > turnEndedAt && spokeAt > at)) return false;
  if (spent === undefined || spent === null) return true;
  return isStamp(spent) && spokeAt > spent;
}

/**
 * The structural confirmation gate (security ruling). Only the boolean true is
 * a yes (PR B's own predicate), so any other `confirmed` goes on as false. A
 * write arriving with `confirmed: true` is forwarded unchanged only when PR B
 * handed back a read-back (needs_confirmation) for this exact key and the
 * owner has answered it (readBackAnswered). The entry and the utterance are
 * spent before the executor is awaited, so confirmations Gemini runs in
 * parallel can't share either. Otherwise it goes on as confirmed:false and PR
 * B answers with the read-back.
 * @param {any} session
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {Array<Record<string, any>>} audit
 * @param {() => number} now - audit clock
 * @returns {Record<string, any>} the arguments to forward
 */
function applyConfirmationGate(session, name, args, audit, now) {
  if (!OWNER_WRITE_TOOL_NAMES.includes(name) || args.confirmed === undefined) return args;
  if (args.confirmed !== true) return { ...args, confirmed: false };
  const pending = pendingConfirmations(session);
  const key = confirmationKey(name, args);
  const entry = key === null ? undefined : pending.get(key);
  if (key !== null && entry && readBackAnswered(session, entry)) {
    pending.delete(key);
    session.ownerConfirmSpentSpeechAt = session.lastOwnerSpeechAt;
    return args;
  }
  audit.push({ name: "owner_confirm_gate", tool: name, successful: false, at: now() });
  console.warn(`[OwnerTools] ${name} came with confirmed=true but no read-back of that change has been answered by the owner — forwarded as confirmed=false. callSid=${session.callSid}`);
  return { ...args, confirmed: false };
}

/**
 * The change itself, from PR B's success message: everything before its
 * not-notified sentence (else the first line), at most DETAIL_MAX characters.
 * @param {unknown} message
 */
function changeDetail(message) {
  const line = String(message || "").trim().split(/\r?\n/)[0].trim();
  const cut = line.search(NOT_NOTIFIED_SENTENCE);
  const chars = Array.from(cut > 0 ? line.slice(0, cut) : line);
  return chars.length > DETAIL_MAX ? `${chars.slice(0, DETAIL_MAX - 1).join("")}…` : chars.join("");
}

/**
 * What this call did, in the owner's terms — null for calls the summary ignores.
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {string} message - the tool's own message (PR B's, for a write)
 * @param {boolean} successful
 * @returns {string|null}
 */
function describeOwnerToolCall(name, args, message, successful) {
  if (!successful) return null;
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "owner_list_appointments":
      if (a.range === "date" && typeof a.date === "string" && a.date) return `Checked jobs on ${a.date.slice(0, 10)}`;
      return `Checked ${RANGE_LABEL.get(a.range) || "the jobs"}`;
    case "owner_list_messages":
      return "Checked messages";
    case "owner_reschedule_appointment":
      return changeDetail(message) || "Moved a job";
    case "owner_cancel_appointment":
      return changeDetail(message) || "Cancelled a job";
    default:
      return null;
  }
}

/**
 * Run one model tool call of an owner session.
 * @param {any} session - CallSession with ownerMode === true (set only from a PIN-verified stream token)
 * @param {{ name: string, args?: Record<string, any> }} toolCall
 * @param {{ executeToolCall: Function, scheduleCache: { invalidate: (orgId: string) => void }, now?: () => number }} deps
 *   `now` stamps the audit entries (default Date.now).
 * @returns {Promise<{ message: string, data?: unknown, __endCall?: true }>} the WHOLE result the model
 *   gets (message + PR B's data) — gemini-live.js sends the object, the classic loop JSON-encodes it.
 */
async function runOwnerToolCall(session, toolCall, deps) {
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
    return { message: `${tool} isn't available on an owner call. Use the owner tools, or tell the owner what you can't do on this call.` };
  }

  if (name !== "end_call") {
    session.ownerToolCalls = (Number.isInteger(session.ownerToolCalls) ? session.ownerToolCalls : 0) + 1;
    if (session.ownerToolCalls > OWNER_MAX_TOOL_CALLS) {
      console.warn(`[OwnerTools] Tool cap (${OWNER_MAX_TOOL_CALLS}) reached. callSid=${session.callSid}`);
      audit.push({ name: "owner_tool_cap", successful: false, at: now() });
      return { message: "TOOL LIMIT REACHED for this call. Do not call any more tools. Tell the owner you've hit the limit for this call and they can ring back for anything else, then say goodbye and call end_call." };
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

  const forwardArgs = applyConfirmationGate(session, name, args, audit, now);

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
  audit.push({ name, successful, at: now(), ownerDetail: describeOwnerToolCall(name, forwardArgs, r.message, successful) });

  if (OWNER_WRITE_TOOL_NAMES.includes(name) && outcomeOf(r) === "needs_confirmation") {
    const key = confirmationKey(name, forwardArgs);
    if (key !== null) pendingConfirmations(session).set(key, { at: Date.now(), seq: session.assistantTurnSeq });
  }

  // A real change frees/takes a slot that OTHER sessions for this org may have
  // pre-loaded — owner sessions carry no snapshot themselves. The change has
  // happened either way, so a cache fault must not keep it from the model.
  if (successful && OWNER_WRITE_TOOL_NAMES.includes(name) && session.organizationId) {
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
 * Deterministic post-call summary (no LLM): successful, described calls in
 * order, consecutive repeats collapsed.
 * @param {Array<{ successful?: boolean, ownerDetail?: string|null }>|undefined} audit
 * @returns {string}
 */
function buildOwnerCallSummary(audit) {
  /** @type {string[]} */
  const parts = [];
  for (const e of Array.isArray(audit) ? audit : []) {
    if (!e || !e.successful || !e.ownerDetail) continue;
    const detail = String(e.ownerDetail).replace(/[.!?]+$/, "");
    if (parts[parts.length - 1] !== detail) parts.push(detail);
  }
  return parts.length ? `Owner call: ${parts.join("; ")}.` : "Owner call: no changes made.";
}

module.exports = { OWNER_MAX_TOOL_CALLS, runOwnerToolCall, buildOwnerCallSummary, describeOwnerToolCall, ownerResultSucceeded };
