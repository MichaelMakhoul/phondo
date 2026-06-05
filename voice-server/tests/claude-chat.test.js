const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// claude-chat reads ANTHROPIC_API_KEY only inside streamClaudeResponse (not at
// load), and openai-llm needs a valid LLM_PROVIDER — default "openai" is valid.
const { _test } = require("../services/claude-chat");
const { makeStreamState, flushSentences, handleClaudeEvent, finalizeClaude } = _test;

// SCRUM-378: pure SSE-reducer tests for the Claude adapter (no network).
describe("flushSentences (SCRUM-378)", () => {
  it("emits complete sentences and keeps the trailing remainder", () => {
    const out = [];
    const rem = flushSentences("Hello there. How are", (s) => out.push(s));
    assert.deepEqual(out, ["Hello there."]);
    assert.equal(rem, "How are");
  });

  it("no onSentence → returns the buffer unchanged (collect-all mode)", () => {
    assert.equal(flushSentences("anything at all", undefined), "anything at all");
  });

  it("breaks on Arabic sentence punctuation too", () => {
    const out = [];
    flushSentences("مرحبا؟ كيف", (s) => out.push(s));
    assert.deepEqual(out, ["مرحبا؟"]);
  });
});

describe("handleClaudeEvent (SCRUM-378)", () => {
  it("accumulates text deltas and streams finished sentences", () => {
    const state = makeStreamState();
    const out = [];
    handleClaudeEvent(state, { type: "content_block_delta", delta: { type: "text_delta", text: "Hi there. " } }, (s) => out.push(s));
    assert.deepEqual(out, ["Hi there."]);
    assert.equal(state.fullContent, "Hi there. ");
  });

  it("assembles a streamed tool_use block from start + input_json deltas", () => {
    const state = makeStreamState();
    handleClaudeEvent(state, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "book_appointment" } });
    handleClaudeEvent(state, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"datetime":' } });
    handleClaudeEvent(state, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"2026-06-10T14:00"}' } });
    assert.equal(state.hasToolCalls, true);
    assert.equal(state.toolUses[0].name, "book_appointment");
    assert.equal(state.toolUses[0].arguments, '{"datetime":"2026-06-10T14:00"}');
  });

  it("throws on a server error event", () => {
    assert.throws(() => handleClaudeEvent(makeStreamState(), { type: "error", error: { message: "overloaded" } }), /overloaded/);
  });

  it("ignores junk/unknown events", () => {
    const state = makeStreamState();
    handleClaudeEvent(state, null);
    handleClaudeEvent(state, { type: "message_start" });
    assert.equal(state.fullContent, "");
    assert.equal(state.hasToolCalls, false);
  });
});

describe("finalizeClaude (SCRUM-378)", () => {
  it("returns OpenAI-compatible tool_calls when present", () => {
    const state = makeStreamState();
    state.hasToolCalls = true;
    state.toolUses = { 0: { id: "toolu_1", name: "check_availability", arguments: '{"date":"2026-06-10"}' } };
    const out = finalizeClaude(state);
    assert.equal(out.type, "tool_calls");
    assert.equal(out.toolCalls[0].type, "function");
    assert.equal(out.toolCalls[0].function.name, "check_availability");
    assert.equal(out.toolCalls[0].function.arguments, '{"date":"2026-06-10"}');
    assert.equal(out.message.role, "assistant");
    assert.equal(out.message.tool_calls.length, 1);
  });

  it("defaults empty tool arguments to {} so JSON.parse never throws downstream", () => {
    const state = makeStreamState();
    state.hasToolCalls = true;
    state.toolUses = { 0: { id: "t", name: "get_current_datetime", arguments: "" } };
    assert.equal(finalizeClaude(state).toolCalls[0].function.arguments, "{}");
  });

  it("returns content and flushes the final remainder sentence", () => {
    const state = makeStreamState();
    state.fullContent = "All done";
    state.textBuffer = "All done";
    const out = [];
    const res = finalizeClaude(state, (s) => out.push(s));
    assert.equal(res.type, "content");
    assert.equal(res.content, "All done");
    assert.deepEqual(out, ["All done"]);
  });

  it("throws when the stream produced no content at all", () => {
    assert.throws(() => finalizeClaude(makeStreamState()), /no content/);
  });
});
