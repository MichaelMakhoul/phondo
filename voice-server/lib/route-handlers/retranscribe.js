"use strict";

const { SENTRY_REASONS, setReasonTag } = require("../sentry-reasons");

// SCRUM-550: post-call re-transcription orchestration. Runs entirely off the
// live-call path (triggered by the Next.js recording webhook). Deps are
// injected so the whole flow is unit-testable without network/DB. Every failure
// is caught, paged (reason=retranscribe-failed), and returns a result — the
// dashboard keeps Gemini's original transcript on any degradation.

const BUCKET = "call-recordings";

/**
 * @param {{ callId: string, deps: object }} args
 *   deps: { getSupabase, transcribeRecording, buildTwoSidedTranscript,
 *           analyzeCallTranscript, applyReanalysis, Sentry,
 *           deepgramApiKey, retranscribeEnabled }
 * @returns {Promise<{ ok: true, retranscribed: boolean, reason?: string }>}
 *   Never throws.
 */
async function handleRetranscribe({ callId, deps }) {
  const {
    getSupabase,
    transcribeRecording,
    buildTwoSidedTranscript,
    analyzeCallTranscript,
    applyReanalysis,
    Sentry,
    deepgramApiKey,
    retranscribeEnabled,
  } = deps;

  const page = (msg, level) => {
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.RETRANSCRIBE_FAILED);
        scope.setLevel(level);
        scope.setExtras({ callId });
        Sentry.captureMessage(String(msg).slice(0, 300), level);
      });
    } catch {
      /* best-effort — a Sentry shim defect must not break re-transcription */
    }
  };

  if (!retranscribeEnabled) return { ok: true, retranscribed: false, reason: "disabled" };
  if (!deepgramApiKey) {
    // Warning, not error: re-transcription is a strictly-additive enhancement.
    // A missing key just means it no-ops and the dashboard keeps Gemini's
    // transcript — nothing is lost, unlike a broken core path. (DEEPGRAM_API_KEY
    // is already required by the classic fallback pipeline, so this is near-impossible.)
    page("retranscribe: DEEPGRAM_API_KEY not set — skipping", "warning");
    return { ok: true, retranscribed: false, reason: "no-deepgram-key" };
  }

  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from("calls")
    .select("id, organization_id, recording_storage_path, transcript, transcript_source, language, metadata")
    .eq("id", callId)
    .single();

  if (error || !row) {
    page(`retranscribe: call ${callId} not found: ${error?.message || "no row"}`, "warning");
    return { ok: true, retranscribed: false, reason: "not-found" };
  }
  if (row.transcript_source === "deepgram") {
    return { ok: true, retranscribed: false, reason: "already-retranscribed" };
  }
  if (!row.recording_storage_path) {
    return { ok: true, retranscribed: false, reason: "no-recording" };
  }

  try {
    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(row.recording_storage_path);
    if (dlErr || !blob) throw new Error(`download failed: ${dlErr?.message || "no blob"}`);
    const audio = Buffer.from(await blob.arrayBuffer());

    const industry = row.metadata && row.metadata.industry;
    const { utterances } = await transcribeRecording(deepgramApiKey, audio, {
      language: row.language,
      industry,
    });
    const accurateTranscript = buildTwoSidedTranscript(utterances);
    if (!accurateTranscript.trim()) {
      page(`retranscribe: empty transcript for call ${callId}`, "warning");
      return { ok: true, retranscribed: false, reason: "empty-transcript" };
    }

    const analysis = await analyzeCallTranscript(accurateTranscript, { language: row.language });
    await applyReanalysis(callId, {
      accurateTranscript,
      priorTranscript: row.transcript,
      analysis,
    });
    return { ok: true, retranscribed: true };
  } catch (err) {
    page(`retranscribe failed for ${callId}: ${err && err.message ? err.message : String(err)}`, "warning");
    return { ok: true, retranscribed: false, reason: "stt-failed" };
  }
}

module.exports = { handleRetranscribe };
