import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return NextResponse.json({ error: "Upstash not configured" }, { status: 503 });
  }

  const redis = Redis.fromEnv();
  const pong = await redis.ping();

  return NextResponse.json({ upstash: pong });
}
