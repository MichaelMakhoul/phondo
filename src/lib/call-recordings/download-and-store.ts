import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";

type Provider = "twilio" | "telnyx";

interface DownloadAndStoreParams {
  provider: Provider;
  recordingUrl: string;
  recordingSid: string;
  callSid: string;
}

export type DownloadAndStoreResult =
  | { ok: true; callId: string; storagePath: string }
  | { ok: false; error: string; transient: boolean };

const BUCKET = "call-recordings";

// Backoffs for the "no call row" race — voice-server may not have finished
// writing the row before the provider sends the recording webhook.
const LOOKUP_BACKOFFS_MS = [0, 1500, 4000];

async function fetchRecording(provider: Provider, url: string): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {};
  switch (provider) {
    case "twilio": {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID/AUTH_TOKEN not set");
      headers.Authorization = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
      break;
    }
    case "telnyx": {
      const key = process.env.TELNYX_API_KEY;
      if (!key) throw new Error("TELNYX_API_KEY not set");
      headers.Authorization = `Bearer ${key}`;
      break;
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${String(_exhaustive)}`);
    }
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Provider ${provider} returned ${res.status} fetching recording`);
  }
  return await res.arrayBuffer();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function downloadAndStoreRecording(
  params: DownloadAndStoreParams,
): Promise<DownloadAndStoreResult> {
  const { provider, recordingUrl, recordingSid, callSid } = params;
  const supabase = createAdminClient();

  // Voice server prefixes CallSids with "sh_" in vapi_call_id for self-hosted
  // calls. Both Twilio (CallSid) and Telnyx (call_control_id) flow through
  // this same naming convention.
  const vapiCallId = `sh_${callSid}`;

  type CallRow = {
    id: string;
    organization_id: string;
    recording_sid: string | null;
    recording_storage_path: string | null;
  };
  let call: CallRow | null = null;

  for (let attempt = 0; attempt < LOOKUP_BACKOFFS_MS.length; attempt++) {
    if (LOOKUP_BACKOFFS_MS[attempt] > 0) await sleep(LOOKUP_BACKOFFS_MS[attempt]);
    // Generated DB types haven't been regenerated for the new recording_*
    // columns yet — cast to `any` matching the project-wide pattern.
    const { data, error: lookupErr } = await (supabase as any)
      .from("calls")
      .select("id, organization_id, recording_sid, recording_storage_path")
      .eq("vapi_call_id", vapiCallId)
      .maybeSingle();

    if (lookupErr) {
      Sentry.withScope((scope) => {
        scope.setTag("service", "call-recordings");
        scope.setTag("provider", provider);
        scope.setExtras({ recordingSid, callSid });
        Sentry.captureException(lookupErr);
      });
      return {
        ok: false,
        error: `Call lookup failed: ${lookupErr.message}`,
        transient: true,
      };
    }

    if (data) {
      call = data as CallRow;
      break;
    }
  }

  if (!call) {
    Sentry.withScope((scope) => {
      scope.setTag("service", "call-recordings");
      scope.setTag("provider", provider);
      scope.setExtras({ recordingSid, callSid, vapiCallId });
      Sentry.captureMessage(
        `No call row for vapi_call_id=${vapiCallId} after ${LOOKUP_BACKOFFS_MS.length} attempts`,
        "warning",
      );
    });
    return {
      ok: false,
      error: `No call row for vapi_call_id=${vapiCallId}`,
      transient: true,
    };
  }

  // Idempotency — providers retry webhooks aggressively, and the same call
  // may also receive *different* recording SIDs if someone kicks off a second
  // recording. Short-circuit retries of the same SID; refuse silent overwrite
  // when a different SID arrives for the same call so we don't lose audio.
  if (call.recording_sid === recordingSid && call.recording_storage_path) {
    return { ok: true, callId: call.id, storagePath: call.recording_storage_path };
  }
  if (call.recording_sid && call.recording_sid !== recordingSid) {
    Sentry.withScope((scope) => {
      scope.setTag("service", "call-recordings");
      scope.setTag("provider", provider);
      scope.setExtras({
        callId: call.id,
        existingRecordingSid: call.recording_sid,
        incomingRecordingSid: recordingSid,
      });
      Sentry.captureMessage(
        `recording_sid conflict on call ${call.id}`,
        "warning",
      );
    });
    return {
      ok: false,
      error: `recording_sid conflict: existing=${call.recording_sid} incoming=${recordingSid}`,
      transient: false,
    };
  }

  let audio: ArrayBuffer;
  try {
    audio = await fetchRecording(provider, recordingUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    Sentry.withScope((scope) => {
      scope.setTag("service", "call-recordings");
      scope.setTag("provider", provider);
      scope.setExtras({ recordingSid, callId: call.id });
      Sentry.captureException(err);
    });
    return { ok: false, error: `Download failed: ${msg}`, transient: true };
  }

  const storagePath = `${call.organization_id}/${call.id}.mp3`;
  const { error: uploadErr } = await (supabase as any).storage
    .from(BUCKET)
    .upload(storagePath, audio, {
      contentType: "audio/mpeg",
      upsert: true,
    });
  if (uploadErr) {
    Sentry.withScope((scope) => {
      scope.setTag("service", "call-recordings");
      scope.setTag("provider", provider);
      scope.setExtras({ recordingSid, callId: call.id, storagePath });
      Sentry.captureException(uploadErr);
    });
    return { ok: false, error: `Upload failed: ${uploadErr.message}`, transient: true };
  }

  const { error: updateErr } = await (supabase as any)
    .from("calls")
    .update({
      recording_storage_path: storagePath,
      recording_sid: recordingSid,
      recording_url: null,
    })
    .eq("id", call.id);
  if (updateErr) {
    Sentry.withScope((scope) => {
      scope.setTag("service", "call-recordings");
      scope.setTag("provider", provider);
      scope.setExtras({ recordingSid, callId: call.id, storagePath });
      Sentry.captureException(updateErr);
    });
    return { ok: false, error: `DB update failed: ${updateErr.message}`, transient: true };
  }

  return { ok: true, callId: call.id, storagePath };
}
