// src/lib/calendar/booking-fields.ts
// SCRUM-602: the business's caller fields (Assistants → Caller Data Collection,
// `assistants.prompt_config.fields`) are read by the receptionist's booking path AND the
// owner assistant's — the owner handler asks for the required ones before its read-back,
// the booking path enforces the name rules as its backstop. Both must see the SAME row:
// an org on a plan with several assistants would otherwise let the two unordered
// `.limit(1)` reads pick different assistants, and a booking could pass the owner's check
// and still be refused after the owner's yes. Oldest assistant first, on both.
//
// SCRUM-617: the field helpers live here too (moved from the owner handler): the
// receptionist's booking path now checks EVERY field the business requires, not just the
// name — the booking tool told the model "first name, last name and the time" for every
// business, and a caller was booked without the address and reason the owner had turned on.

import { sanitizeCustomerText } from "@/lib/owner-assistant/sanitize";

/**
 * The one `prompt_config` row both booking paths read, in a fixed order. SCRUM-617: a
 * caller's booking reads the assistant that answered the call (`assistantId`, from the
 * voice server's trusted envelope — still org-scoped): on a plan with several lines, each
 * line's own required fields apply. Without one (the owner's bookings), the oldest.
 */
export function bookingFieldsQuery(supabase: any, organizationId: string, assistantId?: string): PromiseLike<{ data: { prompt_config?: unknown } | null; error: { code?: string; message?: string } | null }> {
  let query = supabase.from("assistants").select("prompt_config").eq("organization_id", organizationId);
  if (assistantId) query = query.eq("id", assistantId);
  return query
    .order("created_at", { ascending: true })
    .order("id", { ascending: true }) // assistants seeded in one statement share created_at
    .limit(1)
    .maybeSingle();
}

/**
 * SCRUM-602: a field this business collects from callers (Assistants → Caller Data
 * Collection, `assistants.prompt_config.fields`). Each business sets its own: some need
 * a last name, some an email, a tradie an address and how urgent it is.
 */
export type BookingField = { id: string; label: string; required: boolean; verification: string; hint?: string };

/** The fields the booking's own parameters carry — never asked for again through `details`. */
export const BOOKING_OWN_FIELD_IDS = new Set(["first_name", "full_name", "last_name", "phone_number", "email_address"]);
/** One detail's value: a few lines at most. */
export const DETAIL_VALUE_MAX = 300;
/** The whole `details` string; longer is refused, never cut. */
export const DETAILS_MAX = 600;

/** "service_address", "Service Address" and "service address" are one field. */
export function fieldKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** "a", "a and b", "a, b and c". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The business's caller fields from `prompt_config.fields` as stored: a field with no id is
 * skipped, a repeated id counted once, labels and hints flattened to one bounded line.
 */
export function normalizeBookingFields(raw: unknown): BookingField[] {
  if (!Array.isArray(raw)) return [];
  const fields: BookingField[] = [];
  for (const f of raw) {
    const id = typeof f?.id === "string" ? f.id.trim() : "";
    if (!id || fields.some((k) => k.id === id)) continue;
    const hint = sanitizeCustomerText(f?.description, 80);
    fields.push({
      id,
      label: sanitizeCustomerText(f?.label, 60) ?? id.replace(/_/g, " "),
      required: Boolean(f?.required), // truthy, as the booking path's own check reads it
      verification: typeof f?.verification === "string" ? f.verification : "none",
      ...(hint ? { hint } : {}),
    });
  }
  return fields;
}

/** A line break between details is a separator — on both sides (the owner gate's key reads it the same way). */
const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;

/**
 * The extra details as the model passes them: `field=value; field=value` (a colon after
 * the field works too; a line break separates like a semicolon). The field can be the id
 * or the label.
 */
export function parseBookingDetails(raw: unknown): Array<{ key: string; value: string }> | "too_long" | "unreadable" {
  if (raw === undefined || raw === null) return [];
  const joined = String(raw).replace(LINE_BREAKS, ";");
  // Measured after normalisation: a compat character that widens (ﬃ → ffi) must not slip
  // past the cap and be cut with "…" by the sanitiser — nothing here is ever cut.
  if (joined.normalize("NFKC").length > DETAILS_MAX) return "too_long";
  const text = sanitizeCustomerText(joined, DETAILS_MAX);
  if (!text) return [];
  const pairs: Array<{ key: string; value: string }> = [];
  for (const part of text.split(";")) {
    if (!part.trim()) continue;
    const m = /^\s*([^=:]+?)\s*[=:]\s*(.*)$/.exec(part);
    if (!m) return "unreadable";
    pairs.push({ key: m[1], value: m[2].trim() });
  }
  return pairs;
}

/**
 * The fault path's reading of the details: every readable "Label: value" part kept, the rest
 * (a part with no label, anything past the cap) left out — never a refusal.
 */
function parseDetailsLeniently(raw: string | undefined): Array<{ key: string; value: string }> {
  if (!raw) return [];
  const text = sanitizeCustomerText(raw.replace(LINE_BREAKS, ";").slice(0, DETAILS_MAX * 2), DETAILS_MAX * 2) ?? "";
  const pairs: Array<{ key: string; value: string }> = [];
  for (const part of text.split(";")) {
    const m = /^\s*([^=:]+?)\s*[=:]\s*(.*)$/.exec(part);
    if (m && m[2].trim()) pairs.push({ key: m[1], value: m[2].trim() });
  }
  return pairs;
}

