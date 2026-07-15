"use strict";

// SCRUM-550: focused post-call update that overwrites the transcript with the
// accurate Deepgram version, preserves Gemini's original in raw_transcript, and
// stamps transcript_source='deepgram'. Structured fields follow the existing
// convention: summary/caller_name/collected_data/sentiment/cleaned_transcript
// are columns; successEvaluation + unansweredQuestions are merged onto the
// caller-supplied priorMetadata (no second SELECT — state.selected pins that we
// never re-read, so a failed re-read can't wipe accumulated keys). getSupabase is
// stubbed via require.cache (same idiom as call-logger-metadata.test.js).

const test = require("node:test");
const assert = require("node:assert/strict");

const state = { updates: [], existingMetadata: {}, updateError: null, selected: false };

const mockSupabase = {
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => {
          state.selected = true;
          return { data: { metadata: state.existingMetadata }, error: null };
        },
      }),
    }),
    update: (payload) => {
      const entry = { payload };
      state.updates.push(entry);
      return {
        eq: async (_col, id) => {
          entry.id = id;
          return { error: state.updateError };
        },
      };
    },
  }),
};

const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { getSupabase: () => mockSupabase },
};

const { applyReanalysis } = require("../lib/call-logger");

function reset({ existingMetadata = {}, updateError = null } = {}) {
  state.updates = [];
  state.existingMetadata = existingMetadata;
  state.updateError = updateError;
  state.selected = false;
}

const ANALYSIS = {
  summary: "Caller booked a cleaning.",
  callerName: "John Smith",
  collectedData: { email: "j@x.com" },
  sentiment: "positive",
  successEvaluation: "successful",
  unansweredQuestions: ["Do you accept my insurance?"],
  cleanedTranscript: { turns: [{ role: "user", text: "hi" }] },
};

test("writes the transcript trio + display columns and merges analysis into priorMetadata (audit keys preserved)", async () => {
  reset();
  await applyReanalysis("call-1", {
    accurateTranscript: "User: hi\nAI: hello",
    priorTranscript: "User: gibberish\nAI: hello",
    priorMetadata: {
      voice_provider: "self_hosted",
      pipelineFailover: { to: "gpt" },
      consentReason: "two-party-state",
      callerState: "CA",
    },
    analysis: ANALYSIS,
  });
  assert.equal(state.updates.length, 1);
  const { payload, id } = state.updates[0];
  assert.equal(id, "call-1");
  assert.equal(payload.transcript, "User: hi\nAI: hello");
  assert.equal(payload.raw_transcript, "User: gibberish\nAI: hello");
  assert.equal(payload.transcript_source, "deepgram");
  assert.equal(payload.summary, "Caller booked a cleaning.");
  assert.equal(payload.caller_name, "John Smith");
  assert.deepEqual(payload.collected_data, { email: "j@x.com" });
  assert.equal(payload.sentiment, "positive");
  assert.deepEqual(payload.cleaned_transcript, { turns: [{ role: "user", text: "hi" }] });
  // consentReason/callerState (recording-consent audit trail) MUST survive the merge.
  assert.deepEqual(payload.metadata, {
    voice_provider: "self_hosted",
    pipelineFailover: { to: "gpt" },
    consentReason: "two-party-state",
    callerState: "CA",
    successEvaluation: "successful",
    unansweredQuestions: ["Do you accept my insurance?"],
  });
  // No second read — metadata comes from priorMetadata, never a SELECT.
  assert.equal(state.selected, false);
});

test("with null analysis writes ONLY the transcript trio (no display columns, no metadata read)", async () => {
  reset();
  await applyReanalysis("call-2", {
    accurateTranscript: "User: hi",
    priorTranscript: "User: h1",
    analysis: null,
  });
  assert.deepEqual(state.updates[0].payload, {
    transcript: "User: hi",
    raw_transcript: "User: h1",
    transcript_source: "deepgram",
  });
  assert.equal(state.selected, false);
});

test("throws on a DB update error", async () => {
  reset({ updateError: { message: "deadlock" } });
  await assert.rejects(
    () => applyReanalysis("call-3", { accurateTranscript: "User: hi", priorTranscript: null, analysis: null }),
    /applyReanalysis failed for call-3: deadlock/,
  );
});

test("preserves raw_transcript=null when there was no prior transcript", async () => {
  reset();
  await applyReanalysis("call-4", { accurateTranscript: "User: hi", priorTranscript: null, analysis: null });
  assert.equal(state.updates[0].payload.raw_transcript, null);
});

test("analysis without successEvaluation/unansweredQuestions leaves priorMetadata byte-for-byte (no key loss, no spurious add)", async () => {
  reset();
  await applyReanalysis("call-5", {
    accurateTranscript: "User: hi\nAI: hello",
    priorTranscript: null,
    priorMetadata: { voice_provider: "self_hosted", consentReason: "one-party", callerState: null },
    analysis: { summary: "s", sentiment: "neutral" },
  });
  assert.deepEqual(state.updates[0].payload.metadata, {
    voice_provider: "self_hosted",
    consentReason: "one-party",
    callerState: null,
  });
});
