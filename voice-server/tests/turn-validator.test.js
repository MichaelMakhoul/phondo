"use strict";

/**
 * SCRUM-588 — the Tier-2 validator's "no usable verdict" contract.
 *
 * The validator fails OPEN (it must never block a call), so every exit that
 * yields no verdict used to look exactly like a clean pass — a bad
 * VALIDATOR_MODEL, a rejected request field, a reply that is all thinking, a
 * refusal or plain prose would switch the layer off fleet-wide with nothing
 * but a console line. lib/sentry.js turns Sentry.captureMessage into
 * [ALERT:<level>] lines, and the phondo-voice Grafana rules page only on
 * [ALERT:error] (and [FATAL]) — nothing matches [ALERT:warning]. So these
 * tests pin, per exit:
 *   - config failures (400/401/403/404, missing key) → [ALERT:error] at once;
 *   - everything else → a plain trace, then [ALERT:error] from the 3rd
 *     unreadable verdict in a row, repeating until a verdict is READ again;
 *   - none of it ever logs model output or caller words.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const savedKey = process.env.ANTHROPIC_API_KEY;
const savedModel = process.env.VALIDATOR_MODEL;
const savedGateway = { ANTHROPIC_GATEWAY: process.env.ANTHROPIC_GATEWAY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
const realFetch = globalThis.fetch;
const { _test: gatewayTest } = require("../lib/anthropic-gateway");

afterEach(() => {
  gatewayTest.resetRefusal(); // a 401 latches the shared refusal (lib/anthropic-gateway.js)
  for (const [k, v] of Object.entries(savedGateway)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedModel === undefined) delete process.env.VALIDATOR_MODEL;
  else process.env.VALIDATOR_MODEL = savedModel;
  globalThis.fetch = realFetch;
});

/** Fresh module = fresh streak counter. */
function loadValidator({ noKey = false, model } = {}) {
  if (noKey) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = "test-key";
  if (model === undefined) delete process.env.VALIDATOR_MODEL;
  else process.env.VALIDATOR_MODEL = model;
  const p = require.resolve("../services/turn-validator");
  delete require.cache[p];
  return require(p).validateToolResponse;
}

const ARGS = {
  toolName: "book_appointment",
  toolResult: "Booked: Tuesday 13 October 9:30am with Dr Patel.",
  spokenResponse: "Booked for 10am Wednesday with Dr Smith.",
};

/** 2xx reply with the given content blocks. */
const reply = (content, stop_reason = "end_turn") => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content, stop_reason }) });
};
/** Non-2xx reply with an Anthropic error body. */
const httpError = (status, type, message) => {
  globalThis.fetch = async () => ({ ok: false, status, json: async () => ({ type: "error", error: { type, message } }) });
};

/** Capture every console line the validator (and the Sentry shim) writes. */
function captureLogs(t) {
  const lines = [];
  for (const fn of ["log", "warn", "error"]) {
    t.mock.method(console, fn, (...args) => lines.push(args.map(String).join(" ")));
  }
  return {
    lines,
    alerts: (level) => lines.filter((l) => l.startsWith(level ? `[ALERT:${level}]` : "[ALERT:")),
  };
}

describe("config failures page at once — [ALERT:error], validation OFF", () => {
  for (const [status, type, message] of [
    [400, "invalid_request_error", "thinking.type: 'disabled' is not supported for this model"],
    [401, "authentication_error", "invalid x-api-key"],
    [403, "permission_error", "Your API key does not have permission to use the specified resource."],
    [404, "not_found_error", "model: claude-haiku-9-9"],
  ]) {
    it(`HTTP ${status} (${type}) → fail open + [ALERT:error] carrying model, status and the API error`, async (t) => {
      const validate = loadValidator({ model: "claude-haiku-9-9" });
      const logs = captureLogs(t);
      httpError(status, type, message);
      assert.deepEqual(await validate(ARGS), { accurate: true });
      const [line] = logs.alerts("error");
      assert.ok(line, "a config failure must page on the FIRST occurrence");
      assert.match(line, new RegExp(`Tier-2 validator producing no verdicts \\(HTTP ${status}\\) — validation OFF`));
      assert.match(line, /model=claude-haiku-9-9/);
      assert.match(line, new RegExp(`status=${status}`));
      assert.match(line, new RegExp(`error_type=${type}`));
    });
  }

  it("keeps paging while it stays broken — the alert must not resolve on its own", async (t) => {
    const validate = loadValidator();
    const logs = captureLogs(t);
    httpError(404, "not_found_error", "model: nope");
    await validate(ARGS);
    await validate(ARGS);
    assert.equal(logs.alerts("error").length, 2);
  });

  it("ANTHROPIC_API_KEY unset → [ALERT:error] (was a per-call console line)", async (t) => {
    const validate = loadValidator({ noKey: true });
    const logs = captureLogs(t);
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    assert.deepEqual(await validate(ARGS), { accurate: true });
    assert.equal(called, false);
    assert.match(logs.alerts("error")[0] ?? "", /no verdicts \(ANTHROPIC_API_KEY not set\) — validation OFF/);
  });

  it("a non-action tool is not a failure — no request, no log, no alert", async (t) => {
    const validate = loadValidator({ noKey: true });
    const logs = captureLogs(t);
    assert.deepEqual(await validate({ ...ARGS, toolName: "check_availability" }), { accurate: true });
    assert.deepEqual(logs.lines, []);
  });
});

