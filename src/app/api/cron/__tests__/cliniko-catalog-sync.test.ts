import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

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
vi.mock("@/lib/calendar/cliniko-sync", () => ({ syncClinikoCatalog: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncClinikoCatalog } from "@/lib/calendar/cliniko-sync";
import { ClinikoAuthError } from "@/lib/calendar/cliniko";
import * as Sentry from "@sentry/nextjs";
import { GET } from "../cliniko-catalog-sync/route";

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
  // SCRUM-489: settings writes are now the merge RPC; capture each patch as
  // { id, patch } so assertions can read the merged keys directly.
  const merges: Array<{ id: unknown; patch: Record<string, unknown> }> = [];
  let rpcError: { message: string } | null = null;
  const from = () => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
    };
    return chain;
  };
  const rpc = vi.fn(async (_fn: string, args: { p_id: unknown; p_patch: Record<string, unknown> }) => {
    merges.push({ id: args.p_id, patch: args.p_patch });
    return { error: rpcError };
  });
  return { client: { from, rpc }, merges, setRpcError: (e: { message: string } | null) => (rpcError = e) };
}

function req() {
  return new Request("http://localhost/api/cron/cliniko-catalog-sync") as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireCronAuth).mockReturnValue(null as never);
});

describe("GET /api/cron/cliniko-catalog-sync", () => {
  it("rejects unauthenticated cron calls", async () => {
    vi.mocked(requireCronAuth).mockReturnValue(NextResponse.json({ error: "no" }, { status: 401 }) as never);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(syncClinikoCatalog).not.toHaveBeenCalled();
  });

  it("syncs every active integration and reports per-org results", async () => {
    const admin = adminMock([integrationRow("org-1"), integrationRow("org-2")]);
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);
    vi.mocked(syncClinikoCatalog).mockResolvedValue({ practitionersUpserted: 1, serviceTypesUpserted: 1, deactivated: 0 });

    const res = await GET(req());
    const body = await res.json();
    expect(body.scanned).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(vi.mocked(syncClinikoCatalog)).toHaveBeenCalledTimes(2);
    // lastSyncedAt stamped on both
    expect(admin.merges.filter((u) => u.patch.lastSyncedAt)).toHaveLength(2);
  });

  it("surfaces a success-path merge failure instead of silently keeping a stale banner (SCRUM-489/silent-failure)", async () => {
    const admin = adminMock([integrationRow("org-1")]);
    admin.setRpcError({ message: "deadlock detected" });
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);
    vi.mocked(syncClinikoCatalog).mockResolvedValue({ practitionersUpserted: 1, serviceTypesUpserted: 1, deactivated: 0 });

    const res = await GET(req());
    // The sync itself still succeeded; the marker just didn't persist.
    expect((await res.json()).succeeded).toBe(1);
    expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledWith(expect.stringContaining("settings merge failed"));
  });

  it("one org's failure doesn't stop the rest; auth failures flag auth_failed", async () => {
    const admin = adminMock([integrationRow("org-1"), integrationRow("org-2")]);
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);
    vi.mocked(syncClinikoCatalog)
      .mockRejectedValueOnce(new ClinikoAuthError("bad key"))
      .mockResolvedValueOnce({ practitionersUpserted: 1, serviceTypesUpserted: 1, deactivated: 0 });

    const res = await GET(req());
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(body.succeeded).toBe(1);
    const flagged = admin.merges.find((u) => u.patch.errorState === "auth_failed");
    expect(flagged).toBeTruthy();
  });

  it("skips orgs with undecryptable keys, flagging sync_failed", async () => {
    const admin = adminMock([integrationRow("org-1", { access_token: "garbage" })]);
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never);

    const res = await GET(req());
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(syncClinikoCatalog).not.toHaveBeenCalled();
    const flagged = admin.merges.find((u) => u.patch.errorState === "sync_failed");
    expect(flagged).toBeTruthy();
  });
});
