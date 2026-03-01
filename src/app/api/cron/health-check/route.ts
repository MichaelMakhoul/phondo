import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendAdminAlert } from "@/lib/notifications/admin-alerts";

const SERVICE_NAME = "voice-server";
const HEALTH_TIMEOUT_MS = 10_000;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[HealthCheck] CRON_SECRET not configured");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const voiceServerUrl = process.env.VOICE_SERVER_PUBLIC_URL;
  if (!voiceServerUrl) {
    console.error("[HealthCheck] VOICE_SERVER_PUBLIC_URL not configured");
    return NextResponse.json({ error: "VOICE_SERVER_PUBLIC_URL not set" }, { status: 500 });
  }

  // 1. Ping the voice server health endpoint
  let isHealthy = false;
  let errorMessage = "";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    const res = await fetch(`${voiceServerUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    isHealthy = res.ok;
    if (!isHealthy) {
      errorMessage = `HTTP ${res.status}`;
    }
  } catch (err) {
    isHealthy = false;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // 2. Read current state from system_health
  const supabase = createAdminClient();
  const { data: current } = await (supabase as any)
    .from("system_health")
    .select("is_healthy, consecutive_failures")
    .eq("service", SERVICE_NAME)
    .maybeSingle();

  const wasHealthy = current?.is_healthy ?? true;
  const prevFailures = current?.consecutive_failures ?? 0;
  const newFailures = isHealthy ? 0 : prevFailures + 1;

  // 3. Upsert health state
  const { error: upsertError } = await (supabase as any)
    .from("system_health")
    .upsert({
      service: SERVICE_NAME,
      is_healthy: isHealthy,
      consecutive_failures: newFailures,
      last_check_at: new Date().toISOString(),
      last_error: isHealthy ? null : errorMessage,
      updated_at: new Date().toISOString(),
    }, { onConflict: "service" });

  if (upsertError) {
    console.error("[HealthCheck] Failed to upsert health state:", upsertError);
  }

  // 4. Alert on state transitions only
  if (wasHealthy && !isHealthy) {
    console.error(`[HealthCheck] ${SERVICE_NAME} is DOWN:`, errorMessage);
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

  return NextResponse.json({
    service: SERVICE_NAME,
    healthy: isHealthy,
    consecutiveFailures: newFailures,
    ...(errorMessage ? { error: errorMessage } : {}),
  });
}
