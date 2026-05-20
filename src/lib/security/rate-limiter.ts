/**
 * Rate limiter.
 *
 * Two flavours live here side by side:
 *
 *   1. `rateLimit(...)` — the original per-process Map. Synchronous, zero
 *      DB cost, fine for UX-grade limits ("don't hammer the API") where a
 *      motivated attacker hitting parallel lambda instances isn't a real
 *      threat to the business.
 *
 *   2. `rateLimitDistributed(supabase, ...)` — async, hits a shared
 *      Postgres atomic counter (`check_rate_limit_bucket`). Required for
 *      cost-control limits on paid-action endpoints (Twilio outbound,
 *      Google Places, ElevenLabs preview, etc.) where per-instance
 *      enforcement is genuinely bypassable.
 *
 * Callers pick the right tool: stay sync for UX limits, opt into async +
 * shared store for endpoints whose abuse costs us real money. The headers
 * and 429 contract are identical between the two so middleware-style
 * usage doesn't have to branch.
 *
 * On distributed lookup failure (DB brownout) the async helper falls
 * BACK to the local Map limiter rather than failing closed — locking
 * users out during a Supabase outage is worse than the per-instance
 * weakness the function is meant to fix. The fallback is Sentry-paged.
 *
 * See SCRUM-277 for the broader rationale and the migration that adds
 * the Postgres side (00135_rate_limit_buckets.sql).
 */

import * as Sentry from "@sentry/nextjs";
import { SENTRY_REASONS } from "./error-ids";
import { setReasonTag } from "@/lib/observability/sentry-tags";
import type { Database } from "@/lib/supabase/database.types";
import type { ServiceRoleSupabaseClient } from "@/lib/supabase/admin";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
}

/**
 * Argument and return shape of the `check_rate_limit_bucket` RPC,
 * derived from the generated Supabase types. The narrow value-side
 * shape lets compile-time catch a typo like `p_window_ms` →
 * `p_windowMs` at the call site (which would otherwise slip into the
 * always-fail-back path and only show up in Sentry).
 *
 * Exported (SCRUM-298) so test stubs and other rate-limiter
 * extensions can model the contract without re-deriving it.
 */
export type CheckRateLimitBucketArgs =
  Database["public"]["Functions"]["check_rate_limit_bucket"]["Args"];
export type CheckRateLimitBucketReturns =
  Database["public"]["Functions"]["check_rate_limit_bucket"]["Returns"];

/**
 * The Supabase surface `rateLimitDistributed` needs.
 *
 * SCRUM-298: tightened from a `SupabaseClient<Database> | stub` union
 * down to just `ServiceRoleSupabaseClient` (the branded type returned
 * by `createAdminClient()`). The stub-arm never earned its keep — test
 * stubs cast through `unknown` anyway because they model error paths
 * the strict type cannot express. The brand makes the service-role
 * requirement (from migration 00136 which REVOKE'd the RPC from
 * `authenticated`) a compile-time error rather than a docstring +
 * code-review convention.
 */
export type RateLimitSupabaseClient = ServiceRoleSupabaseClient;

// In-memory store (use Redis for distributed systems)
const store = new Map<string, RateLimitEntry>();

/**
 * Result of a rate-limit check. Returned by both the sync `rateLimit()`
 * and async `rateLimitDistributed()` (+ `withRateLimitDistributed`).
 *
 * `failReason` is set ONLY on the distributed limiter's fail-CLOSED
 * branch (cost-control profiles during a Supabase brownout) so callers
 * can distinguish "service is degraded, try again in a moment" from
 * "you've hit your quota, slow down". Both still return 429 with
 * Retry-After — only the JSON body should differ. SCRUM-302.
 */
export type RateLimitFailReason = "service-degraded";

export interface RateLimitResult {
  allowed: boolean;
  headers: Record<string, string>;
  /** Set only when allowed=false AND the deny came from the
   *  fail-CLOSED brownout path. Quota-exhausted denies leave this
   *  undefined so the existing 429 UX stays unchanged. */
  failReason?: RateLimitFailReason;
}

