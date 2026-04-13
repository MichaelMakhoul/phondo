import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import * as Sentry from "@sentry/nextjs";
import { downloadAndStoreRecording } from "@/lib/call-recordings/download-and-store";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-twilio-signature") || "";
  const url = new URL(req.url);
  // Twilio computes the signature over the public-facing URL. Behind Vercel,
  // `req.url` may reflect the internal origin and fail validation, so prefer
  // NEXT_PUBLIC_APP_URL when set.
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}${url.pathname}${url.search}`
    : req.url;

  const bodyText = await req.text();
  const params = Object.fromEntries(new URLSearchParams(bodyText));

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error("[TwilioRecording] TWILIO_AUTH_TOKEN not set");
    Sentry.captureException(new Error("TwilioRecording: TWILIO_AUTH_TOKEN not set"));
    return new NextResponse("server not configured", { status: 500 });
  }

  const valid = twilio.validateRequest(authToken, signature, publicUrl, params);
  if (!valid) {
    console.warn("[TwilioRecording] signature validation failed");
    Sentry.withScope((scope) => {
      scope.setTag("service", "twilio-recording");
      scope.setExtras({ publicUrl, hasSignature: Boolean(signature) });
      Sentry.captureMessage("TwilioRecording: signature validation failed", "warning");
    });
    return new NextResponse("forbidden", { status: 403 });
  }

  const { CallSid, RecordingUrl, RecordingSid, RecordingStatus } = params;

  if (!CallSid) {
    console.warn("[TwilioRecording] missing CallSid");
    return new NextResponse("missing fields", { status: 400 });
  }

  // Twilio is subscribed to "completed", "failed", and "absent" events. Only
  // "completed" carries a usable RecordingUrl — log the others and ack so
  // Twilio doesn't retry forever (failed recordings won't get un-failed).
  if (RecordingStatus && RecordingStatus !== "completed") {
    console.warn("[TwilioRecording] non-completed status", { CallSid, RecordingStatus });
    Sentry.withScope((scope) => {
      scope.setTag("service", "twilio-recording");
      scope.setExtras({ CallSid, RecordingStatus, RecordingSid });
      Sentry.captureMessage(
        `TwilioRecording: non-completed status=${RecordingStatus}`,
        "warning",
      );
    });
    // Best-effort metadata update so the dashboard can surface failed-recording
    // calls without clobbering existing metadata fields. JSONB merge happens
    // by fetching the row first.
    try {
      const supabase = createAdminClient();
      const vapiCallId = `sh_${CallSid}`;
      const { data: row } = await (supabase as any)
        .from("calls")
        .select("id, metadata")
        .eq("vapi_call_id", vapiCallId)
        .maybeSingle();
      if (row?.id) {
        const merged = {
          ...(row.metadata || {}),
          recording_status: RecordingStatus,
          recording_failed_at: new Date().toISOString(),
        };
        await (supabase as any)
          .from("calls")
          .update({ metadata: merged })
          .eq("id", row.id);
      }
    } catch (err) {
      console.warn("[TwilioRecording] metadata update failed:", err);
      Sentry.withScope((scope) => {
        scope.setTag("service", "twilio-recording");
        scope.setExtras({ CallSid, RecordingStatus });
        Sentry.captureException(err);
      });
    }
    return NextResponse.json({ ok: true, ignored: RecordingStatus });
  }

  if (!RecordingUrl || !RecordingSid) {
    console.warn("[TwilioRecording] missing RecordingUrl or RecordingSid", { CallSid });
    return new NextResponse("missing fields", { status: 400 });
  }
  if (!RecordingUrl.startsWith("https://api.twilio.com/")) {
    console.warn("[TwilioRecording] invalid recording url", { CallSid, RecordingUrl });
    Sentry.withScope((scope) => {
      scope.setTag("service", "twilio-recording");
      scope.setExtras({ CallSid, RecordingUrl });
      Sentry.captureMessage("TwilioRecording: invalid recording URL", "warning");
    });
    return new NextResponse("invalid recording url", { status: 400 });
  }

  const result = await downloadAndStoreRecording({
    provider: "twilio",
    recordingUrl: `${RecordingUrl}.mp3`,
    recordingSid: RecordingSid,
    callSid: CallSid,
  });

  if (!result.ok) {
    console.error("[TwilioRecording] store failed:", result.error, { CallSid, RecordingSid });
    Sentry.withScope((scope) => {
      scope.setTag("service", "twilio-recording");
      scope.setExtras({ CallSid, RecordingSid, transient: result.transient });
      Sentry.captureMessage(`TwilioRecording: store failed: ${result.error}`, "error");
    });
    // Transient failures: ask Twilio to retry by returning 5xx.
    // Terminal failures (e.g. SID conflict): 200 to stop the retry loop.
    if (result.transient) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: result.error });
  }

  return NextResponse.json({ ok: true, callId: result.callId });
}
