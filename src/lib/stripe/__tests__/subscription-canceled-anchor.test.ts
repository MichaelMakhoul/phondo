import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

// SCRUM-475: handleSubscriptionCanceled persists the lapse anchor
// (subscriptions.service_ended_at). The anchor must be when paid access actually
// ENDED, not when cancellation was requested. For a cancel_at_period_end
// cancellation the customer.subscription.deleted event fires AT period end
// carrying canceled_at = the earlier request time and ended_at = the real
// access-end. Anchoring on canceled_at would zero the grace window and back-date
// the 90-day reclaim — these tests pin ended_at as the source of truth.

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { handleSubscriptionCanceled } from "@/lib/stripe/billing-service";

// Chainable supabase-js-shaped fake. The handler calls
//   .from("subscriptions").update(payload).eq("stripe_subscription_id", id)
// and awaits the builder (supabase-js's query builder is itself a thenable). We
// capture the update payload + eq filter so the test can assert what got written.
function fakeClient(opts: { updateError?: unknown } = {}) {
  const updateCalls: Array<Record<string, unknown>> = [];
  const eqCalls: Array<{ col: string; val: unknown }> = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    update: (payload: Record<string, unknown>) => {
      updateCalls.push(payload);
      return builder;
    },
    eq: (col: string, val: unknown) => {
      eqCalls.push({ col, val });
      return builder;
    },
    then: (resolve: (v: unknown) => void) => resolve({ error: opts.updateError ?? null }),
  });
  return { client: { from: () => builder }, updateCalls, eqCalls };
}

const mockedCreateAdminClient = vi.mocked(createAdminClient);

function sub(partial: Partial<Stripe.Subscription>): Stripe.Subscription {
  return { id: "sub_1", ...partial } as Stripe.Subscription;
}

const DAY_S = 86_400; // seconds per day (Stripe timestamps are epoch SECONDS)
const T0 = 1_700_000_000; // arbitrary epoch SECONDS — the cancel-REQUEST instant
const isoFromUnix = (unix: number) => new Date(unix * 1000).toISOString();

describe("handleSubscriptionCanceled — lapse anchor = service-end (SCRUM-475)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cancel_at_period_end: anchors service_ended_at on ended_at (period end), NOT canceled_at (request time)", async () => {
    // Requested at T0, but access actually ends 26 days later at period end.
    const endedAt = T0 + 26 * DAY_S;
    const { client, updateCalls, eqCalls } = fakeClient();
    mockedCreateAdminClient.mockReturnValue(client as never);

    await handleSubscriptionCanceled(sub({ id: "sub_pe", canceled_at: T0, ended_at: endedAt }));

    expect(updateCalls).toHaveLength(1);
    const payload = updateCalls[0];
    // The whole point of the fix: anchor on the access-END instant (T0+26d),
    // never the back-dated request time (T0) which would zero the grace window.
    expect(payload.service_ended_at).toBe(isoFromUnix(endedAt));
    expect(payload.service_ended_at).not.toBe(isoFromUnix(T0));
    expect(payload.status).toBe("canceled");
    expect(payload.cancel_at_period_end).toBe(true);
    expect(eqCalls).toEqual([{ col: "stripe_subscription_id", val: "sub_pe" }]);
  });

  it("immediate cancel: canceled_at == ended_at → anchors on that shared instant", async () => {
    const { client, updateCalls } = fakeClient();
    mockedCreateAdminClient.mockReturnValue(client as never);

    await handleSubscriptionCanceled(sub({ id: "sub_now", canceled_at: T0, ended_at: T0 }));

    expect(updateCalls[0].service_ended_at).toBe(isoFromUnix(T0));
  });

  it("falls back to canceled_at when ended_at is absent", async () => {
    const { client, updateCalls } = fakeClient();
    mockedCreateAdminClient.mockReturnValue(client as never);

    await handleSubscriptionCanceled(sub({ id: "sub_fb", canceled_at: T0, ended_at: null }));

    expect(updateCalls[0].service_ended_at).toBe(isoFromUnix(T0));
  });

  it("writes null when neither ended_at nor canceled_at is present", async () => {
    const { client, updateCalls } = fakeClient();
    mockedCreateAdminClient.mockReturnValue(client as never);

    await handleSubscriptionCanceled(sub({ id: "sub_null", canceled_at: null, ended_at: null }));

    expect(updateCalls[0].service_ended_at).toBeNull();
  });

  it("THROWS when the update fails (→ webhook retries)", async () => {
    const { client } = fakeClient({ updateError: { message: "db down" } });
    mockedCreateAdminClient.mockReturnValue(client as never);

    await expect(
      handleSubscriptionCanceled(sub({ id: "sub_err", canceled_at: T0, ended_at: T0 })),
    ).rejects.toThrow(/cancellation failed/);
  });
});
