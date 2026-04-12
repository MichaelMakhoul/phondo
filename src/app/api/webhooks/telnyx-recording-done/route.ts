// src/app/api/webhooks/telnyx-recording-done/route.ts
import { NextRequest, NextResponse } from "next/server";
import nacl from "tweetnacl";
import { downloadAndStoreRecording } from "@/lib/call-recordings/download-and-store";

export const runtime = "nodejs";

function verifyTelnyxSignature(rawBody: string, signatureB64: string, timestamp: string): boolean {
  const publicKeyB64 = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKeyB64) return false;
  try {
    const msg = Buffer.from(`${timestamp}|${rawBody}`);
    const sig = Buffer.from(signatureB64, "base64");
    const key = Buffer.from(publicKeyB64, "base64");
    return nacl.sign.detached.verify(msg, sig, key);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("telnyx-signature-ed25519") || "";
  const timestamp = req.headers.get("telnyx-timestamp") || "";
  const rawBody = await req.text();

  if (!verifyTelnyxSignature(rawBody, signature, timestamp)) {
    console.warn("[telnyx-recording-done] signature validation failed");
    return new NextResponse("forbidden", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("bad json", { status: 400 });
  }

  const data = (payload as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const eventType = (data?.event_type || data?.record_type) as string | undefined;
  if (eventType !== "call.recording.saved") {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const p = (data?.payload ?? {}) as Record<string, unknown>;
  const callControlId = p.call_control_id as string | undefined;
  const recordingId = (p.recording_id || p.id) as string | undefined;
  const recordingUrls = p.recording_urls as Record<string, string> | undefined;
  const publicRecordingUrls = p.public_recording_urls as Record<string, string> | undefined;
  const mp3Url = recordingUrls?.mp3 || publicRecordingUrls?.mp3;

  if (!callControlId || !recordingId || !mp3Url) {
    return new NextResponse("missing fields", { status: 400 });
  }

  const result = await downloadAndStoreRecording({
    provider: "telnyx",
    recordingUrl: mp3Url,
    recordingSid: recordingId,
    callSid: callControlId,
  });

  if (!result.ok) {
    console.error("[telnyx-recording-done] store failed:", result.error, { callControlId, recordingId });
    return NextResponse.json({ ok: false, error: result.error });
  }

  return NextResponse.json({ ok: true, callId: result.callId });
}
