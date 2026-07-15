const { getSupabase } = require("./supabase");
const { Sentry } = require("./sentry");

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
 *
 * Every field below is optional — callers (e.g. pending-transfers)
 * pass whatever subset they have, and the body only writes the ones
 * that are set. SCRUM-317: typed as all-optional so checkJs accepts a
 * partial payload (the destructure alone would infer them required).
 *
 * @param {string} callId
 * @param {object} fields
 * @param {string} [fields.status]
 * @param {number} [fields.durationSeconds]
 * @param {*} [fields.transcript]
 * @param {*} [fields.summary]
 * @param {*} [fields.callerName]
 * @param {*} [fields.collectedData]
 * @param {*} [fields.successEvaluation]
 * @param {boolean} [fields.recordingDisclosurePlayed]
 * @param {boolean} [fields.recordingDisclosureFailed]
 * @param {*} [fields.transferAttempt]
 * @param {*} [fields.callerState]
 * @param {*} [fields.consentReason]
 * @param {*} [fields.sentiment]
 * @param {*} [fields.piiRedacted]
 * @param {*} [fields.answeredBy]
 * @param {*} [fields.outcome]
 * @param {*} [fields.cleanedTranscript]
 * @param {*} [fields.actionTaken]
 * @param {*} [fields.pipelineFailover] - SCRUM-535: {from, to, reason, model} when the fallback provider served the call
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
  piiRedacted,
  answeredBy,
  outcome,
  cleanedTranscript,
  actionTaken,
  pipelineFailover,
}) {
  const supabase = getSupabase();

  const updatePayload = {
    status: status || "completed",
    ended_at: new Date().toISOString(),
    duration_seconds: durationSeconds,
    transcript: transcript || null,
  };

  if (outcome) updatePayload.outcome = outcome;
  if (summary) updatePayload.summary = summary;
  if (callerName) updatePayload.caller_name = callerName;
  if (collectedData) updatePayload.collected_data = collectedData;
  if (sentiment) updatePayload.sentiment = sentiment;
  if (cleanedTranscript) updatePayload.cleaned_transcript = cleanedTranscript;

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
    ...(piiRedacted && { piiRedacted: true }),
    ...(answeredBy && { answeredBy }),
    // SCRUM-535: queryable record of which calls a Gemini outage touched —
    // Sentry has the alert, this has the audit trail.
    ...(pipelineFailover && { pipelineFailover }),
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

  // SCRUM-498: separate GUARDED write — only fills action_taken when it's
  // still empty, so a mid-call "transferred" (written by the transfer
  // service) is never clobbered by the end-of-call booking label.
  if (actionTaken) {
    const { error: actionError } = await supabase
      .from("calls")
      .update({ action_taken: actionTaken })
      .eq("id", callId)
      .is("action_taken", null);
    if (actionError) {
      // Non-fatal: the record itself completed — losing the label only
      // undercounts the booking metric for this one call, but say so loudly:
      // a SYSTEMIC cause (column/grant change) would zero the metric
      // fleet-wide with nothing but Fly logs to show for it (review P3).
      console.error(`[CallLogger] Failed to set action_taken="${actionTaken}" for call ${callId}:`, actionError.message);
      try {
        Sentry.captureMessage(`action_taken write failed for call ${callId}: ${actionError.message}`.slice(0, 300), "warning");
      } catch { /* best-effort */ }
    }
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

/**
 * SCRUM-550: focused post-call update after re-transcription. Overwrites
 * `transcript` with the accurate Deepgram version, preserves Gemini's original
 * in `raw_transcript`, and stamps `transcript_source='deepgram'` (also the
 * idempotency guard). Does NOT touch status/ended_at/duration — those are final.
 *
 * Structured fields follow the existing convention: summary/caller_name/
 * collected_data/sentiment/cleaned_transcript are columns; successEvaluation +
 * unansweredQuestions are merged into `metadata`. The caller passes the metadata
 * it already read (`priorMetadata`) so we merge onto it in-process — no second
 * SELECT here. That avoids clobbering the accumulated metadata (voice_provider,
 * pipelineFailover, consentReason/callerState, disclosure flags) that a failed
 * re-read would collapse to {}, and sidesteps the read-then-write race
 * completeCallRecord deliberately avoids. A null analysis (e.g. a call too short
 * to analyze) still fixes the transcript but leaves display columns/metadata alone.
 *
 * @param {string} callId
 * @param {{ accurateTranscript: string, priorTranscript: string|null, priorMetadata?: object|null, analysis: object|null }} fields
 * @throws on DB error (caller catches → fallback to Gemini's transcript)
 */
async function applyReanalysis(callId, { accurateTranscript, priorTranscript, priorMetadata, analysis }) {
  const supabase = getSupabase();

  const updatePayload = {
    transcript: accurateTranscript,
    raw_transcript: priorTranscript ?? null,
    transcript_source: "deepgram",
  };

  if (analysis) {
    if (analysis.summary) updatePayload.summary = analysis.summary;
    if (analysis.callerName) updatePayload.caller_name = analysis.callerName;
    if (analysis.collectedData) updatePayload.collected_data = analysis.collectedData;
    if (analysis.sentiment) updatePayload.sentiment = analysis.sentiment;
    if (analysis.cleanedTranscript) updatePayload.cleaned_transcript = analysis.cleanedTranscript;

    // Merge onto the metadata the caller already read — never re-read (a failed
    // re-read would collapse to {} and wipe the accumulated keys).
    updatePayload.metadata = {
      ...(priorMetadata || {}),
      ...(analysis.successEvaluation && { successEvaluation: analysis.successEvaluation }),
      ...(analysis.unansweredQuestions && analysis.unansweredQuestions.length > 0 && {
        unansweredQuestions: analysis.unansweredQuestions,
      }),
    };
  }

  const { error } = await supabase.from("calls").update(updatePayload).eq("id", callId);
  if (error) {
    throw new Error(`applyReanalysis failed for ${callId}: ${error.message}`);
  }
}

module.exports = {
  createCallRecord,
  completeCallRecord,
  notifyCallCompleted,
  applyReanalysis,
};
