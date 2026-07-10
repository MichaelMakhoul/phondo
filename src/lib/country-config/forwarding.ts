import {
  getCountryConfig,
  getCountryForCallingCode,
  formatInstructions,
  SUPPORTED_COUNTRIES,
  type CarrierInfo,
  type CountryCode,
} from "./index";

/**
 * SCRUM-516: build the call-forwarding dial codes a customer actually types
 * into their phone, and a `tel:` link that puts the code straight into the
 * dialer.
 *
 * The destination number matters more than it looks. Carrier forwarding codes
 * are MMI strings (3GPP TS 22.030) of the form `**21*<number>#`, and `<number>`
 * has to be dialable from the handset entering it. The dialog used to build it
 * with `phone_number.replace(/\D/g, "")`, which strips the leading "+" from the
 * E.164 number Twilio returns: `+61 2 8555 1234` became `61285551234`, an
 * 11-digit string starting with 6 that no Australian network will route. Every
 * AU customer who followed the on-screen instructions pointed their forwarding
 * at a number that does not exist, and heard the confirmation tone anyway.
 *
 * So the destination is rendered in the national dialing format each carrier's
 * own documentation uses: `0285551234` in Australia, `5551234567` in the US.
 */

export type ForwardingMode = "conditional" | "unconditional";

export interface ForwardingCodes {
  /** The MMI string that turns forwarding on, e.g. "**21*0285551234#". */
  enable: string;
  /** The MMI string that turns it off again, e.g. "##21#". */
  disable: string;
  /** Carrier-specific caveat, shown under the codes. */
  note: string;
}

/**
 * Which country's dialing rules apply to this destination.
 *
 * The passed `countryCode` is a side channel and can be wrong: the phone-numbers
 * page silently leaves it at "US" when the organizations row fails to load, and
 * both call sites default it. Handing an Australian number the US rules
 * reproduces the exact bug this module exists to fix — `+61285551234` falls
 * through the US branch untouched and comes back as the unroutable
 * `61285551234` — while `getCarriersForCountry("US")` shows Verizon codes. The
 * carrier plays its tone; nobody finds out.
 *
 * A leading "+" means E.164, and an E.164 number states its own country. Trust
 * that over the side channel. Only a leading "+" counts: the US number
 * `6125551234` (a Minneapolis area code) starts with Australia's calling code,
 * so digits alone cannot be read as a country.
 *
 * Returns null when the country cannot be established, so callers can decline to
 * show a code rather than show a confidently wrong one.
 */
export function resolveForwardingCountry(
  phone: string,
  countryCode: CountryCode | string
): CountryCode | null {
  const raw = String(phone || "").trim();
  if (raw.startsWith("+")) {
    // An E.164 number we cannot place is NOT silently handed to another
    // country's rules. We'd rather show nothing.
    return getCountryForCallingCode(raw.replace(/\D/g, ""));
  }
  const normalized = String(countryCode || "").toUpperCase();
  return SUPPORTED_COUNTRIES.some((c) => c.code === normalized)
    ? (normalized as CountryCode)
    : null;
}

/**
 * Render an E.164 number in the national form a handset can dial.
 *
 * AU: "+61285551234" → "0285551234" (drop the calling code, restore the "0"
 * trunk prefix). US: "+15551234567" → "5551234567" (no trunk prefix; US
 * carriers document the bare 10 digits).
 *
 * A number already in national form is returned as-is. Anything we cannot
 * recognise is returned with non-digits stripped rather than mangled further —
 * the caller still shows it, and the customer can see it is wrong.
 */
export function toNationalDialable(phone: string, countryCode: CountryCode | string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";

  // The number's own calling code beats the side channel. See above.
  const resolved = resolveForwardingCountry(phone, countryCode);
  const config = getCountryConfig(resolved ?? countryCode);
  const callingCode = config.phone.countryCallingCode;

  if (config.code === "AU") {
    // "61" + 9 national digits, exactly. The trunk prefix "0" is not part of
    // E.164, so it has to be put back.
    if (digits.startsWith(callingCode) && digits.length === 11) {
      return `0${digits.slice(callingCode.length)}`;
    }
    // Already national ("0285551234"), or a length we do not recognise. Hand
    // the digits back rather than mangle them: the owner can see they are wrong.
    return digits;
  }

  // US: "1" + 10 national digits. The "1" is both the calling code and the
  // trunk prefix, so a national number may legitimately carry it. Strip it only
  // when it really IS the calling code on an 11-digit number — without that
  // check, an 11-digit number beginning with anything else loses its first
  // digit. A 10-digit national number needs no change.
  if (digits.startsWith(callingCode) && digits.length === 11) {
    return digits.slice(callingCode.length);
  }
  return digits;
}

