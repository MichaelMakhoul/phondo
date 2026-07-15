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
  language: "en",
  metadata: { industry: "dental" },
};

function makeDeps(overrides = {}) {
  const captured = { applyReanalysis: null, transcribeArgs: null, lookup: null };
  const row = "row" in overrides ? overrides.row : { ...DEFAULT_ROW };
  const supabase = {
    from: () => ({
      select: () => ({
        eq: (col, val) => {
          captured.lookup = { col, val };
          return {
            single: async () => {
              if (overrides.selectThrows) throw overrides.selectThrows;
              return { data: row, error: overrides.selectError || null };
            },
          };
        },
      }),
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
    applyReanalysis: async (callId, fields) => {
      captured.applyReanalysis = { callId, fields };
    },
    Sentry: sentry,
    deepgramApiKey: "deepgramApiKey" in overrides ? overrides.deepgramApiKey : "KEY",
    retranscribeEnabled: "retranscribeEnabled" in overrides ? overrides.retranscribeEnabled : true,
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
    assert.deepEqual(captured.applyReanalysis.fields.priorMetadata, { industry: "dental" });
    assert.deepEqual(captured.applyReanalysis.fields.analysis, { summary: "s", sentiment: "neutral" });
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

  it("skips (no page, no write) an unsupported language — keeps Gemini's transcript AND analysis", async () => {
    const { deps, captured, sentry } = makeDeps({ row: { ...DEFAULT_ROW, language: "ar" } });
    const res = await handleRetranscribe({ callId: "c1", deps });
    assert.equal(res.reason, "unsupported-language");
    assert.equal(res.retranscribed, false);
    assert.equal(captured.applyReanalysis, null);
    // An expected skip (Deepgram Nova-3 supports only en/es), not a failure — no page.
    assert.equal(sentry.events.length, 0);
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
