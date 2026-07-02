const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENAI_API_KEY = "test-key"; // keep parity with openai-realtime.test.js require-time env
const { createGrokRealtimeSession, _test } = require("../services/openai-realtime");
const { buildGrokSessionConfig, buildSessionConfig, createInputTranscriptTracker, PROVIDERS } = _test;
const { resolveTestPipeline } = require("../lib/pipeline-routing");

// SCRUM-378: Grok (xAI) rides the same battle-tested Realtime adapter as OpenAI.
// These tests pin down the Grok-SPECIFIC surface: the xAI session.update schema,
// provider URL/key resolution, and the cumulative-transcript tracker.

describe("buildGrokSessionConfig (SCRUM-378)", () => {
  it("uses native μ-law in+out at an explicit 8 kHz (xAI formats carry a rate)", () => {
    const { session } = buildGrokSessionConfig({ systemPrompt: "hi", tools: [], voiceName: "eve", language: "en" });
    assert.deepEqual(session.audio.input.format, { type: "audio/pcmu", rate: 8000 });
    assert.deepEqual(session.audio.output.format, { type: "audio/pcmu", rate: 8000 });
    assert.equal(session.instructions, "hi");
    assert.equal(session.tool_choice, "auto");
  });

  it("puts voice at the session top level (xAI schema) and defaults to eve", () => {
    assert.equal(buildGrokSessionConfig({ systemPrompt: "x", tools: [] }).session.voice, "eve");
    assert.equal(buildGrokSessionConfig({ systemPrompt: "x", tools: [], voiceName: "rex" }).session.voice, "rex");
    // and NOT nested under audio.output like OpenAI's
    assert.equal(buildGrokSessionConfig({ systemPrompt: "x", tools: [] }).session.audio.output.voice, undefined);
  });

  it("puts server VAD at the session top level WITHOUT OpenAI-only subfields", () => {
    const { session } = buildGrokSessionConfig({ systemPrompt: "x", tools: [] });
    assert.equal(session.turn_detection.type, "server_vad");
    // create_response/interrupt_response are OpenAI fields not documented by
    // xAI — sending them risks an unknown-parameter error on session.update.
    assert.equal("create_response" in session.turn_detection, false);
    assert.equal("interrupt_response" in session.turn_detection, false);
    assert.equal(session.audio.input.turn_detection, undefined);
  });

  it("uses xAI's language_hint (BCP-47) — no transcription model, no noise_reduction", () => {
    assert.equal(buildGrokSessionConfig({ systemPrompt: "x", tools: [], language: "ar" }).session.audio.input.transcription.language_hint, "ar");
    assert.equal(buildGrokSessionConfig({ systemPrompt: "x", tools: [], language: "zz" }).session.audio.input.transcription.language_hint, "en");
    assert.equal(buildGrokSessionConfig({ systemPrompt: "x", tools: [] }).session.audio.input.transcription.language_hint, "en");
    const { session } = buildGrokSessionConfig({ systemPrompt: "x", tools: [], language: "en" });
    assert.equal(session.audio.input.transcription.model, undefined);
    assert.equal(session.audio.input.noise_reduction, undefined);
  });

  it("flattens Chat-style tools exactly like the OpenAI config does", () => {
    const tools = [{ type: "function", function: { name: "book_appointment", description: "books", parameters: { type: "object", properties: {} } } }];
    assert.deepEqual(
      buildGrokSessionConfig({ systemPrompt: "x", tools }).session.tools,
      buildSessionConfig({ systemPrompt: "x", tools }).session.tools,
    );
  });
});

