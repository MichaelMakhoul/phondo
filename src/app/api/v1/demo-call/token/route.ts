import { NextResponse } from "next/server";
import crypto from "crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { DEMO_ORG_ID, DEMO_INDUSTRIES, DEMO_RATE_LIMIT_ERROR, isDemoIndustry } from "@/lib/demo/config";

// ── Rate limiting: multi-layer abuse protection ──────────────────────
//
// Layer 1: Upstash Redis — distributed rate limit (10 calls/hour/IP)
// Layer 2: In-memory global counter — hard cap on total demo calls per hour (prevents bot swarms)
// Layer 3: Short token expiry (30s) — tokens can't be stockpiled
// Layer 4: Per-IP daily cap — even with IP rotation, limits total daily abuse

const ratelimit = process.env.UPSTASH_REDIS_REST_URL
  ? new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(10, "1 h"),
      prefix: "demo-call",
    })
  : null;

// Layer 2: Global hourly cap — prevents bot swarms even with different IPs
const GLOBAL_HOURLY_CAP = 100; // Max 100 demo calls per hour across ALL users
let globalHourlyCount = 0;
let globalHourlyReset = Date.now() + 3_600_000;

function checkGlobalCap(): boolean {
  const now = Date.now();
  if (now > globalHourlyReset) {
    globalHourlyCount = 0;
    globalHourlyReset = now + 3_600_000;
  }
  if (globalHourlyCount >= GLOBAL_HOURLY_CAP) {
    return false;
  }
  globalHourlyCount++;
  return true;
}

// Layer 4: Per-IP daily cap (stricter than hourly — catches slow abuse)
const DAILY_PER_IP_CAP = 20;
const dailyIpMap = new Map<string, { count: number; resetAt: number }>();

function checkDailyCap(ip: string): boolean {
  const now = Date.now();
  const entry = dailyIpMap.get(ip);
  if (!entry || now > entry.resetAt) {
    dailyIpMap.set(ip, { count: 1, resetAt: now + 86_400_000 });
    return true;
  }
  if (entry.count >= DAILY_PER_IP_CAP) {
    return false;
  }
  entry.count++;
  return true;
}

// Cleanup stale daily entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of dailyIpMap.entries()) {
    if (now > entry.resetAt) dailyIpMap.delete(ip);
  }
}, 600_000).unref?.();

// In-memory hourly fallback (when Upstash is unavailable)
const localRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "unknown";
}

async function checkHourlyRateLimit(ip: string): Promise<boolean> {
  if (ratelimit) {
    try {
      const { success } = await ratelimit.limit(ip);
      return success;
    } catch (err) {
      // Upstash unreachable (e.g. local dev) — fall through to in-memory
      console.warn("[DemoRateLimit] Upstash unreachable, using in-memory fallback:", (err as Error).message);
    }
  }

  // In-memory fallback
  const now = Date.now();
  const entry = localRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    localRateLimitMap.set(ip, { count: 1, resetAt: now + 3_600_000 });
    return true;
  }
  if (entry.count >= 10) {
    return false;
  }
  entry.count++;
  return true;
}

// POST /api/v1/demo-call/token — Public token for demo calls (no auth)
export async function POST(request: Request) {
  try {
    let body: { industry?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { industry } = body;

    if (!isDemoIndustry(industry)) {
      return NextResponse.json(
        { error: "Invalid industry. Must be one of: dental, legal, home_services" },
        { status: 400 }
      );
    }

    const ip = getClientIp(request);

    // Layer 2: Global hourly cap (catches bot swarms)
    if (!checkGlobalCap()) {
      console.warn(`[DemoAbuse] Global hourly cap reached (${GLOBAL_HOURLY_CAP} calls/hr)`);
      return NextResponse.json(
        { error: "Demo is experiencing high demand. Please try again in a few minutes." },
        { status: 429 }
      );
    }

    // Layer 4: Daily per-IP cap (catches slow persistent abuse)
    if (!checkDailyCap(ip)) {
      console.warn(`[DemoAbuse] Daily per-IP cap reached for ${ip}`);
      return NextResponse.json(
        { error: "You've reached the daily demo limit. Sign up for a free trial to continue!" },
        { status: 429 }
      );
    }

    // Layer 1: Hourly per-IP rate limit (Upstash or in-memory)
    if (!(await checkHourlyRateLimit(ip))) {
      return NextResponse.json(
        { error: `${DEMO_RATE_LIMIT_ERROR}. Please try again later.` },
        { status: 429 }
      );
    }

    const testCallSecret = process.env.TEST_CALL_SECRET;
    const voiceServerUrl = process.env.VOICE_SERVER_PUBLIC_URL;

    if (!testCallSecret || !voiceServerUrl) {
      console.error("[DemoToken] Missing required env vars:", {
        hasTestCallSecret: !!testCallSecret,
        hasVoiceServerUrl: !!voiceServerUrl,
      });
      return NextResponse.json(
        { error: "Demo calls not configured" },
        { status: 503 }
      );
    }

    const demoConfig = DEMO_INDUSTRIES[industry];

    // Layer 3: Short token expiry (30 seconds — can't stockpile tokens)
    const payload = {
      assistantId: demoConfig.assistantId,
      organizationId: DEMO_ORG_ID,
      exp: Date.now() + 30_000,
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
      .createHmac("sha256", testCallSecret)
      .update(payloadB64)
      .digest("hex");

    const token = `${payloadB64}.${signature}`;
    const wsUrl = voiceServerUrl.replace(/^http/, "ws") + "/ws/test";

    return NextResponse.json({
      token,
      wsUrl,
      assistantName: demoConfig.name,
      industry,
    });
  } catch (error) {
    console.error("Error creating demo call token:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