/**
 * The dial codes for one carrier and one forwarding mode, with the destination
 * already substituted.
 *
 * Returns null when we cannot establish the destination's country, because the
 * only thing worse than no forwarding code is one that dials the wrong place
 * and still plays a confirmation tone. Callers must render nothing rather than
 * fall back — and the null return is what makes the compiler say so, instead of
 * leaving the safety to whoever writes the next caller.
 */
export function buildForwardingCodes(
  carrier: CarrierInfo,
  mode: ForwardingMode,
  destinationPhone: string,
  countryCode: CountryCode | string
): ForwardingCodes | null {
  const country = resolveForwardingCountry(destinationPhone, countryCode);
  if (!country) return null;

  const destination = toNationalDialable(destinationPhone, country);
  if (!destination) return null;

  const instructions = carrier.instructions[mode];
  return {
    enable: formatInstructions(instructions.enable, destination),
    disable: formatInstructions(instructions.disable, destination),
    note: instructions.note,
  };
}

/**
 * A dial code contains only the characters a phone keypad can send.
 *
 * Used to gate `telHref`. We never build a `tel:` URI out of a string we did
 * not generate ourselves — a `tel:` link is a real capability on a handset,
 * and this keeps the set of things it can dial to "MMI codes we composed".
 */
const DIAL_CODE_RE = /^[0-9*#+]+$/;

/**
 * A `tel:` URI that opens the dialer with the code already entered.
 *
 * "#" MUST be percent-encoded. Left bare it is a URI fragment, so
 * `tel:**21*0285551234#` reaches the dialer as `**21*0285551234` — the code
 * silently loses its terminator and does nothing. "*" and "+" are legal in the
 * path and are left alone, because a dialer receiving "%2A" shows the escape.
 *
 * Handsets do not auto-dial MMI codes from a link (both iOS and Android
 * require the user to press call, deliberately, since a link that could send
 * `**21*` unattended would be a hijacking primitive). Pre-filling the dialer is
 * the whole win: the customer stops transcribing a code by hand.
 *
 * Returns null for anything that is not a dial code, so callers render a plain
 * copyable string instead of a broken link.
 */
export function telHref(code: string): string | null {
  const trimmed = String(code || "").trim();
  if (!DIAL_CODE_RE.test(trimmed)) return null;
  return `tel:${trimmed.replace(/#/g, "%23")}`;
}

/**
 * Which of an org's phone numbers can serve as a forwarding destination.
 *
 * Both source types qualify: a "purchased" row IS the Phondo number, and a
 * "forwarded" row's phone_number column also holds the provisioned Twilio
 * number Phondo answers on (user_phone_number holds the customer's own line).
 *
 * Excluded, in the order the checks run:
 * - inactive rows and rows without a number — a dial code pointing at a
 *   released number is the SCRUM-516 bug wearing a new hat;
 * - numbers whose country cannot be established — ForwardingInstructions
 *   renders null for those, so offering one produces a heading and a picker
 *   above a silently blank pane. The wrapper's render condition must match
 *   what the child can actually render.
 */
export function forwardingDestinations<
  T extends { phone_number: string | null; is_active: boolean }
>(numbers: readonly T[] | null | undefined, countryCode: CountryCode | string): T[] {
  if (!Array.isArray(numbers)) return [];
  return numbers.filter(
    (n) =>
      n.is_active &&
      typeof n.phone_number === "string" &&
      n.phone_number.trim() !== "" &&
      resolveForwardingCountry(n.phone_number, countryCode) !== null
  );
}

/**
 * How the two modes are described to a business owner, who does not think in
 * terms of "conditional" and "unconditional".
 */
export const FORWARDING_MODE_LABELS: Record<ForwardingMode, { title: string; blurb: string }> = {
  conditional: {
    title: "When you can't answer",
    blurb:
      "Your phone rings first. If nobody picks up, or the line is busy, the call comes to your AI receptionist. Most businesses start here.",
  },
  unconditional: {
    title: "Every call",
    blurb:
      "Calls go straight to your AI receptionist and your phone never rings. Best after hours, or once you trust it to handle the front desk.",
  },
};
