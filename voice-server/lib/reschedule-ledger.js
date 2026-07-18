/**
 * SCRUM-563: keep the per-call confirmedBookings ledger truthful across
 * reschedules.
 *
 * The ledger (see lib/booking-key.js for the key design) is written by
 * book_appointment and cleared by cancel_appointment, but a successful
 * reschedule_appointment used to leave it untouched. After a time-move the
 * OLD slot's entry kept vouching for a freed slot: RebookGuard then refused
 * a legitimate re-book at the old time with "already booked... LOCKED" for
 * the rest of the call — the model believes the guard, so the caller simply
 * cannot get that slot back.
 *
 * The fix is a MOVE: delete the entry at the old instant, insert one keyed on
 * the new datetime, carrying the confirmation code and folding in whatever
 * the reschedule changed (name spelling, practitioner). Matching is anchored
 * on the INSTANT, not the name — SCRUM-514's lesson is that the model
 * respells names mid-call, so a name-required match would strand a stale
 * entry in exactly the flow this module exists to fix. The name only breaks
 * ties when two entries share an instant (two attendees booked at the same
 * minute in one call — near-impossible, see booking-key.js); when it can't,
 * we move nothing: a stale entry is the pre-existing failure mode, corrupting
 * another attendee's entry would be a new one.
 *
 * A reschedule that matches nothing (an appointment booked on a PREVIOUS
 * call) is a deliberate no-op — the ledger only ever tracked this call's
 * bookings, and inserting one would flip the SUCCESS-FLAG live-outcome
 * heuristic in cleanupSession for calls that merely moved an old booking.
 */

const { bookingKey, normalizeName, normalizeDatetime } = require("./booking-key");

/**
 * Positive success signal for a reschedule result that carries NO structured
 * `success` boolean. The real internal-API handler returns `success` on every
 * business path, so a structured-less result is either the test-mode simulated
 * success ("Done — I've moved your appointment…") or one of the tool-executor
 * INFRA failures (missing config / internal-API 5xx / fetch timeout) — bare
 * `{ message }` objects whose apologetic text carries neither `error` nor
 * `success:false`. Without this gate the audit-entry fallback reads those as
 * success and a timed-out reschedule would still move the ledger: the old
 * entry vanishes (re-book of the still-live slot slips the guard into the DB
 * overlap constraint) and a phantom entry blocks the new time — the very bug
 * SCRUM-563 fixes, re-created on the failure path.
 */
const RESCHEDULE_SUCCESS_SIGNAL = /\b(moved your appointment|i'?ve moved|rescheduled|changed your appointment)\b/i;

/**
 * A confirmedBookings ledger entry. server.js stores {code, datetime, name,
 * practitioner_id, at}; conversationrelay.js stores a lean {code, at} — every
 * field except `at` is optional here so both shapes move cleanly.
 *
 * @typedef {{ code?: string, datetime?: string, name?: string, practitioner_id?: string, at?: number }} LedgerEntry
 */

/**
 * Move this call's ledger entry after a SUCCESSFUL reschedule_appointment.
 * Call sites gate on the tool's success flag — a failed reschedule changed
 * nothing and must not touch the ledger.
 *
 * @param {Map<string, LedgerEntry>|undefined|null} confirmedBookings - the session ledger (mutated in place)
 * @param {{ current_datetime?: string, current_date?: string, new_datetime?: string, first_name?: string, last_name?: string, name?: string, practitioner_id?: string }} args - the reschedule_appointment tool args
 * @param {number} [now] - timestamp for the refreshed entry
 * @returns {{ moved: boolean, fromKey?: string, toKey?: string, ambiguous?: boolean }}
 */
function applyRescheduleToLedger(confirmedBookings, args = {}, now = Date.now()) {
  if (!(confirmedBookings instanceof Map) || confirmedBookings.size === 0) return { moved: false };

  const newDatetime = String(args?.new_datetime || "").trim();
  if (!newDatetime) return { moved: false };

  const oldDatetime = String(args?.current_datetime || "").trim();
  const oldDate = String(args?.current_date || "").trim();

  /** @type {Array<[string, LedgerEntry]>} */
  let candidates = [];
  if (oldDatetime) {
    // Primary match: the normalized instant, exactly how the key was built —
    // "09:00", "09:00:00" and offset variants of the same moment all fold.
    const oldInstant = normalizeDatetime(oldDatetime);
    for (const [key, entry] of confirmedBookings) {
      if (key.startsWith(oldInstant + "|")) candidates.push([key, entry]);
    }
  } else if (oldDate) {
    // Date-only fallback: compare against the LITERAL datetime the booking
    // was made with (org-local ISO), never the UTC-normalized key — an AU
    // morning shifts to the previous UTC date and would never match.
    for (const [key, entry] of confirmedBookings) {
      if (entry && typeof entry.datetime === "string" && entry.datetime.startsWith(oldDate)) {
        candidates.push([key, entry]);
      }
    }
  } else {
    return { moved: false };
  }

  if (candidates.length === 0) return { moved: false };
  if (candidates.length > 1) {
    const argGiven = normalizeName(args?.first_name || String(args?.name || "").trim().split(/\s+/)[0]);
    if (argGiven) {
      candidates = candidates.filter(([key]) => key.slice(key.lastIndexOf("|") + 1) === argGiven);
    }
    if (candidates.length !== 1) return { moved: false, ambiguous: true };
  }

  const [fromKey, entry] = candidates[0];

  // Fold the reschedule's name fields (each optional, defaults to the
  // existing booking — mirrors the internal-API handler's semantics).
  const entryTokens = String(entry?.name || "").trim().split(/\s+/).filter(Boolean);
  const nextFirst = String(args?.first_name || "").trim() || entryTokens[0] || "";
  const nextLast = String(args?.last_name || "").trim() || entryTokens.slice(1).join(" ");
  const nextName = `${nextFirst} ${nextLast}`.trim();

  // The new key's given-name segment: the args' spelling when provided (a
  // future duplicate book_appointment would carry that spelling), otherwise
  // whatever the old key carried — lean ConversationRelay entries have no
  // name field, so the key segment is the only carrier.
  const oldGiven = fromKey.slice(fromKey.lastIndexOf("|") + 1);
  const toKey = bookingKey({ datetime: newDatetime, first_name: nextFirst || oldGiven });

  /** @type {LedgerEntry} */
  const moved = {
    ...(entry || {}),
    datetime: newDatetime,
    // Omitted/empty practitioner_id keeps the current one (schema: "Omit to
    // keep the current practitioner") — it stays the correction-vs-second-
    // person discriminator for classifyRebookAttempt.
    practitioner_id: args?.practitioner_id ? args.practitioner_id : entry?.practitioner_id,
    at: now,
  };
  if (nextName) moved.name = nextName;

  confirmedBookings.delete(fromKey);
  confirmedBookings.set(toKey, moved);
  return { moved: true, fromKey, toKey };
}

module.exports = { applyRescheduleToLedger, RESCHEDULE_SUCCESS_SIGNAL };
