import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { SENTRY_REASONS, type SentryReason } from "@/lib/security/error-ids";

/**
 * Midnight UTC keep-alive cron. Three jobs in one tick so the Vercel
 * Hobby plan's daily-cron budget stretches further:
 *
 *   1. Supabase liveness ping — prevents project auto-pause.
 *   2. Upstash Redis ping — same (optional, only if configured).
 *   3. Prune expired rate_limit_buckets rows (SCRUM-289 — the cleanup
 *      function shipped in 00135 had no caller until now).
 *
 * Cron failures must page Sentry so silent decay is impossible. All
 * three jobs use `pageSentry` (below) for consistent per-job `reason`
 * tags, level=warning, and the defensive try/catch (sentryErr) shim
 * that ensures a Sentry transport defect cannot crash the cron.
 *
 * Per-job Sentry reasons (SCRUM-292 extended the cleanup-only set
 * from SCRUM-289 to cover all three jobs):
 *   - supabase-ping-failed / supabase-ping-threw
 *   - upstash-ping-failed  / upstash-ping-threw
 *   - rate-limit-cleanup-failed / rate-limit-cleanup-threw /
 *     rate-limit-cleanup-unexpected-shape
 */

/**
 * Page Sentry with the cron's standard scope tags + a per-failure
 * `reason`. The `try/catch (sentryErr)` shim around the actual
 * Sentry.withScope call is the suppression contract from SCRUM-277 —
 * a permanent Sentry shim defect must not crash the cron.
 *
 * Use `captureException` for thrown/error-object failures (keeps the
 * stack trace on the Sentry side) and `captureMessage` for non-Error
 * conditions like "RPC returned unexpected shape".
 */
