/**
 * Pure helpers for the kill-switch fallback test-call endpoint. Pulled out
 * of the route handler so they're trivially unit-testable without Twilio,
 * Supabase, or Next.js infrastructure.
 */

/**
 * Map ISO-3166-1 alpha-2 country code → expected E.164 dialing prefix.
 * The PATCH route already restricts fallback writes to E.164 format —
 * this just enforces that the country matches the org's home country at
 * test-call time. Cross-country test calls would dial unexpectedly
 * internationally, so reject by default; users can update their fallback
 * to match the org country or file a follow-up ticket for explicit
 * cross-country confirmation.
 *
 * Only the countries Phondo currently serves are listed; adding new
 * countries requires extending this map AND `country-config/countries/*`.
 */
const COUNTRY_E164_PREFIX: Record<string, string> = {
  US: "+1",
  CA: "+1", // shares North American Numbering Plan with US
  AU: "+61",
};

/**
 * @returns The expected E.164 prefix for a country, or null if unknown.
 */
export function expectedE164PrefixForCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_E164_PREFIX[country.toUpperCase()] || null;
}

/**
 * @returns true when the E.164 phone number's country prefix matches the
 *   org's home country. Returns false for unknown countries (we refuse to
 *   guess — explicit configuration required).
 */
export function matchesCountryPrefix(
  e164Phone: string,
  country: string | null | undefined,
): boolean {
  const prefix = expectedE164PrefixForCountry(country);
  if (!prefix) return false;
  return e164Phone.startsWith(prefix);
}

/**
 * The exact TwiML returned to Twilio's calls.create twiml inline parameter.
 * Kept here (not in the route handler) so the test suite can assert the
 * message text without hitting the route. The message MUST remain short —
 * the call is capped at 10 seconds total by `timeLimit`.
 */
export function buildTestCallTwiml(): string {
  // Polly.Joanna matches the voice used by every other Twilio <Say> in
  // the codebase; SCRUM-275 tracks switching this to an AU voice for AU
  // orgs.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">This is a test call from Phondo confirming your fallback forwarding is set up correctly. You can hang up now.</Say>
  <Hangup/>
</Response>`;
}
