import { describe, it, expect } from "vitest";
import {
  toNationalDialable,
  buildForwardingCodes,
  resolveForwardingCountry,
  telHref,
  forwardingDestinations,
  FORWARDING_MODE_LABELS,
} from "../forwarding";
import { getCarriersForCountry, formatPhoneForCountry } from "../index";

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

  it("only rebuilds an AU number of exactly the right length", () => {
    // "61" + 9 digits is the whole rule. A longer string that happens to start
    // with 61 is not an AU number, and slicing it produces a plausible, wrong,
    // dialable-looking result.
    expect(toNationalDialable("+612855512345", "AU")).toBe("612855512345");
    expect(toNationalDialable("+6128555", "AU")).toBe("6128555");
  });

  it("only strips a leading US 1 when it really is the calling code", () => {
    // Without the prefix check, any 11-digit number loses its first digit.
    expect(toNationalDialable("20285551234", "US")).toBe("20285551234");
    expect(toNationalDialable("15551234567", "US")).toBe("5551234567");
    // And "1" + 10 digits is the whole rule. A twelve-digit string starting
    // with 1 is not a US number; slicing it invents a plausible wrong one.
    expect(toNationalDialable("155512345678", "US")).toBe("155512345678");
  });
});

describe("resolveForwardingCountry", () => {
  it("believes the number's own calling code over the passed country", () => {
    // The phone-numbers page silently leaves countryCode at "US" when the
    // organizations row fails to load. Trusting it would hand an Australian
    // number the US rules and rebuild the exact bug this module exists to fix.
    expect(resolveForwardingCountry("+61285551234", "US")).toBe("AU");
    expect(resolveForwardingCountry("+15551234567", "AU")).toBe("US");
  });

  it("does not read a country out of bare digits", () => {
    // "6125551234" is a Minneapolis number, and it starts with Australia's
    // calling code. Only a leading "+" makes the digits E.164.
    expect(resolveForwardingCountry("6125551234", "US")).toBe("US");
    expect(resolveForwardingCountry("0285551234", "AU")).toBe("AU");
  });

  it("returns null for an E.164 number from a country we have no rules for", () => {
    // Better to show no code than New Zealand's number with America's codes.
    expect(resolveForwardingCountry("+6421234567", "US")).toBeNull();
    expect(resolveForwardingCountry("+33123456789", "AU")).toBeNull();
  });

  it("returns null when neither the number nor the country tells us anything", () => {
    expect(resolveForwardingCountry("0285551234", "")).toBeNull();
    expect(resolveForwardingCountry("0285551234", "NZ")).toBeNull();
    expect(resolveForwardingCountry("", "")).toBeNull();
  });
});

