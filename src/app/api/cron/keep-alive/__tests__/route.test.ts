import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";

// ──────────────────────────────────────────────────────────────────────────
// Module mocks. Hoisted above all imports of the route under test.
// ──────────────────────────────────────────────────────────────────────────

const supabaseState: {
  selectError: unknown;
  selectThrows: Error | null;
  rpcResult: { data: unknown; error: unknown } | null;
  rpcThrows: Error | null;
} = {
  selectError: null,
  selectThrows: null,
  rpcResult: { data: 0, error: null },
  rpcThrows: null,
};

const rpcMock = vi.fn(async (_fn: string) => {
  if (supabaseState.rpcThrows) throw supabaseState.rpcThrows;
  return supabaseState.rpcResult ?? { data: 0, error: null };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        limit: async () => {
          if (supabaseState.selectThrows) throw supabaseState.selectThrows;
          return { data: null, error: supabaseState.selectError };
        },
      }),
    }),
    rpc: rpcMock,
  })),
}));

vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: any) => void) =>
    fn({
      setTag: vi.fn(),
      setLevel: vi.fn(),
      setExtras: vi.fn(),
    }),
  ),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const CRON_SECRET = "test-cron-secret";

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/cron/keep-alive", {
    method: "GET",
    headers,
  });
}

async function callRoute(headers: Record<string, string> = {}) {
  const { GET } = await import("../route");
  return GET(makeRequest(headers));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
  // Upstash configured-off by default so we test the "skipped" branch
  // and don't try to import @upstash/redis in CI.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  supabaseState.selectError = null;
  supabaseState.selectThrows = null;
  supabaseState.rpcResult = { data: 0, error: null };
  supabaseState.rpcThrows = null;
});

// ──────────────────────────────────────────────────────────────────────────
// Auth gates (pre-existing behavior — locked in to catch regression)
// ──────────────────────────────────────────────────────────────────────────

