"use strict";

/**
 * SCRUM-594 PHASE 2: the fast path's booking guards (B2–B4).
 *
 * The phone tests and the simulated-call baseline (scripts/sim-calls) showed
 * the fast path's Claude booking surnames exactly as the STT heard them —
 * "Curry" for "Khoury" — without ever spelling them back, booking a second
 * appointment where the caller wanted the first one moved, and taking four
 * confirmations to cancel. These are the server-side rules for that, read off
 * the never-windowed transcript (`session.fullTranscriptMessages`):
 *
 *  - B2 spelling: book_appointment is held until the AI has read the surname
 *    back letter by letter and the caller said yes (at most SPELLING_HOLD_CAP
 *    holds a call, so a misread "yes" can never strand a booking).
 *  - B3 second booking: while this call holds a booking, a booking at another
 *    time is redirected to reschedule_appointment once.
 *  - B4 cancel: an explicit "cancel <this>?" the caller said yes to counts as
 *    the CancelGate's confirmation (call-session.js#confirmCancel).
 *  - B5 hang-up: end_call waits until the caller has said goodbye or that
 *    they're done (at most END_CALL_HOLD_CAP holds a call) — the simulated
 *    calls hung up on "Yep, that's all correct. Thanks." with more to ask.
 *  - B6 own booking: a reschedule or cancel of a booking THIS call made carries
 *    the name it was booked under, so the booking system never asks the caller
 *    for it again (phone test F1: "Sorry?" was heard as "Deville" and the move
 *    was refused).
 *
 * Only sessions with `bookingGuards` set get any of this (server.js
 * applyFastConversationSettings): Gemini, classic and owner calls are untouched.
 */

/** How many times one call's bookings are held for spelling before the guard steps aside. */
const SPELLING_HOLD_CAP = 2;
/** How many times one call's end_call is held for a goodbye before the guard steps aside. */
const END_CALL_HOLD_CAP = 2;

