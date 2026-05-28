import { NextResponse } from "next/server";
import crypto from "crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { DEMO_ORG_ID, DEMO_INDUSTRIES, DEMO_RATE_LIMIT_ERROR, isDemoIndustry } from "@/lib/demo/config";
import { getClientIp, rateLimitDistributed } from "@/lib/security/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";

// ── Rate limiting: multi-layer abuse protection (in execution order) ──
//
// Layer 1: Per-IP daily cap (in-memory, best-effort) — slow persistent abuse
// Layer 2: Per-IP hourly cap — Upstash Redis distributed (10 calls/hour/IP)
// Layer 3: Global hourly cap — Postgres distributed (100/hr across ALL
//          instances; SCRUM-340: was an in-memory per-instance counter an
//          IP-rotating bot bypassed by spreading across lambdas)
// Layer 4: Short token expiry (30s) — tokens can't be stockpiled
//
// The client IP feeding every per-IP layer now comes from the XFF-spoof-
// hardened getClientIp (SCRUM-340: the local copy trusted the client-supplied
// first X-Forwarded-For hop, so IP rotation defeated all per-IP caps).

const ratelimit = process.env.UPSTASH_REDIS_REST_URL
  ? new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(10, "1 h"),
      prefix: "demo-call",
    })
  : null;

// Layer 4: Per-IP daily cap (stricter than hourly — catches slow abuse)
const DAILY_PER_IP_CAP = 20;
const dailyIpMap = new Map<string, { count: number; resetAt: number }>();

function checkDailyCap(ip: string): boolean {
  pruneStaleEntries();
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

// NOTE: In-memory counters (global cap + daily per-IP) reset on cold start and
// are per-instance. They provide best-effort protection on warm instances but are
// NOT reliable as the sole defense in serverless. Layer 2 (Upstash) is the
// authoritative distributed rate limit.

// Lazy cleanup: prune stale daily entries when map grows large (avoids setInterval in serverless)
function pruneStaleEntries() {
  if (dailyIpMap.size < 100) return;
  const now = Date.now();
  for (const [ip, entry] of dailyIpMap.entries()) {
    if (now > entry.resetAt) dailyIpMap.delete(ip);
  }
}

// In-memory hourly fallback (when Upstash is unavailable)
const localRateLimitMap = new Map<string, { count: number; resetAt: number }>();

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

    // Config check FIRST — free + deterministic. If the demo isn't configured,
    // 503 immediately without consuming any rate-limit slots (SCRUM-340 review:
    // the global-cap slot was previously consumed before this check, draining
    // the 100/hr budget on a misconfigured deploy and masking the real cause).
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

    const ip = getClientIp(request.headers);

    // Check per-IP limits first (cheap) before consuming the shared global counter.
    // This prevents a single abusive IP from exhausting the global cap for everyone.

    // Layer 1: Daily per-IP cap (catches slow persistent abuse)
    if (!checkDailyCap(ip)) {
      console.warn(`[DemoAbuse] Daily per-IP cap reached for ${ip}`);
      return NextResponse.json(
        { error: "You've reached the daily demo limit. Sign up for a free trial to continue!" },
        { status: 429 }
      );
    }

    // Layer 2: Hourly per-IP rate limit (Upstash or in-memory)
    if (!(await checkHourlyRateLimit(ip))) {
      return NextResponse.json(
        { error: `${DEMO_RATE_LIMIT_ERROR}. Please try again later.` },
        { status: 429 }
      );
    }

    // Layer 3: Global hourly cap — Postgres distributed bucket so it holds
    // across lambda instances (an IP-rotating bot previously bypassed the
    // per-instance in-memory counter). Single shared key "global". Only
    // consumed after the IP passed its own checks.
    const globalCap = await rateLimitDistributed(
      createAdminClient(),
      "global",
      "demo-call-global",
      "demoCallGlobal"
    );
    if (!globalCap.allowed) {
      // SCRUM-302 pattern: a Supabase brownout fails this costControl profile
      // CLOSED (failReason="service-degraded") — show an honest availability
      // message rather than the false "high demand" used for a real cap hit.
      const degraded = globalCap.failReason === "service-degraded";
      console.warn(
        degraded
          ? "[DemoAbuse] Global cap unavailable (distributed limiter degraded) — failing closed"
          : "[DemoAbuse] Global hourly cap reached (100 calls/hr across all IPs)"
      );
      return NextResponse.json(
        {
          error: degraded
            ? "The demo is temporarily unavailable. Please try again in a moment."
            : "Demo is experiencing high demand. Please try again in a few minutes.",
        },
        { status: 429, headers: globalCap.headers }
      );
    }

    const demoConfig = DEMO_INDUSTRIES[industry];

    // Layer 4: Short token expiry (30 seconds — can't stockpile tokens)
    const payload = {
      assistantId: demoConfig.assistantId,
      organizationId: DEMO_ORG_ID,
      exp: Date.now() + 30_000,
      // SCRUM-341: unique token id for single-use enforcement at /ws/test.
      jti: crypto.randomUUID(),
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
