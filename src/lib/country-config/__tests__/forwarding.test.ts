import { describe, it, expect } from "vitest";
import {
  toNationalDialable,
  buildForwardingCodes,
  telHref,
  FORWARDING_MODE_LABELS,
} from "../forwarding";
import { getCarriersForCountry } from "../index";

// SCRUM-516. These strings are typed into a real phone by a real business
// owner. If the destination is wrong, forwarding is set to a number that does
// not exist and the carrier still plays a confirmation tone — the failure is
// completely silent until a customer calls and nobody answers.

describe("toNationalDialable", () => {
  it("restores the AU trunk prefix that E.164 drops", () => {
    // The old code did `.replace(/\D/g, "")`, yielding "61285551234" — eleven
    // digits starting with 6, which no Australian network routes.
    expect(toNationalDialable("+61285551234", "AU")).toBe("0285551234");
    expect(toNationalDialable("+61412345678", "AU")).toBe("0412345678");
  });

  it("leaves an AU number already in national form alone", () => {
    expect(toNationalDialable("0285551234", "AU")).toBe("0285551234");
    expect(toNationalDialable("02 8555 1234", "AU")).toBe("0285551234");
  });

  it("strips the US calling code, which is not dialed for a local forward", () => {
    expect(toNationalDialable("+15551234567", "US")).toBe("5551234567");
    expect(toNationalDialable("5551234567", "US")).toBe("5551234567");
  });

  it("never returns a plus, which a keypad cannot send inside an MMI code", () => {
    expect(toNationalDialable("+61285551234", "AU")).not.toContain("+");
    expect(toNationalDialable("+15551234567", "US")).not.toContain("+");
  });

  it("does not mangle a number it cannot recognise", () => {
    // Returned as digits so the owner can SEE it is wrong, rather than being
    // handed a confidently-wrong code.
    expect(toNationalDialable("12345", "AU")).toBe("12345");
    expect(toNationalDialable("", "AU")).toBe("");
    expect(toNationalDialable(null as unknown as string, "AU")).toBe("");
  });
});

describe("telHref", () => {
  it("percent-encodes the terminating hash", () => {
    // Bare, "#" is a URI fragment: the dialer receives "**21*0285551234" and
    // the code silently does nothing.
    expect(telHref("**21*0285551234#")).toBe("tel:**21*0285551234%23");
    expect(telHref("##21#")).toBe("tel:%23%2321%23");
  });

  it("leaves the star alone, because a dialer shows '%2A' literally", () => {
    expect(telHref("*61*0285551234#")).toBe("tel:*61*0285551234%23");
  });

  it("refuses anything that is not a dial code", () => {
    // A tel: link is a capability on a handset. Only codes we composed.
    expect(telHref("javascript:alert(1)")).toBeNull();
    expect(telHref("**21*0285551234#; rm -rf /")).toBeNull();
    expect(telHref("call me")).toBeNull();
    expect(telHref("")).toBeNull();
    expect(telHref(null as unknown as string)).toBeNull();
  });
});

describe("buildForwardingCodes", () => {
  const telstra = getCarriersForCountry("AU").find((c) => c.id === "telstra")!;
  const vodafone = getCarriersForCountry("AU").find((c) => c.id === "vodafone_au")!;

  it("substitutes a dialable destination into the carrier's own template", () => {
    const codes = buildForwardingCodes(telstra, "unconditional", "+61285551234", "AU");
    expect(codes.enable).toBe("*21*0285551234#");
    expect(codes.disable).toBe("#21#");
  });

  it("keeps each carrier's distinct codes", () => {
    // Vodafone uses the double-star form; Telstra does not. Collapsing them
    // would send half our customers a code their network rejects.
    const t = buildForwardingCodes(telstra, "unconditional", "+61285551234", "AU");
    const v = buildForwardingCodes(vodafone, "unconditional", "+61285551234", "AU");
    expect(t.enable).toBe("*21*0285551234#");
    expect(v.enable).toBe("**21*0285551234#");
    expect(t.enable).not.toBe(v.enable);
  });

  it("distinguishes the two forwarding modes", () => {
    const conditional = buildForwardingCodes(telstra, "conditional", "+61285551234", "AU");
    const unconditional = buildForwardingCodes(telstra, "unconditional", "+61285551234", "AU");
    expect(conditional.enable).not.toBe(unconditional.enable);
    expect(conditional.note).toBeTruthy();
  });

  it("produces a code that survives telHref", () => {
    // The two halves must compose: every code we render as a link must be one
    // telHref will actually accept.
    for (const country of ["AU", "US"] as const) {
      for (const carrier of getCarriersForCountry(country)) {
        for (const mode of ["conditional", "unconditional"] as const) {
          const codes = buildForwardingCodes(carrier, mode, "+61285551234", country);
          expect(telHref(codes.enable)).not.toBeNull();
          expect(telHref(codes.disable)).not.toBeNull();
        }
      }
    }
  });

  it("never leaves the destination placeholder unsubstituted", () => {
    for (const country of ["AU", "US"] as const) {
      for (const carrier of getCarriersForCountry(country)) {
        for (const mode of ["conditional", "unconditional"] as const) {
          const codes = buildForwardingCodes(carrier, mode, "+61285551234", country);
          expect(codes.enable).not.toContain("{destination_number}");
          expect(codes.disable).not.toContain("{destination_number}");
        }
      }
    }
  });
});

describe("FORWARDING_MODE_LABELS", () => {
  it("describes the modes in a business owner's words, not the spec's", () => {
    // The object keys are the spec's names; the COPY must not be. Nobody
    // running a dental clinic knows what "unconditional forwarding" means.
    const copy = Object.values(FORWARDING_MODE_LABELS)
      .flatMap((m) => [m.title, m.blurb])
      .join(" ")
      .toLowerCase();
    expect(copy).not.toContain("conditional");
    expect(copy).not.toContain("mmi");
    expect(copy).not.toContain("dial code");
  });
});
