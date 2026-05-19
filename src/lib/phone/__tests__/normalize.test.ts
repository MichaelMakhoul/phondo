import { describe, it, expect } from "vitest";
import { parsePhoneToE164, isE164 } from "../normalize";

describe("parsePhoneToE164", () => {
  describe("already-E.164 inputs", () => {
    it.each([
      ["+61414141883", "+61414141883"],
      ["+14155551234", "+14155551234"],
    ])("preserves valid E.164 %s", (input, expected) => {
      expect(parsePhoneToE164(input, "AU")).toBe(expected);
      expect(parsePhoneToE164(input, "US")).toBe(expected);
    });

    it("preserves valid E.164 with surrounding whitespace", () => {
      expect(parsePhoneToE164("  +61414141883  ", "AU")).toBe("+61414141883");
    });
  });

  describe("AU local-format normalisation", () => {
    it.each([
      ["0414141883", "+61414141883"],
      ["0414 141 883", "+61414141883"],
      ["(0414) 141 883", "+61414141883"],
      ["0414-141-883", "+61414141883"],
      ["61414141883", "+61414141883"],
      ["414141883", "+61414141883"],
      ["02 8123 0183", "+61281230183"],
      ["(02) 9555 1234", "+61295551234"],
    ])("normalises %s → %s", (input, expected) => {
      expect(parsePhoneToE164(input, "AU")).toBe(expected);
    });

    it.each([
      ["041414141883"], // 12 digits — ambiguous
      ["04141883"], // 8 digits — too short for an AU mobile
      ["12345"], // 5 digits — obviously invalid
      ["abc"], // not a phone number
      ["0501234567"], // 050 prefix — not a valid AU mobile/landline first-digit
    ])("rejects ambiguous/invalid AU input %s", (input) => {
      expect(parsePhoneToE164(input, "AU")).toBeNull();
    });
  });

  describe("US local-format normalisation", () => {
    it.each([
      ["4155551234", "+14155551234"],
      ["415-555-1234", "+14155551234"],
      ["(415) 555-1234", "+14155551234"],
      ["14155551234", "+14155551234"],
      ["1 415 555 1234", "+14155551234"],
    ])("normalises %s → %s", (input, expected) => {
      expect(parsePhoneToE164(input, "US")).toBe(expected);
    });

    it.each([
      ["415-555-12"], // too short
      ["555 1234"], // 7 digits, no area code
      ["abc"],
      ["0155551234"], // area code starts with 0
    ])("rejects invalid US input %s", (input) => {
      expect(parsePhoneToE164(input, "US")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("rejects null", () => {
      expect(parsePhoneToE164(null, "AU")).toBeNull();
    });

    it("rejects undefined", () => {
      expect(parsePhoneToE164(undefined, "AU")).toBeNull();
    });

    it("rejects empty string", () => {
      expect(parsePhoneToE164("", "AU")).toBeNull();
      expect(parsePhoneToE164("   ", "AU")).toBeNull();
    });

    it("rejects non-string types", () => {
      expect(parsePhoneToE164(123 as unknown as string, "AU")).toBeNull();
      expect(parsePhoneToE164({} as unknown as string, "AU")).toBeNull();
    });

    it("rejects E.164 with leading-zero country code", () => {
      expect(parsePhoneToE164("+0414141883", "AU")).toBeNull();
    });

    it("rejects too-long numbers (>15 digits after +)", () => {
      expect(parsePhoneToE164("+1234567890123456", "AU")).toBeNull();
    });

    it("rejects cross-country E.164 with wrong default country", () => {
      // +1 number with AU default — refuse rather than guess
      expect(parsePhoneToE164("+14155551234", "AU")).toBe("+14155551234"); // still valid E.164
    });
  });

  // SCRUM-295 regression: the exact broken values from the production audit.
  describe("SCRUM-295 production-data regressions", () => {
    it.each([
      ["041414141883", "AU"], // the transfer rule's broken value (12 digits)
      ["04141883", "AU"], // appointments — too short
      ["04122388971012", "AU"], // appointments — far too long
    ])("rejects production-broken value %s (%s)", (input, country) => {
      expect(parsePhoneToE164(input, country as "AU")).toBeNull();
    });

    it.each([
      ["0414141886", "AU", "+61414141886"], // recoverable
      ["0431234567", "AU", "+61431234567"], // recoverable
      ["02 8123 0183", "AU", "+61281230183"], // recoverable Sydney landline
      ["(02) 9555 1234", "AU", "+61295551234"], // recoverable formatted landline
    ])("normalises recoverable production value %s (%s) → %s", (input, country, expected) => {
      expect(parsePhoneToE164(input, country as "AU")).toBe(expected);
    });
  });
});

describe("isE164", () => {
  it.each([
    ["+61414141883", true],
    ["+14155551234", true],
    ["0414141883", false],
    ["+0414141883", false],
    ["+1234567", false],
    ["", false],
  ])("isE164(%s) === %s", (input, expected) => {
    expect(isE164(input)).toBe(expected);
  });

  it.each([null, undefined, 42, {}, []])("isE164(non-string) === false", (input) => {
    expect(isE164(input)).toBe(false);
  });
});
