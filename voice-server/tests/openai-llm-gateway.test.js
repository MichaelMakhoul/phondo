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

// ─── SCRUM-618 test lens (independent mutants): killers for what the PR's own suite let through ───
// APPEND TO: voice-server/tests/openai-llm-gateway.test.js (at the end of the file —
// `cat .claude/review/618/killers.txt >> voice-server/tests/openai-llm-gateway.test.js`). Uses the file's
// top-level harness (load, recordFetch, MESSAGES, claudeJson, gatewayRefusal, ANTHROPIC_MESSAGES_URL);
// describeGateway is required inside T4. Each test names the mutant it kills (see the review's mutant
// table); all pass on eec49dbd, and each fails on its mutant.
describe("SCRUM-618 test lens: the gateway and its latch are Claude's alone", () => {
  /** OpenAI's answer to a bad key: a 401, which isStandingRefusal counts as standing. */
  const openAIBadKey = () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }),
  });
  const openAIJson = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Nine." } }] }) });

  it("T1 (M8): an OpenAI 401 fails the turn but never latches the Claude refusal — that would take the demo line off classic-fast and page 'Claude requests refused' — non-streaming and streaming", async () => {
    const llm = load({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    globalThis.fetch = recordFetch([], openAIBadKey);
    await assert.rejects(llm.getChatResponse(undefined, MESSAGES), /OpenAI API error 401/);
    assert.equal(gatewayRefusal(), null, "non-streaming: an OpenAI error is not a Claude refusal");
    await assert.rejects(llm.streamChatResponse(undefined, MESSAGES), /OpenAI API error 401/);
    assert.equal(gatewayRefusal(), null, "streaming: an OpenAI error is not a Claude refusal");
  });

  it("T2 (M3): gateway unset, the key is the gateway's ANTHROPIC_API_KEY — a caller's stale key is ignored here too, not only on OpenRouter", async () => {
    const llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "an-key" });
    const calls = [];
    globalThis.fetch = recordFetch(calls, claudeJson);
    await llm.getChatResponse("a-stale-anthropic-key", MESSAGES);
    assert.equal(calls[0].url, ANTHROPIC_MESSAGES_URL);
    assert.equal(calls[0].headers["x-api-key"], "an-key");
  });

  it("T3 (M14): OpenAI with no caller key falls back to OPENAI_API_KEY; with neither, the turn fails before any request", async () => {
    let llm = load({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-env" });
    const calls = [];
    globalThis.fetch = recordFetch(calls, openAIJson);
    await llm.getChatResponse(undefined, MESSAGES);
    assert.equal(calls[0].headers.Authorization, "Bearer sk-env");
    llm = load({ LLM_PROVIDER: "openai" });
    await assert.rejects(llm.streamChatResponse(undefined, MESSAGES), /LLM API key not configured.*OPENAI_API_KEY/);
    assert.equal(calls.length, 1, "nothing sent without a key");
  });

  it("T4 (M9, M11): the boot line checks LLM_MODEL and names the classic pipeline only for LLM_PROVIDER=anthropic — not openai, gemini, or unset (openai-llm.js's default)", () => {
    const { describeGateway } = require("../lib/anthropic-gateway");
    const VIA_OPENROUTER = { ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "sk-or-test" };
    const plain = "Anthropic requests: via OpenRouter, claude-haiku-5-5 only, pinned to Anthropic's servers";
    assert.equal(describeGateway({ ...VIA_OPENROUTER, LLM_PROVIDER: "openai", LLM_MODEL: "gpt-6-luna" }), plain);
    assert.equal(describeGateway({ ...VIA_OPENROUTER, LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.5-flash" }), plain);
    assert.equal(describeGateway({ ...VIA_OPENROUTER, LLM_MODEL: "gpt-6-luna" }), plain, "unset LLM_PROVIDER is openai");
    assert.equal(
      describeGateway({ ...VIA_OPENROUTER, LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-haiku-5-5" }),
      `${plain}; the classic pipeline too (LLM_PROVIDER=anthropic)`,
      "Haiku 5.5 is the model OpenRouter takes: no warning",
    );
  });
});

// SCRUM-618 review round 1: what makes the classic pipeline fit to carry the owner assistant.
describe("classic Claude turns: room to answer, retries, the refusal's own words, the stream's gaps (SCRUM-618)", () => {
  const withHeaders = (r) => ({ ...r, headers: { get: () => null } });
  const overloaded = () => withHeaders({ ok: false, status: 529, text: async () => JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) });

  it("a reply has room for a multi-field tool call: 600 tokens with tools, 200 without (as the fast path)", async () => {
    const llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "an-key" });
    const calls = [];
    globalThis.fetch = recordFetch(calls, claudeJson);
    await llm.getChatResponse(undefined, MESSAGES, { tools: TOOLS });
    await llm.getChatResponse(undefined, MESSAGES);
    assert.deepEqual(calls.map((c) => c.body.max_tokens), [600, 200]);
  });

  it("an overload (529) or a 5xx is retried, then answers — non-streaming and streaming; a 400 is not retried", async () => {
    let llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    let n = 0;
    globalThis.fetch = async () => (n++ === 0 ? overloaded() : claudeJson());
    assert.deepEqual(await llm.getChatResponse(undefined, MESSAGES), { type: "content", content: "One job today." });
    assert.equal(n, 2);
    llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    n = 0;
    globalThis.fetch = async () => (n++ === 0 ? withHeaders({ ok: false, status: 502, text: async () => "bad gateway" }) : claudeStream());
    assert.equal((await llm.streamChatResponse(undefined, MESSAGES)).content, "One job today.");
    assert.equal(n, 2);
    n = 0;
    globalThis.fetch = async () => { n++; return withHeaders({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "messages: bad shape" } }) }); };
    await assert.rejects(llm.streamChatResponse(undefined, MESSAGES), /Anthropic API error 400/);
    assert.equal(n, 1);
  });

  it("the refusal latch keeps the provider's own message, not the JSON around it", async () => {
    const llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or-key" });
    globalThis.fetch = recordFetch([], creditRefusal);
    await assert.rejects(llm.getChatResponse(undefined, MESSAGES));
    assert.equal(gatewayRefusal(), "Claude requests refused (HTTP 400: Your credit balance is too low to access the Anthropic API.)");
  });

  it("a tool with no arguments streams none: its arguments are '{}', never '' (which logged a false parse fault)", async () => {
    const llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "an-key" });
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "owner_list_messages", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    globalThis.fetch = async () => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    const r = await llm.streamChatResponse(undefined, MESSAGES, { tools: TOOLS });
    assert.equal(r.type, "tool_calls");
    assert.equal(r.toolCalls[0].function.arguments, "{}");
  });

  it("a reply cut off at max_tokens is said, with the tool calls it cut", async () => {
    const llm = load({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "an-key" });
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "owner_book_appointment", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"customer_name":"Ja' } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 600 } },
      { type: "message_stop" },
    ];
    globalThis.fetch = async () => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(" "));
    try {
      await llm.streamChatResponse(undefined, MESSAGES, { tools: TOOLS });
    } finally {
      console.warn = realWarn;
    }
    assert.ok(warned.some((l) => l === "[LLM] Anthropic reply cut off at max_tokens (tool calls: owner_book_appointment)"), warned.join("\n"));
  });
});
