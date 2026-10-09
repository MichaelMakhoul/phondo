"use strict";

/**
 * SCRUM-588 — model defaults and their env revert levers.
 *
 * Every module below reads its model env var at LOAD time, so each case sets
 * the env, re-requires the module fresh, and asserts the model (and the
 * request shape that model needs) on the wire via a capturing fetch. A lever
 * that silently stopped being read — or a body that only works for one of
 * the two models — fails here instead of on the night someone pulls it.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const ENV_KEYS = [
  "ANALYSIS_MODEL", "VALIDATOR_MODEL", "LLM_PROVIDER", "LLM_MODEL", "CR_LLM_MODEL",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
});

/** Set (string) / clear (undefined) env vars, then require the module fresh. */
function freshWithEnv(modulePath, env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

const CLAUDE_TEXT_SSE = [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "We open at nine." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

// ─── ANALYSIS_MODEL (post-call-analysis.js) ─────────────────────────────────

describe("ANALYSIS_MODEL — post-call analysis, cleanup and judge", () => {
  const ENGLISH = "User: Hi, I'd like a check-up on Tuesday.\nAI: Booked for 9:30 Tuesday with Dr Patel.";
  const GARBLED = "User: 안녕하세요 I'd like to book.\nAI: Sure, what day suits you?";

  function captureOpenAI(bodies) {
    return async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const system = body.messages[0].content;
      const obj = system.includes("compare two transcripts")
        ? { content_loss: false, note: "" }
        : system.includes("normalising a phone call transcript")
          ? { turns: [{ role: "user", text: "hi" }] }
          : { summary: "Booked a check-up.", sentiment: "neutral" };
      return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(obj) } }] }) };
    };
  }

  async function runAllThreeCalls(mod) {
    await mod.analyzeCallTranscript(ENGLISH, { language: "en" }); // structured + cleanup
    await mod.analyzeCallTranscript(GARBLED, { language: "en" }); // structured + GARBLED cleanup route
    await mod.judgeTranscriptContentLoss(ENGLISH, ENGLISH);
  }

  it("default: every call goes to gpt-6-luna with the reasoning-model request shape", async () => {
    const mod = freshWithEnv("../services/post-call-analysis", { OPENAI_API_KEY: "test-key", ANALYSIS_MODEL: undefined });
    const bodies = [];
    globalThis.fetch = captureOpenAI(bodies);
    await runAllThreeCalls(mod);
    assert.equal(bodies.length, 5, "structured×2 + cleanup×2 + judge");
    for (const b of bodies) {
      assert.equal(b.model, "gpt-6-luna");
      assert.equal(b.max_tokens, undefined, "gpt-6-luna 400s on max_tokens");
      assert.equal(typeof b.max_completion_tokens, "number");
      assert.equal(b.reasoning_effort, "none", "hidden reasoning tokens would eat the cap and empty `content`");
      assert.equal(b.temperature, 0.1, "accepted at reasoning_effort none (probed)");
      assert.deepEqual(b.response_format, { type: "json_object" });
    }
  });

  it("ANALYSIS_MODEL=gpt-4.1-mini reverts ALL calls — including the garbled route — to the classic shape", async () => {
    const mod = freshWithEnv("../services/post-call-analysis", { OPENAI_API_KEY: "test-key", ANALYSIS_MODEL: "gpt-4.1-mini" });
    const bodies = [];
    globalThis.fetch = captureOpenAI(bodies);
    await runAllThreeCalls(mod);
    assert.equal(bodies.length, 5);
    for (const b of bodies) {
      assert.equal(b.model, "gpt-4.1-mini");
      assert.equal(typeof b.max_tokens, "number");
      assert.equal(b.max_completion_tokens, undefined);
      assert.equal(b.reasoning_effort, undefined, "gpt-4.1-mini 400s on reasoning_effort (probed)");
      assert.equal(b.temperature, 0.1);
    }
  });
});

// ─── VALIDATOR_MODEL (turn-validator.js) ────────────────────────────────────

