import { NextResponse } from "next/server";
import crypto from "crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { DEMO_ORG_ID, DEMO_INDUSTRIES, DEMO_RATE_LIMIT_ERROR, isDemoIndustry } from "@/lib/demo/config";

// Upstash Redis rate limiter — shared across all serverless instances.
// Falls back to in-memory if UPSTASH env vars are not set (local dev).
const ratelimit = process.env.UPSTASH_REDIS_REST_URL
  ? new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(10, "1 h"),
      prefix: "demo-call",
    })
  : null;

// In-memory fallback for local development (no Upstash configured)
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

async function checkRateLimit(ip: string): Promise<boolean> {
  if (ratelimit) {
    const { success } = await ratelimit.limit(ip);
    return success;
  }

  // Fallback: in-memory for local dev
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

    // Rate limit by IP
    const ip = getClientIp(request);
    if (!(await checkRateLimit(ip))) {
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

    // Build token identical to test-call/token format
    const payload = {
      assistantId: demoConfig.assistantId,
      organizationId: DEMO_ORG_ID,
      exp: Date.now() + 30_000, // 30 second expiry
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
