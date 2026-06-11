import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-349: the Stripe webhook claims each event.id in stripe_processed_events
// before mutating billing state, so Stripe's at-least-once redelivery (or an
// in-window replay of a captured signed payload) is a no-op.

// Shared mutable state for the mocks (vi.hoisted so the factories can close over it).
const h = vi.hoisted(() => ({
  event: { id: "evt_test_1", type: "customer.subscription.updated", data: { object: {} } } as any,
  insertError: null as any,
  deleteError: null as any,
  handlerError: null as any,
  inserts: [] as any[],
  deletes: [] as any[],
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: vi.fn(() => h.event),
  PLANS: {},
  PlanType: {},
}));

vi.mock("@/lib/stripe/billing-service", () => ({
  handleSubscriptionCreated: vi.fn(async () => {
    if (h.handlerError) throw h.handlerError;
  }),
  handleSubscriptionUpdated: vi.fn(async () => {
    if (h.handlerError) throw h.handlerError;
  }),
  handleSubscriptionCanceled: vi.fn(async () => {}),
  // SCRUM-409: the invoice handlers throw on a real DB error so the ledger claim
  // is released and Stripe retries (asserted below).
  handleInvoicePaymentSucceeded: vi.fn(async () => {
    if (h.handlerError) throw h.handlerError;
  }),
  handleInvoicePaymentFailed: vi.fn(async () => {
    if (h.handlerError) throw h.handlerError;
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => ({
      insert: vi.fn((row: any) => {
        h.inserts.push({ table, row });
        return { error: h.insertError };
      }),
      delete: vi.fn(() => ({
        eq: vi.fn((col: string, val: any) => {
          h.deletes.push({ table, col, val });
          return { error: h.deleteError };
        }),
      })),
      // present for handlers that query (not exercised by these tests)
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })),
      })),
      update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
    })),
  })),
}));

import { POST } from "../route";
import * as billing from "@/lib/stripe/billing-service";

function makeReq() {
  return new Request("https://app.phondo.ai/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=deadbeef" },
    body: "{}",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.event = { id: "evt_test_1", type: "customer.subscription.updated", data: { object: {} } };
  h.insertError = null;
  h.deleteError = null;
  h.handlerError = null;
  h.inserts = [];
  h.deletes = [];
});

describe("POST /api/webhooks/stripe — idempotency ledger (SCRUM-349)", () => {
  it("processes a first-delivery event and records its id", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(billing.handleSubscriptionUpdated).toHaveBeenCalledTimes(1);
    expect(h.inserts).toEqual([
      { table: "stripe_processed_events", row: { event_id: "evt_test_1", event_type: "customer.subscription.updated" } },
    ]);
    expect(h.deletes).toEqual([]); // success → claim is kept
  });

  it("skips a duplicate event (unique violation) without re-processing", async () => {
    h.insertError = { code: "23505", message: "duplicate key" };
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, duplicate: true });
    expect(billing.handleSubscriptionUpdated).not.toHaveBeenCalled();
    expect(h.deletes).toEqual([]); // nothing to release — we never claimed it
  });

  it("fails closed (500) when the ledger insert errors for a non-conflict reason", async () => {
    h.insertError = { code: "08006", message: "connection failure" };
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(billing.handleSubscriptionUpdated).not.toHaveBeenCalled();
  });

  it("releases the claim and 500s when handler processing fails (so Stripe retries)", async () => {
    h.handlerError = new Error("boom");
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(billing.handleSubscriptionUpdated).toHaveBeenCalledTimes(1);
    // claim must be deleted so the redelivery isn't skipped as a duplicate
    expect(h.deletes).toEqual([
      { table: "stripe_processed_events", col: "event_id", val: "evt_test_1" },
    ]);
  });

  it("releases the claim and 500s when an invoice handler throws (SCRUM-409)", async () => {
    // Directly covers the seam this fix is about: a DB fault inside the invoice
    // handler must release the ledger row so Stripe's redelivery re-applies the
    // usage reset / past_due write rather than being skipped as a duplicate.
    h.event = { id: "evt_inv_1", type: "invoice.payment_succeeded", data: { object: {} } };
    h.handlerError = new Error("db down");
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(billing.handleInvoicePaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(h.deletes).toEqual([
      { table: "stripe_processed_events", col: "event_id", val: "evt_inv_1" },
    ]);
  });

  it("still 500s (re-throws) when the claim-release delete also fails", async () => {
    // Compound failure: handler throws AND the release delete errors. The route
    // must not crash on the unchecked delete; it logs and re-throws so Stripe
    // still gets a 500 and retries.
    h.handlerError = new Error("boom");
    h.deleteError = { code: "08006", message: "connection failure" };
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(h.deletes).toHaveLength(1); // release was attempted
  });
});
