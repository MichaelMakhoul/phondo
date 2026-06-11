// SCRUM-438: shared appointment-verification helpers for the AI tool paths.
//
// Three layers of caller verification, used by lookup AND the mutating tools
// (cancel/reschedule):
//
//  1. POSSESSION (phone): does the caller hold the number on the booking?
//     For real calls the voice server threads the call's VERIFIED inbound
//     caller ID through the internal API as a trusted, model-inaccessible
//     field — ownership is compared against THAT when present, and only falls
//     back to the model-supplied phone argument when there is no caller ID
//     (browser test calls). Caller ID is still spoofable on the PSTN, which is
//     why identity is never echoed back on phone-only matches (SCRUM-437) and
//     why orgs can layer knowledge factors on top.
//
//  2. KNOWLEDGE (name/email): the org's `appointment_verification_fields`
//     config, previously honored only by handleLookupAppointment. Mutations
//     now enforce the same explicitly-configured fields. `date_of_birth` is
//     collected by lookup prompts but has NO appointments column to verify
//     against, so it does not count as a verifying factor (PR #346 precedent).
//
//  3. RATE LIMITING / oracle hygiene live in tool-handlers (the messages for
//     "code not found" vs "code found but wrong phone" are kept identical so
//     a voice attacker can't enumerate confirmation codes).

interface VerificationResult {
  success: boolean;
  message: string;
}

export interface VerificationSettings {
  method: "code_and_verify" | "code_only" | "details_only";
  fields: string[];
  /**
   * True when the org explicitly configured verification (structured object or
   * legacy array). Knowledge factors are only enforced on MUTATIONS for
   * explicit configs — the platform default (`["name"]`) keeps applying to
   * lookup matching, but silently demanding a name match on every existing
   * org's cancel flow would be a behavior regression they never opted into.
   * The possession (phone) factor is enforced for mutations regardless.
   */
  explicit: boolean;
}

/**
 * Parse the org's `appointment_verification_fields` column. Accepts the
 * structured `{ method, fields }` object, the legacy plain array of fields
 * (treated as code_and_verify), or null/garbage (platform defaults).
 * Extracted from handleLookupAppointment so mutations share the exact parse.
 */
export function parseVerificationSettings(raw: unknown): VerificationSettings {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { method?: unknown }).method) {
    const r = raw as { method: string; fields?: unknown };
    return {
      method: r.method as VerificationSettings["method"],
      fields: Array.isArray(r.fields) ? r.fields : ["name"],
      explicit: true,
    };
  }
  if (Array.isArray(raw)) {
    return { method: "code_and_verify", fields: raw, explicit: true };
  }
  return { method: "code_and_verify", fields: ["name"], explicit: false };
}

/**
 * Fetch + parse the org's verification settings. Falls back to platform
 * defaults on a DB error (logged): the possession factor — the critical
 * mutation gate — does not depend on these settings, so a transient read
 * failure must not block every cancel/reschedule.
 */
export async function getVerificationSettings(
  supabase: unknown,
  organizationId: string
): Promise<VerificationSettings> {
  const { data, error } = await (supabase as any)
    .from("organizations")
    .select("appointment_verification_fields")
    .eq("id", organizationId)
    .single();

  if (error) {
    console.error("Failed to fetch appointment verification settings — using defaults:", {
      organizationId,
      error: error.message ?? error,
    });
    return parseVerificationSettings(undefined);
  }
  return parseVerificationSettings(data?.appointment_verification_fields);
}

/**
 * Compare two phone numbers for OWNERSHIP purposes.
 *
 * Baseline is the established last-9-digit suffix compare (tolerates E.164 vs
 * national formatting, e.g. +61412345678 vs 0412 345 678). When BOTH numbers
 * are NANP-shaped (US/CA: 11 digits starting with 1, or a bare 10-digit
 * national number), the FULL 10-digit national number is compared instead —
 * a last-9 compare drops the leading area-code digit, so +1 415 555 1234 and
 * +1 215 555 1234 would otherwise falsely pass as the same number.
 */