describe("toNationalDialable — a wrong country must not resurrect the bug", () => {
  it("still dials an AU number correctly when told the org is American", () => {
    // Without this, digits fall through the US branch untouched and come back
    // as "61285551234" — the unroutable string the whole module exists to kill.
    expect(toNationalDialable("+61285551234", "US")).toBe("0285551234");
  });

  it("still dials a US number correctly when told the org is Australian", () => {
    expect(toNationalDialable("+15551234567", "AU")).toBe("5551234567");
  });

  it("produces the AU carrier codes for an AU number under a US country", () => {
    const telstra = getCarriersForCountry("AU").find((c) => c.id === "telstra")!;
    const codes = buildForwardingCodes(telstra, "unconditional", "+61285551234", "US")!;
    expect(codes.enable).toBe("*21*0285551234#");
    expect(codes.enable).not.toContain("61285551234");
  });

  it("refuses to build a code when the destination's country is unknowable", () => {
    // A code that dials nowhere is worse than no code, because the carrier
    // plays its confirmation tone either way. The null return is what stops the
    // next caller of this function from having to remember that.
    const telstra = getCarriersForCountry("AU").find((c) => c.id === "telstra")!;
    expect(buildForwardingCodes(telstra, "unconditional", "+6421234567", "US")).toBeNull();
    expect(buildForwardingCodes(telstra, "unconditional", "0285551234", "NZ")).toBeNull();
    expect(buildForwardingCodes(telstra, "unconditional", "", "AU")).toBeNull();
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

  it("refuses a payload hidden after a newline", () => {
    // The gate must anchor to the whole STRING. Add the `m` flag and "^...$"
    // starts matching a LINE, so a first line of digits waves the rest through.
    expect(telHref("123\njavascript:alert(1)")).toBeNull();
    expect(telHref("*21*0285551234#\r\njavascript:alert(1)")).toBeNull();
    expect(telHref("\n**21*0285551234#\n")).toBe("tel:**21*0285551234%23"); // trim only
  });
});

describe("buildForwardingCodes", () => {
  const telstra = getCarriersForCountry("AU").find((c) => c.id === "telstra")!;
  const vodafone = getCarriersForCountry("AU").find((c) => c.id === "vodafone_au")!;

  it("substitutes a dialable destination into the carrier's own template", () => {
    const codes = buildForwardingCodes(telstra, "unconditional", "+61285551234", "AU")!;
    expect(codes.enable).toBe("*21*0285551234#");
    expect(codes.disable).toBe("#21#");
  });

  it("keeps each carrier's distinct codes", () => {
    // Vodafone uses the double-star form; Telstra does not. Collapsing them
    // would send half our customers a code their network rejects.
    const t = buildForwardingCodes(telstra, "unconditional", "+61285551234", "AU")!;
    const v = buildForwardingCodes(vodafone, "unconditional", "+61285551234", "AU")!;
    expect(t.enable).toBe("*21*0285551234#");
    expect(v.enable).toBe("**21*0285551234#");
    expect(t.enable).not.toBe(v.enable);
  });

  it("distinguishes the two forwarding modes", () => {
    const conditional = buildForwardingCodes(telstra, "conditional", "+61285551234", "AU")!;
    const unconditional = buildForwardingCodes(telstra, "unconditional", "+61285551234", "AU")!;
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
          expect(codes).not.toBeNull();
          expect(telHref(codes!.enable)).not.toBeNull();
          expect(telHref(codes!.disable)).not.toBeNull();
        }
      }
    }
  });

  it("never leaves the destination placeholder unsubstituted", () => {
    for (const country of ["AU", "US"] as const) {
      for (const carrier of getCarriersForCountry(country)) {
        for (const mode of ["conditional", "unconditional"] as const) {
          const codes = buildForwardingCodes(carrier, mode, "+61285551234", country)!;
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

// SCRUM-536: the guide lives permanently on /phone-numbers, so which numbers
// it offers as destinations is a product decision, pinned here because the
// component itself is unpinnable (no component-test harness, SCRUM-530).
describe("forwardingDestinations", () => {
  const base = { id: "p1", phone_number: "+61255550100", is_active: true };

  it("keeps active numbers of BOTH source types (a 'forwarded' row still holds the Phondo number)", () => {
    const purchased = { ...base, id: "a", source_type: "purchased" };
    const forwarded = { ...base, id: "b", source_type: "forwarded" };
    expect(forwardingDestinations([purchased, forwarded], "AU").map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("preserves input order — the caller's ordering decides the default destination", () => {
    // The component defaults to destinations[0] and most owners never open
    // the picker, so the order IS the product. Ids and phones are both
    // deliberately non-ascending so any helpful `.sort()` dies here.
    const rows = [
      { ...base, id: "z", phone_number: "+61255550300" },
      { ...base, id: "a", phone_number: "+61255550100" },
      { ...base, id: "m", phone_number: "+61255550200" },
    ];
    expect(forwardingDestinations(rows, "AU").map((n) => n.id)).toEqual(["z", "a", "m"]);
  });

  it("drops inactive numbers — their dial code would point at a released number", () => {
    expect(forwardingDestinations([{ ...base, is_active: false }], "AU")).toEqual([]);
  });

  it("drops rows with a null, empty or whitespace phone_number", () => {
    expect(
      forwardingDestinations(
        [
          { ...base, id: "n", phone_number: null },
          { ...base, id: "e", phone_number: "" },
          { ...base, id: "w", phone_number: "   " },
        ],
        "AU"
      )
    ).toEqual([]);
  });

  it("drops a number whose country cannot be established — the guide pane would render blank", () => {
    // ForwardingInstructions returns null for a country it has no rules for;
    // offering the number anyway produces a heading and picker above nothing.
    const nz = { ...base, id: "nz", phone_number: "+6421234567" };
    const au = { ...base, id: "au", phone_number: "+61255550100" };
    expect(forwardingDestinations([nz, au], "US").map((n) => n.id)).toEqual(["au"]);
    // Bare digits with no usable org country are unknowable too.
    expect(forwardingDestinations([{ ...base, phone_number: "0285551234" }], "")).toEqual([]);
  });

  it("returns [] for null/undefined input", () => {
    expect(forwardingDestinations(null, "AU")).toEqual([]);
    expect(forwardingDestinations(undefined, "AU")).toEqual([]);
  });
});

// SCRUM-536 companion pins: the picker label is the string a customer eyeballs
// to confirm where calls will land, and formatPhoneForCountry had no tests
// anywhere in the repo. Display-only (dial codes are re-derived from E.164
// downstream), but toNationalDialable is exactly the function class that
// rotted silently in SCRUM-516.
describe("formatPhoneForCountry", () => {
  it("formats AU landline and mobile E.164 for display", () => {
    expect(formatPhoneForCountry("+61255550100", "AU")).toBe("+61 2 5555 0100");
    expect(formatPhoneForCountry("+61412345678", "AU")).toBe("+61 412 345 678");
  });

  it("formats US E.164 and bare ten-digit numbers for display", () => {
    expect(formatPhoneForCountry("+15551234567", "US")).toBe("+1 (555) 123-4567");
    expect(formatPhoneForCountry("5551234567", "US")).toBe("(555) 123-4567");
  });

  it("passes through what it cannot recognise instead of mangling it", () => {
    expect(formatPhoneForCountry("gibberish", "AU")).toBe("gibberish");
    expect(formatPhoneForCountry("+6421234567", "AU")).toBe("+6421234567");
  });
});
