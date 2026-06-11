import { describe, it, expect, vi, afterEach } from "vitest";

// PLANS reads the STRIPE_*_PRICE_ID env vars at module-evaluation time, so each
// test stubs the env and re-imports the module to rebuild the price->plan map.
describe("planTypeFromPriceId (SCRUM-407)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("maps a configured price id to its plan", async () => {
    vi.resetModules();
    vi.stubEnv("STRIPE_STARTER_PRICE_ID", "price_starter_x");
    vi.stubEnv("STRIPE_PROFESSIONAL_PRICE_ID", "price_pro_x");
    vi.stubEnv("STRIPE_BUSINESS_PRICE_ID", "price_biz_x");
    const { planTypeFromPriceId } = await import("@/lib/stripe/client");

    expect(planTypeFromPriceId("price_starter_x")).toBe("starter");
    expect(planTypeFromPriceId("price_pro_x")).toBe("professional");
    expect(planTypeFromPriceId("price_biz_x")).toBe("business");
  });

  it("returns undefined for an unknown, empty, or nullish price id", async () => {
    vi.resetModules();
    vi.stubEnv("STRIPE_PROFESSIONAL_PRICE_ID", "price_pro_x");
    const { planTypeFromPriceId } = await import("@/lib/stripe/client");

    expect(planTypeFromPriceId("price_does_not_exist")).toBeUndefined();
    expect(planTypeFromPriceId("")).toBeUndefined();
    expect(planTypeFromPriceId(null)).toBeUndefined();
    expect(planTypeFromPriceId(undefined)).toBeUndefined();
  });

  it("does not collapse two plans onto one id when env vars are unset (no false match)", async () => {
    vi.resetModules();
    // With the price-id env vars unset, every plan's stripePriceId is undefined.
    // A real undefined price id must not match those undefined slots.
    vi.stubEnv("STRIPE_STARTER_PRICE_ID", "");
    vi.stubEnv("STRIPE_PROFESSIONAL_PRICE_ID", "");
    vi.stubEnv("STRIPE_BUSINESS_PRICE_ID", "");
    const { planTypeFromPriceId } = await import("@/lib/stripe/client");

    expect(planTypeFromPriceId(undefined)).toBeUndefined();
    expect(planTypeFromPriceId("")).toBeUndefined();
  });
});
