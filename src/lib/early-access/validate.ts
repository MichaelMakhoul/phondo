/**
 * Validation for "Request early access" submissions (private-beta signup page).
 *
 * Pure and dependency-free so it can be unit-tested without Next/Supabase and
 * reused if another lead surface is added. The API route
 * (src/app/api/v1/early-access/route.ts) owns transport, rate-limiting,
 * persistence, and notification; this owns only shape + bounds.
 */

// Field bounds — generous enough for real input, tight enough to stop abuse
// from stuffing the row (and the notification email) with junk.
export const EARLY_ACCESS_LIMITS = {
  fullName: 120,
  businessName: 160,
  email: 254, // RFC 5321 max address length
  phone: 40,
  message: 2000,
} as const;

// Deliberately permissive: one @, at least one dot in the domain, no spaces.
// Real deliverability is confirmed by the founder following up, not by regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EarlyAccessInput {
  fullName?: unknown;
  businessName?: unknown;
  email?: unknown;
  phone?: unknown;
  message?: unknown;
  /** Honeypot — real browsers leave this empty; bots fill every field. */
  website?: unknown;
}

/** Normalised, DB-column-shaped payload (snake_case to match the table). */
export interface EarlyAccessData {
  full_name: string;
  business_name: string | null;
  email: string;
  phone: string | null;
  message: string | null;
}

export type EarlyAccessValidation =
  | { ok: true; data: EarlyAccessData }
  // botDetected: honeypot tripped — caller should return 200 and silently drop,
  // never reveal the trap. Other failures are genuine 400s.
  | { ok: false; error: string; botDetected?: boolean };

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Strip control characters (C0 0x00-0x1F, DEL 0x7F, C1 0x80-0x9F — includes
 * CR/LF) from single-line fields so a name or business can't smuggle line
 * breaks into the notification subject or render oddly in the founder's mail
 * client / dashboard. NOT applied to the free-text message, where newlines are
 * legitimate. Done as a code-point filter to keep literal control bytes out of
 * the source.
 */
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * Collapse an optional field to a bounded string, or null when empty.
 * `singleLine` strips control chars (business, phone) before bounding.
 */
function optional(
  value: unknown,
  max: number,
  singleLine = false,
): { value: string | null; tooLong: boolean } {
  let s = asTrimmedString(value);
  if (singleLine) s = stripControlChars(s);
  if (s === "") return { value: null, tooLong: false };
  return { value: s, tooLong: s.length > max };
}

export function validateEarlyAccessInput(input: EarlyAccessInput): EarlyAccessValidation {
  // Honeypot first — a filled hidden field means a bot; drop it silently.
  if (asTrimmedString(input.website) !== "") {
    return { ok: false, botDetected: true, error: "Rejected." };
  }

  const fullName = stripControlChars(asTrimmedString(input.fullName));
  if (fullName === "") return { ok: false, error: "Please enter your name." };
  if (fullName.length > EARLY_ACCESS_LIMITS.fullName) {
    return { ok: false, error: "That name is too long." };
  }

  const email = asTrimmedString(input.email);
  if (email === "") return { ok: false, error: "Please enter your email." };
  if (email.length > EARLY_ACCESS_LIMITS.email || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  const business = optional(input.businessName, EARLY_ACCESS_LIMITS.businessName, true);
  if (business.tooLong) return { ok: false, error: "That business name is too long." };

  const phone = optional(input.phone, EARLY_ACCESS_LIMITS.phone, true);
  if (phone.tooLong) return { ok: false, error: "That phone number is too long." };

  const message = optional(input.message, EARLY_ACCESS_LIMITS.message);
  if (message.tooLong) return { ok: false, error: "That message is too long (2000 characters max)." };

  return {
    ok: true,
    data: {
      full_name: fullName,
      business_name: business.value,
      email,
      phone: phone.value,
      message: message.value,
    },
  };
}
