const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENAI_API_KEY = "test-key";
const { _test } = require("../services/openai-realtime");
const { toRealtimeTools, buildSessionConfig } = _test;

// SCRUM-378: pure-config tests for the OpenAI Realtime adapter (no network).
describe("toRealtimeTools (SCRUM-378)", () => {
  it("flattens Chat-style tool defs to the Realtime flat shape", () => {
    const out = toRealtimeTools([
      { type: "function", function: { name: "book_appointment", description: "books", parameters: { type: "object", properties: { datetime: { type: "string" } } } } },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "function");
    assert.equal(out[0].name, "book_appointment");
    assert.equal(out[0].description, "books");
    assert.deepEqual(out[0].parameters, { type: "object", properties: { datetime: { type: "string" } } });
  });

  it("ignores non-function entries and handles junk", () => {
    assert.deepEqual(toRealtimeTools(null), []);
    assert.deepEqual(toRealtimeTools([{ type: "other" }, {}]), []);
  });
});

describe("buildSessionConfig (SCRUM-378)", () => {
  it("uses native μ-law in+out, far_field noise reduction, and a server VAD", () => {
    const { session } = buildSessionConfig({ systemPrompt: "hi", tools: [], voiceName: "marin", language: "en" });
    assert.equal(session.audio.input.format.type, "audio/pcmu");
    assert.equal(session.audio.output.format.type, "audio/pcmu");
    assert.equal(session.audio.input.noise_reduction.type, "far_field");
    assert.equal(session.audio.input.turn_detection.type, "server_vad");
    assert.equal(session.tool_choice, "auto");
    assert.equal(session.instructions, "hi");
  });

  it("threads the language hint into input transcription (mapped to BCP-47)", () => {
    assert.equal(buildSessionConfig({ systemPrompt: "x", tools: [], language: "ar" }).session.audio.input.transcription.language, "ar");
    assert.equal(buildSessionConfig({ systemPrompt: "x", tools: [], language: "en" }).session.audio.input.transcription.language, "en");
    // unknown/empty → default en
    assert.equal(buildSessionConfig({ systemPrompt: "x", tools: [], language: "zz" }).session.audio.input.transcription.language, "en");
    assert.equal(buildSessionConfig({ systemPrompt: "x", tools: [] }).session.audio.input.transcription.language, "en");
  });
});