/** Two or more single letters with separators, as a model or a caller spells a word aloud. */
const SPELLED_RUN = /(^|[^\p{L}'’])(\p{L}(?:[\s,.\-–—]+\p{L}(?!\p{L}))+)/gu;
/** Dotted abbreviations that look like spelled letters ("9 a.m.", "e.g."). */
const ABBREVIATION = /\b(?:a\.\s?m|p\.\s?m|e\.\s?g|i\.\s?e)\b\.?/gi;

/**
 * Spelled-out letter runs in a text — "K-H-O-U-R-Y", "K, H, O, U, R, Y",
 * "K h o u r y." — as uppercase strings, in order.
 * @param {unknown} text
 * @returns {string[]}
 */
function spelledRuns(text) {
  if (typeof text !== "string" || !text) return [];
  const runs = [];
  for (const m of text.replace(ABBREVIATION, " ").matchAll(SPELLED_RUN)) {
    const letters = (m[2].match(/\p{L}/gu) || []).join("").toUpperCase();
    if (letters.length >= 2) runs.push(letters);
  }
  return runs;
}

/**
 * A surname's letters as they are spelled aloud: A–Z only, accents folded,
 * hyphens and apostrophes dropped. Empty when the name has letters outside
 * A–Z (another script): there is nothing the caller could confirm letter by letter.
 * @param {unknown} surname
 * @returns {string}
 */
function spellableLetters(surname) {
  if (typeof surname !== "string") return "";
  const folded = surname.normalize("NFD").replace(/\p{M}/gu, "");
  if (/[^A-Za-z\s'’.\-]/.test(folded)) return "";
  return folded.replace(/[^A-Za-z]/g, "").toUpperCase();
}

const LEADING_NEGATIVE = /^\W*(no|nope|nah|not|wrong|wait|hang on|hold on)\b/i;
const NEGATIVE_ANYWHERE = /\b(nah|wrong|incorrect|not (?:right|correct|quite)|isn'?t (?:right|correct)|that'?s not)\b/i;
const POSITIVE = /\b(yes|yeah|yep|yup|yea|correct|right|exactly|perfect|spot on|that'?s it|you got it|sounds good|good|sure|absolutely|definitely|okay|ok|uh[- ]?huh|mm[- ]?hmm)\b/i;

/**
 * Does the caller's reply say yes to what was just read back?
 * @param {unknown} text
 * @returns {boolean}
 */
function isAffirmative(text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t || LEADING_NEGATIVE.test(t) || NEGATIVE_ANYWHERE.test(t)) return false;
  return POSITIVE.test(t);
}

/** A short "is that right?" after a read-back — not a question about something else. */
const GENERIC_CHECK = /\b(right|correct|yes|ok(?:ay)?|spelled|spelling)\b/i;

/**
 * Does this AI message ask the caller to check `target`'s spelling? Its LAST
 * question must be the spelling (contain the letters) or a short generic check
 * ("Is that right?"); a read-back with no question at all counts too. A read-back
 * followed by another question ("…K-H-O-U-R-Y. And is the best mobile…?") does
 * not: the caller's "yep" answers that question.
 * @param {string} content
 * @param {string} target - spellableLetters(surname)
 * @returns {boolean}
 */
function asksToCheckSpelling(content, target) {
  const questions = content.match(/[^.!?]*\?/g) || [];
  if (questions.length === 0) return true;
  const last = questions[questions.length - 1];
  if (spelledRuns(last).includes(target)) return true;
  return last.trim().split(/\s+/).length <= 6 && GENERIC_CHECK.test(last);
}

/**
 * Has `surname` been spelled back to the caller and confirmed? The LATEST
 * read-back of exactly these letters decides, by the caller's next words.
 * @param {Array<{ role: string, content: unknown }>} transcript - session.fullTranscriptMessages
 * @param {unknown} surname - the last name about to be saved
 * @returns {{ confirmed: boolean, reason: "confirmed" | "not-spellable" | "not-read-back" | "not-asked" | "awaiting-reply" | "caller-respelled" | "not-affirmed" }}
 */
function surnameSpellingConfirmed(transcript, surname) {
  const target = spellableLetters(surname);
  if (target.length < 2) return { confirmed: true, reason: "not-spellable" };
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role !== "assistant" || !spelledRuns(m.content).includes(target)) continue;
    if (!asksToCheckSpelling(String(m.content), target)) return { confirmed: false, reason: "not-asked" };
    const reply = transcript.slice(i + 1).find((x) => x.role === "user");
    if (!reply) return { confirmed: false, reason: "awaiting-reply" };
    const replyRuns = spelledRuns(reply.content);
    if (replyRuns.length > 0 && !replyRuns.includes(target)) return { confirmed: false, reason: "caller-respelled" };
    if (isAffirmative(reply.content) || replyRuns.includes(target)) return { confirmed: true, reason: "confirmed" };
    return { confirmed: false, reason: "not-affirmed" };
  }
  return { confirmed: false, reason: "not-read-back" };
}

/**
 * The tool result for a booking held for spelling: what the model would save,
 * letter by letter, so the caller can say yes or correct it.
 * @param {string} surname
 * @returns {string}
 */
function spellingHoldMessage(surname) {
  const letters = spellableLetters(surname).split("").join("-");
  return `DO NOT BOOK YET. Read the caller's last name back to them letter by letter, exactly as you will save it — for "${surname}" that is ${letters} — and ask "Is that right?" as its own question, with nothing else in that reply. If they correct it, save their spelling. Call book_appointment again only after they say yes.`;
}

/**
 * Did the AI's last words before the caller's last words ask to cancel one
 * thing ("Do you want me to cancel the Monday 9 AM booking?"), and did the
 * caller say yes? A question that offers a choice ("cancel it, or move it?")
 * is not a confirmation.
 * @param {Array<{ role: string, content: unknown }>} transcript - session.fullTranscriptMessages
 * @returns {boolean}
 */
function cancelConfirmedInTranscript(transcript) {
  const last = transcript.length - 1;
  if (last < 1 || transcript[last].role !== "user") return false;
  const asked = transcript[last - 1];
  if (asked.role !== "assistant" || typeof asked.content !== "string") return false;
  const question = asked.content.replace(/\byes or no\b/gi, "");
  if (!/\bcancel/i.test(question) || !question.includes("?")) return false;
  const questions = question.match(/[^.!?]*\?/g) || [];
  if (questions.some((q) => /\bor\b/i.test(q))) return false;
  return isAffirmative(transcript[last].content);
}

/**
 * @typedef {{ spellingHolds: number, secondBookingNudged: boolean, endCallHolds: number }} GuardState
 */

/**
 * The session's guard counters, created on first use.
 * @param {{ bookingGuardState?: Partial<GuardState> }} session
 * @returns {GuardState}
 */
function guardState(session) {
  const state = /** @type {GuardState} */ (session.bookingGuardState ||= {});
  state.spellingHolds ??= 0;
  state.secondBookingNudged ??= false;
  state.endCallHolds ??= 0;
  return state;
}

/**
 * "Monday 19 October, 9:00 AM" for a model-supplied local datetime
 * ("2026-10-19T09:00:00"); the raw value when it isn't one.
 * @param {unknown} datetime
 * @returns {string}
 */
function describeLocal(datetime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(datetime || ""));
  if (!m) return String(datetime || "an earlier time");
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}

/**
 * The fast path's checks on a book_appointment, before it runs. Null lets it
 * through; otherwise the result's message goes back to the model as the tool
 * result and nothing is booked. Counts its own holds on `session.bookingGuardState`.
 *
 * @param {{ bookingGuards?: boolean, bookingGuardState?: Partial<GuardState>, fullTranscriptMessages: Array<{ role: string, content: unknown }>, confirmedBookings?: Map<string, { datetime?: string, name?: string, at?: number }> }} session
 * @param {Record<string, any>} args - the model's book_appointment arguments
 * @param {(args: Record<string, any>) => string} bookingKey - lib/booking-key.js
 * @returns {{ kind: "second-booking" | "spelling", message: string } | null}
 */
function checkBookingGuards(session, args, bookingKey = require("./booking-key").bookingKey) {
  if (!session.bookingGuards) return null;
  const state = guardState(session);
  const a = args || {};

  // B3: this call already holds a booking and the model books another time.
  const held = session.confirmedBookings;
  if (held && held.size > 0 && !held.has(bookingKey(a)) && !state.secondBookingNudged) {
    state.secondBookingNudged = true;
    const existing = [...held.values()].sort((x, y) => (y.at || 0) - (x.at || 0))[0];
    return {
      kind: "second-booking",
      message: `THIS CALLER ALREADY HAS A BOOKING FROM THIS CALL: ${describeLocal(existing.datetime)} for ${existing.name || "them"}. If they want to CHANGE it to the new time, call reschedule_appointment instead (current_datetime "${existing.datetime}", new_datetime "${a.datetime}") — do not book a second appointment. Only if they clearly want a SECOND, separate appointment as well, confirm that with them, then call book_appointment again.`,
    };
  }

  // B2: the surname must have been spelled back and confirmed.
  const surname = typeof a.last_name === "string" && a.last_name.trim()
    ? a.last_name.trim()
    : String(a.name || "").trim().split(/\s+/).slice(1).join(" ");
  if (!surname || state.spellingHolds >= SPELLING_HOLD_CAP) return null;
  if (surnameSpellingConfirmed(session.fullTranscriptMessages, surname).confirmed) return null;
  state.spellingHolds++;
  return { kind: "spelling", message: spellingHoldMessage(surname) };
}

/**
 * The ledger entry (session.confirmedBookings) a reschedule or cancel is about:
 * by its time or date when the model gave one, else the call's only booking.
 * @param {Record<string, any>} args
 * @param {Map<string, { datetime?: string, name?: string }> | undefined} ledger
 * @param {(datetime: unknown) => string} normalizeDatetime - lib/booking-key.js
 * @returns {{ datetime?: string, name?: string } | null}
 */
function ledgerEntryFor(args, ledger, normalizeDatetime) {
  if (!(ledger instanceof Map) || ledger.size === 0) return null;
  const entries = [...ledger.values()];
  const datetime = String(args.current_datetime || args.datetime || "").trim();
  if (datetime) {
    const instant = normalizeDatetime(datetime);
    const hits = entries.filter((e) => normalizeDatetime(e.datetime) === instant);
    return hits.length === 1 ? hits[0] : null;
  }
  const date = String(args.current_date || args.date || "").trim();
  if (date) {
    const hits = entries.filter((e) => typeof e.datetime === "string" && e.datetime.startsWith(date));
    return hits.length === 1 ? hits[0] : null;
  }
  return entries.length === 1 ? entries[0] : null;
}

/**
 * B6: a reschedule or cancel of a booking this call made, with the name it was
 * booked under when the model didn't pass one.
 * @param {Record<string, any>} args
 * @param {Map<string, { datetime?: string, name?: string }> | undefined} ledger - session.confirmedBookings
 * @param {(datetime: unknown) => string} normalizeDatetime - lib/booking-key.js
 * @returns {Record<string, any>} args, or a copy with `name` filled
 */
function withBookedName(args, ledger, normalizeDatetime) {
  const a = args || {};
  if (typeof a.name === "string" && a.name.trim()) return a;
  const entry = ledgerEntryFor(a, ledger, normalizeDatetime);
  return entry && typeof entry.name === "string" && entry.name.trim() ? { ...a, name: entry.name } : a;
}

/**
 * B6: after a successful update_appointment that changed the name, the ledger
 * entry carries the new one (withBookedName must pass what the booking now says).
 * @param {Map<string, { datetime?: string, name?: string }> | undefined} ledger
 * @param {Record<string, any>} args - update_appointment's arguments
 * @param {(datetime: unknown) => string} normalizeDatetime
 */
function noteNameCorrection(ledger, args, normalizeDatetime) {
  const a = args || {};
  const first = typeof a.first_name === "string" ? a.first_name.trim() : "";
  const last = typeof a.last_name === "string" ? a.last_name.trim() : "";
  if (!first && !last) return;
  const entry = ledgerEntryFor(a, ledger, normalizeDatetime);
  if (!entry) return;
  const parts = String(entry.name || "").trim().split(/\s+/);
  const oldFirst = parts[0] || "";
  const oldLast = parts.slice(1).join(" ");
  entry.name = `${first || oldFirst} ${last || oldLast}`.trim();
}

const GOODBYE = /\b(bye|goodbye|see ya|see you|cheers|that'?ll be all|nothing else|all good|all done|i'?m (?:good|fine|done|right|all set)|we'?re (?:good|done|all set)|no thanks|no,? thank you|have a (?:good|great|nice))\b/i;
/** "That's all" closes a call; "that's all correct" answers a read-back. */
const THATS_ALL = /\bthat'?s (?:all|it|everything)\b(?! (?:correct|right|true))/i;
const PLAIN_NO = /^\W*(no|nope|nah|not really)\b/i;

/**
 * B5: has the caller said goodbye, or that they need nothing else?
 * @param {Array<{ role: string, content: unknown }>} transcript - session.fullTranscriptMessages
 * @returns {boolean}
 */
function callerIsDone(transcript) {
  const last = transcript.length - 1;
  if (last < 0 || transcript[last].role !== "user" || typeof transcript[last].content !== "string") return false;
  const said = transcript[last].content;
  if (GOODBYE.test(said) || THATS_ALL.test(said)) return true;
  const asked = transcript[last - 1];
  return Boolean(asked && asked.role === "assistant" && /anything else/i.test(String(asked.content)) && PLAIN_NO.test(said));
}

/**
 * B5: the fast path's check on an end_call the end_call guard allowed. Null
 * lets the call end; otherwise the message goes back to the model as the tool
 * result and the call stays up.
 * @param {{ bookingGuards?: boolean, bookingGuardState?: Partial<GuardState>, fullTranscriptMessages: Array<{ role: string, content: unknown }> }} session
 * @returns {{ allow: false, message: string } | null}
 */
function checkCallerDone(session) {
  if (!session.bookingGuards) return null;
  const state = guardState(session);
  if (state.endCallHolds >= END_CALL_HOLD_CAP || callerIsDone(session.fullTranscriptMessages)) return null;
  state.endCallHolds++;
  return {
    allow: false,
    message: "DON'T END THE CALL YET: the caller hasn't said goodbye or that they're done. Ask if there's anything else you can help with, and end the call only after they say goodbye or that's all.",
  };
}

module.exports = {
  SPELLING_HOLD_CAP,
  END_CALL_HOLD_CAP,
  withBookedName,
  noteNameCorrection,
  callerIsDone,
  checkCallerDone,
  spelledRuns,
  spellableLetters,
  isAffirmative,
  surnameSpellingConfirmed,
  spellingHoldMessage,
  cancelConfirmedInTranscript,
  checkBookingGuards,
};
