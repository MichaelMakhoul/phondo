/**
 * Phone number normalisation to E.164.
 *
 * E.164 is the international standard: `+` followed by 8-15 digits, no
 * spaces, no parentheses, no dashes. Twilio and Telnyx both reject
 * non-E.164 values when dialing — that's the bug SCRUM-295 fixes.
 *
 * This helper handles common formats SMB owners actually type:
 *   - AU mobile: 0414 141 883 → +61414141883
 *   - AU mobile with country code: 61 414 141 883 → +61414141883
 *   - AU mobile already E.164: +61 414 141 883 → +61414141883 (strip spaces)
 *   - AU landline: (02) 9555 1234 → +61295551234
 *   - US local: 415-555-1234 → +14155551234
 *   - US with country code: 1 415 555 1234 → +14155551234
 *
 * Conservative: returns null for anything ambiguous (wrong digit counts,
 * unrecognised country, garbage input). The caller decides whether to
 * reject or prompt the user to re-enter. NEVER returns a malformed E.164
 * string — every non-null return matches /^\+[1-9]\d{7,14}$/.
 *
 * Pure function, no I/O, fully vitest-covered.
 */

// E.164 validator regex. Single source of truth in this file.
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

/** Country-specific normalisation rules. Add more countries as we expand. */
const COUNTRY_RULES = {
  AU: {
    code: "61",
    // AU mobile is 04XX XXX XXX (10 digits including leading 0).
    // AU landlines vary by state (02 NSW/ACT, 03 VIC/TAS, 07 QLD, 08 SA/WA/NT)
    // and have format 0X XXXX XXXX (10 digits including leading 0).
    // After normalisation, the national number is always 9 digits.
    nationalLength: 9,
    // First digit of the national number must be 2, 3, 4, 7, or 8
    // (matches both mobiles starting with 4 and landlines starting with 2/3/7/8).
    nationalFirstDigit: /^[23478]/,
  },
  US: {
    code: "1",
    // US/Canada (NANP) is XXX-XXX-XXXX, always 10 digits.
    nationalLength: 10,
    // First digit of area code must be 2-9 (no leading 0 or 1 per NANP).
    nationalFirstDigit: /^[2-9]/,
  },
} as const;

export type SupportedCountry = keyof typeof COUNTRY_RULES;

/**
 * Returns true if the input is a string already in valid E.164 format.
 * Permissive about type — returns false for null/undefined/non-string.
 */
export function isE164(value: unknown): value is string {
  return typeof value === "string" && E164_REGEX.test(value);
}

/**
 * Try to normalise a phone number string to E.164 format.
 *
 * @param input The raw phone number string (or null/undefined).
 * @param defaultCountry Used when the input lacks an explicit country code.
 *                       For dashboard forms this should come from the org's
 *                       `country` field. For voice-call tool handlers it
 *                       should also come from the org context, NOT inferred
 *                       from the caller's number.
 * @returns The E.164 string on success, or `null` if the input can't be
 *          unambiguously normalised. The returned string is guaranteed to
 *          match /^\+[1-9]\d{7,14}$/.
 */
export function parsePhoneToE164(
  input: string | null | undefined,
  defaultCountry: SupportedCountry
): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Fast path: already a valid E.164.
  if (E164_REGEX.test(trimmed)) return trimmed;

  // Strip everything that isn't a digit or a leading +.
  // We preserve the leading + so we can distinguish "+61..." from "61...".
  const hasPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (!digitsOnly) return null;

  const rules = COUNTRY_RULES[defaultCountry];
  if (!rules) return null;

  let national: string;

  if (hasPlus) {
    // Caller explicitly provided a + prefix — they're claiming this is
    // already an international number. Strip the country code and validate.
    if (!digitsOnly.startsWith(rules.code)) {
      // International format but a different country — we don't normalise
      // across countries (too easy to get wrong). Caller can provide raw
      // E.164 if they want a non-default-country number.
      return null;
    }
    national = digitsOnly.slice(rules.code.length);
  } else if (digitsOnly.startsWith(rules.code) && digitsOnly.length === rules.code.length + rules.nationalLength) {
    // No + but country code present at the start with the right total length.
    // e.g. "61414141883" (AU) or "14155551234" (US).
    national = digitsOnly.slice(rules.code.length);
  } else if (digitsOnly.startsWith("0") && digitsOnly.length === rules.nationalLength + 1) {
    // Local format with leading 0. AU only — drop the 0.
    if (defaultCountry !== "AU") return null;
    national = digitsOnly.slice(1);
  } else if (digitsOnly.length === rules.nationalLength) {
    // Exactly the national-number length, no country code, no leading 0.
    // Accept as-is (e.g., "414141883" for AU, "4155551234" for US).
    national = digitsOnly;
  } else {
    // Length doesn't match any recognised pattern — ambiguous, refuse.
    return null;
  }

  // Validate the national number's first digit per country rules.
  if (!rules.nationalFirstDigit.test(national)) return null;

  const candidate = "+" + rules.code + national;
  return E164_REGEX.test(candidate) ? candidate : null;
}
