import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-422 (audit finding #6): the Stripe billing portal exposes invoices,
// payment methods, and plan changes — it must be owner/admin gated, not open
// to every org member.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  createBillingPortalSession: vi.fn(async () => ({ url: "https://billing.stripe.com/session/x" })),
}));

import { createClient } from "@/lib/supabase/server";
import { createBillingPortalSession } from "@/lib/stripe";
import { POST } from "@/app/api/billing/portal/route";

function fakeClient(user: { id: string } | null, membership: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    select: chain,
    eq: chain,
    single: async () => ({ data: membership, error: null }),
  });
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => builder,
  };
}

const REQ = new Request("http://localhost/api/billing/portal", { method: "POST" });

describe("POST /api/billing/portal role gate (SCRUM-422)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403s a plain member and never creates a portal session", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeClient(
        { id: "user-1" },
        { organization_id: "org-1", role: "member", organizations: { stripe_customer_id: "cus_1" } },
      ) as never,
    );

    const res = await POST(REQ);
    expect(res.status).toBe(403);
    expect(createBillingPortalSession).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("allows an %s through to the portal", async (role) => {
    vi.mocked(createClient).mockResolvedValue(
      fakeClient(
        { id: "user-1" },
        { organization_id: "org-1", role, organizations: { stripe_customer_id: "cus_1" } },
      ) as never,
    );

    const res = await POST(REQ);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://billing.stripe.com/session/x" });
    expect(createBillingPortalSession).toHaveBeenCalledWith("cus_1", expect.stringContaining("/billing"));
  });

  it("401s with no session", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeClient(null, null) as never);

    const res = await POST(REQ);
    expect(res.status).toBe(401);
    expect(createBillingPortalSession).not.toHaveBeenCalled();
  });
});