export function phonesMatchForOwnership(
  stored: string | null | undefined,
  provided: string | null | undefined
): boolean {
  const s = (stored || "").replace(/\D/g, "");
  const p = (provided || "").replace(/\D/g, "");
  if (!s || !p) return false;
  const isNanp = (d: string) =>
    (d.length === 11 && d.startsWith("1")) || (d.length === 10 && !d.startsWith("0"));
  if (isNanp(s) && isNanp(p)) {
    return s.slice(-10) === p.slice(-10);
  }
  return s.slice(-9) === p.slice(-9);
}

export type PossessionCheck = "match" | "mismatch" | "unverifiable";

/**
 * SCRUM-438 possession factor: does the caller hold the booking's number?
 *
 * The verified inbound caller ID (threaded by the voice server, never
 * model-supplied) takes PRIORITY over the model-controllable phone argument —
 * a model echoing the victim's number can no longer pass ownership on a real
 * call. The model phone is only the fallback when there is no caller ID
 * (browser test calls have none).
 *
 * "unverifiable" = no phone on file, or no phone available to compare —
 * callers must treat it as NOT verified.
 */
export function verifyPhonePossession(
  appointment: { attendee_phone?: string | null },
  modelPhone: string | undefined,
  verifiedCallerPhone: string | undefined
): PossessionCheck {
  const candidate = verifiedCallerPhone?.trim() || modelPhone?.trim() || "";
  if (!appointment.attendee_phone || !candidate) return "unverifiable";
  return phonesMatchForOwnership(appointment.attendee_phone, candidate)
    ? "match"
    : "mismatch";
}

/** Synthetic placeholder generated when a booking was made without an email. */
function isSyntheticBookingEmail(email: string): boolean {
  return email.endsWith("@noreply.phondo.ai");
}

const MUTATION_DETAILS_MISMATCH: VerificationResult = {
  success: false,
  message:
    "Those details don't match what we have on file for that appointment, so I can't change it for security reasons. I can arrange a callback from the team if that helps.",
};

/**
 * Enforce the org's explicitly-configured knowledge factors (name/email) on a
 * mutation, mirroring handleLookupAppointment's field comparisons:
 *   - name: case-insensitive bidirectional contains against attendee_name
 *   - email: case-insensitive equality, skipped when the booking only has the
 *     synthetic placeholder (nothing was ever collected to verify against)
 *
 * "phone" in the configured fields is covered by the possession check, and
 * date_of_birth has no column to verify against (PR #346) — both are skipped
 * here. `code_only` orgs opted into the lightest verification, so no
 * knowledge factors apply.
 *
 * Returns null when verified, or a ToolResult-shaped ask/refusal. The refusal
 * message is deliberately generic (doesn't say WHICH factor failed).
 */
export function verifyKnowledgeFactors(
  appointment: { attendee_name?: string | null; attendee_email?: string | null },
  provided: { name?: string; email?: string },
  settings: VerificationSettings
): VerificationResult | null {
  if (!settings.explicit || settings.method === "code_only") return null;

  for (const field of settings.fields) {
    if (field === "name") {
      const stored = (appointment.attendee_name || "").trim().toLowerCase();
      if (!stored) continue; // nothing on file to verify against
      const given = (provided.name || "").trim().toLowerCase();
      if (!given) {
        return {
          success: false,
          message: "For security, could you confirm the name on the booking before I make that change?",
        };
      }
      if (!stored.includes(given) && !given.includes(stored)) {
        return MUTATION_DETAILS_MISMATCH;
      }
    } else if (field === "email") {
      const stored = (appointment.attendee_email || "").trim().toLowerCase();
      if (!stored || isSyntheticBookingEmail(stored)) continue; // never collected
      const given = (provided.email || "").trim().toLowerCase();
      if (!given) {
        return {
          success: false,
          message: "For security, could you confirm the email address on the booking before I make that change?",
        };
      }
      if (given !== stored) {
        return MUTATION_DETAILS_MISMATCH;
      }
    }
    // "phone" → possession check; "date_of_birth" → no column to verify (skip).
  }
  return null;
}
