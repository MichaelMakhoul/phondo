// SCRUM-438: shared appointment-verification helpers for the AI tool paths.
//
// Three layers of caller verification, used by lookup AND the mutating tools
// (cancel/reschedule):
//
//  1. POSSESSION (phone): does the caller hold the number on the booking?
//     For real calls the voice server threads the call's caller-ID STATE
//     through the internal API as trusted, model-inaccessible fields:
//       'verified' + the inbound caller ID → ownership is compared against
//         THAT, never the model-supplied phone argument;
//       'withheld' (production call, From withheld/sentinel/SIP) → possession
//         is UNVERIFIABLE — mutations refuse outright, because falling back to
//         the model phone would let an attacker dial with #31# and echo the
//         victim's number;
//       absent → genuine browser/test sessions only, where no caller ID can
//         exist; the model-supplied phone is the fallback there.
//     Caller ID is still spoofable on the PSTN, which is why identity is never
//     echoed back on phone-only matches (SCRUM-437) and why orgs can layer
//     knowledge factors on top.
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

import { isValidPhoneNumber } from "@/lib/security/validation";
import { namesMatch } from "@/lib/calendar/name-match";

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

const KNOWN_VERIFICATION_METHODS: ReadonlyArray<VerificationSettings["method"]> = [
  "code_and_verify",
  "code_only",
  "details_only",
];

/**
 * Parse the org's `appointment_verification_fields` column. Accepts the
 * structured `{ method, fields }` object, the legacy plain array of fields
 * (treated as code_and_verify), or null/garbage (platform defaults).
 * Extracted from handleLookupAppointment so mutations share the exact parse.
 * The method string is allowlisted — an unknown value (bad migration, manual
 * DB edit) falls back to the `code_and_verify` default instead of flowing
 * through an unchecked cast (`explicit` stays true: the org DID configure).
 */
