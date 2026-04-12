// src/app/api/webhooks/twilio-recording-done/route.ts
import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { downloadAndStoreRecording } from "@/lib/call-recordings/download-and-store";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-twilio-signature") || "";
  const url = new URL(req.url);
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}${url.pathname}${url.search}`
    : req.url;

  const bodyText = await req.text();
  const params = Object.fromEntries(new URLSearchParams(bodyText));

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error("[twilio-recording-done] TWILIO_AUTH_TOKEN not set");
    return new NextResponse("server not configured", { status: 500 });
  }

  const valid = twilio.validateRequest(authToken, signature, publicUrl, params);
  if (!valid) {
    console.warn("[twilio-recording-done] signature validation failed");
    return new NextResponse("forbidden", { status: 403 });
  }

  const { CallSid, RecordingUrl, RecordingSid, RecordingStatus } = params;
  if (RecordingStatus && RecordingStatus !== "completed") {
    return NextResponse.json({ ok: true, ignored: RecordingStatus });
  }
  if (!CallSid || !RecordingUrl || !RecordingSid) {
    return new NextResponse("missing fields", { status: 400 });
  }
  if (!RecordingUrl.startsWith("https://api.twilio.com/")) {
    return new NextResponse("invalid recording url", { status: 400 });
  }

  const result = await downloadAndStoreRecording({
    provider: "twilio",
    recordingUrl: `${RecordingUrl}.mp3`,
    recordingSid: RecordingSid,
    callSid: CallSid,
  });

  if (!result.ok) {
    console.error("[twilio-recording-done] store failed:", result.error, { CallSid, RecordingSid });
    return NextResponse.json({ ok: false, error: result.error });
  }

  return NextResponse.json({ ok: true, callId: result.callId });
}