describe("VALIDATOR_MODEL — mid-call Tier-2 validator", () => {
  const ARGS = {
    toolName: "book_appointment",
    toolResult: "Booked: Tuesday 13 October 9:30am with Dr Patel.",
    spokenResponse: "You're booked for 10am Wednesday with Dr Smith.",
  };

  function captureAnthropic(capture, content, stopReason = "end_turn") {
    return async (_url, init) => {
      capture.body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ content, stop_reason: stopReason }) };
    };
  }

  it("default: claude-haiku-5-5, thinking disabled, no sampling params, 300-token cap", async () => {
    const { validateToolResponse } = freshWithEnv("../services/turn-validator", { ANTHROPIC_API_KEY: "test-key", VALIDATOR_MODEL: undefined });
    const capture = {};
    globalThis.fetch = captureAnthropic(capture, [{ type: "text", text: '{"accurate": true}' }]);
    assert.deepEqual(await validateToolResponse(ARGS), { accurate: true });
    assert.equal(capture.body.model, "claude-haiku-5-5");
    assert.deepEqual(capture.body.thinking, { type: "disabled" });
    assert.equal(capture.body.temperature, undefined, "Haiku 5.5 400s on temperature");
    assert.equal(capture.body.max_tokens, 300);
  });

  it("VALIDATOR_MODEL=claude-haiku-4-5-20251001 reverts with a request 4.5 accepts", async () => {
    const { validateToolResponse } = freshWithEnv("../services/turn-validator", { ANTHROPIC_API_KEY: "test-key", VALIDATOR_MODEL: "claude-haiku-4-5-20251001" });
    const capture = {};
    globalThis.fetch = captureAnthropic(capture, [{ type: "text", text: '{"accurate": true}' }]);
    await validateToolResponse(ARGS);
    assert.equal(capture.body.model, "claude-haiku-4-5-20251001");
    assert.deepEqual(capture.body.thinking, { type: "disabled" });
  });

  it("a leading thinking block does NOT turn a mismatch into a pass (the silent-off failure)", async () => {
    const { validateToolResponse } = freshWithEnv("../services/turn-validator", { ANTHROPIC_API_KEY: "test-key", VALIDATOR_MODEL: undefined });
    globalThis.fetch = captureAnthropic({}, [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: '{"accurate": false, "discrepancy": "time is 9:30 not 10am"}' },
    ]);
    assert.deepEqual(await validateToolResponse(ARGS), { accurate: false, discrepancy: "time is 9:30 not 10am" });
  });

  it("no text block at all: fails open, and the 3rd in a row raises an [ALERT:error] (the level Grafana pages on)", async (t) => {
    const { validateToolResponse } = freshWithEnv("../services/turn-validator", { ANTHROPIC_API_KEY: "test-key", VALIDATOR_MODEL: undefined });
    const warn = t.mock.method(console, "warn", () => {});
    const error = t.mock.method(console, "error", () => {});
    const alertLines = () =>
      [...warn.mock.calls, ...error.mock.calls].map((c) => String(c.arguments[0])).filter((l) => l.startsWith("[ALERT:"));
    globalThis.fetch = captureAnthropic({}, [{ type: "thinking", thinking: "", signature: "sig" }], "max_tokens");
    for (let i = 0; i < 2; i++) assert.deepEqual(await validateToolResponse(ARGS), { accurate: true });
    assert.equal(alertLines().length, 0, "one or two unreadable verdicts are a blip, not an outage");
    assert.ok(
      warn.mock.calls.some((c) => /No usable verdict \(.*model=claude-haiku-5-5.*stop_reason=max_tokens/.test(String(c.arguments[0]))),
      "every unreadable verdict still leaves a trace with the model and stop_reason"
    );
    assert.deepEqual(await validateToolResponse(ARGS), { accurate: true });
    const [line] = alertLines();
    assert.match(line, /^\[ALERT:error\] \[tier2_validator\] Tier-2 validator producing no verdicts \(3 unreadable in a row\) — validation OFF/);
    assert.match(line, /model=claude-haiku-5-5/);
    assert.match(line, /stop_reason=max_tokens/);
  });
});

// ─── LLM_PROVIDER / LLM_MODEL (openai-llm.js, classic fallback pipeline) ─────

