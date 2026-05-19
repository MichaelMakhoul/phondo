import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Midnight UTC keep-alive cron. Three jobs in one tick so the Vercel
 * Hobby plan's daily-cron budget stretches further:
 *
 *   1. Supabase liveness ping — prevents project auto-pause.
 *   2. Upstash Redis ping — same (optional, only if configured).
 *   3. Prune expired rate_limit_buckets rows (SCRUM-289 — the cleanup
 *      function shipped in 00135 had no caller until now).
 *
 * Cron failures must page Sentry so silent decay is impossible. The
 * cleanup call uses captureException explicitly because dead-row
 * accumulation is the kind of slow problem the daily cron exists to
 * prevent — losing 30 days of cleanups while no one notices is exactly
 * the failure mode SCRUM-289 was filed to close.
 */
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
  try {
    const { error } = await (supabase as any)
      .from("organizations")
      .select("id")
      .limit(1);

    results.supabase = error ? `error: ${error.message}` : "ok";
    if (error) console.error("[KeepAlive] Supabase ping failed:", error);
  } catch (err) {
    results.supabase = "error";
    console.error("[KeepAlive] Supabase ping threw:", err);
  }

  // 2. Ping Upstash Redis to prevent inactivity expiration
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Redis } = await import("@upstash/redis");
      const redis = Redis.fromEnv();
      const pong = await redis.ping();
      results.upstash = pong === "PONG" ? "ok" : `unexpected: ${pong}`;
    } catch (err) {
      results.upstash = "error";
      console.error("[KeepAlive] Upstash Redis ping failed:", err);
    }
  } else {
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
    const { data, error } = await (supabase as any).rpc("cleanup_rate_limit_buckets");
    if (error) {
      results.rate_limit_cleanup = `error: ${error.message}`;
      console.error("[KeepAlive] rate_limit_cleanup RPC failed:", error);
      Sentry.withScope((scope) => {
        scope.setTag("service", "next-cron");
        scope.setTag("cron", "keep-alive");
        scope.setTag("reason", "rate-limit-cleanup-failed");
        scope.setLevel("warning");
        Sentry.captureException(error);
      });
    } else if (typeof data !== "number") {
      // Shape drift. The Postgres signature returns INTEGER; anything
      // else (null, array, string, etc.) is a regression in supabase-js
      // or the migration itself. Treat as a warning, not a success —
      // otherwise the log silently reads "deleted: 0" forever even if
      // the function is broken.
      results.rate_limit_cleanup = `warn: unexpected RPC shape (${data === null ? "null" : typeof data})`;
      console.warn(
        "[KeepAlive] rate_limit_cleanup unexpected shape:",
        data,
      );
      Sentry.withScope((scope) => {
        scope.setTag("service", "next-cron");
        scope.setTag("cron", "keep-alive");
        scope.setTag("reason", "rate-limit-cleanup-unexpected-shape");
        scope.setLevel("warning");
        scope.setExtras({ dataType: data === null ? "null" : typeof data });
        Sentry.captureMessage(
          "cleanup_rate_limit_buckets returned non-integer",
        );
      });
    } else {
      results.rate_limit_cleanup = "ok";
      // Log the deleted count so a stuck cleanup (always 0) is visible.
      console.log("[KeepAlive] rate_limit_cleanup deleted rows:", data);
    }
  } catch (err) {
    results.rate_limit_cleanup = "error";
    console.error("[KeepAlive] rate_limit_cleanup threw:", err);
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "next-cron");
        scope.setTag("cron", "keep-alive");
        scope.setTag("reason", "rate-limit-cleanup-threw");
        scope.setLevel("warning");
        Sentry.captureException(
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    } catch (sentryErr) {
      console.error(
        "[KeepAlive] Sentry capture failed (continuing cron):",
        sentryErr,
      );
    }
  }

  const allOk = Object.values(results).every((v) => v === "ok" || v.startsWith("skipped"));

  console.log("[KeepAlive] Results:", results);
  return NextResponse.json(
    { ok: allOk, timestamp: new Date().toISOString(), ...results },
    { status: allOk ? 200 : 503 }
  );
}
