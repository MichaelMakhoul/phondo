import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/nextjs";
import {
  checkRateLimit,
  rateLimit,
  rateLimitDistributed,
  rateLimitConfigs,
  type RateLimitSupabaseClient,
} from "../rate-limiter";

vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: any) => void) =>
    fn({
      setTag: vi.fn(),
      setLevel: vi.fn(),
      setExtras: vi.fn(),
    }),
  ),
  captureException: vi.fn(),
}));

/**
 * Minimal stub of the Supabase RPC surface. `rpcResult` is mutated per
 * test so we can model success/error/empty/malformed responses without
 * pulling in @supabase/supabase-js.
 */
function makeStubSupabase(): {
  client: RateLimitSupabaseClient;
  rpc: ReturnType<typeof vi.fn>;
  setResult: (result: { data: unknown; error: unknown }) => void;
  setThrows: (err: Error) => void;
} {
  const state: { result: { data: unknown; error: unknown }; throws: Error | null } = {
    result: { data: [{ count: 1, reset_time: new Date(Date.now() + 60_000).toISOString() }], error: null },
    throws: null,
  };
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
    if (state.throws) throw state.throws;
    return state.result;
  });
  return {
    client: { rpc },
    rpc,
    setResult: (result) => {
      state.result = result;
      state.throws = null;
    },
    setThrows: (err) => {
      state.throws = err;
    },
  };
}

