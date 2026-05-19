/**
 * Server-side helpers: resolve an org's default country once, then validate
 * any number of phone strings against it. Used by API routes that accept
 * user-entered phone numbers (transfer rules, notification SMS sender, etc.)
 * to enforce E.164 storage before the value ever reaches the DB.
 *
 * SCRUM-295 — every place a user enters a phone number must go through these.
 */

import { parsePhoneToE164, type SupportedCountry } from "./normalize";

/**
 * Minimal Supabase client shape — we only need `.from(...).select(...).eq(...).single()`.
 * Loose typing because the route handlers use `(supabase as any)` due to SSR
 * type-inference limits, and we don't want to leak that constraint here.
 */
type MinimalSupabaseClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        single: () => Promise<{ data: { country?: string } | null; error: unknown }>;
      };
    };
  };
};

/**
 * Fetch the org's `country` column and resolve it to a SupportedCountry.
 * Defaults to AU on missing/unknown values since AU is the primary market.
 * Throws if the lookup fails entirely — callers should let it surface as
 * a 500 (this is a real DB error, not a validation error).
 */
export async function getOrgCountry(
  orgId: string,
  supabase: unknown
): Promise<SupportedCountry> {
  const { data, error } = await (supabase as MinimalSupabaseClient)
    .from("organizations")
    .select("country")
    .eq("id", orgId)
    .single();

  if (error) {
    throw new Error(
      `Failed to resolve country for organization ${orgId}: ${
        (error as { message?: string })?.message ?? "unknown error"
      }`
    );
  }

  return data?.country === "US" ? "US" : "AU";
}

export type PhoneValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate and normalise a phone string to E.164 against a SupportedCountry.
 *
 * Returns a uniform error message on failure suitable for direct inclusion
 * in a 400 response. Does NOT throw on bad input — invalid phone is a
 * client error, not a server error.
 */
export function validatePhone(
  phone: unknown,
  country: SupportedCountry,
  label = "Phone number"
): PhoneValidationResult {
  if (typeof phone !== "string" || !phone.trim()) {
    return { ok: false, error: `${label} is required.` };
  }
  const normalised = parsePhoneToE164(phone, country);
  if (!normalised) {
    const example = country === "US" ? "+14155551234" : "+61412345678";
    return {
      ok: false,
      error: `${label} "${phone}" is not a valid number for ${country}. Use international format (e.g., ${example}).`,
    };
  }
  return { ok: true, value: normalised };
}