// Clean up expired entries periodically
const CLEANUP_INTERVAL = 60 * 1000; // 1 minute
let cleanupTimer: NodeJS.Timeout | null = null;

function startCleanup() {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.resetTime < now) {
        store.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);

  // Don't prevent process from exiting
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

// Start cleanup on module load
startCleanup();

/**
 * Default rate limit configurations.
 *
 * `costControl: true` opts the profile into fail-CLOSED behaviour when
 * the distributed limiter (rateLimitDistributed) can't reach Postgres.
 * Use it for any profile that gates a paid third-party action (Twilio
 * outbound, ElevenLabs, Google Places, etc.) — falling back to the
 * per-instance Map during a brownout would otherwise restore the exact
 * bypass `rateLimitDistributed` exists to close. Everything else (UX-
 * grade limits, webhook spam guards) keeps fail-open semantics so a
 * Supabase blip doesn't lock legitimate users out.
 */
export const rateLimitConfigs = {
  // Standard API calls - 100 per minute
  standard: {
    windowMs: 60 * 1000,
    maxRequests: 100,
  },
  // Authentication endpoints - 10 per minute
  auth: {
    windowMs: 60 * 1000,
    maxRequests: 10,
  },
  // Webhook endpoints - 1000 per minute (high volume)
  webhook: {
    windowMs: 60 * 1000,
    maxRequests: 1000,
  },
  // Expensive operations (scraping, AI) - 10 per minute
  expensive: {
    windowMs: 60 * 1000,
    maxRequests: 10,
    costControl: true,
  },
  // Test calls - 5 per minute
  testCall: {
    windowMs: 60 * 1000,
    maxRequests: 5,
  },
  // Fallback test calls (outbound, paid Twilio call) — 1 per minute per org
  // to prevent abuse. Tight on purpose: a typo'd fallback is rare and the
  // legitimate use case is "verify once after editing".
  fallbackTestCall: {
    windowMs: 60 * 1000,
    maxRequests: 1,
    costControl: true,
  },
  // Admin expensive operations (Google Places API, bulk scraping) - 3 per minute
  adminExpensive: {
    windowMs: 60 * 1000,
    maxRequests: 3,
    costControl: true,
  },
} as const;

export type RateLimitType = keyof typeof rateLimitConfigs;

/**
 * Check if a request should be rate limited
 * Returns remaining requests if allowed, or -1 if rate limited
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const entry = store.get(key);

  // No entry or expired - create new entry
  if (!entry || entry.resetTime < now) {
    const resetTime = now + config.windowMs;
    store.set(key, { count: 1, resetTime });
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetTime,
    };
  }

  // Entry exists and not expired
  if (entry.count >= config.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: entry.resetTime,
    };
  }

  // Increment count
  entry.count++;
  store.set(key, entry);

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetTime: entry.resetTime,
  };
}

/**
 * Get rate limit key for a request
 * Uses IP + optional user ID for more granular limiting
 */
export function getRateLimitKey(
  identifier: string,
  endpoint: string
): string {
  return `${identifier}:${endpoint}`;
}

/**
 * Rate limiter helper that returns response headers
 */
export function rateLimit(
  identifier: string,
  endpoint: string,
  type: RateLimitType = "standard"
): RateLimitResult {
  const config = rateLimitConfigs[type];
  const key = getRateLimitKey(identifier, endpoint);
  const result = checkRateLimit(key, config);

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": config.maxRequests.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": Math.ceil(result.resetTime / 1000).toString(),
  };

  if (!result.allowed) {
    // SCRUM-291: clamp to >= 1 so a degenerate `resetTime < Date.now()`
    // case never emits `Retry-After: 0`, which some clients interpret
    // as "retry immediately" and would just trigger another 429. Same
    // clamp as the async `rateLimitDistributed` (`buildHeaders` below).
    headers["Retry-After"] = Math.max(
      1,
      Math.ceil((result.resetTime - Date.now()) / 1000),
    ).toString();
  }

  return { allowed: result.allowed, headers };
}