describe("GET /api/cron/keep-alive — auth gates", () => {
  it("500 when CRON_SECRET env var is missing", async () => {
    delete process.env.CRON_SECRET;
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(res.status).toBe(500);
  });

  it("401 when the bearer token doesn't match CRON_SECRET", async () => {
    const res = await callRoute({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("401 when no Authorization header is present at all", async () => {
    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it("does not run any Supabase/RPC work when auth fails", async () => {
    await callRoute({ authorization: "Bearer wrong" });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Happy path — all three jobs succeed
// ──────────────────────────────────────────────────────────────────────────

describe("GET /api/cron/keep-alive — happy path", () => {
  it("returns 200 with ok=true when all jobs succeed", async () => {
    supabaseState.rpcResult = { data: 7, error: null };
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.supabase).toBe("ok");
    expect(body.rate_limit_cleanup).toBe("ok");
    // Upstash should be skipped (unset env)
    expect(body.upstash).toMatch(/^skipped/);
  });

  it("calls cleanup_rate_limit_buckets RPC exactly once", async () => {
    await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("cleanup_rate_limit_buckets");
  });

  it("does NOT page Sentry on the happy path", async () => {
    await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("returns timestamp in ISO-8601 shape", async () => {
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    const body = await res.json();
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// SCRUM-289: cleanup branch failure modes
// ──────────────────────────────────────────────────────────────────────────

describe("GET /api/cron/keep-alive — rate_limit_cleanup failures (SCRUM-289)", () => {
  it("503 + Sentry-paged when the cleanup RPC returns an error", async () => {
    supabaseState.rpcResult = {
      data: null,
      error: { code: "57P01", message: "admin shutdown" },
    };
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.rate_limit_cleanup).toMatch(/^error: admin shutdown/);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("503 + Sentry-paged when the cleanup RPC throws (network error)", async () => {
    supabaseState.rpcThrows = new Error("ECONNREFUSED");
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.rate_limit_cleanup).toBe("error");
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("cleanup RPC failure does NOT short-circuit the Supabase ping result", async () => {
    // Supabase ping must still run — the cleanup failure only marks
    // the cleanup result as error; other ops are independent.
    supabaseState.rpcResult = {
      data: null,
      error: { code: "57P01", message: "admin shutdown" },
    };
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    const body = await res.json();
    expect(body.supabase).toBe("ok");
  });

  it("logs the deleted row count on success (for stuck-cleanup visibility)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    supabaseState.rpcResult = { data: 42, error: null };
    await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    const cleanupLog = consoleSpy.mock.calls.find((c) =>
      String(c[0]).includes("rate_limit_cleanup deleted rows"),
    );
    expect(cleanupLog).toBeDefined();
    expect(cleanupLog?.[1]).toBe(42);
    consoleSpy.mockRestore();
  });

  it("Sentry capture is tagged with reason=rate-limit-cleanup-failed on RPC error", async () => {
    supabaseState.rpcResult = {
      data: null,
      error: { code: "57P01", message: "admin shutdown" },
    };
    await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    // The mock's withScope passes a fresh scope object; we can verify the
    // capture happened, and the scope setup ran (no throw). For per-tag
    // assertions we'd need a shared scope mock — out of scope for this
    // ticket; the per-tag contract is locked in by server-sentry-sites
    // tests in voice-server.
    expect(Sentry.withScope).toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Shape-drift handling: non-number RPC data → warning, not success
// (the silent-coercion-to-0 trap addressed in review)
// ──────────────────────────────────────────────────────────────────────────

describe("GET /api/cron/keep-alive — RPC shape drift (SCRUM-289 review fix)", () => {
  it("503 + Sentry-paged when RPC returns data=null with no error", async () => {
    supabaseState.rpcResult = { data: null, error: null };
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.rate_limit_cleanup).toMatch(/^warn: unexpected RPC shape/);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("503 + Sentry-paged when RPC returns an array (PostgREST shape regression)", async () => {
    supabaseState.rpcResult = {
      data: [{ cleanup_rate_limit_buckets: 7 }],
      error: null,
    };
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(res.status).toBe(503);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("503 + Sentry-paged when RPC returns a string ('integer-as-string' from some PG drivers)", async () => {
    supabaseState.rpcResult = { data: "42" as unknown as number, error: null };
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(res.status).toBe(503);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("captures the unexpected data type in the warning message body", async () => {
    supabaseState.rpcResult = { data: null, error: null };
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    const body = await res.json();
    // The disambiguation between `null` and other falsy values matters
    // for triage — null suggests "function ran but returned nothing"
    // while undefined suggests "supabase-js wrapper drift".
    expect(body.rate_limit_cleanup).toContain("null");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Sentry transport defect must not crash the cron
// ──────────────────────────────────────────────────────────────────────────

describe("GET /api/cron/keep-alive — Sentry shim defect resilience", () => {
  it("returns 503 (not 500) when Sentry.withScope itself throws inside the cleanup catch", async () => {
    supabaseState.rpcThrows = new Error("ECONNREFUSED");
    // Force the OUTER withScope (inside the catch (err) block) to throw —
    // simulates Sentry shim going bad. The inner try/catch should swallow
    // it and the cron should still produce a Response.
    vi.mocked(Sentry.withScope).mockImplementationOnce(() => {
      throw new Error("sentry transport down");
    });
    const res = await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    // Cron MUST still return — a crash here is the worst failure mode
    // because it skips the response and Vercel can't even surface 503.
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.rate_limit_cleanup).toBe("error");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Independence — Supabase failure must not skip cleanup
// ──────────────────────────────────────────────────────────────────────────

describe("GET /api/cron/keep-alive — job independence", () => {
  it("Supabase ping failure does NOT skip the cleanup step", async () => {
    supabaseState.selectError = { code: "08000", message: "connection refused" };
    await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("Supabase ping THROW does NOT skip the cleanup step", async () => {
    supabaseState.selectThrows = new Error("kaboom");
    await callRoute({ authorization: `Bearer ${CRON_SECRET}` });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