describe("PROVIDERS (SCRUM-378) — per-provider URL/key resolution", () => {
  it("grok targets api.x.ai with grok-voice-think-fast-1.0 by default", () => {
    const url = PROVIDERS.grok.url();
    assert.ok(url.startsWith("wss://api.x.ai/v1/realtime?model="), url);
    assert.ok(url.includes("grok-voice-think-fast-1.0"), url);
    assert.equal(PROVIDERS.grok.apiKeyEnv, "XAI_API_KEY");
  });

  it("GROK_REALTIME_MODEL overrides the model at CALL time (no restart needed)", () => {
    process.env.GROK_REALTIME_MODEL = "grok-voice-latest";
    try {
      assert.ok(PROVIDERS.grok.url().includes("model=grok-voice-latest"));
    } finally {
      delete process.env.GROK_REALTIME_MODEL;
    }
    assert.ok(PROVIDERS.grok.url().includes("grok-voice-think-fast-1.0"));
  });

  it("openai provider is unchanged: api.openai.com + gpt-realtime-2 default", () => {
    const url = PROVIDERS.openai.url();
    assert.ok(url.startsWith("wss://api.openai.com/v1/realtime?model="), url);
    assert.ok(url.includes("gpt-realtime-2"), url);
    assert.equal(PROVIDERS.openai.apiKeyEnv, "OPENAI_API_KEY");
  });

  it("createGrokRealtimeSession throws BEFORE opening a socket when XAI_API_KEY is missing", () => {
    delete process.env.XAI_API_KEY;
    assert.throws(() => createGrokRealtimeSession({ systemPrompt: "x", tools: [] }, {}), /XAI_API_KEY/);
  });
});

describe("resolveTestPipeline accepts grok-realtime (SCRUM-378)", () => {
  it("routes a dedicated test number to grok-realtime, leaving others null", () => {
    const overrides = "+61400000000:openai-realtime,+61400000002:grok-realtime";
    assert.equal(resolveTestPipeline("+61400000002", overrides), "grok-realtime");
    assert.equal(resolveTestPipeline("+61400000000", overrides), "openai-realtime");
    assert.equal(resolveTestPipeline("+61499999999", overrides), null);
  });
});

describe("createInputTranscriptTracker (SCRUM-378) — one commit per utterance", () => {
  function mkTracker() {
    const commits = [];
    const t = createInputTranscriptTracker((text) => commits.push(text));
    return { t, commits };
  }

  it("OpenAI style: terminal .completed commits once, empty transcript never commits", () => {
    const { t, commits } = mkTracker();
    t.completed("item_1", "book me in for Tuesday");
    t.completed("item_2", "");
    t.completed("item_3", undefined);
    assert.deepEqual(commits, ["book me in for Tuesday"]);
  });

  it("Grok style: cumulative .updated snapshots commit ONCE (newest wins) on flush", () => {
    const { t, commits } = mkTracker();
    t.updated("item_1", "book");
    t.updated("item_1", "book me in");
    t.updated("item_1", "book me in for Tuesday");
    t.flush(); // response.created — the utterance is over
    t.flush(); // idempotent
    assert.deepEqual(commits, ["book me in for Tuesday"]);
  });

  it("a late .completed for an utterance already flushed is skipped (no double commit)", () => {
    const { t, commits } = mkTracker();
    t.updated("item_1", "hello");
    t.flush();
    t.completed("item_1", "hello there"); // late terminal refinement — already committed provisionally
    assert.deepEqual(commits, ["hello"]);
    // …and the skip is one-shot: a NEW utterance with a new id still commits.
    t.completed("item_2", "second utterance");
    assert.deepEqual(commits, ["hello", "second utterance"]);
  });

  it(".completed for the utterance currently held provisionally supersedes it", () => {
    const { t, commits } = mkTracker();
    t.updated("item_1", "boo");
    t.completed("item_1", "book me in"); // terminal arrives before any flush
    t.flush(); // must NOT re-commit the stale provisional
    assert.deepEqual(commits, ["book me in"]);
  });

  it("late .updated for an already-flushed utterance never re-commits it", () => {
    const { t, commits } = mkTracker();
    t.updated("item_1", "hi");
    t.flush();
    t.updated("item_1", "hi there"); // refinement after commit — dropped
    t.flush();
    assert.deepEqual(commits, ["hi"]);
  });

  it("two utterances in sequence each commit exactly once", () => {
    const { t, commits } = mkTracker();
    t.updated("item_1", "first");
    t.flush();
    t.updated("item_2", "second");
    t.flush();
    assert.deepEqual(commits, ["first", "second"]);
  });

  it("id-less events fall back to exact-text dedup (flush then same-text .completed)", () => {
    const { t, commits } = mkTracker();
    t.updated(null, "hi");
    t.flush();
    t.completed(null, "hi"); // same utterance, no id to match on — text dedup catches it
    t.completed(null, "a different thing"); // genuinely new text still commits
    assert.deepEqual(commits, ["hi", "a different thing"]);
  });
});
