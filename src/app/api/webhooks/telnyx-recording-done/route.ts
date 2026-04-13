import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { downloadAndStoreRecording } from "@/lib/call-recordings/download-and-store";

export const runtime = "nodejs";

function verifyTelnyxSignature(rawBody: string, signatureB64: string, timestamp: string): boolean {
  const publicKeyB64 = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKeyB64) return false;
  try {
    const msg = Buffer.from(`${timestamp}|${rawBody}`);
    const sig = Buffer.from(signatureB64, "base64");
    // Telnyx publishes a 32-byte raw ed25519 public key (base64). Wrap it in the
    // ASN.1 SubjectPublicKeyInfo prefix for ed25519 so node:crypto can import it.
    const rawKey = Buffer.from(publicKeyB64, "base64");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, rawKey]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, msg, keyObject, sig);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!process.env.TELNYX_PUBLIC_KEY) {
    console.error("[TelnyxRecording] TELNYX_PUBLIC_KEY not set");
    Sentry.captureException(new Error("TelnyxRecording: TELNYX_PUBLIC_KEY not set"));
    return new NextResponse("server not configured", { status: 500 });
  }

  const signature = req.headers.get("telnyx-signature-ed25519") || "";
  const timestamp = req.headers.get("telnyx-timestamp") || "";
  const rawBody = await req.text();

  if (!verifyTelnyxSignature(rawBody, signature, timestamp)) {
    console.warn("[TelnyxRecording] signature validation failed");
    Sentry.withScope((scope) => {
      scope.setTag("service", "telnyx-recording");
      scope.setExtras({ hasSignature: Boolean(signature), hasTimestamp: Boolean(timestamp) });
      Sentry.captureMessage("TelnyxRecording: signature validation failed", "warning");
    });
    return new NextResponse("forbidden", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.warn("[TelnyxRecording] bad json", err);
    Sentry.withScope((scope) => {
      scope.setTag("service", "telnyx-recording");
      Sentry.captureException(err);
    });
    return new NextResponse("bad json", { status: 400 });
  }

  const data = (payload as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const eventType = data?.event_type as string | undefined;
  if (!eventType) {
    console.warn("[TelnyxRecording] missing event_type");
    Sentry.withScope((scope) => {
      scope.setTag("service", "telnyx-recording");
      Sentry.captureMessage("TelnyxRecording: missing event_type", "warning");
    });
    return new NextResponse("missing event_type", { status: 400 });
  }
  if (eventType !== "call.recording.saved") {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const p = (data?.payload ?? {}) as Record<string, unknown>;
  const callControlId = p.call_control_id as string | undefined;
  const recordingId = p.recording_id as string | undefined;
  const recordingUrls = p.recording_urls as Record<string, string> | undefined;
  const mp3Url = recordingUrls?.mp3;

  if (!callControlId || !recordingId || !mp3Url) {
    console.warn("[TelnyxRecording] missing fields", { callControlId, recordingId, hasMp3: Boolean(mp3Url) });
    Sentry.withScope((scope) => {
      scope.setTag("service", "telnyx-recording");
      scope.setExtras({ callControlId, recordingId, hasMp3: Boolean(mp3Url) });
      Sentry.captureMessage("TelnyxRecording: missing required fields in payload", "warning");
    });
    return new NextResponse("missing fields", { status: 400 });
  }

  const result = await downloadAndStoreRecording({
    provider: "telnyx",
    recordingUrl: mp3Url,
    recordingSid: recordingId,
    callSid: callControlId,
  });

  if (!result.ok) {
    console.error("[TelnyxRecording] store failed:", result.error, { callControlId, recordingId });
    Sentry.withScope((scope) => {
      scope.setTag("service", "telnyx-recording");
      scope.setExtras({ callControlId, recordingId, transient: result.transient });
      Sentry.captureMessage(`TelnyxRecording: store failed: ${result.error}`, "error");
    });
    // Transient failures: ask Telnyx to retry by returning 5xx.
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
