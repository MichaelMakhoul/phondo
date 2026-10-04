import { describe, it, expect } from "vitest";
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
