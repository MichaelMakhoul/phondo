import { describe, it, expect } from "vitest";
import { analyzePhoneNumber } from "@/lib/spam/spam-detector";
import { getCountryForCallingCode } from "@/lib/country-config";

// SCRUM-441: phone-format scoring must validate an E.164 caller under the
// number's OWN country (derived from its calling code), not the org's.
// Previously a legitimate +1 US caller dialing an AU org failed AU
// validateNational and ate the +5 "Invalid phone number format" penalty —
// stacking toward the 50 "flag" threshold for every cross-border caller.

describe("getCountryForCallingCode", () => {
  it("maps a +1 number's digits to US", () => {
    expect(getCountryForCallingCode("15125550173")).toBe("US");
  });

  it("maps a +61 number's digits to AU", () => {
    expect(getCountryForCallingCode("61295550123")).toBe("AU");
  });

  it("returns null for an unsupported calling code (+44 UK)", () => {
    expect(getCountryForCallingCode("442079460958")).toBeNull();
  });
});

describe("analyzePhoneNumber cross-border E.164 scoring (SCRUM-441)", () => {
  it("does NOT format-penalize a legitimate +1 US caller analyzed under an AU org", () => {
    // The SCRUM-441 pin: previously scored +5 "Invalid phone number format".
    const r = analyzePhoneNumber("+15125550173", "AU");
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("scores the same +1 caller identically under a US org", () => {
    const r = analyzePhoneNumber("+15125550173", "US");
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("does NOT format-penalize a +61 AU caller analyzed under a US org", () => {
    const r = analyzePhoneNumber("+61295550123", "US");
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("scores a +1 caller's suspicious area code under US rules even for an AU org", () => {
    // Area-code extraction must follow the derived country too — "201" is in
    // the US suspicious list and AU extraction would never find it.
    const r = analyzePhoneNumber("+12015550168", "AU");
    expect(r.score).toBe(15);
    expect(r.reasons[0]).toMatch(/Area code 201/);
  });

  it("still format-penalizes a malformed number under its own calling code (+61 with too few digits)", () => {
    const r = analyzePhoneNumber("+6112345", "AU");
    expect(r.score).toBe(5);
    expect(r.reasons).toContain("Invalid phone number format");
  });

  it("falls back to the org country for national-format numbers (no calling code to derive from)", () => {
    // Valid AU national number under an AU org — no "+" so org country rules apply.
    const r = analyzePhoneNumber("0295550123", "AU");
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("falls back to the org country for E.164 numbers from unsupported countries (+44 under AU org)", () => {
    // Documented current behavior: no supported config owns "44", so the org's
    // AU rules apply and the format penalty stands. A small penalty on a
    // genuinely foreign caller is acceptable until the country is supported.
    const r = analyzePhoneNumber("+442079460958", "AU");
    expect(r.score).toBe(5);
    expect(r.reasons).toContain("Invalid phone number format");
  });
});