function pageSentry(opts: {
  reason: SentryReason;
  level?: "warning" | "error";
  err?: unknown;
  message?: string;
  extras?: Record<string, unknown>;
}) {
  const { reason, level = "warning", err, message, extras } = opts;
  try {
    Sentry.withScope((scope) => {
      scope.setTag("service", "next-cron");
      scope.setTag("cron", "keep-alive");
      scope.setTag("reason", reason);
      scope.setLevel(level);
      if (extras) scope.setExtras(extras);
      if (err !== undefined) {
        Sentry.captureException(
          err instanceof Error ? err : new Error(String(err)),
        );
      } else if (message) {
        Sentry.captureMessage(message);
      }
    });
  } catch (sentryErr) {
    // Sentry shim defect must not crash the cron — but make the
    // breadcrumb loud enough that a programming-error-in-the-helper
    // (vs. a genuine Sentry-transport-down) is easy to spot in Loki.
    // Log the full error including stack so the next on-call shift
    // can distinguish "Sentry is down" from "our pageSentry helper
    // has a bug" without having to repro.
    console.error(
      "[KeepAlive] Sentry capture failed (continuing cron):",
      sentryErr instanceof Error
        ? `${sentryErr.message}\n${sentryErr.stack ?? ""}`
        : sentryErr,
    );
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Record<string, string> = {};
  const supabase = createAdminClient();

  // 1. Ping Supabase to keep the project active
  // SCRUM-292 review: dropped the `(supabase as any)` cast — after
  // SCRUM-291's `supabase gen types` regen the typed `.from()` chain
  // is well-defined. A typo on a table name now fails the typechecker.
  try {
    const { error } = await supabase
      .from("organizations")
      .select("id")
      .limit(1);

    if (error) {
      results.supabase = `error: ${error.message}`;
      console.error("[KeepAlive] Supabase ping failed:", error);
      // SCRUM-292: page Sentry on Supabase auto-pause / brownout —
      // the entire reason this cron exists is to prevent auto-pause,
      // so failing silently here would defeat the purpose.
      pageSentry({ reason: SENTRY_REASONS.SUPABASE_PING_FAILED, err: error });
    } else {
      results.supabase = "ok";
    }
  } catch (err) {
    results.supabase = "error";
    console.error("[KeepAlive] Supabase ping threw:", err);
    pageSentry({ reason: SENTRY_REASONS.SUPABASE_PING_THREW, err });
  }

  // 2. Ping Upstash Redis to prevent inactivity expiration
  // SCRUM-292 review: detect the "half-configured" state (only one of
  // URL/TOKEN set, the other missing). Previously this fell through
  // to the silent "skipped" branch — a token rotation that forgot to
  // refresh both env vars would silently decay the Redis backend
  // until inactivity expiration, exactly the failure mode this cron
  // exists to catch.
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const upstashUrlSet = Boolean(upstashUrl);
  const upstashTokenSet = Boolean(upstashToken);
  if (upstashUrlSet && upstashTokenSet) {
    try {
      const { Redis } = await import("@upstash/redis");
      const redis = Redis.fromEnv();
      const pong = await redis.ping();
      if (pong === "PONG") {
        results.upstash = "ok";
      } else {
        // SCRUM-292: unexpected response is a soft failure — Redis
        // responded but with the wrong message. Page so we don't
        // silently accept a misconfigured backend.
        results.upstash = `unexpected: ${pong}`;
        console.error("[KeepAlive] Upstash ping unexpected response:", pong);
        pageSentry({
          reason: SENTRY_REASONS.UPSTASH_PING_FAILED,
          message: "Upstash Redis ping returned non-PONG response",
          extras: { response: String(pong) },
        });
      }
    } catch (err) {
      results.upstash = "error";
      console.error("[KeepAlive] Upstash Redis ping failed:", err);
      pageSentry({ reason: SENTRY_REASONS.UPSTASH_PING_THREW, err });
    }
  } else if (upstashUrlSet !== upstashTokenSet) {
    // XOR: exactly one of the two env vars is set. A deploy that
    // rotated the token and forgot the URL (or vice versa) lands here.
    // Treat as failure — never "skipped".
    results.upstash = `half-configured (${upstashUrlSet ? "URL set, TOKEN missing" : "TOKEN set, URL missing"})`;
    console.error("[KeepAlive] Upstash half-configured:", results.upstash);
    pageSentry({
      reason: SENTRY_REASONS.UPSTASH_HALF_CONFIGURED,
      message: "Upstash env vars are half-configured",
      extras: {
        urlSet: upstashUrlSet,
        tokenSet: upstashTokenSet,
      },
    });
  } else {
    // Neither set → optional Upstash is intentionally disabled.
    results.upstash = "skipped (not configured)";
  }

  // 3. SCRUM-289: prune expired rate_limit_buckets rows. The cleanup
  // function is SECURITY DEFINER and was granted to service_role only
  // in 00135 (the migration that created it), so the admin client
  // above is required. Sentry-paged on failure so a slow accumulation
  // of dead rows can't go unnoticed for months.
  //
  // Verified against supabase-js@2.x + PostgREST 12 (2026-05-20):
  // `cleanup_rate_limit_buckets()` returns `data: <number>` matching
  // its Postgres `RETURNS INTEGER` signature, not `data: [{ ... }]`.
  // If you upgrade either, re-verify before trusting the deleted-row
  // log — the non-number branch below treats shape drift as a warning
  // (not success) so a silent regression here surfaces in Sentry.
  try {
    // No `as any` — `database.types.ts` knows `cleanup_rate_limit_buckets`
    // returns `number` and takes no args (since SCRUM-291's `gen types`
    // regen), so a typo on the RPC name now fails the typechecker.
    const { data, error } = await supabase.rpc("cleanup_rate_limit_buckets");
    if (error) {
      results.rate_limit_cleanup = `error: ${error.message}`;
      console.error("[KeepAlive] rate_limit_cleanup RPC failed:", error);
      pageSentry({ reason: SENTRY_REASONS.RATE_LIMIT_CLEANUP_FAILED, err: error });
    } else if (typeof data !== "number") {
      // Shape drift. The Postgres signature returns INTEGER; anything
      // else (null, array, string, etc.) is a regression in supabase-js
      // or the migration itself. Treat as a warning, not a success —
      // otherwise the log silently reads "deleted: 0" forever even if
      // the function is broken.
      const dataType = data === null ? "null" : typeof data;
      results.rate_limit_cleanup = `warn: unexpected RPC shape (${dataType})`;
      console.warn("[KeepAlive] rate_limit_cleanup unexpected shape:", data);
      pageSentry({
        reason: SENTRY_REASONS.RATE_LIMIT_CLEANUP_UNEXPECTED_SHAPE,
        message: "cleanup_rate_limit_buckets returned non-integer",
        extras: { dataType },
      });
    } else {
      results.rate_limit_cleanup = "ok";
      // Log the deleted count so a stuck cleanup (always 0) is visible.
      console.log("[KeepAlive] rate_limit_cleanup deleted rows:", data);
    }
  } catch (err) {
    results.rate_limit_cleanup = "error";
    console.error("[KeepAlive] rate_limit_cleanup threw:", err);
    pageSentry({ reason: SENTRY_REASONS.RATE_LIMIT_CLEANUP_THREW, err });
  }

  const allOk = Object.values(results).every((v) => v === "ok" || v.startsWith("skipped"));

  console.log("[KeepAlive] Results:", results);
  return NextResponse.json(
    { ok: allOk, timestamp: new Date().toISOString(), ...results },
    { status: allOk ? 200 : 503 }
  );
}
