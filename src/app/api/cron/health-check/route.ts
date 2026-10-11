import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendAdminAlert } from "@/lib/notifications/admin-alerts";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { pageSentry } from "@/lib/observability/page-sentry";

const SERVICE_NAME = "voice-server";

// SCRUM-579: the 30s ping budget below only holds if the function itself is
// allowed to run that long. Matches daily-summary / number-release-sweep:
// 60s is the Hobby plan ceiling (vercel.json sets no per-function override).
// Without this the platform default could kill the run mid-ping — and this
// route writes system_health and alerts AFTER the fetch, so a truncated run
// would leave no health row and no alert. Silence, not a failure.
export const maxDuration = 60;

// SCRUM-579: whenever the voice server scales to zero when idle
// (min_machines_running = 0; it is 1 while outreach or a pilot runs, SCRUM-580),
// this daily ping is usually the request that wakes it. A cached-image wake takes ~6s; the first
// wake after a deploy re-pulls the image and measured ~14s. 10s would have turned
// a normal cold start into a false "voice server is down" admin alert, so the
// budget covers the pull case with room to spare. A genuinely dead server still
// fails — it just takes 30s to say so, once a day.
const HEALTH_TIMEOUT_MS = 30_000;

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req, "health-check");
  if (authFail) return authFail;

  const voiceServerUrl = process.env.VOICE_SERVER_PUBLIC_URL;

  // 1. Ping the voice server health endpoint
  let isHealthy = false;
  let errorMessage = "";

  if (!voiceServerUrl) {
    console.error("[HealthCheck] VOICE_SERVER_PUBLIC_URL not configured");
    errorMessage = "VOICE_SERVER_PUBLIC_URL not set";
  } else {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      try {
        const res = await fetch(`${voiceServerUrl}/health`, {
          signal: controller.signal,
        });

        isHealthy = res.ok;
        if (!isHealthy) {
          errorMessage = `HTTP ${res.status}`;
        }
      } finally {
        // finally, not after the await: the throw path below would otherwise
        // leave a 30s timer armed on a reused Fluid Compute instance.
        clearTimeout(timeout);
      }
    } catch (err) {
      isHealthy = false;
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  // 2. Read current state from system_health
  const supabase = createAdminClient();
  const { data: current, error: readError } = await (supabase as any)
    .from("system_health")
    .select("is_healthy, consecutive_failures")
    .eq("service", SERVICE_NAME)
    .maybeSingle();

  if (readError) {
    console.error("[HealthCheck] Failed to read health state from DB:", readError);
    // SCRUM-579: this used to be console.error only. Alerting below is skipped
    // when the read fails, and this cron is now the only external down-detector
    // (Fly stops probing a stopped machine), so a silent read failure means
    // nothing is watching. Page instead.
    pageSentry({
      service: "next-cron",
      reason: SENTRY_REASONS.HEALTH_CHECK_STATE_READ_FAILED,
      level: "error",
      err: readError,
      message: "health-check could not read system_health — down/recovery alerting skipped this run",
      tags: { cron: "health-check" },
    });
  }

  // If DB read failed, we can't determine previous state — skip alerting to avoid
  // false positives (spam on every check) or missed recovery alerts
  const dbReadOk = !readError;
  const wasHealthy = current?.is_healthy ?? true;
  const prevFailures = current?.consecutive_failures ?? 0;
  const newFailures = isHealthy ? 0 : prevFailures + 1;

  // 3. Upsert health state
  const { error: upsertError } = await (supabase as any)
    .from("system_health")
    .upsert({
      service: SERVICE_NAME,
      is_healthy: isHealthy,
      // SCRUM-579: when the read failed, prevFailures defaulted to 0, so writing
      // this would reset the escalation counter to 1 on every run — destroying
      // the signal precisely while alerting is suppressed. Leave it untouched.
      ...(dbReadOk ? { consecutive_failures: newFailures } : {}),
      last_check_at: new Date().toISOString(),
      last_error: isHealthy ? null : errorMessage,
      updated_at: new Date().toISOString(),
    }, { onConflict: "service" });

  if (upsertError) {
    console.error("[HealthCheck] Failed to upsert health state:", upsertError);
    // SCRUM-579: the route used to return 200 here, so a failing write looked
    // like a green cron run while the admin dashboard kept rendering the last
    // persisted state as current. Page, and fail the run.
    pageSentry({
      service: "next-cron",
      reason: SENTRY_REASONS.HEALTH_CHECK_STATE_WRITE_FAILED,
      level: "error",
      err: upsertError,
      message: "health-check could not persist system_health — dashboard state is now stale",
      tags: { cron: "health-check" },
    });
  }

  // 4. Alert on state transitions only (skip if we couldn't read previous state)
  if (!dbReadOk) {
    console.warn("[HealthCheck] Skipping alerts — could not read previous state from DB");
  } else if (wasHealthy && !isHealthy) {
    console.error(`[HealthCheck] ${SERVICE_NAME} is DOWN:`, errorMessage);
    // SCRUM-589: sendAdminAlert only reaches someone if ADMIN_ALERT_EMAIL or
    // ADMIN_ALERT_PHONE is set on Vercel; this line pages through Grafana
    // regardless.
    pageSentry({
      service: "next-cron",
      reason: SENTRY_REASONS.VOICE_SERVER_DOWN,
      level: "error",
      message: `voice-server failed its health check: ${errorMessage}`,
      tags: { cron: "health-check" },
    });
    await sendAdminAlert(
      "down",
      SERVICE_NAME,
      `Health check failed: ${errorMessage}`
    ).catch((err) => console.error("[HealthCheck] Failed to send down alert:", err));
  } else if (!wasHealthy && isHealthy) {
    console.log(`[HealthCheck] ${SERVICE_NAME} has RECOVERED after ${prevFailures} failures`);
    await sendAdminAlert(
      "recovered",
      SERVICE_NAME,
      `Service recovered after ${prevFailures} consecutive failures`
    ).catch((err) => console.error("[HealthCheck] Failed to send recovery alert:", err));
  }

  return NextResponse.json(
    {
      service: SERVICE_NAME,
      healthy: isHealthy,
      // When the read failed, newFailures came from a `?? 0` fallback and was
      // deliberately not persisted — reporting it would claim 1 while the row
      // may hold 12.
      ...(dbReadOk ? { consecutiveFailures: newFailures } : { alertingSkipped: true }),
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(upsertError ? { persisted: false } : {}),
    },
    // Mirrors keep-alive: a run that could not persist its result is not a
    // successful run, and neither is one that could not alert — this cron is
    // the only external down-detector. Vercel's cron log is the only place
    // either shows up.
    upsertError || !dbReadOk ? { status: 503 } : undefined
  );
}
