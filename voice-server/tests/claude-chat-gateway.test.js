const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { streamClaudeResponse } = require("../services/claude-chat");
const { gatewayRefusal, _test: gatewayTest } = require("../lib/anthropic-gateway");

// SCRUM-594: the fast path's Claude requests follow ANTHROPIC_GATEWAY (lib/anthropic-gateway.js).
const ENV_KEYS = ["ANTHROPIC_GATEWAY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
  gatewayTest.resetRefusal();
});

function setEnv(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

/** An Anthropic Messages stream that says `text`. */
function sse(text) {
  const events = [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "claude-haiku-5-5", stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** Records each request and answers with `respond()`. */
function stubFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return calls;
}

const MESSAGES = [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }];

describe("streamClaudeResponse and ANTHROPIC_GATEWAY (SCRUM-594)", () => {
  it("openrouter: one request to OpenRouter with its bearer key, Haiku 5.5 pinned to Anthropic, and the reply streams as before", async () => {
    setEnv({ ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "sk-or-test", ANTHROPIC_API_KEY: "sk-ant-test" });
    const calls = stubFetch(() => new Response(sse("Hi there."), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const said = [];
    const out = await streamClaudeResponse(MESSAGES, { model: "claude-haiku-5-5", onSentence: (s) => said.push(s) });
    assert.deepEqual(out, { type: "content", content: "Hi there." });
    assert.deepEqual(said, ["Hi there."]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/messages");
    assert.equal(calls[0].init.headers.authorization, "Bearer sk-or-test");
    assert.ok(!("x-api-key" in calls[0].init.headers));
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "anthropic/claude-haiku-5.5");
    assert.deepEqual(body.provider, { only: ["anthropic"], allow_fallbacks: false });
    assert.equal(body.stream, true);
    assert.equal(body.system, "Be brief.");
  });

  it("default: api.anthropic.com with the Anthropic key, as before", async () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const calls = stubFetch(() => new Response(sse("Hello."), { status: 200 }));
    assert.deepEqual(await streamClaudeResponse(MESSAGES, { model: "claude-haiku-5-5" }), { type: "content", content: "Hello." });
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0].init.headers["x-api-key"], "sk-ant-test");
    assert.equal(JSON.parse(calls[0].init.body).model, "claude-haiku-5-5");
  });

  it("openrouter: another model is refused before anything is sent", async () => {
    setEnv({ ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "sk-or-test" });
    const calls = stubFetch(() => new Response(sse("x"), { status: 200 }));
    await assert.rejects(streamClaudeResponse(MESSAGES, { model: "claude-sonnet-5-5" }), /claude-sonnet-5-5 may not be sent through OpenRouter/);
    assert.equal(calls.length, 0);
  });

  it("openrouter without its key: refused before anything is sent", async () => {
    setEnv({ ANTHROPIC_GATEWAY: "openrouter", ANTHROPIC_API_KEY: "sk-ant-test" });
    const calls = stubFetch(() => new Response(sse("x"), { status: 200 }));
    await assert.rejects(streamClaudeResponse(MESSAGES, { model: "claude-haiku-5-5" }), /OPENROUTER_API_KEY not set/);
    assert.equal(calls.length, 0);
  });

  it("an OpenRouter error names the gateway, and its code when there is no type (the $5 cap: 402)", async () => {
    setEnv({ ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "sk-or-test" });
    stubFetch(() => new Response(JSON.stringify({ error: { code: 402, message: "Key limit exceeded" } }), { status: 402 }));
    await assert.rejects(streamClaudeResponse(MESSAGES, { model: "claude-haiku-5-5" }), /^Error: Anthropic API error 402 via OpenRouter \(402: Key limit exceeded\)$/);
  });

  it("a spent cap latches the refusal, so new demo calls take the global pipeline (F10)", async (t) => {
    setEnv({ ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "sk-or-test" });
    t.mock.method(console, "error", () => {});
    stubFetch(() => new Response(JSON.stringify({ error: { code: 402, message: "Key limit exceeded" } }), { status: 402 }));
    assert.equal(gatewayRefusal(), null);
    await assert.rejects(streamClaudeResponse(MESSAGES, { model: "claude-haiku-5-5" }), /402/);
    assert.equal(gatewayRefusal(), "Claude requests refused (HTTP 402: Key limit exceeded)");
  });

  it("a request Claude answers clears a latched refusal", async (t) => {
    const { noteGatewayRefusal } = require("../lib/anthropic-gateway");
    setEnv({ ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "sk-or-test" });
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "log", () => {});
    noteGatewayRefusal(402, "Key limit exceeded");
    assert.ok(gatewayRefusal());
    stubFetch(() => new Response(sse("Hi."), { status: 200 }));
    await streamClaudeResponse(MESSAGES, { model: "claude-haiku-5-5" });
    assert.equal(gatewayRefusal(), null);
  });

  it("a one-off error doesn't latch", async () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    stubFetch(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages: field required" } }), { status: 400 }));
    await assert.rejects(streamClaudeResponse(MESSAGES, { model: "claude-haiku-5-5" }), /400/);
    assert.equal(gatewayRefusal(), null);
  });

  it("OpenRouter's temporary 502/503 are retried, as Anthropic's 429/500/529 always were", async (t) => {
    setEnv({ ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "sk-or-test" });
    t.mock.method(console, "warn", () => {});
    for (const status of [502, 503]) {
      let n = 0;
      const calls = stubFetch(() => (n++ === 0
        ? new Response("{}", { status, headers: { "retry-after": "0" } })
        : new Response(sse("Back again."), { status: 200 })));
      assert.deepEqual(await streamClaudeResponse(MESSAGES, { model: "claude-haiku-5-5" }), { type: "content", content: "Back again." });
      assert.equal(calls.length, 2, String(status));
    }
  });

  it("an Anthropic error reads as before", async () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    stubFetch(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }), { status: 400 }));
    await assert.rejects(streamClaudeResponse(MESSAGES, { model: "claude-haiku-5-5" }), /^Error: Anthropic API error 400 \(invalid_request_error: Your credit balance is too low\)$/);
  });
});
