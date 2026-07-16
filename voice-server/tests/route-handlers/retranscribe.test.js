"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { handleRetranscribe } = require("../../lib/route-handlers/retranscribe");

// SCRUM-550: the re-transcription orchestration. Deps injected; asserts the
// guard/fallback matrix and that a successful run feeds applyReanalysis the
// accurate transcript + the prior Gemini transcript. Fake Sentry records the
// paged reason/level so the retranscribe-failed contract is pinned.

function makeSentry() {
  const events = [];
  let current = null;
  return {
    events,
    withScope: (fn) => {
      const scope = {
        tags: {},
        extras: {},
        level: null,
        setTag(k, v) { this.tags[k] = v; },
        setLevel(l) { this.level = l; },
        setExtras(e) { Object.assign(this.extras, e); },
      };
      current = scope;
      try { fn(scope); } finally { current = null; }
    },
    captureMessage: (msg, level) => {
      events.push({ msg, level, reason: current?.tags?.reason, service: current?.tags?.service });
    },
  };
}

const DEFAULT_ROW = {
  id: "c1",
  organization_id: "o1",
  recording_storage_path: "o1/c1.mp3",
  transcript: "User: gibberish\nAI: hello",
  transcript_source: null,
  ended_at: "2026-07-16T00:00:00Z",
  metadata: { voice_provider: "self_hosted" },
  // SCRUM-552: language/industry are NOT calls columns — they arrive via
  // to-one FK embeds (assistants/organizations), either of which can be null.
  assistants: { language: "en" },
  organizations: { industry: "dental" },
};

function makeDeps(overrides = {}) {
  const captured = {
    applyReanalysis: null,
    transcribeArgs: null,
    lookup: null,
    selectCols: null,
    judgeArgs: null,
    retryFn: null,
  };
  const row = "row" in overrides ? overrides.row : { ...DEFAULT_ROW };
  const supabase = {
    from: () => ({
      select: (cols) => {
        captured.selectCols = cols;
        return {
          eq: (col, val) => {
            captured.lookup = { col, val };
            return {
              single: async () => {
                if (overrides.selectThrows) throw overrides.selectThrows;
                return { data: row, error: overrides.selectError || null };
              },
            };
          },
        };
      },
    }),
    storage: {
      from: () => ({
        download: async () =>
          overrides.downloadError
            ? { data: null, error: overrides.downloadError }
            : { data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null },
      }),
    },
  };
  const sentry = makeSentry();
  const deps = {
    getSupabase: () => supabase,
    transcribeRecording:
      overrides.transcribeRecording ||
      (async (key, audio, opts) => {
        captured.transcribeArgs = { key, opts };
        return { utterances: [{ start: 0, channel: 0, transcript: "real caller words" }], channelCount: 2 };
      }),
    buildTwoSidedTranscript:
      overrides.buildTwoSidedTranscript || (() => "User: real caller words\nAI: hello"),
    analyzeCallTranscript:
      overrides.analyzeCallTranscript || (async () => ({ summary: "s", sentiment: "neutral" })),
    judgeContentLoss:
      overrides.judgeContentLoss ||
      (async (prior, replacement) => {
        captured.judgeArgs = { prior, replacement };
        return { contentLoss: false, note: null };
      }),
    applyReanalysis: async (callId, fields) => {
      captured.applyReanalysis = { callId, fields };
    },
    Sentry: sentry,
    deepgramApiKey: "deepgramApiKey" in overrides ? overrides.deepgramApiKey : "KEY",
    retranscribeEnabled: "retranscribeEnabled" in overrides ? overrides.retranscribeEnabled : true,
    // Capture instead of setTimeout so tests drive the retry synchronously.
    scheduleRetry: (fn) => {
      captured.retryFn = fn;
    },
  };
  return { deps, captured, sentry };
}

