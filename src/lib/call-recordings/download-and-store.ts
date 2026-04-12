// src/lib/call-recordings/download-and-store.ts
import { createClient } from "@supabase/supabase-js";

type Provider = "twilio" | "telnyx";

interface DownloadAndStoreParams {
  provider: Provider;
  recordingUrl: string;   // signed or authenticated provider URL
  recordingSid: string;   // Twilio RecordingSid or Telnyx recording id
  callSid: string;        // Twilio CallSid or Telnyx call_control_id
}

interface DownloadAndStoreResult {
  ok: boolean;
  callId?: string;
  storagePath?: string;
  error?: string;
}

const BUCKET = "call-recordings";

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function fetchRecording(provider: Provider, url: string): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {};
  if (provider === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID/AUTH_TOKEN not set");
    headers.Authorization = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
  } else {
    const key = process.env.TELNYX_API_KEY;
    if (!key) throw new Error("TELNYX_API_KEY not set");
    headers.Authorization = `Bearer ${key}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Provider ${provider} returned ${res.status} fetching recording`);
  }
  return await res.arrayBuffer();
}

export async function downloadAndStoreRecording(
  params: DownloadAndStoreParams,
): Promise<DownloadAndStoreResult> {
  const { provider, recordingUrl, recordingSid, callSid } = params;
  const supabase = getServiceClient();

  // Look up the call row to get org + call id. Voice server prefixes CallSids
  // with "sh_" in vapi_call_id for self-hosted calls. Both Twilio (CallSid) and
  // Telnyx (call_control_id) flow through this same naming convention.
  const vapiCallId = `sh_${callSid}`;
  const { data: call, error: lookupErr } = await supabase
    .from("calls")
    .select("id, organization_id, recording_sid, recording_storage_path")
    .eq("vapi_call_id", vapiCallId)
    .maybeSingle();

  if (lookupErr) {
    return { ok: false, error: `Call lookup failed: ${lookupErr.message}` };
  }
  if (!call) {
    return { ok: false, error: `No call row for vapi_call_id=${vapiCallId}` };
  }

  // Idempotency: if we already stored this recording, do nothing.
  if (call.recording_sid === recordingSid && call.recording_storage_path) {
    return { ok: true, callId: call.id, storagePath: call.recording_storage_path };
  }

  // Download from provider.
  let audio: ArrayBuffer;
  try {
    audio = await fetchRecording(provider, recordingUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Download failed: ${msg}` };
  }

  // Upload to Supabase Storage.
  const storagePath = `${call.organization_id}/${call.id}.mp3`;
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, audio, {
      contentType: "audio/mpeg",
      upsert: true,
    });
  if (uploadErr) {
    return { ok: false, error: `Upload failed: ${uploadErr.message}` };
  }

  // Update call row — clear legacy recording_url so dashboard stops showing the broken link.
  const { error: updateErr } = await supabase
    .from("calls")
    .update({
      recording_storage_path: storagePath,
      recording_sid: recordingSid,
      recording_url: null,
    })
    .eq("id", call.id);
  if (updateErr) {
    return { ok: false, error: `DB update failed: ${updateErr.message}` };
  }

  return { ok: true, callId: call.id, storagePath };
}
