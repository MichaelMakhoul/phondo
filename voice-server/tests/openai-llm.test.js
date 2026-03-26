const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Set env before import to avoid startup crash
process.env.LLM_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "test-key";

const { _test } = require("../services/openai-llm");
const { toAnthropicMessages, toAnthropicTools, parseAnthropicResponse, processSentenceBuffer } = _test;

// ─── toAnthropicMessages ─────────────────────────────────────────────────────

describe("toAnthropicMessages", () => {
  it("should extract system messages into separate system param", () => {
    const messages = [
      { role: "system", content: "You are a receptionist." },
      { role: "user", content: "Hello" },
    ];
    const { system, messages: converted } = toAnthropicMessages(messages);
    assert.equal(system, "You are a receptionist.");
    assert.equal(converted.length, 1);
    assert.equal(converted[0].role, "user");
  });

  it("should concatenate multiple system messages", () => {
    const messages = [
      { role: "system", content: "Rule 1." },
      { role: "system", content: "Rule 2." },
      { role: "user", content: "Hi" },
    ];
    const { system } = toAnthropicMessages(messages);
    assert.equal(system, "Rule 1.\n\nRule 2.");
  });

  it("should convert tool_calls to tool_use blocks", () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [
        { id: "tc1", function: { name: "check_availability", arguments: '{"date":"2026-03-25"}' } },
      ]},
    ];
    const { messages: converted } = toAnthropicMessages(messages);
    assert.equal(converted.length, 1);
    assert.equal(converted[0].role, "assistant");
    assert.equal(converted[0].content[0].type, "tool_use");
    assert.equal(converted[0].content[0].name, "check_availability");
    assert.deepEqual(converted[0].content[0].input, { date: "2026-03-25" });
  });

  it("should handle malformed tool call arguments gracefully", () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [
        { id: "tc1", function: { name: "test", arguments: "not-valid-json" } },
      ]},
    ];
    const { messages: converted } = toAnthropicMessages(messages);
    assert.deepEqual(converted[0].content[0].input, {});
  });

  it("should merge consecutive tool results into one user message", () => {
    const messages = [
      { role: "tool", tool_call_id: "tc1", content: "Result 1" },
      { role: "tool", tool_call_id: "tc2", content: "Result 2" },
    ];
    const { messages: converted } = toAnthropicMessages(messages);
    assert.equal(converted.length, 1);
    assert.equal(converted[0].role, "user");
    assert.equal(converted[0].content.length, 2);
    assert.equal(converted[0].content[0].type, "tool_result");
    assert.equal(converted[0].content[0].tool_use_id, "tc1");
    assert.equal(converted[0].content[1].tool_use_id, "tc2");
  });

  it("should not merge non-consecutive tool results", () => {
    const messages = [
      { role: "tool", tool_call_id: "tc1", content: "Result 1" },
      { role: "assistant", content: "Processing..." },
      { role: "tool", tool_call_id: "tc2", content: "Result 2" },
    ];
    const { messages: converted } = toAnthropicMessages(messages);
    assert.equal(converted.length, 3);
  });

  it("should pass through regular user/assistant messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const { system, messages: converted } = toAnthropicMessages(messages);
    assert.equal(system, "");
    assert.equal(converted.length, 2);
    assert.equal(converted[0].content, "Hello");
    assert.equal(converted[1].content, "Hi there!");
  });
});

// ─── toAnthropicTools ────────────────────────────────────────────────────────

describe("toAnthropicTools", () => {
  it("should convert OpenAI tool format to Anthropic format", () => {
    const tools = [
      { type: "function", function: { name: "check_availability", description: "Check slots", parameters: { type: "object", properties: { date: { type: "string" } } } } },
    ];
    const result = toAnthropicTools(tools);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "check_availability");
    assert.equal(result[0].description, "Check slots");
    assert.ok(result[0].input_schema);
  });

  it("should return undefined for empty tools", () => {
    assert.equal(toAnthropicTools([]), undefined);
    assert.equal(toAnthropicTools(null), undefined);
    assert.equal(toAnthropicTools(undefined), undefined);
  });
});

// ─── parseAnthropicResponse ──────────────────────────────────────────────────

describe("parseAnthropicResponse", () => {
  it("should parse text content", () => {
    const data = { content: [{ type: "text", text: "Hello!" }], stop_reason: "end_turn" };
    const result = parseAnthropicResponse(data);
    assert.equal(result.type, "content");
    assert.equal(result.content, "Hello!");
  });

  it("should parse tool_use blocks", () => {
    const data = { content: [
      { type: "tool_use", id: "tu1", name: "book_appointment", input: { date: "2026-03-26" } },
    ]};
    const result = parseAnthropicResponse(data);
    assert.equal(result.type, "tool_calls");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, "book_appointment");
    assert.equal(JSON.parse(result.toolCalls[0].function.arguments).date, "2026-03-26");
  });

  it("should handle mixed text + tool_use blocks", () => {
    const data = { content: [
      { type: "text", text: "Let me check..." },
      { type: "tool_use", id: "tu1", name: "check_availability", input: {} },
    ]};
    const result = parseAnthropicResponse(data);
    assert.equal(result.type, "tool_calls");
    assert.ok(result.message.content); // text is preserved
  });

  it("should throw on empty content", () => {
    assert.throws(() => parseAnthropicResponse({ content: [], stop_reason: "end_turn" }));
  });
});

// ─── processSentenceBuffer ───────────────────────────────────────────────────

describe("processSentenceBuffer", () => {
  it("should split on sentence boundaries when first chunk is long enough", () => {
    const sentences = [];
    const remaining = processSentenceBuffer(
      "I'd be happy to help you with that appointment today. What time would work best for you? ",
      (s) => sentences.push(s)
    );
    // First sentence is 52 chars (>30 threshold), should split
    assert.ok(sentences.length >= 1);
    assert.ok(sentences[0].includes("appointment today"));
  });

  it("should not split very short first sentences (under 30 chars)", () => {
    const sentences = [];
    const remaining = processSentenceBuffer(
      "Sure. I can help with that appointment.",
      (s) => sentences.push(s)
    );
    // "Sure." is only 5 chars — should be batched with next sentence
    // The whole thing is only 39 chars total, under 100 threshold
    assert.equal(sentences.length, 0);
    assert.ok(remaining.length > 0);
  });

  it("should flush long enough sentences", () => {
    const sentences = [];
    const remaining = processSentenceBuffer(
      "I'd be happy to help you schedule an appointment for tomorrow morning. What time works best for you? ",
      (s) => sentences.push(s)
    );
    assert.ok(sentences.length >= 1);
  });

  it("should return remaining text without sentence boundary", () => {
    const sentences = [];
    const remaining = processSentenceBuffer("Hello there, how are", (s) => sentences.push(s));
    assert.equal(sentences.length, 0);
    assert.equal(remaining, "Hello there, how are");
  });

  it("should work with null onSentence callback", () => {
    const remaining = processSentenceBuffer("Hello. World.", null);
    assert.equal(remaining, "Hello. World.");
  });
});