export function parseVerificationSettings(raw: unknown): VerificationSettings {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { method?: unknown }).method) {
    const r = raw as { method: string; fields?: unknown };
    return {
      method: (KNOWN_VERIFICATION_METHODS as readonly string[]).includes(r.method)
        ? (r.method as VerificationSettings["method"])
        : "code_and_verify",
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

/** Wire states the voice server can claim for a call's caller ID. */
export type CallerIdState = "verified" | "withheld";

/**
 * Twilio's numeric sentinel for a withheld caller ID — "+266696687" spells
 * ANONYMOUS on a keypad. It is 9 digits, so it passes isValidPhoneNumber and
 * would otherwise become a never-matching "verified" phone that hard-blocks
 * the caller's mutations. Normalized to 'withheld' here as well as in the
 * voice server, so both sentinel forms behave identically at every boundary.
 */
const ANONYMOUS_CALLER_SENTINEL_DIGITS = "266696687";

/**
 * SCRUM-438: the validated, tri-state caller-ID for a tool call.
 *  - 'verified': a production call with a real dialable From — `phone` is the
 *    ONLY number possession may be compared against.
 *  - 'withheld': a production call with no usable caller ID (withheld/sentinel
 *    /SIP From). Possession is unverifiable; mutations must refuse rather than
 *    fall back to the model-controlled phone argument.
 *  - 'test': a browser/test session, where no caller ID can exist — the
 *    model-supplied phone is the only possible possession factor.
 */
export type ResolvedCallerId =
  | { state: "verified"; phone: string }
  | { state: "withheld" }
  | { state: "test" };

/**
 * Validate the trusted caller-ID fields (top-level payload fields the model
 * can never reach) into a ResolvedCallerId. Shared by the internal tool-call
 * route AND the mutation handlers (the handlers are the security boundary, so
 * they re-validate).
 *
 * Fail-secure: an unrecognized state string, a 'verified' claim without a
 * usable phone, or the +266696687 anonymous sentinel all resolve to
 * 'withheld'. Only the complete ABSENCE of both fields means a test session.
 * A valid phone WITHOUT a state resolves 'verified' — keeps a voice server
 * that predates the state field working during a rolling deploy.
 */
export function resolveCallerId(trusted?: {
  verifiedCallerPhone?: string;
  callerIdState?: string;
}): ResolvedCallerId {
  if (!trusted || (trusted.callerIdState === undefined && trusted.verifiedCallerPhone === undefined)) {
    return { state: "test" };
  }
  const phone = trusted.verifiedCallerPhone;
  if (
    (trusted.callerIdState === undefined || trusted.callerIdState === "verified") &&
    typeof phone === "string" &&
    isValidPhoneNumber(phone) &&
    phone.replace(/\D/g, "") !== ANONYMOUS_CALLER_SENTINEL_DIGITS
  ) {
    return { state: "verified", phone };
  }
  return { state: "withheld" };
}

/**
 * SCRUM-560: gate for the call-authority id. Only a well-formed uuid from the
 * request ENVELOPE (never `arguments`) may ever grant ownership or reach a
 * `call_id.eq.` filter — `call_id` is a uuid column, so a malformed value in
 * a query would become a cast error the caller hears as "having trouble".
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function trustedCallIdForOwnership(callId: string | undefined | null): string | undefined {
  const v = typeof callId === "string" ? callId.trim() : "";
  // Lowercased so the strict === in verifyPhonePossession can never miss a
  // row the SQL call_id.eq filter surfaced (uuid columns render lowercase).
  return v && UUID_RE.test(v) ? v.toLowerCase() : undefined;
}

/**
 * SCRUM-438 possession factor: does the caller hold the booking's number?
 *
 * For 'verified' calls the inbound caller ID (threaded by the voice server,
 * never model-supplied) is the ONLY candidate — a model echoing the victim's
 * number can no longer pass ownership on a real call. For 'withheld' calls
 * possession is always unverifiable: the model phone must never substitute
 * for a caller ID the caller deliberately hid (#31# + echoing the victim's
 * number would otherwise re-open the spoof). The model phone applies only to
 * 'test' sessions, where no caller ID can exist.
 *
 * SCRUM-560 call authority: a row whose `call_id` equals the CURRENT call's
 * trusted id is owned outright — the call that created a booking has full
 * authority over it (the same trust basis update_appointment anchors on).
 * Checked FIRST and phone-independently: it must hold after the caller
 * corrects the contact phone away from their caller ID, which is exactly
 * when the phone comparison goes blind. `trustedCallId` comes from the
 * request envelope via trustedCallIdForOwnership — never from model args.
 * (The mutation handlers still refuse withheld caller IDs before possession
 * is ever consulted; the authority check deliberately doesn't reintroduce
 * that decision here.)
 *
 * "unverifiable" = no phone on file, no phone available to compare, or a
 * withheld caller ID — callers must treat it as NOT verified.
 */
export function verifyPhonePossession(
  appointment: { attendee_phone?: string | null; call_id?: string | null },
  modelPhone: string | undefined,
  callerId: ResolvedCallerId,
  trustedCallId?: string
): PossessionCheck {
  if (trustedCallId && appointment.call_id && appointment.call_id === trustedCallId) {
    return "match";
  }
  if (callerId.state === "withheld") return "unverifiable";
  const candidate =
    callerId.state === "verified" ? callerId.phone.trim() : modelPhone?.trim() || "";
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
 * SCRUM-506: the caller's OWN identity details collected earlier in THIS call
 * (accumulated in the voice server's per-call session store and threaded here as
 * a trusted, model-inaccessible field). Used to backfill a verification factor
 * the model didn't repeat, so the AI doesn't re-ask for something already given.
 */
export type CollectedDetails = Record<string, string>;

/**
 * SCRUM-506: the allowlisted keys the per-call collected-details bag may carry.
 * `phone`/`date_of_birth`/`medicare_number` are accepted (so the store can hold
 * them) but only `name`/`email` are backfilled as verification factors today —
 * the rest is defensive breadth for future factors, Sentry-scrubbed either way.
 */
const COLLECTED_DETAIL_KEYS = ["name", "phone", "email", "date_of_birth", "medicare_number"] as const;

/**
 * SCRUM-506: the per-call collected details reach the internal route as a
 * top-level, model-inaccessible field. Sanitize defensively even on the
 * authenticated internal channel: keep only allowlisted string factors, trimmed
 * and length-capped; reject non-objects/arrays; return undefined when nothing
 * survives. Iterating a fixed literal allowlist (never keys off `raw`) means
 * `__proto__`/`constructor` can never pollute the output.
 */
export function sanitizeCollectedDetails(raw: unknown): CollectedDetails | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of COLLECTED_DETAIL_KEYS) {
    const v = src[key];
    if (typeof v === "string") {
      const trimmed = v.trim().slice(0, 200);
      if (trimmed) out[key] = trimmed;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * SCRUM-506: fill a MISSING verification factor (name/email) from the per-call
 * collected details — never overriding a value the model DID provide. Pure;
 * returns a new object. This only avoids a re-ASK: verifyKnowledgeFactors still
 * runs the match against the actual record, so a carried-but-wrong detail is
 * still rejected (MUTATION_DETAILS_MISMATCH).
 */
export function applyCollectedDetails(
  provided: { name?: string; email?: string },
  collected: CollectedDetails | undefined
): { name?: string; email?: string } {
  if (!collected) return provided;
  const out = { ...provided };
  if (!out.name?.trim() && collected.name?.trim()) out.name = collected.name;
  if (!out.email?.trim() && collected.email?.trim()) out.email = collected.email;
  return out;
}

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
      // SCRUM-506: use the SAME tolerant phonetic match as lookup
      // (name-match.ts, used at tool-handlers.ts:3011) — a name good enough to
      // FIND the booking must be good enough to CHANGE it. Safe here because
      // verifyKnowledgeFactors is only reached AFTER phone possession returns
      // "match" (the precondition name-match.ts requires). `stored`/`given`
      // above already established both are non-empty; namesMatch does its own
      // normalization, so compare the original-case values.
      if (!namesMatch(provided.name || "", appointment.attendee_name || "")) {
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