describe("rateLimitDistributed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls check_rate_limit_bucket with the right RPC name and args", async () => {
    const stub = makeStubSupabase();
    await rateLimitDistributed(stub.client, "org-1", "phone-numbers/test-fallback", "fallbackTestCall");
    expect(stub.rpc).toHaveBeenCalledTimes(1);
    expect(stub.rpc).toHaveBeenCalledWith("check_rate_limit_bucket", {
      p_key: "org-1:phone-numbers/test-fallback",
      p_window_ms: rateLimitConfigs.fallbackTestCall.windowMs,
      p_max_requests: rateLimitConfigs.fallbackTestCall.maxRequests,
    });
  });

  it("allows the request when post-increment count <= max", async () => {
    const stub = makeStubSupabase();
    const futureReset = new Date(Date.now() + 30_000).toISOString();
    stub.setResult({ data: [{ count: 1, reset_time: futureReset }], error: null });
    const { allowed, headers } = await rateLimitDistributed(
      stub.client,
      "org-1",
      "endpoint",
      "fallbackTestCall",
    );
    expect(allowed).toBe(true);
    // remaining = max - count = 1 - 1 = 0; correct for the LAST-allowed call
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(headers["X-RateLimit-Limit"]).toBe("1");
    // Retry-After should NOT be set on allowed responses
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("denies and includes Retry-After when post-increment count > max", async () => {
    const stub = makeStubSupabase();
    const futureReset = new Date(Date.now() + 30_000).toISOString();
    stub.setResult({ data: [{ count: 2, reset_time: futureReset }], error: null });
    const { allowed, headers } = await rateLimitDistributed(
      stub.client,
      "org-1",
      "endpoint",
      "fallbackTestCall",
    );
    expect(allowed).toBe(false);
    expect(headers["Retry-After"]).toBeDefined();
    // Retry-After is integer seconds, rounded up, minimum 1
    const retryAfter = Number(headers["Retry-After"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(31);
    // Remaining clamps to 0 even though count - max would be 1
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
  });

  it("Retry-After is at least 1 even when the window has effectively expired", async () => {
    const stub = makeStubSupabase();
    // reset_time is in the past — could yield ceil(negative/1000) which is
    // 0 or even negative. The header must still be a positive integer so
    // clients don't interpret 0/negative as "retry now" (which would just
    // get them another 429).
    const pastReset = new Date(Date.now() - 1000).toISOString();
    stub.setResult({ data: [{ count: 2, reset_time: pastReset }], error: null });
    const { headers } = await rateLimitDistributed(stub.client, "org-1", "ep", "fallbackTestCall");
    expect(Number(headers["Retry-After"])).toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────────────
  // Fail-CLOSED branch — cost-control profiles (fallbackTestCall,
  // expensive, adminExpensive). Locking admins out during a Supabase
  // brownout is worse than reopening the unbounded-Twilio-cost bypass —
  // verify the limiter chose lock-out, not bypass.
  // ────────────────────────────────────────────────────────────────────

  it("fails CLOSED on RPC error for cost-control type (fallbackTestCall)", async () => {
    const stub = makeStubSupabase();
    stub.setResult({ data: null, error: { code: "57P01", message: "admin shutdown" } });
    const { allowed, headers } = await rateLimitDistributed(
      stub.client,
      "fc-error-org",
      "endpoint",
      "fallbackTestCall",
    );
    expect(allowed).toBe(false);
    expect(headers["X-RateLimit-Limit"]).toBe("1");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    // Retry-After should be present and anchor to the configured window
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
    expect(Number(headers["Retry-After"])).toBeLessThanOrEqual(60);
    // Sentry must be paged with failMode=closed
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED on RPC throw for cost-control type", async () => {
    const stub = makeStubSupabase();
    stub.setThrows(new Error("ECONNREFUSED"));
    const { allowed } = await rateLimitDistributed(
      stub.client,
      "fc-throw-org",
      "endpoint",
      "expensive",
    );
    expect(allowed).toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED on empty result for cost-control type", async () => {
    const stub = makeStubSupabase();
    stub.setResult({ data: [], error: null });
    const { allowed } = await rateLimitDistributed(
      stub.client,
      "fc-empty-org",
      "endpoint",
      "adminExpensive",
    );
    expect(allowed).toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED on malformed reset_time for cost-control type", async () => {
    const stub = makeStubSupabase();
    stub.setResult({ data: [{ count: 1, reset_time: "not-a-timestamp" }], error: null });
    const { allowed } = await rateLimitDistributed(
      stub.client,
      "fc-malformed-org",
      "endpoint",
      "fallbackTestCall",
    );
    expect(allowed).toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  // ────────────────────────────────────────────────────────────────────
  // Fail-OPEN (local fallback) — non-cost-control profiles. UX-grade
  // limits should not lock users out during a DB blip.
  // ────────────────────────────────────────────────────────────────────

  it("falls back to local sync limiter on RPC error for non-cost-control type (standard)", async () => {
    const stub = makeStubSupabase();
    stub.setResult({ data: null, error: { code: "57P01", message: "admin shutdown" } });
    const { allowed, headers } = await rateLimitDistributed(
      stub.client,
      "fo-error-org",
      "endpoint",
      "standard",
    );
    // Local limiter starts fresh for this never-seen key → allowed=true
    expect(allowed).toBe(true);
    expect(headers["X-RateLimit-Limit"]).toBe("100");
    // Sentry must be paged so on-call sees the degraded mode
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("falls back to local on RPC throw for non-cost-control type (auth)", async () => {
    const stub = makeStubSupabase();
    stub.setThrows(new Error("ECONNREFUSED"));
    const { allowed } = await rateLimitDistributed(
      stub.client,
      "fo-throw-org",
      "endpoint",
      "auth",
    );
    expect(allowed).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("falls back to local on empty result for non-cost-control type", async () => {
    const stub = makeStubSupabase();
    stub.setResult({ data: [], error: null });
    const { allowed } = await rateLimitDistributed(
      stub.client,
      "fo-empty-org",
      "endpoint",
      "webhook",
    );
    expect(allowed).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("falls back to local on malformed reset_time for non-cost-control type", async () => {
    const stub = makeStubSupabase();
    stub.setResult({ data: [{ count: 1, reset_time: "not-a-timestamp" }], error: null });
    const { allowed } = await rateLimitDistributed(
      stub.client,
      "fo-malformed-org",
      "endpoint",
      "testCall",
    );
    expect(allowed).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("does NOT page Sentry on the happy path", async () => {
    const stub = makeStubSupabase();
    await rateLimitDistributed(stub.client, "org-1", "endpoint", "fallbackTestCall");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("uses the requested type's config (standard vs fallbackTestCall)", async () => {
    const stub = makeStubSupabase();
    await rateLimitDistributed(stub.client, "org-1", "endpoint", "standard");
    const callArgs = stub.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.p_max_requests).toBe(rateLimitConfigs.standard.maxRequests);
    expect(callArgs.p_window_ms).toBe(rateLimitConfigs.standard.windowMs);
  });

  it("identifier and endpoint compose into a single 'identifier:endpoint' key", async () => {
    const stub = makeStubSupabase();
    await rateLimitDistributed(stub.client, "10.0.0.1", "voice-preview", "expensive");
    const callArgs = stub.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.p_key).toBe("10.0.0.1:voice-preview");
  });
});

describe("checkRateLimit (sync local limiter — unchanged behavior)", () => {
  it("first call is allowed", () => {
    const result = checkRateLimit("test-key-1", { windowMs: 60_000, maxRequests: 3 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("rejects once max is reached", () => {
    const key = "test-key-2";
    const config = { windowMs: 60_000, maxRequests: 2 };
    expect(checkRateLimit(key, config).allowed).toBe(true);
    expect(checkRateLimit(key, config).allowed).toBe(true);
    const third = checkRateLimit(key, config);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });
});

describe("rateLimit (sync wrapper — unchanged behavior)", () => {
  it("returns headers with X-RateLimit-* on allowed", () => {
    const { allowed, headers } = rateLimit("test-id-1", "endpoint", "standard");
    expect(allowed).toBe(true);
    expect(headers["X-RateLimit-Limit"]).toBeDefined();
    expect(headers["X-RateLimit-Remaining"]).toBeDefined();
    expect(headers["X-RateLimit-Reset"]).toBeDefined();
    expect(headers["Retry-After"]).toBeUndefined();
  });
});
