import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * SCRUM-301 contract tests for the export route — mirror of the scan
 * route tests. Same ordering + memoization invariants apply.
 */

const state: {
  user: { id: string } | null;
  isAdmin: boolean;
  rateLimit: { allowed: boolean; failReason?: "service-degraded" };
} = {
  user: { id: "user-1" },
  isAdmin: true,
  rateLimit: { allowed: true },
};

const callTracker: {
  isPlatformAdminClientArg: unknown;
  loadFilteredBusinessesClientArg: unknown;
} = {
  isPlatformAdminClientArg: undefined,
  loadFilteredBusinessesClientArg: undefined,
};

const adminClientSentinel = { __sentinel: "admin-client" };
const createAdminClientMock = vi.fn(() => adminClientSentinel);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: createAdminClientMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })),
    },
  })),
}));

vi.mock("@/lib/admin/admin-auth", () => ({
  isPlatformAdmin: vi.fn(async (_userId: string, client?: unknown) => {
    callTracker.isPlatformAdminClientArg = client;
    return state.isAdmin;
  }),
}));

const withRateLimitDistributedMock = vi.fn(async () => ({
  allowed: state.rateLimit.allowed,
  headers: { "Retry-After": "60" },
  ...(state.rateLimit.failReason ? { failReason: state.rateLimit.failReason } : {}),
}));
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimitDistributed: withRateLimitDistributedMock,
}));

const loadFilteredBusinessesMock = vi.fn(async (_filters: unknown, client?: unknown) => {
  callTracker.loadFilteredBusinessesClientArg = client;
  return [];
});
vi.mock("@/lib/lead-discovery/search-orchestrator", () => ({
  loadFilteredBusinesses: loadFilteredBusinessesMock,
}));

function makeReq() {
  return new NextRequest(
    "http://localhost/api/admin/lead-discovery/export?location=Sydney&professions=dentist",
    { method: "GET" },
  );
}

async function callRoute() {
  const { GET } = await import("../route");
  return GET(makeReq());
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: "user-1" };
  state.isAdmin = true;
  state.rateLimit = { allowed: true };
  callTracker.isPlatformAdminClientArg = undefined;
  callTracker.loadFilteredBusinessesClientArg = undefined;
});

describe("GET /api/admin/lead-discovery/export — SCRUM-301 ordering + memoization", () => {
  it("429 when rate-limit denies — auth + admin do NOT run", async () => {
    state.rateLimit = { allowed: false };
    const res = await callRoute();
    expect(res.status).toBe(429);
    expect(loadFilteredBusinessesMock).not.toHaveBeenCalled();
    expect(callTracker.isPlatformAdminClientArg).toBeUndefined();
  });

  it("401 when not authenticated (rate-limit passed first)", async () => {
    state.user = null;
    const res = await callRoute();
    expect(res.status).toBe(401);
    expect(withRateLimitDistributedMock).toHaveBeenCalledTimes(1);
    expect(loadFilteredBusinessesMock).not.toHaveBeenCalled();
  });

  it("403 when authenticated but not admin", async () => {
    state.isAdmin = false;
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(loadFilteredBusinessesMock).not.toHaveBeenCalled();
  });

  it("constructs createAdminClient ONCE per request", async () => {
    await callRoute();
    expect(createAdminClientMock).toHaveBeenCalledTimes(1);
  });

  it("threads the same admin client into isPlatformAdmin + loadFilteredBusinesses", async () => {
    await callRoute();
    expect(callTracker.isPlatformAdminClientArg).toBe(adminClientSentinel);
    expect(callTracker.loadFilteredBusinessesClientArg).toBe(adminClientSentinel);
  });

  it("200 happy path returns CSV", async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    // SCRUM-290 review: rate-limit headers also returned on 200.
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
