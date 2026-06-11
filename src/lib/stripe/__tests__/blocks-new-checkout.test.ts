import { describe, it, expect } from "vitest";
import { blocksNewCheckout } from "@/lib/stripe/billing-service";

describe("blocksNewCheckout (SCRUM-406)", () => {
  it("does not block when there is no subscription row", () => {
    expect(blocksNewCheckout(null)).toBe(false);
  });

  it("does not block the trial_<orgId> placeholder (free-trial → paid is the point)", () => {
    expect(
      blocksNewCheckout({ stripe_subscription_id: "trial_abc-123", status: "trialing" })
    ).toBe(false);
  });

  it("does not block a row with an empty/placeholder subscription id", () => {
    expect(blocksNewCheckout({ stripe_subscription_id: "", status: "trialing" })).toBe(false);
    expect(blocksNewCheckout({ stripe_subscription_id: null, status: "active" })).toBe(false);
  });

  it("blocks a real active Stripe subscription", () => {
    expect(
      blocksNewCheckout({ stripe_subscription_id: "sub_123", status: "active" })
    ).toBe(true);
  });

  it("blocks a real Stripe-side trial and a past_due subscription", () => {
    expect(blocksNewCheckout({ stripe_subscription_id: "sub_123", status: "trialing" })).toBe(true);
    expect(blocksNewCheckout({ stripe_subscription_id: "sub_123", status: "past_due" })).toBe(true);
  });

  it("does not block a real subscription that is canceled or expired (re-subscribe allowed)", () => {
    expect(blocksNewCheckout({ stripe_subscription_id: "sub_123", status: "canceled" })).toBe(false);
    expect(
      blocksNewCheckout({ stripe_subscription_id: "sub_123", status: "incomplete_expired" })
    ).toBe(false);
  });

  it("does not block when status is missing", () => {
    expect(blocksNewCheckout({ stripe_subscription_id: "sub_123" })).toBe(false);
  });
});
