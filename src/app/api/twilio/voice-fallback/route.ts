import { createAdminClient } from "@/lib/supabase/admin";
import Twilio from "twilio";

const REJECTED_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Sorry, this request could not be processed.</Say>
</Response>`;

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

    // Parse form data once — used for both validation and business logic
    const formData = await request.formData();
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

    // Look up the organization by the called number to log the call
    const supabase = createAdminClient();
    const { data: phoneRecord } = await (supabase as any)
      .from("phone_numbers")
      .select("id, organization_id, assistant_id")
      .eq("phone_number", called)
      .eq("is_active", true)
      .maybeSingle();

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
        });

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
