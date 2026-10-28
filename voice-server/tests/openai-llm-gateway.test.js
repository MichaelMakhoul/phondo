const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { gatewayRefusal, OPENROUTER_MESSAGES_URL, ANTHROPIC_MESSAGES_URL, _test: gatewayTest } = require("../lib/anthropic-gateway");

// SCRUM-618: the classic pipeline's Claude turns (services/openai-llm.js with
// LLM_PROVIDER=anthropic) go through lib/anthropic-gateway.js, as the fast
// path's do. Going direct, every classic turn failed while prod ran on
// OpenRouter with an empty Anthropic balance — so OWNER_PIPELINE=classic could
// not take the owner assistant off Gemini.
const ENV_KEYS = ["LLM_PROVIDER", "LLM_MODEL", "ANTHROPIC_GATEWAY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
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

/** openai-llm.js reads LLM_PROVIDER at load: a fresh copy under exactly `env`. */
function load(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const resolved = require.resolve("../services/openai-llm");
  delete require.cache[resolved];
  return require(resolved);
}

const MESSAGES = [{ role: "system", content: "You are the owner's assistant." }, { role: "user", content: "What's on today?" }];
const TOOLS = [{ type: "function", function: { name: "owner_list_appointments", description: "d", parameters: { type: "object", properties: {} } } }];

/** Records each request; answers with `respond()`. */
function recordFetch(calls, respond) {
  return async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return respond();
  };
}
const claudeJson = () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "One job today." }], stop_reason: "end_turn" }) });
const claudeStream = () =>
  new Response(
    [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "One job today." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const creditRefusal = () => ({
  ok: false,
  status: 400,
  text: async () => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }),
});

describe("classic pipeline Claude turns go through the gateway (SCRUM-618)", () => {
  it("on OpenRouter: OpenRouter's URL and key, Haiku 5.5's OpenRouter name, pinned to Anthropic — no Anthropic key needed, the caller's key ignored", async () => {
    const llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    const calls = [];
    globalThis.fetch = recordFetch(calls, claudeJson);
    assert.deepEqual(await llm.getChatResponse("a-stale-anthropic-key", MESSAGES), { type: "content", content: "One job today." });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, OPENROUTER_MESSAGES_URL);
    assert.equal(calls[0].headers.authorization, "Bearer or-key");
    assert.equal(calls[0].headers["x-api-key"], undefined);
    assert.equal(calls[0].body.model, "anthropic/claude-haiku-5.5");
    assert.deepEqual(calls[0].body.provider, { only: ["anthropic"], allow_fallbacks: false });
  });

  it("on OpenRouter, streaming with tools (the owner assistant's turn): same route, stream on, tools converted", async () => {
    const llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    const calls = [];
    globalThis.fetch = recordFetch(calls, claudeStream);
    const result = await llm.streamChatResponse(undefined, MESSAGES, { tools: TOOLS });
    assert.equal(result.content, "One job today.");
    assert.equal(calls[0].url, OPENROUTER_MESSAGES_URL);
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].body.model, "anthropic/claude-haiku-5.5");
    assert.equal(calls[0].body.tools[0].name, "owner_list_appointments");
    assert.equal(calls[0].body.system, "You are the owner's assistant.");
  });

  it("gateway unset: straight to Anthropic with the Anthropic key, the body as before", async () => {
    const llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "an-key" });
    const calls = [];
    globalThis.fetch = recordFetch(calls, claudeJson);
    await llm.getChatResponse(undefined, MESSAGES);
    assert.equal(calls[0].url, ANTHROPIC_MESSAGES_URL);
    assert.equal(calls[0].headers["x-api-key"], "an-key");
    assert.equal(calls[0].body.model, "claude-haiku-5-5");
    assert.equal(calls[0].body.provider, undefined);
  });

  it("a credit refusal fails the turn AND latches, like the fast path's — non-streaming and streaming", async () => {
    let llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    globalThis.fetch = recordFetch([], creditRefusal);
    await assert.rejects(llm.getChatResponse(undefined, MESSAGES), /Anthropic API error 400/);
    assert.match(gatewayRefusal() ?? "", /^Claude requests refused \(HTTP 400: .*credit balance/);
    gatewayTest.resetRefusal();
    llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    globalThis.fetch = recordFetch([], creditRefusal);
    await assert.rejects(llm.streamChatResponse(undefined, MESSAGES, { tools: TOOLS }), /Anthropic API error 400/);
    assert.match(gatewayRefusal() ?? "", /credit balance/);
  });

  it("a model OpenRouter won't take, or a missing gateway key, fails before any request goes out", async () => {
    let llm = load({ LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5-5", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    const calls = [];
    globalThis.fetch = recordFetch(calls, claudeJson);
    await assert.rejects(llm.getChatResponse(undefined, MESSAGES), /claude-sonnet-5-5/);
    llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_GATEWAY: "openrouter" });
    await assert.rejects(llm.streamChatResponse(undefined, MESSAGES), /OPENROUTER_API_KEY not set/);
    assert.equal(calls.length, 0);
  });

  it("OpenAI is untouched: its own URL and the caller's key, whatever the gateway says", async () => {
    const llm = load({ LLM_PROVIDER: "openai", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    const calls = [];
    globalThis.fetch = recordFetch(calls, () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Nine." } }] }) }));
    await llm.getChatResponse("sk-test", MESSAGES);
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0].headers.Authorization, "Bearer sk-test");
  });
});