describe("handleRetranscribe (SCRUM-550)", () => {
  it("skips when disabled — no page, no DB write", async () => {
    const { deps, captured, sentry } = makeDeps({ retranscribeEnabled: false });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.deepEqual(res, { ok: true, retranscribed: false, reason: "disabled" });
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events.length, 0);
  });

  it("pages a warning when the Deepgram key is missing (graceful — Gemini transcript kept)", async () => {
    const { deps, sentry } = makeDeps({ deepgramApiKey: undefined });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "no-deepgram-key");
    assert.equal(sentry.events.length, 1);
    assert.equal(sentry.events[0].level, "warning");
    assert.equal(sentry.events[0].reason, "retranscribe-failed");
    assert.equal(sentry.events[0].service, "voice-server");
  });

  it("skips (idempotent) when already re-transcribed — no page, no write", async () => {
    const { deps, captured, sentry } = makeDeps({ row: { ...DEFAULT_ROW, transcript_source: "deepgram" } });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "already-retranscribed");
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events.length, 0);
  });

  it("skips when there is no stored recording — no page, no write", async () => {
    const { deps, captured } = makeDeps({ row: { ...DEFAULT_ROW, recording_storage_path: null } });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "no-recording");
    assert.equal(captured.applyReanalysis, null);
  });

  it("pages a warning when the call row is not found", async () => {
    const { deps, sentry } = makeDeps({ row: null });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "not-found");
    assert.equal(sentry.events[0].level, "warning");
    assert.equal(sentry.events[0].reason, "retranscribe-failed");
  });

  it("happy path: transcribes, analyzes, and feeds applyReanalysis the accurate + prior transcript", async () => {
    const { deps, captured } = makeDeps();
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.deepEqual(res, { ok: true, retranscribed: true });
    assert.equal(captured.transcribeArgs.key, "KEY");
    assert.deepEqual(captured.transcribeArgs.opts, { language: "en", industry: "dental" });
    assert.equal(captured.applyReanalysis.callId, "c1");
    assert.equal(captured.applyReanalysis.fields.accurateTranscript, "User: real caller words\nAI: hello");
    assert.equal(captured.applyReanalysis.fields.priorTranscript, "User: gibberish\nAI: hello");
    assert.deepEqual(captured.applyReanalysis.fields.priorMetadata, { voice_provider: "self_hosted" });
    assert.deepEqual(captured.applyReanalysis.fields.analysis, { summary: "s", sentiment: "neutral" });
    // SCRUM-553: the content-loss judge sees exactly the pair being swapped.
    assert.deepEqual(captured.judgeArgs, {
      prior: "User: gibberish\nAI: hello",
      replacement: "User: real caller words\nAI: hello",
    });
  });

  it("falls back (pages, no write) when Deepgram throws — transcript left untouched", async () => {
    const { deps, captured, sentry } = makeDeps({
      transcribeRecording: async () => {
        throw new Error("deepgram 503");
      },
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "stt-failed");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events[0].level, "warning");
    assert.equal(sentry.events[0].reason, "retranscribe-failed");
  });

  it("returns empty-transcript (no write) when the builder yields nothing", async () => {
    const { deps, captured } = makeDeps({ buildTwoSidedTranscript: () => "   " });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "empty-transcript");
    assert.equal(captured.applyReanalysis, null);
  });

  it("looks the row up by primary key (id) with the given callId — pins the producer/consumer contract", async () => {
    const { deps, captured } = makeDeps();
    await handleRetranscribe({ callId: "c1", deps });
    // The webhook must send calls.id (a UUID), not the Twilio CallSid. If this
    // regresses to .eq("vapi_call_id", …) or a typo, re-transcription no-ops
    // in prod — the mock now captures the real column/value so it can't hide it.
    assert.deepEqual(captured.lookup, { col: "id", val: "c1" });
    // SCRUM-552: EXACT select pin. The shipped bug selected `language`, which is
    // not a calls column — PostgREST 42703'd every lookup and the feature no-op'd
    // in prod, invisible to a mock that accepts any select string. Any change to
    // this string must be a conscious, schema-checked edit (update this pin AND
    // verify each bare column exists on calls; embeds are to-one FK joins).
    assert.equal(
      captured.selectCols,
      "id, organization_id, recording_storage_path, transcript, transcript_source, ended_at, metadata, assistants(language), organizations(industry)",
    );
  });

  it("pages and returns not-found when the row lookup THROWS (never escapes the handler)", async () => {
    const { deps, captured, sentry } = makeDeps({ selectThrows: new Error("pool timeout") });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "not-found");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events[0].level, "warning");
    assert.equal(sentry.events[0].reason, "retranscribe-failed");
  });

  it("skips (no page, no write) an unsupported assistant language — keeps Gemini's transcript AND analysis", async () => {
    const { deps, captured, sentry } = makeDeps({ row: { ...DEFAULT_ROW, assistants: { language: "ar" } } });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "unsupported-language");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.applyReanalysis, null);
    // An expected skip (Deepgram Nova-3 supports only en/es), not a failure — no page.
    assert.equal(sentry.events.length, 0);
  });

  it("skips (no page, no write) when the assistant embed is null — never guesses English over a good transcript", async () => {
    const { deps, captured, sentry } = makeDeps({
      row: { ...DEFAULT_ROW, assistants: null },
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    // Assistant deleted (FK is ON DELETE SET NULL) ⇒ no language evidence.
    // Transcribing with a guessed English model could permanently overwrite
    // Gemini's correct transcript + analysis — skip instead.
    assert.equal(res.reason, "no-assistant");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events.length, 0);
  });

  it("classifies a PostgREST query REJECTION as lookup-rejected at ERROR level — never benign not-found", async () => {
    // Replays the SCRUM-552 failure shape: a bad column/embed rejects the
    // query for EVERY call (42703), which previously camouflaged as per-call
    // "not found" warnings. Must page loudly under its own reason.
    const { deps, captured, sentry } = makeDeps({
      selectError: { code: "42703", message: "column calls.language does not exist" },
      row: null,
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "lookup-rejected");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events.length, 1);
    assert.equal(sentry.events[0].level, "error");
    assert.equal(sentry.events[0].reason, "retranscribe-lookup-rejected");
    assert.match(sentry.events[0].msg, /REJECTED \(42703\)/);
  });

  it("keeps PGRST116 (no rows) on the benign not-found path — not a rejection", async () => {
    const { deps, sentry } = makeDeps({
      selectError: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
      row: null,
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "not-found");
    assert.equal(sentry.events[0].level, "warning");
    assert.equal(sentry.events[0].reason, "retranscribe-failed");
  });

  it("falls back to metadata.industry when the organization embed is null (legacy path)", async () => {
    const { deps, captured } = makeDeps({
      row: { ...DEFAULT_ROW, organizations: null, metadata: { industry: "legal" } },
    });
    await handleRetranscribe({ callId: "c1", deps });
    assert.deepEqual(captured.transcribeArgs.opts, { language: "en", industry: "legal" });
  });

  it("silently skips a genuinely-empty call (ended_at SET, no transcript) — no page, no retry, no STT", async () => {
    const { deps, captured, sentry } = makeDeps({ row: { ...DEFAULT_ROW, transcript: "   " } });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "no-prior-transcript");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.transcribeArgs, null);
    assert.equal(captured.applyReanalysis, null);
    assert.equal(captured.retryFn, null);
    assert.equal(sentry.events.length, 0);
  });

  it("RACE (ended_at NULL): schedules ONE delayed self-retry instead of permanently skipping", async () => {
    const { deps, captured, sentry } = makeDeps({
      row: { ...DEFAULT_ROW, transcript: null, ended_at: null },
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    // The recording webhook beat the call-end write. The webhook fires ONCE —
    // without the retry this call would silently never be re-transcribed.
    assert.equal(res.reason, "no-prior-transcript-retrying");
    assert.equal(typeof captured.retryFn, "function");
    assert.equal(sentry.events.length, 0);
    assert.equal(captured.transcribeArgs, null);

    // Drive the retry: the row STILL has no call-end write → the call-end path
    // died. That's a real failure signal — page it; never a third attempt.
    captured.retryFn();
    await new Promise((r) => setImmediate(r));
    assert.equal(sentry.events.length, 1);
    assert.equal(sentry.events[0].level, "warning");
    assert.equal(sentry.events[0].reason, "retranscribe-failed");
    assert.match(sentry.events[0].msg, /call-end write never landed/);
  });

  it("RACE resolved by retry: the delayed run re-transcribes once the call-end write landed", async () => {
    const racingRow = { ...DEFAULT_ROW, transcript: null, ended_at: null };
    const { deps, captured } = makeDeps({ row: racingRow });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "no-prior-transcript-retrying");
    // The call-end write lands between first pass and retry (mutate the shared
    // row object the mock returns).
    racingRow.transcript = "User: gibberish\nAI: hello";
    racingRow.ended_at = "2026-07-16T00:00:00Z";
    captured.retryFn();
    await new Promise((r) => setImmediate(r));
    assert.ok(captured.applyReanalysis, "retry should have completed the re-transcription");
  });

  it("skips (pages, no write) on GROSS content loss — replacement under half the original's length", async () => {
    const longPrior = `User: ${"caller words ".repeat(20)}\nAI: ${"assistant words ".repeat(20)}`;
    const { deps, captured, sentry } = makeDeps({
      row: { ...DEFAULT_ROW, transcript: longPrior },
      buildTwoSidedTranscript: () => "User: tiny\nAI: fragment",
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "content-loss");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events[0].level, "warning");
    // Guard hits carry their OWN reason — the guard working must not pollute
    // the broken-feature (retranscribe-failed) alert.
    assert.equal(sentry.events[0].reason, "retranscribe-content-loss");
    assert.match(sentry.events[0].msg, /gross content loss/);
  });

  it("skips (pages, no write) when the judge reports content loss — Gemini's transcript kept", async () => {
    const { deps, captured, sentry } = makeDeps({
      judgeContentLoss: async () => ({ contentLoss: true, note: "Arabic exchange missing from B" }),
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "content-loss");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events[0].level, "warning");
    assert.equal(sentry.events[0].reason, "retranscribe-content-loss");
    assert.match(sentry.events[0].msg, /content loss \(judge\)/);
    // The note paraphrases caller speech — it must NEVER reach the Sentry
    // message (messages bypass the extras scrubber → verbatim in Loki).
    assert.doesNotMatch(sentry.events[0].msg, /Arabic exchange missing/);
  });

  it("FAIL-OPEN: a transient judge blip on a Latin-script call proceeds to write (console only)", async () => {
    const { deps, captured, sentry } = makeDeps({
      judgeContentLoss: async () => {
        throw new Error("OpenAI 503: overloaded");
      },
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    // The judge is a best-effort guard on a strictly-additive feature — a blip
    // must not turn the feature off. Gross loss is still caught by the
    // deterministic length backstop.
    assert.deepEqual(res, { ok: true, retranscribed: true });
    assert.ok(captured.applyReanalysis);
    assert.equal(sentry.events.length, 0);
  });

  it("FAIL-CLOSED on truncation: a verdict too large to emit is positive-leaning — keep Gemini's", async () => {
    const { deps, captured, sentry } = makeDeps({
      judgeContentLoss: async () => {
        const err = /** @type {Error & { isMaxTokensTruncation?: boolean }} */ (
          new Error("OpenAI hit max_tokens (truncated)")
        );
        err.isMaxTokensTruncation = true;
        throw err;
      },
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "content-loss");
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events[0].reason, "retranscribe-content-loss");
    assert.match(sentry.events[0].msg, /truncated.*failing closed/);
  });

  it("FAIL-CLOSED on a garble-signature call: judge unavailable + non-Latin original — keep Gemini's", async () => {
    const { deps, captured, sentry } = makeDeps({
      row: { ...DEFAULT_ROW, transcript: "User: مرحبا أريد موعدا\nAI: hello" },
      judgeContentLoss: async () => {
        throw new Error("OpenAI 503: overloaded");
      },
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    // The mixed-language class is where Deepgram-en demonstrably drops content
    // (call 6e1feb9c) — when the judge can't rule, keeping Gemini IS the guard.
    assert.equal(res.reason, "content-loss");
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events[0].reason, "retranscribe-content-loss");
    assert.match(sentry.events[0].msg, /garble-signature.*failing closed/);
  });

  it("SYSTEMIC judge failure (e.g. revoked key) pages retranscribe-failed — never silently off fleet-wide", async () => {
    const { deps, captured, sentry } = makeDeps({
      judgeContentLoss: async () => {
        throw new Error("OpenAI 401: invalid api key");
      },
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    // Latin-script call → still fails open (proceeds), but the systemic
    // signature pages so the owner knows the guard is OFF for every call.
    assert.deepEqual(res, { ok: true, retranscribed: true });
    assert.ok(captured.applyReanalysis);
    assert.equal(sentry.events.length, 1);
    assert.equal(sentry.events[0].reason, "retranscribe-failed");
    assert.match(sentry.events[0].msg, /SYSTEMICALLY failing/);
  });

  it("SYSTEMIC wiring defect (judge dep undefined → TypeError) pages, garbled call still fails closed", async () => {
    const { deps, captured, sentry } = makeDeps({
      row: { ...DEFAULT_ROW, transcript: "User: مرحبا\nAI: hi" },
    });
    deps.judgeContentLoss = undefined;
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "content-loss");
    assert.equal(captured.applyReanalysis, null);
    const reasons = sentry.events.map((e) => e.reason);
    assert.ok(reasons.includes("retranscribe-failed"), "systemic page missing");
    assert.ok(reasons.includes("retranscribe-content-loss"), "fail-closed page missing");
  });

  it("skips (pages, no write) a single-channel Deepgram result — no all-User garbage overwrite", async () => {
    const { deps, captured, sentry } = makeDeps({
      transcribeRecording: async () => ({
        utterances: [
          { start: 0, channel: 0, transcript: "everything landed on one channel" },
          { start: 1, channel: 0, transcript: "and would be labelled all User" },
        ],
        channelCount: 1,
      }),
    });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "not-multichannel");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.applyReanalysis, null);
    assert.equal(sentry.events[0].level, "warning");
    assert.equal(sentry.events[0].reason, "retranscribe-failed");
  });
});