describe("unreadable verdicts — trace each, page ([ALERT:error]) from the 3rd in a row", () => {
  // Each exit below is a 2xx (or transport) failure that used to be a silent
  // or console-only pass.
  const EXITS = [
    ["thinking-only reply, cap spent thinking", () => reply([{ type: "thinking", thinking: "", signature: "s" }], "max_tokens"), /cause=no-text.*stop_reason=max_tokens/],
    ["refusal with empty content", () => reply([], "refusal"), /cause=no-text.*stop_reason=refusal/],
    ["whitespace-only text", () => reply([{ type: "text", text: "  \n " }]), /cause=no-text/],
    ["prose / non-JSON (e.g. a refusal sentence)", () => reply([{ type: "text", text: "I can't help with that request." }], "refusal"), /cause=not-json.*stop_reason=refusal/],
    ['string verdict {"accurate":"false"}', () => reply([{ type: "text", text: '{"accurate":"false"}' }]), /cause=no-boolean-verdict/],
    ['string verdict {"accurate":"true"}', () => reply([{ type: "text", text: '{"accurate":"true"}' }]), /cause=no-boolean-verdict/],
    ["HTTP 529 overloaded (transient, not config)", () => httpError(529, "overloaded_error", "Overloaded"), /cause=http-error.*status=529.*error_type=overloaded_error/],
    ["network failure / timeout", () => { globalThis.fetch = async () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }; }, /cause=request-failed.*error_type=TimeoutError/],
  ];

  for (const [name, arrange, traceRe] of EXITS) {
    it(`${name}: fails open, leaves a trace, and the 3rd in a row is an [ALERT:error]`, async (t) => {
      const validate = loadValidator();
      const logs = captureLogs(t);
      arrange();
      for (let i = 0; i < 2; i++) assert.deepEqual(await validate(ARGS), { accurate: true });
      assert.equal(logs.alerts().length, 0, "one or two are a blip, not an outage");
      assert.ok(logs.lines.some((l) => traceRe.test(l)), `trace missing for ${name}: ${logs.lines.join(" | ")}`);
      assert.deepEqual(await validate(ARGS), { accurate: true });
      const [line] = logs.alerts("error");
      assert.equal(logs.alerts("warning").length, 0, "Grafana pages on nothing at warning level");
      assert.match(line ?? "", /Tier-2 validator producing no verdicts \(3 unreadable in a row\) — validation OFF/);
    });
  }

  it("never logs what the model said (a prose reply can quote the caller)", async (t) => {
    const validate = loadValidator();
    const logs = captureLogs(t);
    reply([{ type: "text", text: "Mrs Maria Lopez on 0412 345 678 is booked, I cannot comply." }]);
    for (let i = 0; i < 3; i++) await validate(ARGS);
    assert.ok(logs.lines.length >= 3);
    for (const l of logs.lines) assert.doesNotMatch(l, /Maria|0412|comply/);
  });

  it("the streak resets ONLY on a readable verdict — a 2xx with an unreadable body never resets it", async (t) => {
    const validate = loadValidator();
    const logs = captureLogs(t);
    reply([{ type: "text", text: "not json" }]);
    await validate(ARGS);
    await validate(ARGS);
    reply([{ type: "text", text: '{"accurate": true}' }]); // readable → streak back to 0
    assert.deepEqual(await validate(ARGS), { accurate: true });
    reply([{ type: "text", text: "not json" }]);
    await validate(ARGS);
    await validate(ARGS);
    assert.equal(logs.alerts().length, 0, "2 + reset + 2 must not page");
    await validate(ARGS);
    assert.equal(logs.alerts("error").length, 1, "the 3rd after the reset pages");
    await validate(ARGS);
    assert.equal(logs.alerts("error").length, 2, "and it keeps paging while it stays unreadable");
  });
});

