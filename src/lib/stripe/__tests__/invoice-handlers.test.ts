import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

// Mock the service-role client used by the invoice handlers + resetMonthlyUsage.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
} from "@/lib/stripe/billing-service";

// A chainable supabase-js-shaped fake. `.maybeSingle()` resolves the select
// result; awaiting the builder (the `.update().eq()` path) resolves the update
// result — mirroring supabase-js where the query builder is itself a thenable.
function fakeClient(opts: { sub?: unknown; selectError?: unknown; updateError?: unknown }) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    update: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: opts.sub ?? null, error: opts.selectError ?? null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: null, error: opts.updateError ?? null }),
  });
  return { from: () => builder };
}

const mockedCreateAdminClient = vi.mocked(createAdminClient);

function invoice(partial: Partial<Stripe.Invoice>): Stripe.Invoice {
  return partial as Stripe.Invoice;
}

describe("handleInvoicePaymentSucceeded (SCRUM-409)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resets usage and does not throw on the happy path", async () => {
    mockedCreateAdminClient.mockReturnValue(
      fakeClient({ sub: { organization_id: "org-1" }, updateError: null }) as never,
    );
    await expect(
      handleInvoicePaymentSucceeded(invoice({ subscription: "sub_1", billing_reason: "subscription_cycle" })),
    ).resolves.toBeUndefined();
  });

  it("THROWS when the subscription lookup errors (→ webhook retries)", async () => {
    mockedCreateAdminClient.mockReturnValue(
      fakeClient({ selectError: { message: "db down" } }) as never,
    );
    await expect(
      handleInvoicePaymentSucceeded(invoice({ subscription: "sub_1", billing_reason: "subscription_cycle" })),
    ).rejects.toThrow(/lookup failed/);
  });

  it("THROWS when the usage reset write fails", async () => {
    mockedCreateAdminClient.mockReturnValue(
      fakeClient({ sub: { organization_id: "org-1" }, updateError: { message: "write failed" } }) as never,
    );
    await expect(
      handleInvoicePaymentSucceeded(invoice({ subscription: "sub_1", billing_reason: "subscription_cycle" })),
    ).rejects.toThrow(/Failed to reset monthly usage/);
  });

  it("acks (no throw, no reset) when there is no local subscription row", async () => {
    // updateError is set: if reset were called it would throw — it must not be.
    mockedCreateAdminClient.mockReturnValue(
      fakeClient({ sub: null, updateError: { message: "would throw" } }) as never,
    );
    await expect(
      handleInvoicePaymentSucceeded(invoice({ subscription: "sub_1", billing_reason: "subscription_cycle" })),
    ).resolves.toBeUndefined();
  });

  it("does nothing for non-cycle invoices and never touches the DB", async () => {
    await expect(
      handleInvoicePaymentSucceeded(invoice({ subscription: "sub_1", billing_reason: "subscription_create" })),
    ).resolves.toBeUndefined();
    expect(mockedCreateAdminClient).not.toHaveBeenCalled();
  });

  it("does nothing when there is no subscription id", async () => {
    await expect(handleInvoicePaymentSucceeded(invoice({ billing_reason: "subscription_cycle" }))).resolves.toBeUndefined();
    expect(mockedCreateAdminClient).not.toHaveBeenCalled();
  });
});

describe("handleInvoicePaymentFailed (SCRUM-409)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks past_due without throwing on success", async () => {
    mockedCreateAdminClient.mockReturnValue(fakeClient({ updateError: null }) as never);
    await expect(
      handleInvoicePaymentFailed(invoice({ subscription: "sub_1" })),
    ).resolves.toBeUndefined();
  });

  it("THROWS when the past_due update fails (→ webhook retries)", async () => {
    mockedCreateAdminClient.mockReturnValue(fakeClient({ updateError: { message: "db down" } }) as never);
    await expect(
      handleInvoicePaymentFailed(invoice({ subscription: "sub_1" })),
    ).rejects.toThrow(/update failed/);
  });

  it("does nothing when there is no subscription id", async () => {
    await expect(handleInvoicePaymentFailed(invoice({}))).resolves.toBeUndefined();
    expect(mockedCreateAdminClient).not.toHaveBeenCalled();
  });
});
