import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { withRateLimitDistributed } from "@/lib/security/rate-limiter";
import { isValidVoiceId } from "@/lib/security/validation";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { pageSentry } from "@/lib/observability/page-sentry";

// Maximum text length to prevent abuse (Deepgram charges per character)
const MAX_TEXT_LENGTH = 500;

/**
 * POST /api/v1/voice-preview — Generate voice preview via the voice-server's
 * Deepgram Aura TTS endpoint.
 *
 * SCRUM-221: switched from direct ElevenLabs calls (which were returning 402
 * due to quota exhaustion) to the voice-server /preview endpoint. Deepgram is
 * already the fallback TTS engine on the voice pipeline so we reuse the same
 * mapping + API key rather than maintaining a second TTS provider on Vercel.
 */
export async function POST(request: Request) {
  try {
    // Rate limit — Deepgram TTS charges per character, so this is a
    // paid-action endpoint. SCRUM-290 migrated from the per-instance
    // Map to the shared Postgres-backed limiter; `expensive` profile
    // has `costControl: true` so a Supabase brownout fails closed
    // rather than reopening the cold-start parallelism bypass.
    const rl = await withRateLimitDistributed(
      createAdminClient(),
      request,
      "/api/v1/voice-preview",
      "expensive",
    );
    if (!rl.allowed) {
      // SCRUM-302: distinguish brownout-deny ("Supabase degraded") from
      // quota-deny ("you hammered the API") so users mid-onboarding
      // don't see a misleading "Too many requests" for one click.
      const error = rl.failReason === "service-degraded"
        ? "Service temporarily unavailable. Please try again in a moment."
        : "Too many requests. Please try again later.";
      return NextResponse.json(
        { error, failReason: rl.failReason },
        { status: 429, headers: rl.headers }
      );
    }

    // Authentication check — only signed-in dashboard users
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { voiceId, text } = body;

    if (!voiceId || !text) {
      return NextResponse.json(
        { error: "voiceId and text are required" },
        { status: 400 }
      );
    }

    if (!isValidVoiceId(voiceId)) {
      return NextResponse.json(
        { error: "Invalid voice ID format" },
        { status: 400 }
      );
    }

    if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Text must be a string with maximum ${MAX_TEXT_LENGTH} characters` },
        { status: 400 }
      );
    }

    const voiceServerUrl = process.env.VOICE_SERVER_PUBLIC_URL;
    const internalSecret = process.env.INTERNAL_API_SECRET;

    if (!voiceServerUrl || !internalSecret) {
      console.error("[voice-preview] VOICE_SERVER_PUBLIC_URL or INTERNAL_API_SECRET missing");
      // SCRUM-300: missing env vars is a deployment misconfig — page
      // Sentry at ERROR level so on-call sees it immediately rather
      // than waiting for an alert threshold.
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.VOICE_PREVIEW_ENV_MISSING,
        level: "error",
        message: "voice-preview required env vars missing",
        extras: {
          voiceServerUrlSet: Boolean(voiceServerUrl),
          internalSecretSet: Boolean(internalSecret),
        },
      });
      return NextResponse.json(
        { error: "Voice preview is not configured on this deployment." },
        { status: 503 }
      );
    }

    const upstream = await fetch(`${voiceServerUrl}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({ voiceId, text }),
    });

    if (!upstream.ok) {
      const errorPayload = await upstream.json().catch(() => ({ error: "Upstream error" }));
      console.error(
        `[voice-preview] voice-server ${upstream.status} for voice=${voiceId}: ${JSON.stringify(errorPayload).slice(0, 200)}`
      );
      // SCRUM-300 review: skip Sentry for 429 (legitimate
      // user-driven quota exhaustion at Deepgram — predictable,
      // surfaces via Retry-After to the user, not actionable
      // for on-call). 4xx other than 429 indicates env rot or
      // a contract break; 5xx indicates voice-server outage.
      // Both deserve to page. Without this discrimination a
      // marketing-burst of "Try Voice" clicks would spam Sentry
      // with non-actionable 429s and drown out real outages.
      if (upstream.status !== 429) {
        const isAuthFailure = upstream.status === 401 || upstream.status === 403;
        pageSentry({
          service: "next-api",
          reason: SENTRY_REASONS.VOICE_PREVIEW_UPSTREAM_NON_2XX,
          // 401/403 = INTERNAL_API_SECRET rot or a misconfig —
          // env-level incident, escalate to error.
          level: isAuthFailure ? "error" : "warning",
          message: `voice-server returned ${upstream.status}`,
          extras: {
            upstreamStatus: upstream.status,
            voiceId,
            // Truncate payload to avoid blowing past Sentry's extras limit.
            errorPayloadSnippet: JSON.stringify(errorPayload).slice(0, 200),
          },
        });
      }

      // Pass 429 through unchanged so the browser can surface a "try again" UI.
      // Pass other 4xx through as-is. Remap 5xx to 502.
      const forwardStatus =
        upstream.status === 429 || (upstream.status >= 400 && upstream.status < 500)
          ? upstream.status
          : 502;

      const responseHeaders: Record<string, string> = {};
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) responseHeaders["Retry-After"] = retryAfter;

      return NextResponse.json(
        { error: errorPayload?.error || "Failed to generate voice preview" },
        { status: forwardStatus, headers: responseHeaders }
      );
    }

    const audioBuffer = await upstream.arrayBuffer();
    const upstreamContentType = upstream.headers.get("content-type") || "audio/wav";

    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": upstreamContentType,
        "Content-Length": audioBuffer.byteLength.toString(),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error generating voice preview:", error);
    // SCRUM-300: catch-all now pages Sentry. Previously a generic
    // 500 disappeared into Vercel logs; no on-call signal.
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.VOICE_PREVIEW_FAILED,
      err: error,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
