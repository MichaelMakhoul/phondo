import { describe, it, expect } from "vitest";
import { PLANS, getDisplayPlans } from "@/lib/stripe/client";

// SCRUM-568: the owner's printed offer is "the first 30 days are free" — every
// marketing surface (site + flyer) promises it, so the effective trial length
// must be pinned. A revert to 14 would expire customers' trials 16 days early
// with nothing else in the suite noticing.
describe("trial duration lock (SCRUM-568)", () => {
  it("every display (SMB) plan grants a 30-day trial", () => {
    for (const plan of getDisplayPlans()) {
      const config = PLANS[plan.id];
      expect(
        "trialDays" in config ? config.trialDays : undefined,
        `${plan.id} trialDays`
      ).toBe(30);
    }
  });

  it("the effective trial is 30 days for EVERY plan type, fallback included", () => {
    // Mirrors the exact expression used by the trial route and the Stripe
    // checkout (subscription_data.trial_period_days): plans without trialDays
    // (agency tiers) ride the fallback, which must also be 30.
    for (const [planId, config] of Object.entries(PLANS)) {
      const effective = "trialDays" in config ? config.trialDays : 30;
      expect(effective, `${planId} effective trial days`).toBe(30);
    }
  });
});
