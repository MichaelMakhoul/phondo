"use strict";

const { SENTRY_REASONS, setReasonTag } = require("../sentry-reasons");
const { SUPPORTED_STT_LANGUAGES } = require("../../services/deepgram-stt");
const { containsNonLatinScript } = require("../../services/post-call-analysis");
const { DEBUG_TRANSCRIPTS } = require("../log-transcript");

// SCRUM-550: post-call re-transcription orchestration. Runs entirely off the
// live-call path (triggered by the Next.js recording webhook). Deps are
// injected so the whole flow is unit-testable without network/DB. Every failure
// is caught, paged (reason=retranscribe-failed), and returns a result — the
// dashboard keeps Gemini's original transcript on any degradation.

const BUCKET = "call-recordings";

/**
 * @param {{ callId: string, deps: object, isRetry?: boolean }} args
 *   deps: { getSupabase, transcribeRecording, buildTwoSidedTranscript,
 *           analyzeCallTranscript, judgeContentLoss, applyReanalysis, Sentry,
 *           deepgramApiKey, retranscribeEnabled, scheduleRetry? }
 *   isRetry: internal — set by the one-shot delayed self-retry when the
 *   recording webhook beat the call-end write (never re-schedules).
 * @returns {Promise<{ ok: true, retranscribed: boolean, reason?: string }>}
 *   Never throws.
 */
async function handleRetranscribe({ callId, deps, isRetry = false }) {
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
    // Injectable for tests; default holds no process open (unref).
    scheduleRetry = (fn) => {
      const t = setTimeout(fn, 60_000);
      if (typeof t.unref === "function") t.unref();
    },
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

  // SCRUM-553: guard hits are the guard WORKING, not the feature failing —
  // their own reason keeps retranscribe-failed a clean broken-feature alert
  // and gives the owner a reviewable queue of kept-Gemini calls (the same
  // conflation lesson SCRUM-552 fixed with lookup-rejected).
  const pageContentLoss = (msg) => {
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.RETRANSCRIBE_CONTENT_LOSS);
        scope.setLevel("warning");
        scope.setExtras({ callId });
        Sentry.captureMessage(String(msg).slice(0, 300), "warning");
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
      .select("id, organization_id, recording_storage_path, transcript, transcript_source, ended_at, metadata, assistants(language), organizations(industry)")
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
  // SCRUM-553: no prior transcript ⇒ don't overwrite. Two distinct cases,
  // discriminated by ended_at (written in the SAME update as the transcript by
  // completeCallRecord):
  //   ended_at NULL  → the recording webhook BEAT the call-end write (analysis
  //     can take 10-35s; Twilio's recording callback is seconds-scale). Writing
  //     now would let completeCallRecord clobber the Deepgram transcript while
  //     transcript_source keeps claiming 'deepgram'. The webhook fires ONCE —
  //     no retry exists anywhere — so schedule ONE delayed self-retry; if the
  //     call-end write STILL hasn't landed then, the call-end path died: page.
  //   ended_at SET   → the call genuinely produced no transcript. Nothing to
  //     improve, nothing to compare the content-loss guards against — silent
  //     skip is correct.
  if (!row.transcript || !String(row.transcript).trim()) {
    if (!row.ended_at && !isRetry) {
      scheduleRetry(() => {
        handleRetranscribe({ callId, deps, isRetry: true }).catch(() => {
          /* handler never throws; belt-and-braces for the detached call */
        });
      });
      return { ok: true, retranscribed: false, reason: "no-prior-transcript-retrying" };
    }
    if (!row.ended_at) {
      page(
        `retranscribe: call-end write never landed for ${callId} — re-transcription skipped`,
        "warning",
      );
    }
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
      pageContentLoss(
        `retranscribe: gross content loss for call ${callId} — replacement ${accurateTranscript.length} chars vs original ${row.transcript.length}`,
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
      if (verdict.contentLoss) {
        // The judge note paraphrases caller speech — keep it OUT of the Sentry
        // message: messages bypass the key-based extras scrubber and land
        // verbatim in the Loki alert line (security review, PR #407). callId is
        // enough to triage — both transcripts are in the DB. SCRUM-339 pattern:
        // content only on explicit debug opt-in, newline-stripped.
        if (DEBUG_TRANSCRIPTS && verdict.note) {
          console.log(
            `[Retranscribe] judge note for ${callId}: ${verdict.note.replace(/[\r\n]+/g, " ")}`,
          );
        }
        pageContentLoss(`retranscribe: content loss (judge) for call ${callId}`);
        return { ok: true, retranscribed: false, reason: "content-loss" };
      }
    } catch (judgeErr) {
      const judgeMsg = judgeErr && judgeErr.message ? judgeErr.message : String(judgeErr);

      // A verdict too large to emit is note-bearing, i.e. positive-leaning —
      // truncation concentrates on exactly the verdicts the guard exists to
      // deliver. Fail CLOSED (keep Gemini's transcript).
      if (judgeErr && judgeErr.isMaxTokensTruncation) {
        pageContentLoss(
          `retranscribe: judge verdict truncated for call ${callId} — failing closed`,
        );
        return { ok: true, retranscribed: false, reason: "content-loss" };
      }

      // Systemic signatures (revoked/unset key, a wiring defect making the dep
      // undefined, malformed-verdict schema drift) mean the guard is OFF for
      // EVERY call, not this one — rare by nature, so paging them is not
      // per-call noise. Blips (429/5xx/timeouts) stay on console only.
      const systemic =
        /^OpenAI 40[13]\b/.test(judgeMsg) ||
        judgeMsg.includes("OPENAI_API_KEY not set") ||
        judgeMsg.includes("malformed verdict") ||
        judgeErr instanceof TypeError;
      if (systemic) {
        page(
          `retranscribe: content-loss judge SYSTEMICALLY failing (${judgeMsg.slice(0, 120)}) — guard is OFF fleet-wide`,
          "warning",
        );
      }

      // Bound the blast radius: a garble-signature original (non-Latin script —
      // the mixed-language class where Deepgram-en demonstrably drops content,
      // call 6e1feb9c) fails CLOSED when the judge can't rule. Latin-script
      // calls fail OPEN: there a judge outage is genuinely harmless and the
      // gross-length backstop still stands.
      if (containsNonLatinScript(row.transcript)) {
        pageContentLoss(
          `retranscribe: judge unavailable on a garble-signature call ${callId} — failing closed`,
        );
        return { ok: true, retranscribed: false, reason: "content-loss" };
      }
      if (!systemic) {
        console.warn(
          `[Retranscribe] content-loss judge failed for ${callId} — proceeding (fail-open):`,
          judgeMsg,
        );
      }
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
