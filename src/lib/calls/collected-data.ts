// SCRUM-392: render post-call `collected_data` values for the call-detail UI.
// Values can be primitives, arrays, or objects (e.g. an `appointments` field is an
// array of {date,time,doctor}). A naive `String(value)` yields "[object Object]"; this
// formats them readably and lets the UI hide non-answer fields ("not provided" etc.).

// Deliberately excludes "none": for a dental/medical assistant "none" is a real
// clinical answer (allergies: none, medications: none), not a non-answer.
const NON_ANSWERS = new Set([
  "", "not provided", "not specified", "unknown", "n/a", "na", "null", "undefined",
]);

/**
 * Format a collected_data value as a human-readable string:
 * - primitives → their string form
 * - arrays → each element formatted, joined with "; "
 * - objects → their values formatted, joined with " · " (keys dropped — for an
 *   appointment {date,time,doctor} that reads "Wed June 17 · 9:00 AM · Lisa Thompson")
 */
export function formatCollectedValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(formatCollectedValue).map((s) => s.trim()).filter(Boolean).join("; ");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(formatCollectedValue)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" · ");
  }
  return String(value);
}

/**
 * True when a collected value carries no real answer ("not provided", empty, etc.) —
 * such fields are noise on the detail panel (the real phone/etc. is shown elsewhere).
 */
export function isNonAnswer(value: unknown): boolean {
  return NON_ANSWERS.has(formatCollectedValue(value).toLowerCase());
}
