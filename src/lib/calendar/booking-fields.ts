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

/** The one `prompt_config` row both booking paths read, in a fixed order. */
export function bookingFieldsQuery(supabase: any, organizationId: string): PromiseLike<{ data: { prompt_config?: unknown } | null; error: { code?: string; message?: string } | null }> {
  return supabase
    .from("assistants")
    .select("prompt_config")
    .eq("organization_id", organizationId)
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

/** The name and number keys a caller's details may carry: their own parameters hold them. */
const CALLER_OWN_KEYS = new Set(["firstname", "fullname", "name", "lastname", "surname", "phone", "phonenumber"]);

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
  given: { email?: string | null; details?: unknown }
): { problem: "too_long" | "unreadable" } | { missing: BookingField[]; lines: string[]; email: string | null } {
  const parsed = parseBookingDetails(given.details);
  if (parsed === "too_long" || parsed === "unreadable") return { problem: parsed };
  const byKey = new Map<string, BookingField>();
  for (const f of fields) {
    byKey.set(fieldKey(f.id), f);
    byKey.set(fieldKey(f.label), f);
  }
  const values = new Map<string, string>();
  const others: string[] = [];
  let email = typeof given.email === "string" && given.email.trim() ? given.email.trim() : null;
  for (const { key, value } of parsed) {
    const v = sanitizeCustomerText(value, DETAIL_VALUE_MAX);
    if (!v) continue; // a blank value is no value
    const k = fieldKey(key);
    if (k === "email" || k === "emailaddress") {
      email ??= v.replace(/\s+/g, "");
      continue;
    }
    const field = byKey.get(k);
    if (field && !BOOKING_OWN_FIELD_IDS.has(field.id)) {
      if (!values.has(field.id)) values.set(field.id, v);
      continue;
    }
    if (field || CALLER_OWN_KEYS.has(k)) continue;
    const label = sanitizeCustomerText(key, 40);
    if (label) others.push(`${label}: ${v}`);
  }
  const missing = fields.filter((f) =>
    f.required && (f.id === "email_address" ? email === null : !BOOKING_OWN_FIELD_IDS.has(f.id) && !values.has(f.id))
  );
  const lines = [...fields.filter((f) => values.has(f.id)).map((f) => `${f.label}: ${values.get(f.id)}`), ...others];
  return { missing, lines, email };
}
