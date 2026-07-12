import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-349: the Stripe webhook claims each event.id in stripe_processed_events
// before mutating billing state, so Stripe's at-least-once redelivery (or an
// in-window replay of a captured signed payload) is a no-op.

// Shared mutable state for the mocks (vi.hoisted so the factories can close over it).
const h = vi.hoisted(() => ({
  event: { id: "evt_test_1", type: "customer.subscription.updated", data: { object: {} } } as any,
  constructError: null as any,
  insertError: null as any,
  deleteError: null as any,
  deleteThrow: null as any,
  handlerError: null as any,
  inserts: [] as any[],
  deletes: [] as any[],
  pages: [] as any[],
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: vi.fn(() => {
    if (h.constructError) throw h.constructError;
    return h.event;
  }),
  PLANS: {},
  PlanType: {},
}));

// SCRUM-201: every failure path must page — capture the calls.
vi.mock("@/lib/observability/page-sentry", () => ({
  pageSentry: vi.fn((opts: any) => h.pages.push(opts)),
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
          if (h.deleteThrow) throw h.deleteThrow;
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
  h.constructError = null;
  h.insertError = null;
  h.deleteError = null;
  h.deleteThrow = null;
  h.handlerError = null;
  h.inserts = [];
  h.deletes = [];
  h.pages = [];
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

describe("POST /api/webhooks/stripe — failure paging (SCRUM-201)", () => {
  it("happy path pages nothing", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(h.pages).toEqual([]);
  });

  it("duplicate delivery (23505) is healthy — pages nothing", async () => {
    h.insertError = { code: "23505", message: "duplicate key" };
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(h.pages).toEqual([]);
  });

  it("signature verification failure pages at WARNING (probe noise must not email)", async () => {
    h.constructError = new Error("No signatures found matching the expected signature");
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toMatchObject({
      service: "next-api",
      reason: "stripe-webhook-signature-failed",
      level: "warning",
    });
  });

  it("ledger claim failure pages at ERROR with the event identity", async () => {
    h.insertError = { code: "08006", message: "connection failure" };
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toMatchObject({
      reason: "stripe-webhook-failed",
      level: "error",
      extras: { stage: "ledger-claim", eventId: "evt_test_1", eventType: "customer.subscription.updated" },
    });
  });

  it("handler failure pages ERROR exactly once — the outer catch must not double-page the re-throw", async () => {
    h.handlerError = new Error("boom");
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toMatchObject({
      reason: "stripe-webhook-failed",
      level: "error",
      err: h.handlerError,
      extras: { stage: "handler", eventId: "evt_test_1" },
    });
  });

  it("stranded event (handler throws + release fails) pages STRANDED at ERROR plus the handler failure", async () => {
    h.handlerError = new Error("boom");
    h.deleteError = { code: "08006", message: "connection failure" };
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const reasons = h.pages.map((p: any) => p.reason);
    expect(reasons).toContain("stripe-webhook-event-stranded");
    expect(reasons).toContain("stripe-webhook-failed");
    expect(h.pages).toHaveLength(2); // and nothing double-pages
    const stranded = h.pages.find((p: any) => p.reason === "stripe-webhook-event-stranded");
    expect(stranded).toMatchObject({
      level: "error",
      extras: { eventId: "evt_test_1", eventType: "customer.subscription.updated", code: "08006" },
    });
  });

  it("a THROWN claim release is the same stranded condition — coerced, paged as STRANDED with the event identity, handler error preserved", async () => {
    // Without the coercion the throw escapes to the outer catch: wrong
    // reason, stage=request, no eventId, and the original billing failure
    // is swallowed by the release throw.
    h.handlerError = new Error("boom");
    h.deleteThrow = new Error("fetch failed");
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const reasons = h.pages.map((p: any) => p.reason);
    expect(reasons).toContain("stripe-webhook-event-stranded");
    expect(h.pages).toHaveLength(2);
    const stranded = h.pages.find((p: any) => p.reason === "stripe-webhook-event-stranded");
    expect(stranded).toMatchObject({
      level: "error",
      extras: { eventId: "evt_test_1", code: "thrown" },
    });
    // The handler page still carries the ORIGINAL billing error.
    const handler = h.pages.find((p: any) => p.reason === "stripe-webhook-failed");
    expect(handler).toMatchObject({ err: h.handlerError, extras: { stage: "handler" } });
  });
});
