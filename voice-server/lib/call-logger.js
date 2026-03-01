const { getSupabase } = require("./supabase");

/**
 * Create a call record when the call starts.
 * Stores the Twilio CallSid prefixed with "sh_" in the vapi_call_id column
 * (NOT NULL UNIQUE) to distinguish self-hosted calls from Vapi-originated ones.
 *
 * @returns {Promise<string|null>} The call record UUID, or null on failure
 */
async function createCallRecord({ orgId, assistantId, phoneNumberId, callerPhone, callSid }) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("calls")
    .insert({
      organization_id: orgId,
      assistant_id: assistantId,
      phone_number_id: phoneNumberId,
      vapi_call_id: `sh_${callSid}`, // prefix to distinguish from Vapi call IDs
      caller_phone: callerPhone,
      direction: "inbound",
      status: "in-progress",
      started_at: new Date().toISOString(),
      metadata: { voice_provider: "self_hosted" },
    })
    .select("id")
    .single();

  if (error) {
    console.error("[CallLogger] Failed to create call record:", {
      callSid,
      orgId,
      error,
    });
    return null;
  }

  return data.id;
}

/**
 * Update the call record when the call ends.
 * Accepts optional post-call analysis results.
 * Throws on failure so the caller can handle it.
 */
async function completeCallRecord(callId, {
  status,
  durationSeconds,
  transcript,
  summary,
  callerName,
  collectedData,
  successEvaluation,
  recordingDisclosurePlayed,
  recordingDisclosureFailed,
  transferAttempt,
  callerState,
  consentReason,
  sentiment,
  answeredBy,
}) {
  const supabase = getSupabase();

  const updatePayload = {
    status: status || "completed",
    ended_at: new Date().toISOString(),
    duration_seconds: durationSeconds,
    transcript: transcript || null,
  };

  if (summary) updatePayload.summary = summary;
  if (callerName) updatePayload.caller_name = callerName;
  if (collectedData) updatePayload.collected_data = collectedData;
  if (sentiment) updatePayload.sentiment = sentiment;

  // Merge metadata extras into a single atomic update.
  // Initial metadata (set at insert time) is { voice_provider: "self_hosted" }.
  // We include it here to avoid a read-then-write race with the call-completed
  // webhook which also writes to metadata concurrently.
  const metadataExtras = {
    ...(successEvaluation && { successEvaluation }),
    ...(recordingDisclosurePlayed && { recordingDisclosurePlayed: true }),
    ...(recordingDisclosureFailed && { recordingDisclosureFailed: true }),
    ...(transferAttempt && { transferAttempt }),
    // Always include both callerState and consentReason together when consent was checked,
    // even if callerState is null (distinguishes "checked but unknown" from "never checked").
    ...(consentReason != null && { consentReason, callerState: callerState ?? null }),
    ...(answeredBy && { answeredBy }),
  };

  if (Object.keys(metadataExtras).length > 0) {
    updatePayload.metadata = { voice_provider: "self_hosted", ...metadataExtras };
  }

  const { error } = await supabase
    .from("calls")
    .update(updatePayload)
    .eq("id", callId);

  if (error) {
    throw new Error(`Failed to complete call record ${callId}: ${error.message}`);
  }
}

/**
 * POST to the Next.js internal endpoint for post-call processing
 * (spam analysis, billing, notifications, webhook delivery).
 * Retries up to 2 times on transient failures (5xx, network errors).
 * Errors are caught internally — this function never throws.
 */
async function notifyCallCompleted(internalApiUrl, secret, payload) {
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${internalApiUrl}/api/internal/call-completed`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": secret,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) return;

      const text = (await res.text()).slice(0, 500);
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        console.warn(`[CallLogger] Internal API returned ${res.status}, retrying (${attempt + 1}/${MAX_RETRIES}):`, { callId: payload.callId });
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      console.error("[CallLogger] Internal API error — post-call processing lost:", {
        status: res.status,
        body: text,
        callId: payload.callId,
        organizationId: payload.organizationId,
      });
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[CallLogger] Network error, retrying (${attempt + 1}/${MAX_RETRIES}):`, err.message);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      console.error("[CallLogger] Failed to notify after retries — billing, notifications, and webhooks lost:", {
        callId: payload.callId,
        organizationId: payload.organizationId,
        error: err.message,
      });
    }
  }
}

module.exports = {
  createCallRecord,
  completeCallRecord,
  notifyCallCompleted,
};
