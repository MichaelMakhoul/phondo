import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ──────────────────────────────────────────────────────────────────────────
// Module mocks. Hoisted above all imports of the route under test.
// ──────────────────────────────────────────────────────────────────────────

const state: {
  user: { id: string } | null;
  isAdmin: boolean;
  rateLimit: { allowed: boolean; failReason?: "service-degraded" };
} = {
  user: { id: "user-1" },
  isAdmin: true,
  rateLimit: { allowed: true },
};

// SCRUM-301: track which admin client object was passed to each helper
// so we can prove memoization — all helpers must receive the SAME
// object identity (not a fresh `createAdminClient()` per helper).
const callTracker: {
  isPlatformAdminClientArg: unknown;
  scanClientArg: unknown;
} = {
  isPlatformAdminClientArg: undefined,
  scanClientArg: undefined,
};

const adminClientSentinel = { __sentinel: "admin-client" };
const createAdminClientMock = vi.fn(() => adminClientSentinel);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: createAdminClientMock,
}));

const createClientMock = vi.fn(async () => ({
  auth: {
    getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })),
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: createClientMock,
}));

const isPlatformAdminMock = vi.fn(async (userId: string, client?: unknown) => {
  callTracker.isPlatformAdminClientArg = client;
  return state.isAdmin;
});
vi.mock("@/lib/admin/admin-auth", () => ({
  isPlatformAdmin: isPlatformAdminMock,
}));

const withRateLimitDistributedMock = vi.fn(async () => ({
  allowed: state.rateLimit.allowed,
  headers: { "Retry-After": "60" },
  ...(state.rateLimit.failReason ? { failReason: state.rateLimit.failReason } : {}),
}));
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimitDistributed: withRateLimitDistributedMock,
}));

const scanBusinessCRMsMock = vi.fn(async (ids: string[], client?: unknown) => {
  callTracker.scanClientArg = client;
  return ids.map((id) => ({ id, name: `Business ${id}` }));
});
vi.mock("@/lib/lead-discovery/search-orchestrator", () => ({
  scanBusinessCRMs: scanBusinessCRMsMock,
}));

// SCRUM-301 review: validation helper is a pure function with no
// side-effects — no need to mock it. Using the real one means tests
// catch real edge cases (e.g. malformed UUIDs that look 36-char-ish)
// rather than the previous over-permissive regex stub.
// (Not mocked.)

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const VALID_UUID = "00000000-0000-0000-0000-000000000001";

function makeReq(body: unknown = { businessIds: [VALID_UUID] }) {
  return new NextRequest("http://localhost/api/admin/lead-discovery/scan", {
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
  callTracker.scanClientArg = undefined;
});

// ──────────────────────────────────────────────────────────────────────────
// SCRUM-301 contract: rate-limit fires BEFORE auth+admin checks
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/lead-discovery/scan — rate-limit-before-auth ordering (SCRUM-301)", () => {
  it("429 when rate-limit denies — auth + admin checks do NOT run", async () => {
    state.rateLimit = { allowed: false };
    const res = await callRoute();
    expect(res.status).toBe(429);
    // The whole point of SCRUM-301: unauth attackers must not burn
    // DB hits before being limited.
    expect(createClientMock).not.toHaveBeenCalled();
    expect(isPlatformAdminMock).not.toHaveBeenCalled();
    // Orchestrator must not have run either.
    expect(scanBusinessCRMsMock).not.toHaveBeenCalled();
  });

  it("429 brownout-deny surfaces failReason (cross-check with SCRUM-302)", async () => {
    state.rateLimit = { allowed: false, failReason: "service-degraded" };
    const res = await callRoute();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Service temporarily unavailable");
    expect(body.failReason).toBe("service-degraded");
  });

  it("401 when authenticated check fails (rate-limit passed first)", async () => {
    state.user = null;
    const res = await callRoute();
    expect(res.status).toBe(401);
    // Rate limit ran (SCRUM-301 ordering) before the auth check.
    expect(withRateLimitDistributedMock).toHaveBeenCalledTimes(1);
    // No admin check, no orchestrator.
    expect(isPlatformAdminMock).not.toHaveBeenCalled();
    expect(scanBusinessCRMsMock).not.toHaveBeenCalled();
  });

  it("403 when authenticated but not platform admin", async () => {
    state.isAdmin = false;
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(isPlatformAdminMock).toHaveBeenCalledTimes(1);
    expect(scanBusinessCRMsMock).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// SCRUM-301 contract: createAdminClient memoization
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/lead-discovery/scan — admin client memoization (SCRUM-301)", () => {
  it("constructs createAdminClient ONCE per request", async () => {
    await callRoute();
    expect(createAdminClientMock).toHaveBeenCalledTimes(1);
  });

  it("threads the same admin client into isPlatformAdmin + scanBusinessCRMs", async () => {
    await callRoute();
    // Pre-SCRUM-301 each helper called createAdminClient() itself,
    // burning 3× the SupabaseClient construction per request. Now
    // they receive the route-level singleton.
    expect(callTracker.isPlatformAdminClientArg).toBe(adminClientSentinel);
    expect(callTracker.scanClientArg).toBe(adminClientSentinel);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Happy path + body validation (existing behavior — locked in)
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/lead-discovery/scan — happy path + validation", () => {
  it("200 with scanned businesses on happy path", async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.businesses).toHaveLength(1);
    expect(body.businesses[0].id).toBe(VALID_UUID);
  });

  it("400 on invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/admin/lead-discovery/scan", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    const { POST } = await import("../route");
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("400 when businessIds is missing or empty", async () => {
    const res1 = await callRoute({});
    expect(res1.status).toBe(400);
    const res2 = await callRoute({ businessIds: [] });
    expect(res2.status).toBe(400);
  });

  it("400 when businessIds has more than 100 entries", async () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      `00000000-0000-0000-0000-${i.toString().padStart(12, "0")}`
    );
    const res = await callRoute({ businessIds: ids });
    expect(res.status).toBe(400);
  });

  it("400 when any businessId is not a valid UUID", async () => {
    const res = await callRoute({ businessIds: ["not-a-uuid"] });
    expect(res.status).toBe(400);
  });
});
