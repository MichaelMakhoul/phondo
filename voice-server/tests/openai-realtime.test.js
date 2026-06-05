const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENAI_API_KEY = "test-key";
const { _test } = require("../services/openai-realtime");
const { toRealtimeTools, buildSessionConfig, createResponseGate, isBenignError } = _test;

// SCRUM-378: pure-config + state-machine tests for the OpenAI Realtime adapter (no network).
describe("toRealtimeTools (SCRUM-378)", () => {
  it("flattens Chat-style tool defs to the Realtime flat shape", () => {
    const out = toRealtimeTools([
      { type: "function", function: { name: "book_appointment", description: "books", parameters: { type: "object", properties: { datetime: { type: "string" } } } } },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "function");
    assert.equal(out[0].name, "book_appointment");
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

  it("sets create_response + interrupt_response EXPLICITLY (don't rely on defaults)", () => {
    const { session } = buildSessionConfig({ systemPrompt: "x", tools: [], language: "en" });
    assert.equal(session.audio.input.turn_detection.create_response, true);
    assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  });

  it("threads the language hint into input transcription (mapped to BCP-47)", () => {
    assert.equal(buildSessionConfig({ systemPrompt: "x", tools: [], language: "ar" }).session.audio.input.transcription.language, "ar");
    assert.equal(buildSessionConfig({ systemPrompt: "x", tools: [], language: "zz" }).session.audio.input.transcription.language, "en");
    assert.equal(buildSessionConfig({ systemPrompt: "x", tools: [] }).session.audio.input.transcription.language, "en");
  });
});

describe("isBenignError (SCRUM-378)", () => {
  it("treats recoverable Realtime error codes as benign (don't drop the call)", () => {
    assert.equal(isBenignError("conversation_already_has_active_response"), true);
    assert.equal(isBenignError("response_cancel_not_active"), true);
    assert.equal(isBenignError("input_audio_buffer_commit_empty"), true);
  });
  it("treats unknown/fatal codes as NOT benign", () => {
    assert.equal(isBenignError("server_error"), false);
    assert.equal(isBenignError(""), false);
    assert.equal(isBenignError(undefined), false);
  });
});

describe("createResponseGate (SCRUM-378) — never two active responses", () => {
  function mkGate() {
    let sends = 0;
    const gate = createResponseGate(() => { sends += 1; });
    return { gate, sends: () => sends };
  }

  it("sends on the first request, then marks pending until response.created", () => {
    const { gate, sends } = mkGate();
    assert.equal(gate.request(), true);
    assert.equal(sends(), 1);
    assert.deepEqual(gate.snapshot, { active: false, pending: true, queued: false });
  });

  it("QUEUES (no second send) when a request arrives while pending — the create→created race", () => {
    const { gate, sends } = mkGate();
    gate.request();                        // send #1, pending
    assert.equal(gate.request(), false);   // would collide → queue
    assert.equal(sends(), 1);
    assert.equal(gate.snapshot.queued, true);
  });

  it("QUEUES while a response is active, then flushes exactly once on done", () => {
    const { gate, sends } = mkGate();
    gate.request();   // send #1
    gate.created();   // active
    assert.deepEqual(gate.snapshot, { active: true, pending: false, queued: false });
    gate.request();   // active → queued (no send)
    assert.equal(sends(), 1);
    gate.done();      // response over
    assert.equal(gate.flushQueued(), true); // fires the queued one
    assert.equal(sends(), 2);
    assert.equal(gate.flushQueued(), false); // nothing left to flush
    assert.equal(sends(), 2);
  });

  it("a clean created→done cycle then a new request never collides", () => {
    const { gate, sends } = mkGate();
    gate.request(); gate.created(); gate.done(); // turn 1 complete
    assert.equal(gate.request(), true);          // turn 2 create allowed
    assert.equal(sends(), 2);
  });

  it("resync RE-QUEUES the rejected create so it re-fires on the next done (no lost turn)", () => {
    const { gate, sends } = mkGate();
    gate.request();   // our create (send #1)
    gate.resync();    // server rejected it (conversation_already_has_active_response) → active + re-queued
    assert.equal(gate.active, true);
    assert.equal(sends(), 1);
    gate.done();      // the real active response finished
    assert.equal(gate.flushQueued(), true); // our create re-fires — caller still gets the turn
    assert.equal(sends(), 2);
  });

  it("a direct fire clears a stale queued flag — no spurious 3rd create (P1 regression)", () => {
    const { gate, sends } = mkGate();
    gate.request(); gate.created();      // active, send #1
    gate.request();                      // queued while active (no send)
    assert.equal(sends(), 1);
    gate.done();                         // active=false, queued still set
    assert.equal(gate.request(), true);  // DIRECT fire (e.g. tool-followup path) → send #2, clears queued
    assert.equal(sends(), 2);
    gate.created(); gate.done();
    assert.equal(gate.flushQueued(), false); // queued was cleared → NO 3rd create
    assert.equal(sends(), 2);
  });

  it("flushQueued is a no-op while still busy", () => {
    const { gate, sends } = mkGate();
    gate.request(); gate.created(); gate.request(); // queued while active
    assert.equal(gate.flushQueued(), false);        // still active → don't fire
    assert.equal(sends(), 1);
  });
});
