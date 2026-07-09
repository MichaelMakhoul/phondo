import { getCountryConfig, formatInstructions, type CarrierInfo, type CountryCode } from "./index";

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

  const config = getCountryConfig(countryCode);
  const callingCode = config.phone.countryCallingCode;

  if (config.code === "AU") {
    // "61" + 9 national digits. The trunk prefix "0" is not part of E.164.
    if (digits.startsWith(callingCode) && digits.length === 11) {
      return `0${digits.slice(callingCode.length)}`;
    }
    // Already national: "0285551234".
    if (digits.startsWith("0") && digits.length === 10) return digits;
    return digits;
  }

  // US: "1" + 10 national digits. The "1" is both the calling code and the
  // trunk prefix, so a national number may legitimately carry it.
  if (digits.startsWith(callingCode) && digits.length === 11) {
    return digits.slice(callingCode.length);
  }
  if (digits.length === 10) return digits;
  return digits;
}

/**
 * The dial codes for one carrier and one forwarding mode, with the destination
 * already substituted.
 */
export function buildForwardingCodes(
  carrier: CarrierInfo,
  mode: ForwardingMode,
  destinationPhone: string,
  countryCode: CountryCode | string
): ForwardingCodes {
  const destination = toNationalDialable(destinationPhone, countryCode);
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