/**
 * Get client IP from request headers
 * Handles common proxy headers
 */
export function getClientIp(headers: Headers): string {
  // SCRUM-290 security fix: header priority. The previous order trusted
  // `x-forwarded-for` first and took its FIRST comma-separated entry —
  // but on Vercel that entry is client-supplied. A malicious caller
  // could send `x-forwarded-for: <victim-IP>` to bucket their requests
  // under another user's IP and lock that user out of paid-action
  // endpoints (the bucket is now global in Postgres, so the lockout is
  // platform-wide, not just per-lambda).
  //
  // Vercel-controlled headers (which the edge always sets and the
  // client cannot fake) take precedence here. We fall back to taking
  // the LAST entry of `x-forwarded-for` — that's the one the trusted
  // proxy actually appended, not what the client claimed.

  // 1. `x-vercel-forwarded-for` — set by Vercel edge to the true client
  //    IP. Untaintable by client headers in production.
  const vercelIp = headers.get("x-vercel-forwarded-for");
  if (vercelIp) {
    return vercelIp.split(",")[0].trim();
  }

  // 2. `x-real-ip` — also Vercel-set; single value, not a chain.
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  // 3. `x-forwarded-for` — fall back to the LAST entry. The proxy
  //    appends the actual client IP last; everything before it is
  //    client-supplied and untrusted.
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor.split(",");
    return parts[parts.length - 1].trim();
  }

  return "unknown";
}

/**
 * Convenience function to apply rate limiting to Next.js API routes
 */
export function withRateLimit(
  request: Request,
  endpoint: string,
  type: RateLimitType = "standard"
) {
  const clientIp = getClientIp(new Headers(request.headers));
  return rateLimit(clientIp, endpoint, type);
}

// ─────────────────────────────────────────────────────────────────────
// Distributed (cross-instance) rate limiter — SCRUM-277.
//
// Backed by the `rate_limit_buckets` table and `check_rate_limit_bucket`
// SECURITY DEFINER RPC. The RPC does an atomic UPSERT that either
// increments an active bucket or resets an expired one in a single
// round-trip, so two concurrent lambdas can never both observe "we're
// under the cap" against the same key.
// ─────────────────────────────────────────────────────────────────────

/**
 * Single bucket row as returned by `check_rate_limit_bucket`. Derived
 * from the generated Supabase types so a Postgres-side rename + regen
 * propagates here without a duplicate hand-maintained shape.
 */
type RateLimitBucketRow = CheckRateLimitBucketReturns[number];

/** RPC name lives in one place so the call site and the generated
 *  `Database["public"]["Functions"]` overload stay in lockstep — a
 *  rename in one spot is a typecheck error in the other. */
const CHECK_BUCKET_RPC = "check_rate_limit_bucket" as const;

/**
 * Stringify an RPC error for logs/Sentry. Plain `String(obj)` returns
 * "[object Object]" for Supabase error responses, stripping the PG
 * code/message/hint/details that on-call needs to triage. Preserve
 * Error instances as-is and JSON-stringify everything else.
 */
function stringifyRpcError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return "unknown";
  if (typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

function buildHeaders(
  config: RateLimitConfig,
  count: number,
  resetTime: number,
  allowed: boolean,
): Record<string, string> {
  const remaining = Math.max(0, config.maxRequests - count);
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": config.maxRequests.toString(),
    "X-RateLimit-Remaining": remaining.toString(),
    "X-RateLimit-Reset": Math.ceil(resetTime / 1000).toString(),
  };
  if (!allowed) {
    // Retry-After is integer seconds (RFC 7231). Round up so a partial
    // second doesn't tell the client "retry now" while the window is
    // still 0.4s open.
    headers["Retry-After"] = Math.max(
      1,
      Math.ceil((resetTime - Date.now()) / 1000),
    ).toString();
  }
  return headers;
}

