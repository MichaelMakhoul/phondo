import { describe, it, expect, vi, afterEach } from "vitest";
import { DEMO_INDUSTRIES, DEMO_PHONE_LINES, demoIndustryFromSearch, isDemoIndustry } from "../config";

// Tradie outreach links straight to the plumber persona (/demo?industry=home_services),
// while plain /demo stays on the dental demo the live ads promise.

describe("demoIndustryFromSearch", () => {
  it("reads a valid ?industry= deep link", () => {
    expect(demoIndustryFromSearch("?industry=home_services")).toBe("home_services");
    expect(demoIndustryFromSearch("?utm_source=sms&industry=legal")).toBe("legal");
  });

  it("ignores a missing or unknown industry", () => {
    expect(demoIndustryFromSearch("")).toBeNull();
    expect(demoIndustryFromSearch("?industry=plumber")).toBeNull();
    expect(demoIndustryFromSearch("?industry=")).toBeNull();
  });

  it("rejects inherited object keys, which `in` would have let through", () => {
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(demoIndustryFromSearch(`?industry=${key}`)).toBeNull();
      expect(isDemoIndustry(key)).toBe(false);
    }
  });
});

describe("demo personas", () => {
  it("the trades demo answers as Copperline Plumbing", () => {
    expect(DEMO_INDUSTRIES.home_services.name).toBe("Copperline Plumbing");
  });

  it("each tap-to-call line names the persona it answers as", () => {
    expect(DEMO_PHONE_LINES.dental?.persona).toBe("our demo dental clinic");
    expect(DEMO_PHONE_LINES.home_services?.persona).toBe("our demo plumbing business");
    expect(DEMO_PHONE_LINES.legal).toBeUndefined();
  });
});

describe("DEMO_PHONE_LINES pairs each number with the persona that answers it", () => {
  // A swapped env var would label one business's number as another's: the
  // dental number answers as a real org, the trades number as the plumber.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("the dental line carries the dental env number, the trades line the trades env number", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_PHONE_NUMBER", "+61238205672");
    vi.stubEnv("NEXT_PUBLIC_DEMO_TRADES_PHONE_NUMBER", "+61299990000");
    vi.resetModules();
    const { DEMO_PHONE_LINES: lines } = await import("../config");
    expect(lines.dental).toEqual({ number: "+61238205672", persona: "our demo dental clinic" });
    expect(lines.home_services).toEqual({ number: "+61299990000", persona: "our demo plumbing business" });
  });
});
