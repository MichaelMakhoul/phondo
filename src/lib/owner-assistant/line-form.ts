/**
 * Form logic for Settings → "Your assistant line" (SCRUM-585, spec §6):
 * field validation, the save payload, server-error extraction and the card's
 * initial state from the page's owner_access read. It lives outside the card
 * because this repo has no component test harness; the card is thin wiring
 * over these.
 *
 * Client-safe on purpose: it imports only dependency-free modules (the phone
 * normaliser and ./pin-rules) and never ./pin, which pulls Node crypto into
 * the browser bundle.
 */
import { parsePhoneToE164, type SupportedCountry } from "@/lib/phone/normalize";
import { WEAK_PIN_MESSAGE, isValidPin, isWeakPin } from "@/lib/owner-assistant/pin-rules";

/** How the card words the PIN rule. ASCII digits only: PIN_REGEX has no Unicode digits. */
export const PIN_RULE_TEXT = "4–8 digits (0–9)";

export const PIN_REQUIRED_MESSAGE = `Choose a PIN of ${PIN_RULE_TEXT}`;
export const PIN_FORMAT_MESSAGE = `PIN must be ${PIN_RULE_TEXT}`;
export const PIN_MISMATCH_MESSAGE = "PINs don't match";
export const PIN_CONFIRM_ONLY_MESSAGE =
  "Enter your new PIN here too, or clear the confirmation to keep your current PIN";

/** What the Settings page hands the card for a line it read successfully. */
export interface OwnerLineInitial {
  /** False for a line that was never set up (no owner_access row). */
  configured: boolean;
  phoneE164: string | null;
  pinLength: number | null;
  enabled: boolean;
}

export type OwnerLineField = "phone" | "pin" | "pinConfirm";
export type OwnerLineErrors = Partial<Record<OwnerLineField, string>>;

export interface OwnerLineValues {
  phone: string;
  pin: string;
  pinConfirm: string;
}

export interface OwnerLineValidationOptions {
  country: SupportedCountry;
  /** True once a row exists: a blank PIN then means "keep the current one". */
  configured: boolean;
}

/** A number the org's country accepts, shown as the placeholder and in the phone error. */
export function phoneExampleFor(country: SupportedCountry): string {
  return country === "US" ? "+14155551234" : "0412 345 678";
}

/**
 * Field errors for the card, empty when it is safe to submit. Mirrors the
 * server's rules so a bad entry is caught before a request is made; the server
 * stays the authority and its 400 is still surfaced if the two ever disagree.
 *
 * isWeakPin is only meaningful for a PIN that already passed isValidPin (it
 * returns true for "", "1", "12", "123"), so the format is checked first and a
 * half-typed PIN is never reported as weak.
 *
 * The card puts no maxLength on the PIN inputs: a browser would silently cut a
 * pasted 9+ digit PIN down to a valid-looking 8-digit one the owner never
 * chose. The whole value reaches this check and gets the format error, so
 * nothing here may truncate, slice or trim a PIN before testing it.
 */
export function validateOwnerLineForm(
  { phone, pin, pinConfirm }: OwnerLineValues,
  { country, configured }: OwnerLineValidationOptions,
): OwnerLineErrors {
  const errors: OwnerLineErrors = {};

  if (!parsePhoneToE164(phone, country)) {
    errors.phone = `Enter a valid mobile number (e.g., ${phoneExampleFor(country)})`;
  }

  if (pin === "") {
    if (!configured) {
      errors.pin = PIN_REQUIRED_MESSAGE;
    } else if (pinConfirm !== "") {
      // Typing only the confirmation would otherwise save silently with the OLD
      // PIN while the owner believes it changed.
      errors.pin = PIN_CONFIRM_ONLY_MESSAGE;
    }
    return errors;
  }

  if (!isValidPin(pin)) {
    errors.pin = PIN_FORMAT_MESSAGE;
  } else if (isWeakPin(pin)) {
    errors.pin = WEAK_PIN_MESSAGE;
  }
  if (pin !== pinConfirm) {
    errors.pinConfirm = PIN_MISMATCH_MESSAGE;
  }

  return errors;
}

export interface OwnerLineSaveBody {
  phone: string;
  enabled: boolean;
  pin?: string;
}

/**
 * The PUT body. A blank PIN is omitted, not sent as "": the API reads a missing
 * `pin` as "keep the stored one" and rejects an empty string as malformed.
 */
export function buildSaveBody({
  phone,
  pin,
  enabled,
}: {
  phone: string;
  pin: string;
  enabled: boolean;
}): OwnerLineSaveBody {
  return { phone: phone.trim(), enabled, ...(pin ? { pin } : {}) };
}

/**
 * The API's `{ error: string }` message, or `fallback` for anything else (a
 * non-JSON body, a missing or non-string error). Only a string is ever handed
 * to a toast, so a malformed body cannot become a React render error.
 */
export function serverErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "string" && error.trim() !== "") return error;
  }
  return fallback;
}

/** Shown instead of the form when the page could not read the line. */
export const LOAD_FAILED_MESSAGE = "We couldn't load your assistant line — refresh to try again.";

/** The result of the page's `.maybeSingle()` read of owner_access, exactly as Supabase returns it. */
export interface OwnerAccessRead {
  /** The row (phone_e164, pin_length, enabled), or null when there is none. */
  data: unknown;
  error: unknown;
}

function hasOwnerAccessColumns(
  row: unknown,
): row is { phone_e164: string; pin_length: number; enabled: boolean } {
  if (typeof row !== "object" || row === null) return false;
  const { phone_e164, pin_length, enabled } = row as Record<string, unknown>;
  return typeof phone_e164 === "string" && typeof pin_length === "number" && typeof enabled === "boolean";
}

/**
 * The card's initial state from the Settings page's owner_access read, or null
 * when the line could not be read (the card then shows LOAD_FAILED_MESSAGE and
 * no form).
 *
 * A failed read must never be mistaken for "no row yet", the same rule the API
 * applies to its own pre-save read: the empty form says "Not set up yet." and a
 * save from it would overwrite a stored PIN through the service-role API with a
 * success toast. So an error, and a row that is not the three expected columns,
 * both fail closed to null. Only a clean "no row" gives the empty form, and only
 * the three non-secret columns are copied out of a row.
 */
export function resolveOwnerLineInitial({ data, error }: OwnerAccessRead): OwnerLineInitial | null {
  if (error) return null;
  if (data === null || data === undefined) {
    return { configured: false, phoneE164: null, pinLength: null, enabled: true };
  }
  if (!hasOwnerAccessColumns(data)) return null;
  return {
    configured: true,
    phoneE164: data.phone_e164,
    pinLength: data.pin_length,
    enabled: data.enabled,
  };
}
