/**
 * SCRUM-514: the key for a call's in-memory "already booked this" ledger.
 *
 * The ledger stops the model re-issuing book_appointment for a slot it just
 * booked. It used to be keyed on the raw `datetime|first_name|last_name`
 * template, which a real call defeated: the model spelled the caller's surname
 * two different ways across the two tool calls, missed the guard, hit the DB's
 * overlap constraint, and told the caller their booking had failed — while the
 * confirmed booking sat in the database.
 *
 * So the key is deliberately coarse — datetime plus given name, nothing else:
 *
 *   - datetime, normalised to a UTC instant, so "14:00" and "14:00:00" and
 *     "14:00:00+10:00" for the same moment are one key
 *   - the given name, case- and punctuation-folded — enough to tell a second
 *     attendee ("...and my husband") from the same attendee respelled
 *
 * `practitioner_id` is deliberately NOT in the key, even though two
 * practitioners genuinely can be booked at the same instant. Including it looks
 * right and is a trap: the database splits its overlap checks across two
 * partial indexes (`no_overlapping_appointments WHERE practitioner_id IS NULL`
 * and `no_overlapping_practitioner_appointments WHERE practitioner_id IS NOT
 * NULL`). A row with a practitioner and a row without therefore never conflict.
 * So if the model names a practitioner on the first call and omits it on the
 * re-book, a practitioner-keyed guard misses, no 23P01 fires, the server-side
 * idempotency never runs, and a SILENT DUPLICATE appointment is created. The
 * database cannot back us up in that direction; the guard is the only defence.
 *
 * The cost of leaving it out is a false block only when two people who share a
 * given name are booked to different practitioners at the same instant, in one
 * call. One person cannot attend two appointments at once, so this is close to
 * impossible — and a rare false block is far cheaper than a silent double
 * booking in a real diary.
 *
 * An unparseable datetime falls back to its trimmed literal. A naive datetime
 * ("2027-07-07T10:00:00") is resolved in the voice server's own timezone rather
 * than the org's, which is harmless because the key is only ever compared
 * against other keys from the same call, in the same process. A wrong key costs
 * a redundant round-trip; throwing here would drop the call.
 */
function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "");
}

function normalizeDatetime(datetime) {
  const raw = String(datetime || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.toLowerCase();
  // Minute precision: appointments are never scheduled to the second.
  return parsed.toISOString().slice(0, 16);
}

/**
 * @param {{ datetime?: string, first_name?: string, last_name?: string, name?: string }} args
 * @returns {string}
 */
function bookingKey(args = {}) {
  const given = normalizeName(args.first_name || String(args.name || "").trim().split(/\s+/)[0]);
  return `${normalizeDatetime(args.datetime)}|${given}`;
}

module.exports = { bookingKey, normalizeName, normalizeDatetime };