/** The name and number keys a caller's details may carry: their own parameters hold them. */
const CALLER_OWN_KEYS = new Set(["firstname", "fullname", "name", "lastname", "surname", "phone", "phonenumber"]);
/** A field (by its id or label key) that IS an email, whatever its id — the email parameter fills it. */
const isEmailKey = (k: string) => k === "email" || k === "emailaddress";
/**
 * A caller who has none (no email, no insurer): "none" is an answer (DATA COLLECTION says so)
 * — for a required email it satisfies the field and saves nothing.
 */
const NONE_RE = /^(?:none|no|nope|n\/?a|nil|nothing|not applicable|no email|(?:i |they |he |she )?(?:do ?n'?o?t|does ?n'?o?t) have (?:one|any|an? email))\.?$/i;
/** A key the model copied with its description ("Urgency Level (Routine, Urgent, or Emergency)") without it. */
const withoutDescription = (key: string) => fieldKey(key.replace(/\s*\([^)]*\)\s*$/, ""));

/**
 * The model's details as text: a string as given; an object (`{"Address": "…"}`) or a list
 * of strings, which a model may pass for a string parameter, as "Label: value" parts; any
 * other type is no details (never a throw).
 */
function detailsText(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string").join("; ");
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
  }
  return undefined;
}

/**
 * SCRUM-617: what a CALLER's booking still needs from this business's required fields,
 * beyond the booking's own parameters (the name, the number, the email) — an address, the
 * reason for the call. Forgiving where the owner's gate is strict, since no read-back key
 * rides on it: a label the business doesn't have is kept as a note line, a field's first
 * non-blank value wins, and an email passed as a detail counts when the email parameter is empty.
 * @returns the missing required fields, the details as note lines (the business's order,
 *   then any others), and the email to save — or why the details couldn't be read.
 */
export function callerBookingDetails(
  fields: BookingField[],
  given: { lastName?: string | null; email?: string | null; details?: unknown },
  /** A fields read fault: nothing is refused — what can't be read is left out, the rest kept. */
  opts: { lenient?: boolean } = {}
): { problem: "too_long" | "unreadable" } | { problem: "value_too_long"; label: string } | { missing: BookingField[]; lines: string[]; email: string | null } {
  const parsed = opts.lenient ? parseDetailsLeniently(detailsText(given.details)) : parseBookingDetails(detailsText(given.details));
  if (parsed === "too_long" || parsed === "unreadable") return { problem: parsed };
  const byKey = new Map<string, BookingField>();
  for (const f of fields) {
    byKey.set(fieldKey(f.id), f);
    byKey.set(fieldKey(f.label), f);
  }
  const values = new Map<string, string>();
  const others: string[] = [];
  const givenEmail = typeof given.email === "string" && given.email.trim() ? given.email.trim() : null;
  let emailNone = givenEmail !== null && NONE_RE.test(givenEmail);
  let email = emailNone ? null : givenEmail;
  // The key as given first — a label that itself ends in brackets ("Emergency (Y/N)", "Budget
  // (AUD)") is matched whole — then without a description the model copied onto it.
  const keyOf = (key: string) => (byKey.has(fieldKey(key)) ? fieldKey(key) : withoutDescription(key));
  for (const { key, value } of parsed) {
    // Never cut a detail the business asked for: too long is refused, as on the owner's path
    // (on a fault, left out).
    if (value.length > DETAIL_VALUE_MAX) {
      if (opts.lenient) continue;
      return { problem: "value_too_long", label: byKey.get(keyOf(key))?.label ?? sanitizeCustomerText(key, 40) ?? "detail" };
    }
    const v = sanitizeCustomerText(value, DETAIL_VALUE_MAX);
    if (!v) continue; // a blank value is no value
    const k = keyOf(key);
    const field = byKey.get(k);
    if (isEmailKey(k)) {
      // Only something that looks like an address is one ("Email: not given" isn't); "none" is an answer.
      if (v.includes("@")) email ??= v.replace(/\s+/g, "");
      else if (NONE_RE.test(v)) emailNone = true;
      if (!field || BOOKING_OWN_FIELD_IDS.has(field.id)) continue;
    }
    if (field && !BOOKING_OWN_FIELD_IDS.has(field.id)) {
      if (!values.has(field.id)) values.set(field.id, v);
      continue;
    }
    if (field || CALLER_OWN_KEYS.has(k)) continue;
    const label = sanitizeCustomerText(key, 40);
    if (label) others.push(`${label}: ${v}`);
  }
  const lastName = typeof given.lastName === "string" && given.lastName.trim() ? given.lastName.trim() : null;
  const missing = fields.filter((f) => {
    if (!f.required) return false;
    if (f.id === "last_name") return lastName === null;
    if (f.id === "email_address") return email === null && !emailNone;
    if (BOOKING_OWN_FIELD_IDS.has(f.id)) return false;
    // A custom field that is an email ("Email", "Email Address"): the email parameter fills it too.
    if (isEmailKey(fieldKey(f.label)) || isEmailKey(fieldKey(f.id))) return email === null && !emailNone && !values.has(f.id);
    return !values.has(f.id);
  });
  const lines = [...fields.filter((f) => values.has(f.id)).map((f) => `${f.label}: ${values.get(f.id)}`), ...others];
  return { missing, lines, email };
}
