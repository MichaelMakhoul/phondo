/**
 * SCRUM-557 — classify a RebookGuard hit: true duplicate vs name correction.
 *
 * Real call 2026-07-17: the AI booked "Michael PL" (mis-heard surname), the
 * caller spelled the correction ("Makhoul"), and the AI re-called
 * book_appointment with the fixed name. lib/booking-key DELIBERATELY drops the
 * surname (SCRUM-514 — a respelled surname must not slip the duplicate guard),
 * so the corrected re-book mapped to the same key and RebookGuard blocked it
 * as a duplicate. Worse, the guard's "already booked, it's LOCKED" reply
 * convinced the model the corrected booking existed; a follow-up cancel then
 * removed the only real appointment while the caller was told "you're booked
 * for 9am tomorrow".
 *
 * The fix: when the guarded re-book carries a DIFFERENT surname than the
 * ledger entry, it is the caller correcting their name — not the model
 * second-guessing itself. The guard performs an in-place attendee update on
 * the appointment this call created (update_appointment_attendee, a
 * guard-internal tool that is never exposed to the model) instead of blocking.
 *
 * Pure classification + message constants here so both pipelines (Gemini +
 * classic) share one tested implementation.
 */

const { normalizeName } = require("./booking-key");

/** Normalized surname from a ledger name ("Michael PL" → "pl"); "" if none. */
function surnameFromLedgerName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return parts.length > 1 ? normalizeName(parts.slice(1).join(" ")) : "";
}

/**
 * @param {{ name?: string, practitioner_id?: string }} existing - the ledger entry for the matched key
 * @param {{ last_name?: string, practitioner_id?: string }} args - the new book_appointment args
 * @returns {{ kind: "duplicate" } | { kind: "name-correction" }}
 */
function classifyRebookAttempt(existing, args) {
  // Two DIFFERENT practitioners at the same instant is the one legitimate way
  // the duplicate key can carry two PEOPLE ("John Smith with Dr A, and John
  // Baker with Dr B" — the DB's split overlap indexes allow it). Renaming
  // would silently destroy attendee #1's booking, so classify it back to the
  // old recoverable false-block, which the booking-key doc already accepts.
  const oldPrac = existing?.practitioner_id;
  const newPrac = args?.practitioner_id;
  if (oldPrac && newPrac && String(oldPrac) !== String(newPrac)) return { kind: "duplicate" };
  const newLast = normalizeName(args?.last_name || "");
  if (!newLast) return { kind: "duplicate" }; // no surname supplied — same-person re-book
  const oldLast = surnameFromLedgerName(existing?.name);
  // Same normalized surname = the SCRUM-514 respelling case — still a duplicate.
  // A different (or newly supplied) surname = the caller correcting their name.
  return oldLast === newLast ? { kind: "duplicate" } : { kind: "name-correction" };
}

/** The original SCRUM-257 hard rejection for a true duplicate. */
const DUPLICATE_REBOOK_MESSAGE =
  "CRITICAL: You already booked this exact appointment in this call. The booking is LOCKED in the database. DO NOT call book_appointment again. To change the TIME or the PRACTITIONER, call reschedule_appointment (pass practitioner_id for a practitioner change; it changes the booking atomically in one step). To fix a DETAIL the caller corrected — name spelling, contact phone, email, or a note — call update_appointment with only the corrected fields.";

/** Fallback when the correction attempt itself throws (network etc.). */
const CORRECTION_ERROR_MESSAGE =
  "CORRECTION FAILED (internal error). The appointment still exists under the PREVIOUS details — do NOT cancel it and do NOT claim it was fixed. Apologize and offer schedule_callback so the team can correct it.";

/**
 * SCRUM-557: appended to a successful cancel_appointment result so the model
 * can never believe a phantom booking survives the cancel — the exact belief
 * that stranded a caller with zero appointments while being told "you're
 * booked for 9am".
 */
const CANCEL_NUDGE =
  " NOTE: the caller now has NO appointment from this call. If they still want an appointment, call book_appointment NOW with the full details — do NOT tell them anything is booked until it returns success.";

module.exports = {
  classifyRebookAttempt,
  surnameFromLedgerName,
  DUPLICATE_REBOOK_MESSAGE,
  CORRECTION_ERROR_MESSAGE,
  CANCEL_NUDGE,
};