describe("LLM_MODEL — classic pipeline defaults per provider", () => {
  const MESSAGES = [{ role: "system", content: "You are a receptionist." }, { role: "user", content: "When do you open?" }];
  const TOOLS = [{ type: "function", function: { name: "check_availability", description: "d", parameters: { type: "object", properties: {} } } }];

  function captureJson(capture, responseBody) {
    return async (_url, init) => {
      capture.body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => responseBody };
    };
  }

  it("anthropic default is claude-haiku-5-5: thinking disabled, no temperature (non-streaming)", async () => {
    const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "anthropic", LLM_MODEL: undefined, ANTHROPIC_API_KEY: "test-key" });
    assert.equal(llm.DEFAULT_MODEL, "claude-haiku-5-5");
    const capture = {};
    globalThis.fetch = captureJson(capture, { content: [{ type: "text", text: "Nine." }], stop_reason: "end_turn" });
    assert.deepEqual(await llm.getChatResponse(undefined, MESSAGES), { type: "content", content: "Nine." });
    assert.equal(capture.body.model, "claude-haiku-5-5");
    assert.deepEqual(capture.body.thinking, { type: "disabled" });
    assert.equal(capture.body.temperature, undefined, "Haiku 5.5 400s on temperature (probed)");
    assert.equal(capture.body.max_tokens, 150);
  });

  it("anthropic streaming turn with tools: same knobs, stream on, tools converted", async () => {
    const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "anthropic", LLM_MODEL: undefined, ANTHROPIC_API_KEY: "test-key" });
    let body;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(CLAUDE_TEXT_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const result = await llm.streamChatResponse(undefined, MESSAGES, { tools: TOOLS });
    assert.equal(result.content, "We open at nine.");
    assert.equal(body.stream, true);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, 300);
    assert.equal(body.tools[0].name, "check_availability");
  });

  it("LLM_MODEL=claude-haiku-4-5-20251001 reverts the anthropic provider", async () => {
    const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-haiku-4-5-20251001", ANTHROPIC_API_KEY: "test-key" });
    assert.equal(llm.DEFAULT_MODEL, "claude-haiku-4-5-20251001");
    const capture = {};
    globalThis.fetch = captureJson(capture, { content: [{ type: "text", text: "Nine." }] });
    await llm.getChatResponse(undefined, MESSAGES);
    assert.equal(capture.body.model, "claude-haiku-4-5-20251001");
    assert.deepEqual(capture.body.thinking, { type: "disabled" }, "accepted by Haiku 4.5 (probed)");
  });

  it("openai default stays gpt-4.1-mini with the classic shape (gpt-6-luna lost the TTFT bar)", async () => {
    const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "openai", LLM_MODEL: undefined, OPENAI_API_KEY: "test-key" });
    assert.equal(llm.DEFAULT_MODEL, "gpt-4.1-mini");
    const capture = {};
    globalThis.fetch = captureJson(capture, { choices: [{ message: { content: "Nine." } }] });
    await llm.getChatResponse(undefined, MESSAGES);
    assert.equal(capture.body.max_tokens, 150);
    assert.equal(capture.body.temperature, 0.7);
    assert.equal(capture.body.reasoning_effort, undefined);
  });

  it("LLM_MODEL=gpt-6-luna gets the reasoning shape — tools only work at reasoning_effort none", async () => {
    const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "openai", LLM_MODEL: "gpt-6-luna", OPENAI_API_KEY: "test-key" });
    const capture = {};
    globalThis.fetch = captureJson(capture, { choices: [{ message: { content: "Nine." } }] });
    await llm.getChatResponse(undefined, MESSAGES, { tools: TOOLS });
    assert.equal(capture.body.model, "gpt-6-luna");
    assert.equal(capture.body.max_tokens, undefined);
    assert.equal(capture.body.max_completion_tokens, 300);
    assert.equal(capture.body.reasoning_effort, "none");
    assert.equal(capture.body.tool_choice, "auto");
  });

  it("gemini default stays gemini-3.5-flash with the classic shape (3.8-flash lost the TTFT bar)", async () => {
    const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "gemini", LLM_MODEL: undefined, GEMINI_API_KEY: "test-key" });
    assert.equal(llm.DEFAULT_MODEL, "gemini-3.5-flash");
    const capture = {};
    globalThis.fetch = captureJson(capture, { choices: [{ message: { content: "Nine." } }] });
    await llm.getChatResponse(undefined, MESSAGES);
    assert.equal(capture.body.max_tokens, 150);
    assert.equal(capture.body.reasoning_effort, undefined);
  });
});

// ─── CR_LLM_MODEL (claude-chat.js, ConversationRelay test pipeline) ─────────

describe("CR_LLM_MODEL — ConversationRelay test pipeline", () => {
  function captureStream(capture) {
    return async (_url, init) => {
      capture.body = JSON.parse(init.body);
      return new Response(CLAUDE_TEXT_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  }

  it("default claude-haiku-5-5: thinking disabled, no temperature (it 400s)", async () => {
    const chat = freshWithEnv("../services/claude-chat", { CR_LLM_MODEL: undefined, ANTHROPIC_API_KEY: "test-key" });
    assert.equal(chat.CR_LLM_MODEL, "claude-haiku-5-5");
    const capture = {};
    globalThis.fetch = captureStream(capture);
    const result = await chat.streamClaudeResponse([{ role: "user", content: "hi" }]);
    assert.equal(result.content, "We open at nine.");
    assert.equal(capture.body.model, "claude-haiku-5-5");
    assert.deepEqual(capture.body.thinking, { type: "disabled" });
    assert.equal(capture.body.temperature, undefined);
  });

  it("CR_LLM_MODEL=claude-haiku-4-5-20251001 (the revert) gets thinking disabled, no temperature, and a full body", async () => {
    const chat = freshWithEnv("../services/claude-chat", { CR_LLM_MODEL: "claude-haiku-4-5-20251001", ANTHROPIC_API_KEY: "test-key" });
    const capture = {};
    globalThis.fetch = captureStream(capture);
    await chat.streamClaudeResponse([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    assert.equal(capture.body.model, "claude-haiku-4-5-20251001");
    assert.deepEqual(capture.body.thinking, { type: "disabled" });
    assert.equal(capture.body.temperature, undefined);
    assert.equal(capture.body.stream, true);
    assert.equal(capture.body.system, "sys");
    assert.deepEqual(capture.body.messages, [{ role: "user", content: "hi" }]);
  });

  it("a tier swap (CR_LLM_MODEL=claude-sonnet-5-5) sends neither knob, so it never 400s", async () => {
    const chat = freshWithEnv("../services/claude-chat", { CR_LLM_MODEL: "claude-sonnet-5-5", ANTHROPIC_API_KEY: "test-key" });
    const capture = {};
    globalThis.fetch = captureStream(capture);
    await chat.streamClaudeResponse([{ role: "user", content: "hi" }]);
    assert.equal(capture.body.model, "claude-sonnet-5-5");
    assert.equal(capture.body.thinking, undefined);
    assert.equal(capture.body.temperature, undefined);
  });
});
