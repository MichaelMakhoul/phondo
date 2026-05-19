import { describe, it, expect } from "vitest";
import {
  expectedE164PrefixForCountry,
  matchesCountryPrefix,
  buildTestCallTwiml,
} from "../helpers";

describe("expectedE164PrefixForCountry", () => {
  it("returns +1 for US", () => {
    expect(expectedE164PrefixForCountry("US")).toBe("+1");
  });

  it("returns +1 for CA (shares NANP with US)", () => {
    expect(expectedE164PrefixForCountry("CA")).toBe("+1");
  });

  it("returns +61 for AU", () => {
    expect(expectedE164PrefixForCountry("AU")).toBe("+61");
  });

  it("is case-insensitive", () => {
    expect(expectedE164PrefixForCountry("au")).toBe("+61");
    expect(expectedE164PrefixForCountry("Au")).toBe("+61");
  });

  it("returns null for unknown countries", () => {
    expect(expectedE164PrefixForCountry("ZZ")).toBeNull();
    expect(expectedE164PrefixForCountry("GB")).toBeNull(); // not yet supported
  });

  it("returns null for null/undefined/empty", () => {
    expect(expectedE164PrefixForCountry(null)).toBeNull();
    expect(expectedE164PrefixForCountry(undefined)).toBeNull();
    expect(expectedE164PrefixForCountry("")).toBeNull();
  });
});

describe("matchesCountryPrefix", () => {
  describe("matches when phone and country agree", () => {
    it("US org + US E.164", () => {
      expect(matchesCountryPrefix("+14155551234", "US")).toBe(true);
    });

    it("AU org + AU E.164", () => {
      expect(matchesCountryPrefix("+61412345678", "AU")).toBe(true);
    });

    it("US org + Canada number (NANP)", () => {
      expect(matchesCountryPrefix("+14165550100", "US")).toBe(true);
    });
  });

  describe("rejects mismatched country", () => {
    it("AU org + US E.164 → reject", () => {
      expect(matchesCountryPrefix("+14155551234", "AU")).toBe(false);
    });

    it("US org + AU E.164 → reject", () => {
      expect(matchesCountryPrefix("+61412345678", "US")).toBe(false);
    });

    it("US org + UK E.164 → reject (UK not currently in the prefix map)", () => {
      expect(matchesCountryPrefix("+447911123456", "US")).toBe(false);
    });
  });

  describe("rejects when country is unknown", () => {
    it("unknown country → reject (never guess)", () => {
      expect(matchesCountryPrefix("+14155551234", "ZZ")).toBe(false);
    });

    it("null country → reject", () => {
      expect(matchesCountryPrefix("+14155551234", null)).toBe(false);
    });
  });
});

describe("buildTestCallTwiml", () => {
  it("returns valid TwiML with the expected disclosure message", () => {
    const xml = buildTestCallTwiml();
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain("<Response>");
    expect(xml).toContain("</Response>");
    expect(xml).toContain("<Say");
    expect(xml).toContain("Polly.Joanna");
    expect(xml).toContain("This is a test call from Phondo");
    expect(xml).toContain("<Hangup/>");
  });

  it("Say element appears before Hangup", () => {
    const xml = buildTestCallTwiml();
    expect(xml.indexOf("<Say")).toBeLessThan(xml.indexOf("<Hangup/>"));
  });

  it("does not include any unsafe templating placeholders", () => {
    const xml = buildTestCallTwiml();
    // The TwiML is hard-coded — no user input is interpolated, so XML
    // escaping isn't strictly required, but make sure the helper isn't
    // accidentally introducing template-leak markers.
    expect(xml).not.toContain("${");
    expect(xml).not.toContain("{{");
    expect(xml).not.toContain("<%");
  });
});
