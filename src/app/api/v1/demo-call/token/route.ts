import { NextResponse } from "next/server";
import crypto from "crypto";
import { DEMO_ORG_ID, DEMO_INDUSTRIES, DEMO_RATE_LIMIT_ERROR, isDemoIndustry } from "@/lib/demo/config";

// In-memory rate limit — best-effort only, not shared across serverless instances.
// Acceptable for MVP; migrate to Redis/Upstash for production multi-instance.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref?.();

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

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
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
    if (!checkRateLimit(ip)) {
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
