import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/security/cron-auth", () => ({ requireCronAuth: vi.fn(() => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/encryption", () => ({
  safeDecrypt: vi.fn((v: string) => (v?.startsWith("enc:") ? v.slice(4) : null)),
}));
vi.mock("@/lib/calendar/cliniko", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/cliniko")>();
  return {
    ...actual,
    ClinikoClient: vi.fn(function ClinikoClient() {
      return {};
    }),
  };
});
vi.mock("@/lib/calendar/cliniko-reconcile", () => ({
  reconcileClinikoOrg: vi.fn(async () => ({ ran: true, cancelled: 0, moved: 0, scanned: 0 })),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileClinikoOrg } from "@/lib/calendar/cliniko-reconcile";
import { GET } from "../cliniko-reconcile-sync/route";

function integrationRow(org: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `int-${org}`,
    organization_id: org,
    access_token: "enc:MS0xLWl0c2Fu-au2",
    settings: { shard: "au2", businessId: "b-1" },
    ...overrides,
  };
}

function adminMock(rows: Array<Record<string, unknown>>) {
  const updates: Array<{ id: unknown; payload: Record<string, unknown> }> = [];
  const from = () => {
    let updatePayload: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (k: string, v: unknown) => {
        if (updatePayload && k === "id") updates.push({ id: v, payload: updatePayload });
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      update: (p: Record<string, unknown>) => {
        updatePayload = p;
        return chain;
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
    };
    return chain;
  };
  return { client: { from }, updates };
}

function req() {
  return new Request("http://localhost/api/cron/cliniko-reconcile-sync") as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireCronAuth).mockReturnValue(null as never);
});

describe("GET /api/cron/cliniko-reconcile-sync", () => {
  it("rejects unauthenticated cron calls", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireCronAuth).mockReturnValueOnce(
      NextResponse.json({ error: "unauthorized" }, { status: 401 }) as never
    );
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("force-reconciles every active integration", async () => {
    const { client } = adminMock([integrationRow("org-1"), integrationRow("org-2")]);
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(vi.mocked(reconcileClinikoOrg)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(reconcileClinikoOrg).mock.calls[0][2]).toMatchObject({ force: true });
    // ctx carries the integration id + business
    expect(vi.mocked(reconcileClinikoOrg).mock.calls[0][0]).toMatchObject({ integrationId: "int-org-1", businessId: "b-1" });
  });

  it("one org's setup failure does not block the rest", async () => {
    // A row missing its key throws in setup (before reconcile); the other runs.
    const { client } = adminMock([integrationRow("org-1", { access_token: "plain-not-enc" }), integrationRow("org-2")]);
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(2);
    expect(body.results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(1);
    expect(vi.mocked(reconcileClinikoOrg)).toHaveBeenCalledTimes(1); // org-2 only
  });

  it("reports ok:false when reconcile aborts internally (ran:false)", async () => {
    const { client } = adminMock([integrationRow("org-1")]);
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    vi.mocked(reconcileClinikoOrg).mockResolvedValueOnce({ ran: false, cancelled: 0, moved: 0, scanned: 0 });
    const res = await GET(req());
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ organizationId: "org-1", ok: false });
  });

  it("skips an integration missing its shard/business without throwing", async () => {
    const { client } = adminMock([integrationRow("org-1", { settings: { shard: "au2" } })]);
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(vi.mocked(reconcileClinikoOrg)).not.toHaveBeenCalled();
  });
});
