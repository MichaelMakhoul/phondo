import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/twilio/voice-fallback
 *
 * Twilio calls this URL when the primary voice webhook (voice server) fails.
 * Returns TwiML that plays a friendly message and records a voicemail,
 * so callers never hear dead air.
 */
export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const formData = await request.formData();

    // Twilio POSTs back to the action URL after recording completes.
    // Just return a goodbye — don't re-log the call.
    if (url.searchParams.get("recording") === "done") {
      const goodbye = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for your message. Goodbye.</Say>
</Response>`;
      return new Response(goodbye, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    const from = formData.get("From")?.toString() || "Unknown";
    const called = formData.get("Called")?.toString() || "Unknown";
    const errorCode = formData.get("ErrorCode")?.toString() || "";

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
