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
 *           analyzeCallTranscript, judgeContentLoss, applyReanalysis, Sentry,
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
    judgeContentLoss,
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

  // SCRUM-552: distinct reason at ERROR level for a PostgREST-rejected lookup
  // (bad column / unresolvable embed). One of these means the feature is dead
  // for EVERY call — the exact failure that shipped camouflaged as per-call
  // "not found" warnings. Separate reason so Grafana can alert on it alone.
  const pageLookupRejected = (msg) => {
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.RETRANSCRIBE_LOOKUP_REJECTED);
        scope.setLevel("error");
        scope.setExtras({ callId });
        Sentry.captureMessage(String(msg).slice(0, 300), "error");
      });
    } catch {
      /* best-effort */
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
    // A PostgREST REJECTION (has a code and it isn't PGRST116/"no rows") is
    // systemic — a bad column or unresolvable embed rejects the query for
    // every call, not this one. Page it apart from the benign miss so it
    // can't hide as per-call noise again. Codeless (thrown/network) errors
    // stay on the benign path: transient, self-limiting, can't be classified.
    const rejected = Boolean(error && error.code && error.code !== "PGRST116");
    if (rejected) {
      pageLookupRejected(
        `retranscribe: lookup REJECTED (${error.code}): ${error.message} — feature likely dead for ALL calls`,
      );
      return { ok: true, retranscribed: false, reason: "lookup-rejected" };
    }
    page(`retranscribe: call ${callId} not found: ${error?.message || "no row"}`, "warning");
    return { ok: true, retranscribed: false, reason: "not-found" };
  }
  if (row.transcript_source === "deepgram") {
    return { ok: true, retranscribed: false, reason: "already-retranscribed" };
  }
  if (!row.recording_storage_path) {
    return { ok: true, retranscribed: false, reason: "no-recording" };
  }
  // SCRUM-553: no prior transcript ⇒ skip. Two reasons: (1) on short calls the
  // recording webhook can beat the call-end analysis write, and re-transcribing
  // mid-race would interleave with completeCallRecord — its later write clobbers
  // the Deepgram transcript while transcript_source keeps claiming 'deepgram'.
  // (2) With nothing to compare against, the content-loss guards below are
  // blind. A call whose Gemini transcript is genuinely empty loses nothing.
  if (!row.transcript || !String(row.transcript).trim()) {
    return { ok: true, retranscribed: false, reason: "no-prior-transcript" };
  }
  // No assistant embed = no language evidence (assistant deleted — the FK is
  // ON DELETE SET NULL). Guessing English on a possibly non-English recording
  // would permanently overwrite Gemini's correct transcript AND analysis (no
  // raw_ backup for the analysis columns, and the deepgram stamp is never
  // retried). Skip — strictly-additive means never risking the good copy.
  if (!row.assistants) {
    return { ok: true, retranscribed: false, reason: "no-assistant" };
  }

  // Language = the assistant's configured language (what the live pipeline
  // spoke); industry = the org's (metadata.industry never materialized in prod —
  // 0 of 259 calls — kept only as a legacy fallback for the keyterm boost).
  const language = row.assistants.language || null;
  const industry =
    (row.organizations && row.organizations.industry) ||
    (row.metadata && row.metadata.industry) ||
    null;

  // Deepgram Nova-3 pre-recorded supports only {en, es} (SUPPORTED_STT_LANGUAGES).
  // Today this guard is future-proofing: assistants.language is DB-constrained
  // to {en, es}, so it can only fire once assistants gain more languages. A
  // mid-call language switch (SCRUM-547) on an `en` assistant is instead caught
  // AFTER transcription by the SCRUM-553 content-loss guards below — there is no
  // reliable per-call language signal (Gemini's turn labels are garble-noise).
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

    // SCRUM-553 guard 1 (deterministic backstop): a replacement under half the
    // original's length means Deepgram dropped a large share of the call (e.g.
    // audio in a language its model can't transcribe). Catches only GROSS loss
    // by design — the observed real-world mixed-language loss sat at 0.757, so
    // the semantic judge below is the primary guard; this one survives judge
    // outages. Skip = keep Gemini's transcript; the stamp is never written, so
    // nothing is lost.
    if (accurateTranscript.length < 0.5 * row.transcript.length) {
      page(
        `retranscribe: gross content loss for call ${callId} — replacement ${accurateTranscript.length} chars vs original ${row.transcript.length}`,
        "warning",
      );
      return { ok: true, retranscribed: false, reason: "content-loss" };
    }

    // SCRUM-553 guard 2 (primary): LLM compare of old-vs-new. Prod evidence
    // (call 6e1feb9c, 2026-07-17): Deepgram-en silently dropped a mid-call
    // Arabic exchange Gemini had kept (garbled but present) — invisible to
    // length ratios and to Gemini's noise-ridden per-turn language labels.
    // FAIL-OPEN by design: the judge is a best-effort guard on a strictly-
    // additive feature; its own outage must not disable re-transcription
    // (gross loss is still caught above). A false positive only skips —
    // Gemini's transcript stays, which is today's status quo.
    try {
      const verdict = await judgeContentLoss(row.transcript, accurateTranscript);
      if (verdict && verdict.contentLoss) {
        page(
          `retranscribe: content loss (judge) for call ${callId}${verdict.note ? ` — ${verdict.note}` : ""}`,
          "warning",
        );
        return { ok: true, retranscribed: false, reason: "content-loss" };
      }
    } catch (judgeErr) {
      console.warn(
        `[Retranscribe] content-loss judge failed for ${callId} — proceeding (fail-open):`,
        judgeErr && judgeErr.message ? judgeErr.message : String(judgeErr),
      );
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
