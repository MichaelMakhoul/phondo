import { describe, it, expect } from "vitest";
import { updatePhoneNumberSchema, E164_REGEX } from "../route";

// SCRUM-kill-switch regression suite for the PATCH input schema.
// The tri-state semantics (undefined / null / string) are load-bearing — a
// past bug had the transform collapse undefined → null, which silently
// wiped the saved fallback on every unrelated PATCH (e.g., assigning an
// assistant). These tests pin that behaviour shut.

describe("updatePhoneNumberSchema.fallbackForwardNumber", () => {
  it("preserves undefined when the field is omitted entirely", () => {
    const parsed = updatePhoneNumberSchema.parse({ aiEnabled: true });
    expect(parsed.fallbackForwardNumber).toBeUndefined();
  });

  it("treats explicit null as a clear", () => {
    const parsed = updatePhoneNumberSchema.parse({ fallbackForwardNumber: null });
    expect(parsed.fallbackForwardNumber).toBeNull();
  });

  it("treats empty string as a clear", () => {
    const parsed = updatePhoneNumberSchema.parse({ fallbackForwardNumber: "" });
    expect(parsed.fallbackForwardNumber).toBeNull();
  });

  it("trims surrounding whitespace before validation", () => {
    const parsed = updatePhoneNumberSchema.parse({ fallbackForwardNumber: "  +61412345678  " });
    expect(parsed.fallbackForwardNumber).toBe("+61412345678");
  });

  it("rejects whitespace-only strings (trim → '' → fails E.164 refine)", () => {
    // "   " enters the trim branch → trims to "" → refine sees a string that
    // is neither null nor matches E164_REGEX → throws. This documents the
    // current behaviour: only literal "" or null clears the fallback.
    expect(() =>
      updatePhoneNumberSchema.parse({ fallbackForwardNumber: "   " })
    ).toThrow();
  });

  it("rejects malformed E.164 (no country code prefix)", () => {
    expect(() =>
      updatePhoneNumberSchema.parse({ fallbackForwardNumber: "0412345678" })
    ).toThrow();
  });

  it("rejects malformed E.164 (leading zero in country code)", () => {
    expect(() =>
      updatePhoneNumberSchema.parse({ fallbackForwardNumber: "+0412345678" })
    ).toThrow();
  });

  it("rejects formatted numbers with spaces or punctuation", () => {
    expect(() =>
      updatePhoneNumberSchema.parse({ fallbackForwardNumber: "+61 412 345 678" })
    ).toThrow();
    expect(() =>
      updatePhoneNumberSchema.parse({ fallbackForwardNumber: "(02) 9999 1234" })
    ).toThrow();
  });

  it("accepts valid AU mobile in E.164", () => {
    const parsed = updatePhoneNumberSchema.parse({ fallbackForwardNumber: "+61412345678" });
    expect(parsed.fallbackForwardNumber).toBe("+61412345678");
  });

  it("accepts valid US number in E.164", () => {
    const parsed = updatePhoneNumberSchema.parse({ fallbackForwardNumber: "+14155551234" });
    expect(parsed.fallbackForwardNumber).toBe("+14155551234");
  });

  it("rejects extremely long numbers (>15 digits after +)", () => {
    expect(() =>
      updatePhoneNumberSchema.parse({ fallbackForwardNumber: "+1234567890123456" })
    ).toThrow();
  });

  it("rejects too-short numbers (<8 digits after +)", () => {
    expect(() =>
      updatePhoneNumberSchema.parse({ fallbackForwardNumber: "+12345" })
    ).toThrow();
  });

  it("does not touch other fields when only fallbackForwardNumber is set", () => {
    const parsed = updatePhoneNumberSchema.parse({ fallbackForwardNumber: "+61412345678" });
    expect(parsed.assistantId).toBeUndefined();
    expect(parsed.aiEnabled).toBeUndefined();
    expect(parsed.friendlyName).toBeUndefined();
  });

  // Regression test for the bug found in type-design review: a PATCH that
  // only sets, say, assistantId must NOT cause fallback_forward_number to be
  // written to NULL. The route handler relies on
  //   if (validatedData.fallbackForwardNumber !== undefined) { ... }
  // to gate the DB write. If undefined collapses to null, that gate opens
  // and saved fallbacks get silently wiped.
  it("REGRESSION: unrelated PATCH does not produce a defined fallbackForwardNumber", () => {
    const parsed = updatePhoneNumberSchema.parse({ assistantId: "00000000-0000-4000-8000-000000000000" });
    expect(parsed.fallbackForwardNumber).toBeUndefined();
    // Explicit assertion: the value must compare === undefined, not just be falsy.
    // `null !== undefined` so this catches the bug if it regresses.
    expect(parsed.fallbackForwardNumber === undefined).toBe(true);
  });
});

describe("E164_REGEX (shared by API and voice-server)", () => {
  it.each([
    ["+61412345678", true],
    ["+14155551234", true],
    ["+442071838750", true],
    ["+12345678", true], // 8-digit minimum
    ["+123456789012345", true], // 15-digit maximum
  ])("accepts %s", (input, expected) => {
    expect(E164_REGEX.test(input)).toBe(expected);
  });

  it.each([
    ["0412345678", false],
    ["+0412345678", false],
    ["+61 412 345 678", false],
    ["+a12345678", false],
    ["+1234567", false], // too short (7 digits)
    ["+1234567890123456", false], // too long (16 digits)
    ["", false],
    ["+", false],
  ])("rejects %s", (input, expected) => {
    expect(E164_REGEX.test(input)).toBe(expected);
  });
});
