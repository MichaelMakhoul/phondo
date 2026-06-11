import { describe, it, expect, vi, beforeEach } from "vitest";
import RealStripe from "stripe";

// SCRUM-433: idempotency-key edge cases on the checkout route.
// (a) Reusing the org+plan+hour key after the original session was COMPLETED
//     (subscribe → cancel → re-subscribe within the hour) replays a dead
//     session — the route must detect it and mint a fresh single-use key,
//     UNLESS the completed session's subscription is still live (webhook
//     lag), in which case it must answer like the already-subscribed path.
// (b) A concurrent double-submit of the same key throws
//     StripeIdempotencyError with HTTP 409 — the route must return a
//     retry-friendly 409, not a generic 500. Any OTHER idempotency failure
//     (400 = key reused with different params) is retried ONCE with a fresh
//     nonce key.
// (c) The live-session retrieve is best-effort: if it fails after a
//     successful create, the route returns the created session instead of
//     500ing a healthy checkout.

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
  getSubscription: vi.fn(),
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
  getSubscription,
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
    "mints a fresh nonce key when the replayed session is %s and NOT backed by a live subscription",
    async (staleStatus) => {
      vi.mocked(createCheckoutSession)
        .mockResolvedValueOnce({ id: "cs_stale", url: "https://checkout.stripe.com/stale" } as never)
        .mockResolvedValueOnce({ id: "cs_fresh", url: "https://checkout.stripe.com/fresh" } as never);
      vi.mocked(retrieveCheckoutSession).mockResolvedValue({
        status: staleStatus,
        // Only a "complete" session carries a subscription; the route must
        // verify it is no longer live before minting a payable session.
        subscription: staleStatus === "complete" ? "sub_old" : null,
      } as never);
      vi.mocked(getSubscription).mockResolvedValue(
        { id: "sub_old", status: "canceled" } as never
      );

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

  it("routes to the billing portal (no fresh session) when the replayed session completed AND its subscription is live (webhook lag)", async () => {
    vi.mocked(createCheckoutSession).mockResolvedValue(
      { id: "cs_done", url: "https://checkout.stripe.com/done" } as never
    );
    vi.mocked(retrieveCheckoutSession).mockResolvedValue(
      { status: "complete", subscription: "sub_live" } as never
    );
    vi.mocked(getSubscription).mockResolvedValue(
      { id: "sub_live", status: "active" } as never
    );
    vi.mocked(createBillingPortalSession).mockResolvedValue(
      { url: "https://billing.stripe.com/p" } as never
    );

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://billing.stripe.com/p" });
    expect(getSubscription).toHaveBeenCalledWith("sub_live");
    // Minting a fresh payable session here would re-open the same-plan
    // double-subscribe window the DB guard closed.
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("falls back to the created session when the live-session retrieve fails (create succeeded — never 500 a healthy checkout)", async () => {
    vi.mocked(createCheckoutSession).mockResolvedValue(
      { id: "cs_1", url: "https://checkout.stripe.com/1" } as never
    );
    vi.mocked(retrieveCheckoutSession).mockRejectedValue(new Error("stripe blip"));

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/1" });
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("returns a retry-friendly 409 (not 500) when a concurrent checkout is already in flight (HTTP 409)", async () => {
    vi.mocked(createCheckoutSession).mockRejectedValue(
      new RealStripe.errors.StripeIdempotencyError({
        message: "There is currently another in-progress request using this Idempotency Key",
        statusCode: 409,
      } as never)
    );

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("checkout_in_progress");
    expect(body.error).toMatch(/already in progress/);
  });

  it("retries ONCE with a fresh nonce key when the key was reused with different params (HTTP 400)", async () => {
    vi.mocked(createCheckoutSession)
      .mockRejectedValueOnce(
        new RealStripe.errors.StripeIdempotencyError({
          message:
            "Keys for idempotent requests can only be used with the same parameters they were first used with",
          statusCode: 400,
        } as never)
      )
      .mockResolvedValueOnce(
        { id: "cs_retry", url: "https://checkout.stripe.com/retry" } as never
      );

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/retry" });
    expect(createCheckoutSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createCheckoutSession).mock.calls[1][5]).toEqual({
      idempotencyKey: expect.stringMatching(
        new RegExp(`^checkout:org-1:professional:\\d+:${UUID_RE}$`)
      ),
    });
    // The retry used a never-before-seen nonce key — nothing to replay, so no
    // staleness probe.
    expect(retrieveCheckoutSession).not.toHaveBeenCalled();
  });

  it("propagates to a 500 when the fresh-key retry ALSO fails (no retry loop)", async () => {
    vi.mocked(createCheckoutSession).mockRejectedValue(
      new RealStripe.errors.StripeIdempotencyError({
        message: "Keys for idempotent requests can only be used with the same parameters",
        statusCode: 400,
      } as never)
    );

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(500);
    expect(createCheckoutSession).toHaveBeenCalledTimes(2);
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
