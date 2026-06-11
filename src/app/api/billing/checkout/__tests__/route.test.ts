import { describe, it, expect, vi, beforeEach } from "vitest";
import RealStripe from "stripe";

// SCRUM-433: idempotency-key edge cases on the checkout route.
// (a) Reusing the org+plan+hour key after the original session was COMPLETED
//     (subscribe → cancel → re-subscribe within the hour) replays a dead
//     session — the route must detect it and mint a fresh single-use key.
// (b) A concurrent double-submit of the same key throws
//     StripeIdempotencyError — the route must return a retry-friendly 409,
//     not a generic 500.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) => cb({ setExtras: vi.fn(), setTag: vi.fn() })),
  captureMessage: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
  createBillingPortalSession: vi.fn(),
  retrieveCheckoutSession: vi.fn(),
  PLANS: {
    professional: { stripePriceId: "price_pro" },
  },
}));

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createCheckoutSession,
  createBillingPortalSession,
  retrieveCheckoutSession,
} from "@/lib/stripe";
import { POST } from "@/app/api/billing/checkout/route";

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function fakeServerClient(membership: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    single: async () => ({ data: membership, error: null }),
  });
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "o@x.com" } } }) },
    from: () => builder,
  };
}

// Admin client only serves the existing-subscription lookup here (the org
// already has a stripe_customer_id, so the customer-save path is not hit).
function fakeAdminClient(existingSub: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: existingSub, error: null }),
  });
  return { from: () => builder };
}

function checkoutRequest(planType = "professional") {
  return new Request("http://localhost/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ planType }),
  });
}

const MEMBERSHIP = {
  organization_id: "org-1",
  role: "owner",
  organizations: { id: "org-1", name: "Org One", stripe_customer_id: "cus_1" },
};

describe("POST /api/billing/checkout idempotency edges (SCRUM-433)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createClient).mockResolvedValue(fakeServerClient(MEMBERSHIP) as never);
    vi.mocked(createAdminClient).mockReturnValue(fakeAdminClient(null) as never);
  });

  it("returns the session from a single create when the (possibly replayed) session is still open", async () => {
    vi.mocked(createCheckoutSession).mockResolvedValue(
      { id: "cs_1", url: "https://checkout.stripe.com/1" } as never
    );
    vi.mocked(retrieveCheckoutSession).mockResolvedValue({ status: "open" } as never);

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/1" });
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createCheckoutSession).mock.calls[0][5]).toEqual({
      idempotencyKey: expect.stringMatching(/^checkout:org-1:professional:\d+$/),
    });
    expect(retrieveCheckoutSession).toHaveBeenCalledWith("cs_1");
  });

  it.each(["complete", "expired"] as const)(
    "mints a fresh nonce key when the replayed session is %s (re-subscribe within the same hour)",
    async (staleStatus) => {
      vi.mocked(createCheckoutSession)
        .mockResolvedValueOnce({ id: "cs_stale", url: "https://checkout.stripe.com/stale" } as never)
        .mockResolvedValueOnce({ id: "cs_fresh", url: "https://checkout.stripe.com/fresh" } as never);
      vi.mocked(retrieveCheckoutSession).mockResolvedValue({ status: staleStatus } as never);

      const res = await POST(checkoutRequest());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/fresh" });
      expect(createCheckoutSession).toHaveBeenCalledTimes(2);
      expect(vi.mocked(createCheckoutSession).mock.calls[1][5]).toEqual({
        idempotencyKey: expect.stringMatching(
          new RegExp(`^checkout:org-1:professional:\\d+:${UUID_RE}$`)
        ),
      });
    }
  );

  it("returns a retry-friendly 409 (not 500) when a concurrent checkout is already in flight", async () => {
    vi.mocked(createCheckoutSession).mockRejectedValue(
      new RealStripe.errors.StripeIdempotencyError({
        message: "There is currently another in-progress request using this Idempotency Key",
      } as never)
    );

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("checkout_in_progress");
    expect(body.error).toMatch(/already in progress/);
  });

  it("still returns a 500 for non-idempotency Stripe failures", async () => {
    vi.mocked(createCheckoutSession).mockRejectedValue(new Error("stripe down"));

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to create checkout session" });
  });

  it("never reaches session creation for an org that already has a live subscription", async () => {
    // Regression guard for the SCRUM-406 behavior the new code sits next to.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdminClient({ stripe_subscription_id: "sub_live", status: "active" }) as never
    );
    vi.mocked(createBillingPortalSession).mockResolvedValue(
      { url: "https://billing.stripe.com/p" } as never
    );

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://billing.stripe.com/p" });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
});
