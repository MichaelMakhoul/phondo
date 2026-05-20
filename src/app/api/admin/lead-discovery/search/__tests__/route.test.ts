import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * SCRUM-301 contract tests for the search route — mirror of the scan
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
  executeSearchClientArg: unknown;
} = {
  isPlatformAdminClientArg: undefined,
  executeSearchClientArg: undefined,
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

const executeSearchMock = vi.fn(async (_params: unknown, client?: unknown) => {
  callTracker.executeSearchClientArg = client;
  return { businesses: [], cached: false };
});
vi.mock("@/lib/lead-discovery/search-orchestrator", () => ({
  executeSearch: executeSearchMock,
}));

function makeReq(body: unknown = { location: "Sydney", professions: ["dentist"], limit: 25 }) {
  return new NextRequest("http://localhost/api/admin/lead-discovery/search", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function callRoute(body?: unknown) {
  const { POST } = await import("../route");
  return POST(makeReq(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: "user-1" };
  state.isAdmin = true;
  state.rateLimit = { allowed: true };
  callTracker.isPlatformAdminClientArg = undefined;
  callTracker.executeSearchClientArg = undefined;
});

describe("POST /api/admin/lead-discovery/search — SCRUM-301 ordering + memoization", () => {
  it("429 when rate-limit denies — auth + admin do NOT run", async () => {
    state.rateLimit = { allowed: false };
    const res = await callRoute();
    expect(res.status).toBe(429);
    expect(executeSearchMock).not.toHaveBeenCalled();
    expect(callTracker.isPlatformAdminClientArg).toBeUndefined();
  });

  it("401 when not authenticated (rate-limit passed first)", async () => {
    state.user = null;
    const res = await callRoute();
    expect(res.status).toBe(401);
    expect(withRateLimitDistributedMock).toHaveBeenCalledTimes(1);
    expect(executeSearchMock).not.toHaveBeenCalled();
  });

  it("403 when authenticated but not admin", async () => {
    state.isAdmin = false;
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(executeSearchMock).not.toHaveBeenCalled();
  });

  it("constructs createAdminClient ONCE per request", async () => {
    await callRoute();
    expect(createAdminClientMock).toHaveBeenCalledTimes(1);
  });

  it("threads the same admin client into isPlatformAdmin + executeSearch", async () => {
    await callRoute();
    expect(callTracker.isPlatformAdminClientArg).toBe(adminClientSentinel);
    expect(callTracker.executeSearchClientArg).toBe(adminClientSentinel);
  });

  it("200 happy path", async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
  });
});

describe("POST /api/admin/lead-discovery/search — input validation", () => {
  it("400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/admin/lead-discovery/search", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    const { POST } = await import("../route");
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("400 when location missing or too short", async () => {
    expect((await callRoute({ professions: ["dentist"] })).status).toBe(400);
    expect((await callRoute({ location: "x", professions: ["dentist"] })).status).toBe(400);
  });

  it("400 when professions missing or empty", async () => {
    expect((await callRoute({ location: "Sydney" })).status).toBe(400);
    expect((await callRoute({ location: "Sydney", professions: [] })).status).toBe(400);
  });

  it("400 on invalid limit value", async () => {
    const res = await callRoute({ location: "Sydney", professions: ["dentist"], limit: 7 });
    expect(res.status).toBe(400);
  });
});
