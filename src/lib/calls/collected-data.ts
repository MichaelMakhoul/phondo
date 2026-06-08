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

/**
 * True when a collected value is a single editable scalar (string/number/boolean/
 * null/undefined). Structured values (arrays/objects, e.g. an `appointments` array of
 * {date,time,doctor}) are NOT primitive — they must not be edited as a flattened
 * string, which would destroy their structure (SCRUM-394).
 */
export function isPrimitiveCollectedValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * The editable subset of collected_data for the call-detail edit grid: primitive
 * fields only, each formatted to a string for a text input. Structured fields are
 * intentionally excluded — they're shown read-only and preserved verbatim on save.
 */
export function toEditablePrimitives(
  collected: Record<string, unknown> | null | undefined
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(collected || {})
      .filter(([, v]) => isPrimitiveCollectedValue(v))
      .map(([k, v]) => [k, formatCollectedValue(v)])
  );
}

/**
 * Merge edited primitive fields back over the stored collected_data, PRESERVING
 * structured fields (SCRUM-394). Only keys that are primitive (or absent) in the
 * stored data are overlaid — an edited string can never clobber a structured
 * (array/object) field. Used server-side: the client sends only the editable
 * primitive strings, the server merges them over what's stored.
 */
export function mergeEditableCollectedData(
  existing: Record<string, unknown> | null | undefined,
  edited: Record<string, string>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing || {}) };
  for (const [key, value] of Object.entries(edited)) {
    if (!(key in merged) || isPrimitiveCollectedValue(merged[key])) {
      merged[key] = value;
    }
  }
  return merged;
}
