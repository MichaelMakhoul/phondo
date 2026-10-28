// SCRUM-617: what a booking needs from THIS business's Caller Data Collection fields
// (`assistants.prompt_config.fields`), for the prompt rules that are written per call.
// Gemini's freshest-instruction block demanded a first and last name for every business
// and nothing else — so the booking handler refused, and Gemini, told to book after the
// names, never asked for the address or the reason the owner had turned on.

/** The fields the booking's own parameters carry (as src/lib/calendar/booking-fields.ts). */
const OWN_FIELD_IDS = new Set(["first_name", "full_name", "last_name", "phone_number", "email_address"]);

/**
 * @param {unknown} fields - prompt_config.fields as stored
 * @returns {{ lastName: boolean, email: boolean, others: string[] }} whether a last name and
 *   an email are required, and the labels of every other required field ("Address", "Urgency
 *   Level (Routine, Urgent, or Emergency)"). No fields saved (a legacy assistant): a last name,
 *   as before.
 */
function bookingNeeds(fields) {
  if (!Array.isArray(fields)) return { lastName: true, email: false, others: [] };
  const required = (id) => fields.some((f) => f && f.id === id && f.required);
  const others = [];
  for (const f of fields) {
    if (!f || !f.required || typeof f.id !== "string" || OWN_FIELD_IDS.has(f.id)) continue;
    const label = oneLine(f.label, 60) || f.id.replace(/_/g, " ");
    const hint = oneLine(f.description, 80);
    others.push(hint ? `${label} (${hint})` : label);
  }
  return { lastName: required("last_name"), email: required("email_address"), others };
}

/** Owner-written text, flattened to one bounded line before it reaches a prompt. */
function oneLine(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

/** "a", "a and b", "a, b and c". */
function listWords(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The Gemini prompt's BOOKING PATH, for what THIS business's bookings need — the last-name
 * step only where it's required, and a step for the other required items — with the step
 * numbers the rules after it refer to.
 * @param {boolean} lastName
 * @param {string[]} otherNeeds - labels, plus "Email Address" when an email is required
 * @returns {string}
 */
function bookingPathSteps(lastName, otherNeeds) {
  const steps = [
    `Caller says a time works ("9am is fine")`,
    `You ask for first name (if not captured)`,
    ...(lastName ? [`You ask for last name (if not captured)`] : []),
    ...(otherNeeds.length ? [`You collect what this business also needs: ${listWords(otherNeeds)} (what the caller already said counts) — passed in details`] : []),
    `You say a short filler in the caller's language (the equivalent of "one moment, let me book that for you")`,
    `You CALL THE book_appointment TOOL — this is non-negotiable`,
    `You WAIT for the tool result`,
    `You read back the booking details (name, date, time, practitioner) from the tool result`,
    `You ask "Is everything correct?" — NEVER promise a text, email, or any follow-up notification`,
    `You call end_call AFTER the caller acknowledges`,
  ];
  const at = (start) => steps.findIndex((s) => s.startsWith(start)) + 1;
  return (
    steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") +
    "\n\n" +
    `BETWEEN step ${at("You say a short filler")} and step ${at("You read back")}, you MUST be SILENT — do not speak any words while the tool is executing. Wait for the tool result before opening your mouth again. The tool call takes 1-3 seconds; the caller will hear your filler phrase during this time.\n\n` +
    `YOU MUST NOT speak the words "you're all set", "I've booked", "appointment is confirmed", or anything that implies success BEFORE step ${at("You WAIT")} (tool result) arrives. If you speak these words without a prior successful book_appointment result, THE CALL HAS FAILED and the caller has NO actual appointment.\n\n`
  );
}

module.exports = { bookingNeeds, listWords, bookingPathSteps };