describe("readable verdicts (incl. the shapes Haiku 4.5, the revert model, emits)", () => {
  it("a note truncated at max_tokens still FLAGS the turn, as 'Unknown discrepancy' — and counts as read", async (t) => {
    const validate = loadValidator();
    const logs = captureLogs(t);
    reply([{ type: "text", text: "not json" }]);
    await validate(ARGS);
    await validate(ARGS);
    reply([{ type: "text", text: '{"accurate": false, "discrepancy": "Date mismatch: tool booked Tuesday 13 Oct' }], "max_tokens");
    assert.deepEqual(await validate(ARGS), { accurate: false, discrepancy: "Unknown discrepancy" });
    reply([{ type: "text", text: "not json" }]);
    await validate(ARGS);
    assert.equal(logs.alerts().length, 0, "the flagged verdict reset the streak");
  });

  it("fenced JSON is read", async () => {
    const validate = loadValidator();
    reply([{ type: "text", text: '```json\n{"accurate": false, "discrepancy": "time is 9:30 not 10am"}\n```' }]);
    assert.deepEqual(await validate(ARGS), { accurate: false, discrepancy: "time is 9:30 not 10am" });
  });

  it("a false verdict without a note still flags the turn", async () => {
    const validate = loadValidator();
    reply([{ type: "text", text: '{"accurate": false}' }]);
    assert.deepEqual(await validate(ARGS), { accurate: false, discrepancy: "Unknown discrepancy" });
  });
});

describe("ANTHROPIC_GATEWAY=openrouter (SCRUM-594: the Anthropic balance is empty)", () => {
  it("a spent cap (402) pages at once, and latches the refusal for the demo line", async (t) => {
    const { gatewayRefusal, _test: gatewayTest } = require("../lib/anthropic-gateway");
    t.after(() => gatewayTest.resetRefusal());
    process.env.ANTHROPIC_GATEWAY = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const validate = loadValidator();
    const logs = captureLogs(t);
    httpError(402, "payment_required", "Key limit exceeded");
    assert.deepEqual(await validate(ARGS), { accurate: true });
    assert.match(logs.alerts("error").find((l) => l.includes("tier2_validator")) ?? "", /no verdicts \(HTTP 402\) — validation OFF/);
    assert.equal(gatewayRefusal(), "Claude requests refused (HTTP 402: Key limit exceeded)");
  });

  it("validates through OpenRouter with its bearer key, Haiku 5.5 pinned to Anthropic", async () => {
    process.env.ANTHROPIC_GATEWAY = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const validate = loadValidator();
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"accurate": false, "discrepancy": "time is 9:30 not 10am"}' }], stop_reason: "end_turn" }) };
    };
    assert.deepEqual(await validate(ARGS), { accurate: false, discrepancy: "time is 9:30 not 10am" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/messages");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.authorization, "Bearer sk-or-test");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "anthropic/claude-haiku-5.5");
    assert.deepEqual(body.provider, { only: ["anthropic"], allow_fallbacks: false });
    assert.match(body.messages[0].content, /TOOL CALLED: book_appointment/);
  });

  it("no OpenRouter key: fail open, no request, and a config alert naming the key", async (t) => {
    process.env.ANTHROPIC_GATEWAY = "openrouter";
    delete process.env.OPENROUTER_API_KEY;
    const validate = loadValidator();
    const logs = captureLogs(t);
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    assert.deepEqual(await validate(ARGS), { accurate: true });
    assert.equal(called, false);
    assert.match(logs.alerts("error")[0] ?? "", /no verdicts \(OPENROUTER_API_KEY not set \(ANTHROPIC_GATEWAY=openrouter\)\) — validation OFF/);
  });

  it("a VALIDATOR_MODEL OpenRouter won't take (the Haiku 4.5 revert): fail open, no request, a config alert", async (t) => {
    process.env.ANTHROPIC_GATEWAY = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const validate = loadValidator({ model: "claude-haiku-4-5-20251001" });
    const logs = captureLogs(t);
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    assert.deepEqual(await validate(ARGS), { accurate: true });
    assert.equal(called, false);
    assert.match(logs.alerts("error")[0] ?? "", /claude-haiku-4-5-20251001 may not be sent through OpenRouter/);
  });
});
