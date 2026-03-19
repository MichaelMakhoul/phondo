import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const results: Record<string, string> = {};

  // 1. Ping Supabase to keep the project active
  try {
    const supabase = createAdminClient();
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

  const allOk = Object.values(results).every((v) => v === "ok" || v.startsWith("skipped"));

  console.log("[KeepAlive] Results:", results);
  return NextResponse.json(
    { ok: allOk, timestamp: new Date().toISOString(), ...results },
    { status: allOk ? 200 : 503 }
  );
}
