"use strict";

/**
 * SCRUM-588 — the classic pipeline's FULL request bodies for every provider
 * (openai default + the gpt-6-luna lever, anthropic, gemini) × stream × tools.
 * server.js only ever calls streamChatResponse, so the streaming body is the
 * live one; the non-streaming path is pinned alongside so the two can't drift.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const ENV_KEYS = ["LLM_PROVIDER", "LLM_MODEL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = realFetch;
});
function freshWithEnv(modulePath, env) {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

const MESSAGES = [{ role: "system", content: "You are a receptionist." }, { role: "user", content: "When do you open?" }];
const TOOLS = [{ type: "function", function: { name: "check_availability", description: "d", parameters: { type: "object", properties: {} } } }];

const OPENAI_SSE = ['data: {"choices":[{"delta":{"content":"We open at nine."}}]}', "", "data: [DONE]", ""].join("\n");
const CLAUDE_SSE = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "We open at nine." } },
  { type: "message_stop" },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

function capture(sink, { streamBody, jsonBody }) {
  return async (_url, init) => {
    sink.body = JSON.parse(init.body);
    if (sink.body.stream === true) return new Response(streamBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    return { ok: true, status: 200, json: async () => jsonBody };
  };
}
async function call(llm, stream, options) {
  return stream ? llm.streamChatResponse(undefined, MESSAGES, options) : llm.getChatResponse(undefined, MESSAGES, options);
}

describe("classic LLM request bodies — streaming (the live path) and non-streaming", () => {
  for (const stream of [true, false]) {
    for (const withTools of [false, true]) {
      const label = `${stream ? "stream" : "non-stream"}, ${withTools ? "with" : "without"} tools`;
      const options = withTools ? { tools: TOOLS } : undefined;

      it(`openai gpt-4.1-mini (default), ${label}: full classic body`, async () => {
        const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "openai", LLM_MODEL: undefined, OPENAI_API_KEY: "k" });
        const sink = {};
        globalThis.fetch = capture(sink, { streamBody: OPENAI_SSE, jsonBody: { choices: [{ message: { content: "Nine." } }] } });
        await call(llm, stream, options);
        assert.equal(sink.body.model, "gpt-4.1-mini");
        assert.equal(sink.body.stream, stream, "stream flag must match the call path");
        assert.deepEqual(sink.body.messages, MESSAGES);
        assert.equal(sink.body.max_tokens, withTools ? 300 : 150);
        assert.equal(sink.body.reasoning_effort, undefined);
        assert.deepEqual(sink.body.tools, withTools ? TOOLS : undefined);
        assert.equal(sink.body.tool_choice, withTools ? "auto" : undefined);
      });

      it(`openai LLM_MODEL=gpt-6-luna, ${label}: reasoning body`, async () => {
        const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "openai", LLM_MODEL: "gpt-6-luna", OPENAI_API_KEY: "k" });
        const sink = {};
        globalThis.fetch = capture(sink, { streamBody: OPENAI_SSE, jsonBody: { choices: [{ message: { content: "Nine." } }] } });
        await call(llm, stream, options);
        assert.equal(sink.body.model, "gpt-6-luna");
        assert.equal(sink.body.stream, stream);
        assert.deepEqual(sink.body.messages, MESSAGES);
        assert.equal(sink.body.max_tokens, undefined);
        assert.equal(sink.body.max_completion_tokens, withTools ? 300 : 150);
        assert.equal(sink.body.reasoning_effort, "none");
        assert.deepEqual(sink.body.tools, withTools ? TOOLS : undefined);
      });

      it(`gemini default (gemini-3.5-flash), ${label}: classic body on the OpenAI-compatible endpoint`, async () => {
        const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "gemini", LLM_MODEL: undefined, GEMINI_API_KEY: "k" });
        const sink = {};
        globalThis.fetch = capture(sink, { streamBody: OPENAI_SSE, jsonBody: { choices: [{ message: { content: "Nine." } }] } });
        await call(llm, stream, options);
        assert.equal(sink.body.model, "gemini-3.5-flash");
        assert.equal(sink.body.stream, stream, "stream flag must match the call path");
        assert.deepEqual(sink.body.messages, MESSAGES);
        assert.equal(sink.body.max_tokens, withTools ? 300 : 150);
        assert.equal(sink.body.temperature, 0.7);
        assert.equal(sink.body.reasoning_effort, undefined);
        assert.equal(sink.body.max_completion_tokens, undefined);
        assert.deepEqual(sink.body.tools, withTools ? TOOLS : undefined);
        assert.equal(sink.body.tool_choice, withTools ? "auto" : undefined);
      });

      it(`anthropic default, ${label}: system + messages + thinking off`, async () => {
        const llm = freshWithEnv("../services/openai-llm", { LLM_PROVIDER: "anthropic", LLM_MODEL: undefined, ANTHROPIC_API_KEY: "k" });
        const sink = {};
        globalThis.fetch = capture(sink, { streamBody: CLAUDE_SSE, jsonBody: { content: [{ type: "text", text: "Nine." }] } });
        await call(llm, stream, options);
        assert.equal(sink.body.model, "claude-haiku-5-5");
        assert.equal(sink.body.stream, stream ? true : undefined, "stream flag must match the call path");
        assert.equal(sink.body.system, "You are a receptionist.");
        assert.deepEqual(sink.body.messages, [{ role: "user", content: "When do you open?" }]);
        assert.deepEqual(sink.body.thinking, { type: "disabled" });
        assert.equal(sink.body.temperature, undefined);
        assert.equal(sink.body.max_tokens, withTools ? 300 : 150);
        assert.equal(sink.body.tools?.[0]?.name, withTools ? "check_availability" : undefined);
      });
    }
  }
});
