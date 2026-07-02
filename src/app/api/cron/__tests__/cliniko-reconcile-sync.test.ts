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

import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileClinikoOrg } from "@/lib/calendar/cliniko-reconcile";
import { ClinikoAuthError } from "@/lib/calendar/cliniko";
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

  it("one org failing does not block the rest", async () => {
    const { client } = adminMock([integrationRow("org-1"), integrationRow("org-2")]);
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    vi.mocked(reconcileClinikoOrg).mockRejectedValueOnce(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(2);
    expect(body.results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(1);
    expect(vi.mocked(reconcileClinikoOrg)).toHaveBeenCalledTimes(2);
  });

  it("flags the integration on an auth failure", async () => {
    const { client, updates } = adminMock([integrationRow("org-1")]);
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    vi.mocked(reconcileClinikoOrg).mockRejectedValueOnce(new ClinikoAuthError("bad key"));
    await GET(req());
    const flag = updates.find((u) => u.id === "int-org-1");
    expect((flag?.payload.settings as Record<string, unknown>)?.errorState).toBe("auth_failed");
  });

  it("skips an integration missing its shard/business without throwing", async () => {
    const { client } = adminMock([integrationRow("org-1", { settings: { shard: "au2" } })]);
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(vi.mocked(reconcileClinikoOrg)).not.toHaveBeenCalled();
  });
});
