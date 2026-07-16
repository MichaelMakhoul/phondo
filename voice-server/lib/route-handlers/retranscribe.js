"use strict";

const { SENTRY_REASONS, setReasonTag } = require("../sentry-reasons");
const { SUPPORTED_STT_LANGUAGES } = require("../../services/deepgram-stt");

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
  // Wrap the lookup so a THROWN rejection (network/pool) is paged with the
  // retranscribe-failed reason the Grafana rule watches, not just a returned
  // `error`. Without this the throw escapes past page() to server.js's outer
  // net — safe for the transcript, but invisible to alerting.
  /** @type {{ data: any, error: any }} */
  let lookup;
  try {
    // SCRUM-552: calls has NO language/industry columns — language lives on the
    // assistant, industry on the organization. Selecting a non-existent column
    // makes PostgREST reject the whole query (42703), which sent EVERY call down
    // the not-found branch. Both embeds are to-one FK joins (bare-table idiom,
    // same as answer-mode.js) and either can be null (e.g. deleted assistant).
    lookup = await supabase
      .from("calls")
      .select("id, organization_id, recording_storage_path, transcript, transcript_source, metadata, assistants(language), organizations(industry)")
      .eq("id", callId)
      .single();
  } catch (err) {
    lookup = { data: null, error: err };
  }
  const { data: row, error } = lookup;

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
  // Language = the assistant's configured language (what the live pipeline
  // spoke); industry = the org's (metadata.industry never materialized in prod —
  // 0 of 259 calls — kept only as a legacy fallback for the keyterm boost).
  const language = (row.assistants && row.assistants.language) || null;
  const industry =
    (row.organizations && row.organizations.industry) ||
    (row.metadata && row.metadata.industry) ||
    null;

  // Deepgram Nova-3 pre-recorded supports only {en, es} (SUPPORTED_STT_LANGUAGES).
  // transcribeRecording would silently transcribe an unsupported language (e.g. an
  // Arabic call) with the English model, yielding plausible-looking garbage that
  // passes the empty-guard and overwrites the Gemini-derived analysis columns
  // (summary/caller_name/collected_data/sentiment) — and those have NO raw_ backup.
  // Skip; keep Gemini's transcript AND analysis. Null/unset language ⇒ English ⇒ OK.
  if (language && !SUPPORTED_STT_LANGUAGES.has(language)) {
    return { ok: true, retranscribed: false, reason: "unsupported-language" };
  }

  try {
    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(row.recording_storage_path);
    if (dlErr || !blob) throw new Error(`download failed: ${dlErr?.message || "no blob"}`);
    const audio = Buffer.from(await blob.arrayBuffer());

    const { utterances, channelCount } = await transcribeRecording(deepgramApiKey, audio, {
      language,
      industry,
    });
    // Dual-channel diarization is the whole premise: caller on one channel, AI on
    // the other. A single-channel result (mono recording, multichannel not honored,
    // config drift) puts every utterance on channel 0 → buildTwoSidedTranscript
    // labels ALL of it "User:" with no AI turns. That non-empty garbage would pass
    // the empty-guard, overwrite Gemini's correct transcript, and stamp it
    // permanently (idempotent — never retried). Skip; keep Gemini's.
    if (!(channelCount >= 2)) {
      page(`retranscribe: expected multichannel, got ${channelCount} channel(s) for call ${callId}`, "warning");
      return { ok: true, retranscribed: false, reason: "not-multichannel" };
    }
    const accurateTranscript = buildTwoSidedTranscript(utterances);
    if (!accurateTranscript.trim()) {
      page(`retranscribe: empty transcript for call ${callId}`, "warning");
      return { ok: true, retranscribed: false, reason: "empty-transcript" };
    }

    const analysis = await analyzeCallTranscript(accurateTranscript, { language });
    await applyReanalysis(callId, {
      accurateTranscript,
      priorTranscript: row.transcript,
      priorMetadata: row.metadata,
      analysis,
    });
    return { ok: true, retranscribed: true };
  } catch (err) {
    page(`retranscribe failed for ${callId}: ${err && err.message ? err.message : String(err)}`, "warning");
    return { ok: true, retranscribed: false, reason: "stt-failed" };
  }
}

module.exports = { handleRetranscribe };