/**
 * Cross-instance rate-limit check. Use for paid-action endpoints (Twilio
 * outbound calls, ElevenLabs voice preview, Google Places API, etc.)
 * where a motivated abuser hitting parallel lambda instances would
 * otherwise bypass the per-process Map.
 *
 * Failure mode is driven by the profile's `costControl` flag:
 *   - costControl=true → fail CLOSED on RPC error (return 429 with
 *     `Retry-After: 60`). Falling back to the per-instance Map during a
 *     Supabase brownout would restore the exact bypass this function
 *     exists to close, so we'd rather lock the (rare) outage admin out
 *     than expose unbounded Twilio cost.
 *   - costControl=false (or absent) → fall back to the local Map
 *     limiter. UX-grade limits ("don't hammer the API") shouldn't lock
 *     users out during a DB blip.
 *
 * Both modes Sentry-page on RPC failure so on-call sees the degraded
 * mode regardless of which path was taken.
 *
 * IMPORTANT: this function calls a SECURITY DEFINER RPC whose EXECUTE
 * is restricted to `service_role` (the `authenticated` grant was
 * revoked in migration 00136 after the cross-tenant poisoning vector
 * was found). The caller MUST pass a service-role-level Supabase client
 * (e.g. `createAdminClient()` from `@/lib/supabase/admin`). A user-bound
 * cookie client will hit the RPC and get `permission denied`, which the
 * function will treat as a brownout and either fail closed
 * (cost-control) or fall back (non-cost-control) — so the only visible
 * symptom of using the wrong client is the Sentry page. Verify the
 * client type in code review.
 *
 * @param supabase  Service-role Supabase client (see note above).
 * @param identifier  Per-org UUID, IP address, or other namespace
 *                    component. Combined with `endpoint` to form the
 *                    bucket key — same shape as the sync limiter.
 * @param endpoint    Short identifier of the protected route.
 * @param type        Configured limit profile.
 */
