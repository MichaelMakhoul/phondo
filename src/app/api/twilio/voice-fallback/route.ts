import { createAdminClient } from "@/lib/supabase/admin";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import Twilio from "twilio";

const REJECTED_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Sorry, this request could not be processed.</Say>
</Response>`;

// SCRUM-589: the outage page below is pushed to Loki only once this response
// has been sent (after()), and Twilio gives up on the fallback after 15s. Bound
// each query so a hung Supabase can't cost the caller the voicemail or the
// founder the page.
const DB_TIMEOUT_MS = 4000;

/**
 * The path of the voice-server URL Twilio reports as failed (`ErrorUrl`), so a
 * page tells a full outage (`/twiml`) from one broken flow (an action URL such
 * as `/twiml/transfer-status`). Path only — no host or query string.
 */
function errorUrlPath(errorUrl: string | undefined): string {
  if (!errorUrl) return "none";
  try {
    return new URL(errorUrl).pathname;
  } catch {
    return "unparseable";
  }
}

/**
 * Validate that the incoming request was actually sent by Twilio.
 * Returns the parsed form params if valid, or null if invalid.
 */
function validateTwilioSignature(
  request: Request,
  params: Record<string, string>,
  path: string
): boolean {
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  if (!twilioAuthToken) {
    console.error("[VoiceFallback] TWILIO_AUTH_TOKEN not configured — cannot validate request");
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.VOICE_FALLBACK_ENV_MISSING,
      level: "error",
      message: "TWILIO_AUTH_TOKEN is unset — voice-fallback rejects every call, so callers the voice server failed get no voicemail either",
      tags: { route: "voice-fallback" },
    });
    return false;
  }

  const signature = request.headers.get("X-Twilio-Signature") || "";
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    console.warn("[VoiceFallback] NEXT_PUBLIC_APP_URL not set — signature validation may fail behind a proxy");
  }
  const url = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}${path}`
    : request.url;

  return Twilio.validateRequest(twilioAuthToken, signature, url, params);
}

/**
 * POST /api/twilio/voice-fallback
 *
 * Twilio calls this URL when the primary voice webhook (voice server) fails.
 * Returns TwiML that plays a friendly message and records a voicemail,
 * so callers never hear dead air.
 */
export async function POST(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const isRecordingDone = requestUrl.searchParams.get("recording") === "done";

    // Parse form data once — used for both validation and business logic.
    // SCRUM-589: Twilio always posts a form, and this runs BEFORE the signature
    // check — so an unparseable body is rejected here without paging, or any
    // internet POST could fire the voice-fallback-failed alert from the catch.
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (parseErr) {
      console.warn(
        "[VoiceFallback] Unparseable body — rejecting",
        parseErr instanceof Error ? parseErr.message : parseErr
      );
      return new Response(REJECTED_TWIML, {
        status: 400,
        headers: { "Content-Type": "text/xml" },
      });
    }
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = value.toString();
    });

    // Determine the correct path for signature validation
    // (Twilio signs against the full URL including query params)
    const validationPath = isRecordingDone
      ? "/api/twilio/voice-fallback?recording=done"
      : "/api/twilio/voice-fallback";

    // Validate Twilio signature
    const isValid = validateTwilioSignature(request, params, validationPath);
    if (!isValid) {
      console.warn("[VoiceFallback] Invalid Twilio signature — rejecting request", {
        path: validationPath,
        from: params.From || "unknown",
      });
      return new Response(REJECTED_TWIML, {
        status: 403,
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Twilio POSTs back to the action URL after recording completes.
    // Just return a goodbye — don't re-log the call.
    if (isRecordingDone) {
      const goodbye = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for your message. Goodbye.</Say>
</Response>`;
      return new Response(goodbye, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    const from = params.From || "Unknown";
    const called = params.Called || "Unknown";
    const errorCode = params.ErrorCode || "";

    console.error("[VoiceFallback] Primary voice webhook failed — serving fallback TwiML", {
      From: from,
      Called: called,
      ErrorCode: errorCode,
    });

    // SCRUM-589: Twilio only lands here when the voice server failed or timed
    // out on /twiml, so this caller is getting voicemail instead of the AI.
    // Page on every one (Grafana emails on the [ALERT:error] line), BEFORE the
    // DB lookup so a Supabase fault can't swallow it. IDs only — never the
    // caller's number.
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.VOICE_FALLBACK_SERVED,
      level: "error",
      message: "Caller sent to fallback voicemail — the voice server failed or timed out on a TwiML request",
      extras: {
        errorCode: errorCode || "none",
        errorUrl: errorUrlPath(params.ErrorUrl),
        callSid: params.CallSid || "unknown",
      },
      tags: { route: "voice-fallback" },
    });

    // Look up the organization by the called number to log the call
    const supabase = createAdminClient();
    const { data: phoneRecord, error: lookupError } = await (supabase as any)
      .from("phone_numbers")
      .select("id, organization_id, assistant_id")
      .eq("phone_number", called)
      .eq("is_active", true)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
      .maybeSingle();

    if (lookupError) {
      console.error("[VoiceFallback] Phone number lookup failed:", lookupError.message);
    }

    if (phoneRecord) {
      // Insert a failed call record so the business sees it in their call log
      const { error: insertError } = await (supabase as any)
        .from("calls")
        .insert({
          organization_id: phoneRecord.organization_id,
          assistant_id: phoneRecord.assistant_id,
          phone_number_id: phoneRecord.id,
          caller_phone: from,
          direction: "inbound",
          status: "failed",
          started_at: new Date().toISOString(),
          metadata: { fallback: true, error_code: errorCode || undefined },
        })
        .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));

      if (insertError) {
        console.error("[VoiceFallback] Failed to insert call record:", insertError);
      }
    } else {
      console.warn("[VoiceFallback] No phone record found for:", called);
    }

    // Return TwiML: friendly message -> voicemail recording -> goodbye
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">We're sorry, our system is temporarily unavailable. Please leave a message after the beep and we'll get back to you as soon as possible.</Say>
  <Record maxLength="120" playBeep="true" action="/api/twilio/voice-fallback?recording=done" />
  <Say voice="Polly.Joanna">Thank you for your message. Goodbye.</Say>
</Response>`;

    return new Response(twiml, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (err) {
    console.error("[VoiceFallback] Unhandled error:", err);
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.VOICE_FALLBACK_FAILED,
      level: "error",
      err,
      message: "voice-fallback threw — the caller heard \"technical difficulties\" and got no voicemail",
      tags: { route: "voice-fallback" },
    });

    // Even on error, return valid TwiML so the caller hears something
    const fallbackTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">We're sorry, we're experiencing technical difficulties. Please try again later.</Say>
</Response>`;

    return new Response(fallbackTwiml, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }
}
