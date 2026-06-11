import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

// SCRUM-433: two checkout tabs with DIFFERENT plans produce two real Stripe
// subscriptions (different idempotency keys, both pass the DB guard before
// either webhook lands). The subscriptions upsert is keyed on organization_id,
// so the second webhook would silently ORPHAN the first subscription — Stripe
// keeps billing it while our DB forgets it. handleSubscriptionCreated must
// detect the conflict and cancel the orphan instead.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) => cb({ setExtras: vi.fn(), setTag: vi.fn() })),
  captureMessage: vi.fn(),
}));
// Keep PLANS/planTypeFromPriceId real; only stub the Stripe client factory.
vi.mock("@/lib/stripe/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe/client")>();
  return { ...actual, getStripeClient: vi.fn() };
});

import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripeClient } from "@/lib/stripe/client";
import { handleSubscriptionCreated } from "@/lib/stripe/billing-service";

// Chainable supabase-js-shaped fake covering both queries the handler makes:
// .select().eq().maybeSingle() (existing-row lookup) and .upsert() (the write).
function fakeAdmin(opts: { existing?: unknown; selectError?: unknown; upsertError?: unknown }) {
  const upsertCalls: Array<{ row: Record<string, unknown> }> = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: opts.existing ?? null, error: opts.selectError ?? null }),
    upsert: (row: Record<string, unknown>) => {
      upsertCalls.push({ row });
      return Promise.resolve({ error: opts.upsertError ?? null });
    },
  });
  return { client: { from: () => builder }, upsertCalls };
}

function stripeMock() {
  return {
    subscriptions: {
      retrieve: vi.fn(async (id: string) => ({ id, status: "active" })),
      cancel: vi.fn(async () => ({})),
    },
  };
}

function sub(partial: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_new",
    status: "active",
    metadata: { organizationId: "org-1", plan: "professional" },
    items: { data: [{ price: { id: "price_x" } }] },
    current_period_start: 1_700_000_000,
    current_period_end: 1_702_592_000,
    trial_end: null,
    cancel_at_period_end: false,
    ...partial,
  } as unknown as Stripe.Subscription;
}

describe("handleSubscriptionCreated duplicate-subscription guard (SCRUM-433)", () => {
  let stripe: ReturnType<typeof stripeMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    stripe = stripeMock();
    vi.mocked(getStripeClient).mockReturnValue(stripe as never);
  });

  it("upserts normally when the org has no subscription row", async () => {
    const { client, upsertCalls } = fakeAdmin({ existing: null });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await handleSubscriptionCreated(sub());

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].row.stripe_subscription_id).toBe("sub_new");
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it("upserts over the trial_<orgId> placeholder without touching Stripe", async () => {
    const { client, upsertCalls } = fakeAdmin({
      existing: { stripe_subscription_id: "trial_org-1", status: "trialing" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await handleSubscriptionCreated(sub());

    expect(upsertCalls).toHaveLength(1);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it("upserts idempotently when the row already holds the SAME subscription id", async () => {
    const { client, upsertCalls } = fakeAdmin({
      existing: { stripe_subscription_id: "sub_new", status: "active" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await handleSubscriptionCreated(sub());

    expect(upsertCalls).toHaveLength(1);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it("upserts over a different subscription that is NOT live in the DB (re-subscribe after cancel)", async () => {
    const { client, upsertCalls } = fakeAdmin({
      existing: { stripe_subscription_id: "sub_old", status: "canceled" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await handleSubscriptionCreated(sub());

    expect(upsertCalls).toHaveLength(1);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it("cancels the orphaned previous subscription when both are live, flags Sentry, and records the incoming one", async () => {
    const { client, upsertCalls } = fakeAdmin({
      existing: { stripe_subscription_id: "sub_old", status: "active" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await handleSubscriptionCreated(sub());

    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_old");
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("duplicate subscription"),
      "error"
    );
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].row.stripe_subscription_id).toBe("sub_new");
  });

  it("keeps the existing row (no cancel, no upsert) when the INCOMING sub is no longer live — it lost the race", async () => {
    // Each sub funnels through twice (checkout.session.completed +
    // customer.subscription.created). If a late event arrives for a sub we
    // already canceled, writing it would cancel the survivor too.
    const { client, upsertCalls } = fakeAdmin({
      existing: { stripe_subscription_id: "sub_old", status: "active" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      id,
      status: id === "sub_new" ? "canceled" : "active",
    }));

    await handleSubscriptionCreated(sub());

    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(upsertCalls).toHaveLength(0);
  });

  it("overwrites WITHOUT canceling when the existing sub is no longer live at Stripe (stale DB status)", async () => {
    const { client, upsertCalls } = fakeAdmin({
      existing: { stripe_subscription_id: "sub_old", status: "active" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      id,
      status: id === "sub_old" ? "canceled" : "active",
    }));

    await handleSubscriptionCreated(sub());

    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].row.stripe_subscription_id).toBe("sub_new");
  });

  it("overwrites WITHOUT canceling when the existing sub id is missing at Stripe (resource_missing)", async () => {
    const { client, upsertCalls } = fakeAdmin({
      existing: { stripe_subscription_id: "sub_old", status: "active" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => {
      if (id === "sub_old") throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
      return { id, status: "active" };
    });

    await handleSubscriptionCreated(sub());

    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(upsertCalls).toHaveLength(1);
  });

  it("THROWS (→ webhook retries) on a transient Stripe error while checking the existing sub", async () => {
    const { client, upsertCalls } = fakeAdmin({
      existing: { stripe_subscription_id: "sub_old", status: "active" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => {
      if (id === "sub_old") throw Object.assign(new Error("api down"), { code: "api_error" });
      return { id, status: "active" };
    });

    await expect(handleSubscriptionCreated(sub())).rejects.toThrow("api down");
    expect(upsertCalls).toHaveLength(0);
  });

  it("THROWS (→ webhook retries) when the orphan cancel fails, without recording the new sub", async () => {
    const { client, upsertCalls } = fakeAdmin({
      existing: { stripe_subscription_id: "sub_old", status: "active" },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    stripe.subscriptions.cancel.mockRejectedValue(new Error("cancel failed"));

    await expect(handleSubscriptionCreated(sub())).rejects.toThrow("cancel failed");
    expect(upsertCalls).toHaveLength(0);
  });

  it("THROWS (→ webhook retries) when the existing-row lookup errors", async () => {
    const { client, upsertCalls } = fakeAdmin({ selectError: { message: "db down" } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await expect(handleSubscriptionCreated(sub())).rejects.toThrow(/lookup failed/);
    expect(upsertCalls).toHaveLength(0);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });
});
