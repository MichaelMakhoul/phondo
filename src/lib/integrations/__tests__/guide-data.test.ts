import { describe, it, expect } from "vitest";
import {
  getRecommendedPlatforms,
  INTEGRATION_GUIDES,
  INDUSTRY_RECOMMENDATIONS,
} from "../guide-data";

describe("getRecommendedPlatforms", () => {
  it("returns dental recommendations for dental industry", () => {
    const rec = getRecommendedPlatforms("dental");
    expect(rec.industry).toBe("dental");
    expect(rec.label).toBe("Dental Practice");
    expect(rec.tools.length).toBeGreaterThan(0);
    expect(rec.tip).toBeTruthy();
  });

  it("returns home services recommendations", () => {
    const rec = getRecommendedPlatforms("home_services");
    expect(rec.industry).toBe("home_services");
    expect(rec.tools).toContain("ServiceM8");
  });

  it("falls back to generic for unknown industry", () => {
    const rec = getRecommendedPlatforms("unknown_industry");
    expect(rec.industry).toBe("other");
    expect(rec.label).toBe("General Business");
  });

  it("falls back to generic for null industry", () => {
    const rec = getRecommendedPlatforms(null);
    expect(rec.industry).toBe("other");
  });
});

describe("INTEGRATION_GUIDES", () => {
  it("has guides for all supported platforms", () => {
    const platformIds = INTEGRATION_GUIDES.map((g) => g.platformId);
    expect(platformIds).toContain("zapier");
    expect(platformIds).toContain("make");
    expect(platformIds).toContain("google_sheets");
    expect(platformIds).toContain("webhook");
  });

  it("all guides have required fields", () => {
    for (const guide of INTEGRATION_GUIDES) {
      expect(guide.name).toBeTruthy();
      expect(guide.description).toBeTruthy();
      expect(guide.steps.length).toBeGreaterThan(0);
    }
  });

  it("webhook guide includes payload example", () => {
    const webhookGuide = INTEGRATION_GUIDES.find((g) => g.platformId === "webhook");
    expect(webhookGuide?.payloadNote).toBeTruthy();
    expect(webhookGuide?.payloadNote).toContain("x-phondo-signature");
  });
});

describe("INDUSTRY_RECOMMENDATIONS", () => {
  it("covers all major industries", () => {
    const industries = INDUSTRY_RECOMMENDATIONS.map((r) => r.industry);
    expect(industries).toContain("dental");
    expect(industries).toContain("medical");
    expect(industries).toContain("legal");
    expect(industries).toContain("home_services");
    expect(industries).toContain("real_estate");
    expect(industries).toContain("salon");
    expect(industries).toContain("automotive");
    expect(industries).toContain("veterinary");
    expect(industries).toContain("restaurant");
    expect(industries).toContain("other");
  });

  it("each recommendation has tools and tips", () => {
    for (const rec of INDUSTRY_RECOMMENDATIONS) {
      expect(rec.tools.length).toBeGreaterThan(0);
      expect(rec.tip).toBeTruthy();
      expect(rec.label).toBeTruthy();
    }
  });
});
