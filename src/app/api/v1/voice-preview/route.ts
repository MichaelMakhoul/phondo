import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { isValidVoiceId } from "@/lib/security/validation";

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
    // Rate limit - voice preview is a moderately expensive operation
    const { allowed, headers } = withRateLimit(request, "/api/v1/voice-preview", "expensive");
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers }
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
      return NextResponse.json(
        { error: errorPayload?.error || "Failed to generate voice preview" },
        { status: upstream.status >= 500 ? 502 : upstream.status }
      );
    }

    const audioBuffer = await upstream.arrayBuffer();

    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBuffer.byteLength.toString(),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error generating voice preview:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
