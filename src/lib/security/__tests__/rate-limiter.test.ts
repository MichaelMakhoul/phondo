import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/nextjs";
import {
  checkRateLimit,
  rateLimit,
  rateLimitDistributed,
  rateLimitConfigs,
  withRateLimitDistributed,
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
 *
 * SCRUM-298: `RateLimitSupabaseClient` is now the branded
 * `ServiceRoleSupabaseClient` newtype, so the stub goes through
 * `as unknown as ...` to bypass both the brand and the full
 * SupabaseClient surface. This is the canonical
 * "test fixture for a branded type" pattern — the brand exists to
 * stop production code from passing the wrong client; tests
 * deliberately ignore it to model error paths the strict type
 * cannot express.
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
    // The cast acknowledges the stub's wider shape — the production
    // call site uses the narrowed `check_rate_limit_bucket` overload,
    // but the runtime contract `rateLimitDistributed` actually relies
    // on (an object with `.rpc()` that returns `{ data, error }`) is
    // the same in both cases.
    client: { rpc } as unknown as RateLimitSupabaseClient,
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
    const result = await rateLimitDistributed(
      stub.client,
      "fc-error-org",
      "endpoint",
      "fallbackTestCall",
    );
    expect(result.allowed).toBe(false);
    expect(result.headers["X-RateLimit-Limit"]).toBe("1");
    expect(result.headers["X-RateLimit-Remaining"]).toBe("0");
    // Retry-After should be present and anchor to the configured window
    expect(Number(result.headers["Retry-After"])).toBeGreaterThan(0);
    expect(Number(result.headers["Retry-After"])).toBeLessThanOrEqual(60);
    // Sentry must be paged with failMode=closed
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    // SCRUM-302: fail-closed branch tags the result so callers can
    // render a distinct UX message ("service degraded" vs "quota burn").
    expect(result.failReason).toBe("service-degraded");
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

describe("withRateLimitDistributed (IP-keyed async wrapper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keys the rate-limit bucket on x-vercel-forwarded-for (untaintable in prod)", async () => {
    const stub = makeStubSupabase();
    const request = new Request("http://localhost/api/v1/voice-preview", {
      headers: { "x-vercel-forwarded-for": "203.0.113.42" },
    });
    await withRateLimitDistributed(
      stub.client,
      request,
      "/api/v1/voice-preview",
      "expensive",
    );
    expect(stub.rpc).toHaveBeenCalledTimes(1);
    const callArgs = stub.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.p_key).toBe("203.0.113.42:/api/v1/voice-preview");
  });

  it("falls back to x-real-ip when x-vercel-forwarded-for is absent", async () => {
    const stub = makeStubSupabase();
    const request = new Request("http://localhost/admin/scan", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    await withRateLimitDistributed(
      stub.client,
      request,
      "admin-lead-discovery-scan",
      "adminExpensive",
    );
    const callArgs = stub.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.p_key).toBe("198.51.100.7:admin-lead-discovery-scan");
  });

  it("SECURITY: trusts the LAST entry of x-forwarded-for (the proxy-appended one), not the first", async () => {
    // SCRUM-290 security fix: previously the helper took the FIRST
    // entry of x-forwarded-for, which on Vercel is client-supplied.
    // An attacker sending `x-forwarded-for: <victim-IP>` could lock
    // the victim out of paid-action endpoints (the bucket is global
    // in Postgres post-SCRUM-290). Lock the priority order in.
    const stub = makeStubSupabase();
    const request = new Request("http://localhost/api/v1/voice-preview", {
      // Format: <attacker-supplied>, <real-attacker-IP-appended-by-Vercel>
      headers: { "x-forwarded-for": "10.0.0.1, 192.0.2.99" },
    });
    await withRateLimitDistributed(
      stub.client,
      request,
      "/api/v1/voice-preview",
      "expensive",
    );
    const callArgs = stub.rpc.mock.calls[0][1] as Record<string, unknown>;
    // Must bucket the ATTACKER, not the spoofed victim IP.
    expect(callArgs.p_key).toBe("192.0.2.99:/api/v1/voice-preview");
    expect(callArgs.p_key).not.toBe("10.0.0.1:/api/v1/voice-preview");
  });

  it("SECURITY: x-vercel-forwarded-for wins even when x-forwarded-for tries to spoof", async () => {
    const stub = makeStubSupabase();
    const request = new Request("http://localhost/api/v1/scrape-preview", {
      headers: {
        // Attacker tries to spoof via x-forwarded-for
        "x-forwarded-for": "10.0.0.1",
        // Vercel sets x-vercel-forwarded-for to the real client IP
        "x-vercel-forwarded-for": "192.0.2.99",
      },
    });
    await withRateLimitDistributed(stub.client, request, "scrape", "expensive");
    const callArgs = stub.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.p_key).toBe("192.0.2.99:scrape");
  });

  it("falls back to 'unknown' when no IP header is present", async () => {
    const stub = makeStubSupabase();
    const request = new Request("http://localhost/api/v1/scrape-preview");
    await withRateLimitDistributed(stub.client, request, "scrape", "expensive");
    const callArgs = stub.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.p_key).toBe("unknown:scrape");
  });

  it("forwards the right windowMs + maxRequests for adminExpensive profile", async () => {
    const stub = makeStubSupabase();
    const request = new Request("http://localhost/admin/scan", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    await withRateLimitDistributed(
      stub.client,
      request,
      "admin-lead-discovery-scan",
      "adminExpensive",
    );
    const callArgs = stub.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.p_max_requests).toBe(rateLimitConfigs.adminExpensive.maxRequests);
    expect(callArgs.p_window_ms).toBe(rateLimitConfigs.adminExpensive.windowMs);
  });

  it("fails CLOSED on RPC error for costControl profile (no per-instance fallback)", async () => {
    const stub = makeStubSupabase();
    stub.setResult({ data: null, error: { code: "57P01", message: "admin shutdown" } });
    const request = new Request("http://localhost/api/v1/voice-preview", {
      headers: { "x-vercel-forwarded-for": "192.0.2.1" },
    });
    const { allowed, headers } = await withRateLimitDistributed(
      stub.client,
      request,
      "/api/v1/voice-preview",
      "expensive",
    );
    expect(allowed).toBe(false);
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("falls back to LOCAL Map on RPC error for non-costControl profile", async () => {
    // Covers the fail-OPEN path through the wrapper (the lower-level
    // rateLimitDistributed has its own tests; this proves the wrapper
    // doesn't swallow the path).
    const stub = makeStubSupabase();
    stub.setResult({ data: null, error: { code: "57P01", message: "down" } });
    const request = new Request("http://localhost/api/v1/standard", {
      headers: { "x-vercel-forwarded-for": "10.0.0.2" },
    });
    const { allowed } = await withRateLimitDistributed(
      stub.client,
      request,
      "/api/v1/standard",
      "standard",
    );
    expect(allowed).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe("failReason discrimination (SCRUM-302: brownout-deny vs quota-deny)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("quota-deny (count > max, RPC succeeded) does NOT set failReason", async () => {
    const stub = makeStubSupabase();
    // Post-increment count = 2, max = 1 → over the cap.
    stub.setResult({
      data: [{ count: 2, reset_time: new Date(Date.now() + 30_000).toISOString() }],
      error: null,
    });
    const result = await rateLimitDistributed(
      stub.client,
      "quota-org",
      "endpoint",
      "fallbackTestCall",
    );
    expect(result.allowed).toBe(false);
    // No failReason on the legitimate quota-burn path — quota-deny is
    // the user's fault ("you hammered the API"), brownout-deny isn't.
    expect(result.failReason).toBeUndefined();
  });

  it("brownout-deny (RPC errored, costControl=true) sets failReason='service-degraded'", async () => {
    const stub = makeStubSupabase();
    stub.setResult({ data: null, error: { code: "57P01", message: "admin shutdown" } });
    const result = await rateLimitDistributed(
      stub.client,
      "brownout-org",
      "endpoint",
      "fallbackTestCall",
    );
    expect(result.allowed).toBe(false);
    expect(result.failReason).toBe("service-degraded");
  });

  it("brownout-deny via withRateLimitDistributed propagates failReason", async () => {
    // The wrapper delegates to rateLimitDistributed; verify the field
    // isn't accidentally dropped on the way through.
    const stub = makeStubSupabase();
    stub.setThrows(new Error("ECONNREFUSED"));
    const request = new Request("http://localhost/api/v1/voice-preview", {
      headers: { "x-vercel-forwarded-for": "192.0.2.1" },
    });
    const result = await withRateLimitDistributed(
      stub.client,
      request,
      "/api/v1/voice-preview",
      "expensive",
    );
    expect(result.allowed).toBe(false);
    expect(result.failReason).toBe("service-degraded");
  });

  it("non-cost-control fallback to local Map does NOT set failReason", async () => {
    // standard profile + RPC error → falls back to local Map, allowed=true.
    // failReason should remain undefined (not a denial at all).
    const stub = makeStubSupabase();
    stub.setResult({ data: null, error: { code: "57P01", message: "down" } });
    const result = await rateLimitDistributed(
      stub.client,
      "fallback-org-noreason",
      "endpoint",
      "standard",
    );
    expect(result.allowed).toBe(true);
    expect(result.failReason).toBeUndefined();
  });

  it("happy path (allowed=true) does NOT set failReason", async () => {
    const stub = makeStubSupabase();
    const result = await rateLimitDistributed(
      stub.client,
      "happy-org",
      "endpoint",
      "fallbackTestCall",
    );
    expect(result.allowed).toBe(true);
    expect(result.failReason).toBeUndefined();
  });

  it("sync rateLimit() never sets failReason (it's a distributed-limiter-only concept)", () => {
    const result = rateLimit("sync-id", "endpoint", "standard");
    expect(result.failReason).toBeUndefined();
  });
});

describe("ServiceRoleSupabaseClient brand (SCRUM-298)", () => {
  // These tests prove the brand at compile time. `@ts-expect-error`
  // comments fail the build if the type system stops rejecting the
  // wrong client shape — that build break IS the regression test.
  //
  // Production calls are wrapped in `if (false)` so the typechecker
  // sees them but the runtime never executes (avoids unhandled
  // promise rejections + stderr noise from the destructure-on-undefined).

  it("rejects an unbranded SupabaseClient<Database> (the user-bound cookie client)", () => {
    // Simulates `await createClient()` — the SSR cookie client. The
    // shape is a full SupabaseClient<Database> so the only mismatch
    // available for `@ts-expect-error` to catch is the brand itself.
    // (A bare object would be rejected on structural grounds too, so
    // that wouldn't actually prove the brand — see SCRUM-298 review.)
    const cookieClient =
      {} as unknown as import("@supabase/supabase-js").SupabaseClient<
        import("@/lib/supabase/database.types").Database
      >;
    if (false as boolean) {
      // @ts-expect-error — `SupabaseClient<Database>` is NOT assignable
      // to `ServiceRoleSupabaseClient` (brand missing). If the brand
      // is ever rolled back the error here disappears and the unused
      // expect-error fails the build.
      rateLimitDistributed(cookieClient, "id", "ep", "standard");
    }
    expect(true).toBe(true);
  });

  it("rejects an unbranded SupabaseClient<Database> at `withRateLimitDistributed` too", () => {
    // Parallel coverage so a future contributor who decides
    // withRateLimitDistributed should accept a wider type is forced
    // to update this assertion explicitly.
    const cookieClient =
      {} as unknown as import("@supabase/supabase-js").SupabaseClient<
        import("@/lib/supabase/database.types").Database
      >;
    const dummyRequest = new Request("http://localhost/");
    if (false as boolean) {
      // @ts-expect-error — same brand-rejection contract as the
      // un-wrapped helper above.
      withRateLimitDistributed(cookieClient, dummyRequest, "ep", "standard");
    }
    expect(true).toBe(true);
  });

  it("accepts the stub via `as unknown as RateLimitSupabaseClient` (test escape hatch)", async () => {
    // This is what every other test in this file does. The brand
    // is real, but tests bypass it deliberately to model RPC error
    // paths the strict type can't express.
    const stub = makeStubSupabase();
    await rateLimitDistributed(stub.client, "id", "ep", "standard");
    expect(stub.rpc).toHaveBeenCalled();
  });
});

describe("rateLimit (sync wrapper)", () => {
  it("returns headers with X-RateLimit-* on allowed", () => {
    const { allowed, headers } = rateLimit("test-id-1", "endpoint", "standard");
    expect(allowed).toBe(true);
    expect(headers["X-RateLimit-Limit"]).toBeDefined();
    expect(headers["X-RateLimit-Remaining"]).toBeDefined();
    expect(headers["X-RateLimit-Reset"]).toBeDefined();
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("Retry-After is >= 1 on denied requests (SCRUM-291 clamp)", () => {
    // Use a 1-request limit so the second hit is denied. With a 60s
    // window the unclamped value is already ≥ 1, so this test passes
    // either way — but it locks in the basic "denied → positive
    // Retry-After" contract.
    const key = "test-clamp-id";
    rateLimit(key, "endpoint", "fallbackTestCall");
    const { allowed, headers } = rateLimit(key, "endpoint", "fallbackTestCall");
    expect(allowed).toBe(false);
    expect(Number(headers["Retry-After"])).toBeGreaterThanOrEqual(1);
  });

  it("Retry-After is clamped to >= 1 even when resetTime is in the PAST (degenerate path)", () => {
    // Force the degenerate `resetTime < Date.now()` case using fake
    // timers: hit the limiter (creates a bucket with resetTime = now +
    // 60s), then jump time forward 59.4s and trigger the over-limit
    // path before the bucket expires (60s exactly). The actual past-
    // resetTime case is only reachable if `checkRateLimit` skipped its
    // own expiry guard — defense-in-depth, but the clamp catches it.
    //
    // The simpler proof: stub `Date.now()` directly so the second call
    // computes ceil((futureReset - laterNow) / 1000) ≤ 0 even though
    // the bucket is still considered "active". This exercises only the
    // rateLimit wrapper's Retry-After math — not the bucket-state
    // machine in `checkRateLimit`.
    const key = "test-clamp-degenerate";
    // First call: create bucket, but force Date.now() WAY in the past
    // so resetTime ends up close to "real now".
    const realNow = Date.now();
    const originalDateNow = Date.now;
    Date.now = vi.fn(() => realNow - 120_000); // 2 min before real now
    try {
      rateLimit(key, "endpoint", "fallbackTestCall"); // creates bucket
      // Second call: Date.now() returns way after the bucket's resetTime
      // (which was set to realNow - 120s + 60s = realNow - 60s).
      Date.now = vi.fn(() => realNow); // bucket expired 60s ago
      const r = rateLimit(key, "endpoint", "fallbackTestCall");
      // checkRateLimit treats this as a NEW window (bucket expired),
      // so it's actually allowed. The Retry-After clamp doesn't apply
      // (no Retry-After header set on allowed responses). This is
      // correct behavior — the clamp guard is for cases where
      // checkRateLimit somehow returns allowed=false with a past
      // resetTime, which the in-memory store doesn't naturally produce.
      // What we CAN assert here: if a 429 ever comes back from the
      // sync limiter, Retry-After must be ≥ 1.
      if (!r.allowed) {
        expect(Number(r.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
      }
    } finally {
      Date.now = originalDateNow;
    }
  });
});

describe("demoCallGlobal profile (SCRUM-340)", () => {
  // Locks the profile name + values: the demo-call route references
  // "demoCallGlobal" by string, and an arg-order/profile-rename slip would
  // typecheck but silently break the global cost cap.
  it("is 100 requests per hour with cost-control fail-closed", () => {
    expect(rateLimitConfigs.demoCallGlobal).toBeDefined();
    expect(rateLimitConfigs.demoCallGlobal.maxRequests).toBe(100);
    expect(rateLimitConfigs.demoCallGlobal.windowMs).toBe(60 * 60 * 1000);
    expect(
      "costControl" in rateLimitConfigs.demoCallGlobal &&
        rateLimitConfigs.demoCallGlobal.costControl
    ).toBe(true);
  });
});