export async function rateLimitDistributed(
  supabase: RateLimitSupabaseClient,
  identifier: string,
  endpoint: string,
  type: RateLimitType = "standard",
): Promise<RateLimitResult> {
  const config = rateLimitConfigs[type];
  const key = getRateLimitKey(identifier, endpoint);
  // SCRUM-298: `costControl` is only present on profiles that opt in.
  // Use `in` to narrow rather than cast — TypeScript discriminates
  // the as-const literal-typed configs cleanly, so a future profile
  // that forgets the flag still defaults to fail-open here without
  // needing a cast.
  const failClosed = "costControl" in config && config.costControl === true;

  let row: RateLimitBucketRow | null = null;
  let rpcError: unknown = null;
  try {
    // No `as { data: unknown; error: unknown }` widener needed — the
    // branded `SupabaseClient<Database>` carries the narrowed
    // `check_rate_limit_bucket` overload directly, so destructuring
    // `{ data, error }` returns `CheckRateLimitBucketReturns | null`
    // plus `error: unknown` for free. SCRUM-298 collapsed the prior
    // `RateLimitSupabaseClient` union (which required this widener
    // to bridge the two arms) down to just the branded type.
    const { data, error } = await supabase.rpc(CHECK_BUCKET_RPC, {
      p_key: key,
      p_window_ms: config.windowMs,
      p_max_requests: config.maxRequests,
    });
    if (error) {
      rpcError = error;
    } else if (Array.isArray(data) && data.length > 0) {
      // PostgREST returns TABLE(...)-typed RPCs as an array of row objects.
      // `data[0]` is now correctly typed as `RateLimitBucketRow` — no cast.
      row = data[0];
    } else {
      rpcError = new Error("check_rate_limit_bucket returned empty result");
    }
  } catch (err) {
    rpcError = err;
  }

  if (row) {
    // count is post-increment — if count > max, this request put us over.
    const resetTime = new Date(row.reset_time).getTime();
    if (Number.isNaN(resetTime)) {
      // Shouldn't happen — Postgres returned a malformed timestamp. Treat
      // as DB error (fall back) so we don't emit a nonsense Retry-After.
      rpcError = new Error(
        `check_rate_limit_bucket returned non-parseable reset_time: ${row.reset_time}`,
      );
    } else {
      const allowed = row.count <= config.maxRequests;
      return {
        allowed,
        headers: buildHeaders(config, row.count, resetTime, allowed),
      };
    }
  }

  // Fallback path: DB unreachable, returned malformed data, or RPC
  // permission denied (caller mis-using a non-service-role client).
  // Branch on the profile's cost-control flag — see function docstring
  // for the trade-off.
  //
  // Stringify Supabase error objects deliberately — `String({})` yields
  // "[object Object]" and silently strips PG codes (e.g. "57P01" for
  // admin shutdown, "42501" for permission denied). On-call triage
  // depends on those codes, so JSON-stringify non-Error objects to
  // preserve them in console + Sentry.
  const errStr = stringifyRpcError(rpcError);
  console.error(
    "[rate-limiter] distributed check failed",
    failClosed ? "— failing CLOSED (costControl)" : "— falling back to local Map",
    { key, type, error: errStr },
  );
  try {
    Sentry.withScope((scope) => {
      scope.setTag("service", "next-api");
      setReasonTag(scope, SENTRY_REASONS.RATE_LIMIT_DISTRIBUTED_FAILED);
      scope.setTag("failMode", failClosed ? "closed" : "local-fallback");
      scope.setLevel("warning");
      // Pass the raw object as an extra so the full PG error (code, hint,
      // details) lands in Sentry even if the captureException message is
      // just the stringified summary.
      scope.setExtras({ key, type, rpcErrorRaw: rpcError });
      Sentry.captureException(
        rpcError instanceof Error ? rpcError : new Error(errStr),
      );
    });
  } catch (sentryErr) {
    // Sentry shim defect must not crash the limiter, but the swallowed
    // shim error is itself a meta-silent-failure signal. Emit a console
    // breadcrumb so a permanent shim regression is at least visible
    // in Vercel/Loki logs even if no Sentry events are arriving.
    console.error(
      "[rate-limiter] Sentry capture failed (continuing limiter):",
      sentryErr,
    );
  }

  if (failClosed) {
    // Pay-per-call profile during a brownout: deny rather than re-open
    // the bypass the distributed limiter exists to close. Headers
    // mirror the normal 429 shape, with a conservative Retry-After
    // anchored to the configured window so clients back off.
    //
    // SCRUM-302: tag this branch with `failReason: "service-degraded"`
    // so callers can render a distinct UX message — a user mid-
    // onboarding sees "Service temporarily unavailable" rather than
    // a misleading "Too many requests" when they made one request and
    // have plenty of quota.
    const resetTime = Date.now() + config.windowMs;
    return {
      allowed: false,
      headers: buildHeaders(config, config.maxRequests + 1, resetTime, false),
      failReason: "service-degraded",
    };
  }
  return rateLimit(identifier, endpoint, type);
}

/**
 * Distributed equivalent of `withRateLimit(request, ...)` — keys on the
 * caller's IP for paid-action endpoints that don't have a per-org
 * identifier handy at the time of the rate-limit check (e.g. routes
 * that do the auth check AFTER the rate limit). Use this when migrating
 * existing `withRateLimit` call sites; for routes that already load a
 * resource first, call `rateLimitDistributed` with the org id directly.
 *
 * SCRUM-290 follow-up to SCRUM-277 — covers the 6 paid-action endpoints
 * (voice-preview, scrape-preview, knowledge-base/scrape, lead-discovery
 * scan/search/export) that previously bypassed the per-instance Map by
 * parallelising across lambda cold-starts.
 *
 * Caller must supply a service-role Supabase client (see the
 * `rateLimitDistributed` docstring for the why).
 */
export async function withRateLimitDistributed(
  supabase: RateLimitSupabaseClient,
  request: Request,
  endpoint: string,
  type: RateLimitType = "standard",
): Promise<RateLimitResult> {
  const clientIp = getClientIp(new Headers(request.headers));
  return rateLimitDistributed(supabase, clientIp, endpoint, type);
}
