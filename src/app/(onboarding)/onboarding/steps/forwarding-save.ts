/**
 * Pure validation/normalisation for the onboarding Forwarding step (SCRUM-284).
 *
 * Extracted from the wizard's handleNext so the decision logic is unit-testable
 * without rendering the component or mocking fetch. The wizard calls this, then
 * acts on the result: create a transfer_rule for the (normalised) transfer
 * number, stash the (normalised) fallback for the phone-provisioning step.
 */

import { parsePhoneToE164, type SupportedCountry } from "@/lib/phone/normalize";

export interface ForwardingValidation {
  ok: boolean;
  /** Which field failed, for targeting the error message. */
  errorField?: "transfer" | "fallback";
  /** E.164 transfer number, or null if the field was left blank. */
  transfer: string | null;
  /** E.164 fallback number, or null if the field was left blank. */
  fallback: string | null;
}

/**
 * Validate + normalise both forwarding numbers. Blank fields are allowed
 * (skipping is permitted) and resolve to null. A non-blank field that can't
 * be parsed to E.164 fails fast with `errorField` set — the wizard refuses to
 * advance so we never half-save one number and silently drop the other.
 */
export function validateForwarding(
  transferRaw: string,
  fallbackRaw: string,
  country: SupportedCountry
): ForwardingValidation {
  const transferTrimmed = (transferRaw || "").trim();
  const fallbackTrimmed = (fallbackRaw || "").trim();

  let transfer: string | null = null;
  if (transferTrimmed) {
    const normalised = parsePhoneToE164(transferTrimmed, country);
    if (!normalised) return { ok: false, errorField: "transfer", transfer: null, fallback: null };
    transfer = normalised;
  }

  let fallback: string | null = null;
  if (fallbackTrimmed) {
    const normalised = parsePhoneToE164(fallbackTrimmed, country);
    if (!normalised) return { ok: false, errorField: "fallback", transfer, fallback: null };
    fallback = normalised;
  }

  return { ok: true, transfer, fallback };
}
