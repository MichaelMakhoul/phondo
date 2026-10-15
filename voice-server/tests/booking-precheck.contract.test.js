"use strict";

/**
 * SCRUM-593 — the booking pre-check's fail-open, paging and request contract.
 * Companion to booking-precheck.test.js (which pins verdicts, modes, the hold
 * cap and the fixed hold text); spec:
 * docs/superpowers/specs/2026-10-15-booking-precheck-design.md.
 *
 * Pins the lines that keep the layer SAFE and OBSERVABLE and that could be
 * deleted or weakened without any other test noticing (found by mutation
 * testing): the 3 s timeout, the request envelope, the business timezone, the
 * hold cap's [ALERT:warning], which HTTP statuses page at once, the
 * booking_precheck service tag (never the Tier-2 checker's), unreadable /
 * empty / non-JSON replies, "never throws", log hygiene (SCRUM-339) and the
 * server.js glue's mapping of the call's own state into the request.
 *
 * Every console.* call is captured (see beforeEach), so a run prints nothing.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const SAVED = { key: process.env.ANTHROPIC_API_KEY, mode: process.env.PRECHECK_MODE, model: process.env.PRECHECK_MODEL };
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realError = console.error;
const realLog = console.log;
/** @type {string[]} */
let logs = [];

beforeEach(() => {
  logs = [];
  console.warn = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
});

afterEach(() => {
  for (const [envName, v] of [["ANTHROPIC_API_KEY", SAVED.key], ["PRECHECK_MODE", SAVED.mode], ["PRECHECK_MODEL", SAVED.model]]) {
    if (v === undefined) delete process.env[envName];
    else process.env[envName] = v;
  }
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
  console.log = realLog;
});

/** Fresh module = fresh unreadable streak. */
function load({ mode, model, noKey = false } = {}) {
  if (noKey) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = "test-key";
  if (mode === undefined) delete process.env.PRECHECK_MODE;
  else process.env.PRECHECK_MODE = mode;
  if (model === undefined) delete process.env.PRECHECK_MODEL;
  else process.env.PRECHECK_MODEL = model;
  const p = require.resolve("../lib/booking-precheck");
  delete require.cache[p];
  return require(p);
}

/** Stub fetch with a 2xx reply carrying one text block; records the request. */
function replyText(text) {
  const seen = { calls: 0, body: /** @type {any} */ (null), url: /** @type {any} */ (null), headers: /** @type {any} */ (null), signal: /** @type {any} */ (null) };
  globalThis.fetch = async (url, init) => {
    seen.calls++;
    seen.url = url;
    seen.headers = init.headers;
    seen.signal = init.signal;
    seen.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) };
  };
  return seen;
}

const CONVERSATION = [
  { role: "system", content: "SECRET SYSTEM PROMPT" },
  { role: "assistant", content: "Thanks for calling. How can I help?" },
  { role: "user", content: "I need a plumber tomorrow morning." },
  { role: "assistant", content: "Sure. What's your first name?" },
  { role: "user", content: "Michael." },
];
const ARGS = { first_name: "Michael", last_name: "Makhlouf", datetime: "2026-10-15T09:00" };
const NOW = new Date("2026-10-14T10:56:00Z");
const input = (over = {}) => ({
  toolName: "book_appointment",
  args: ARGS,
  messages: CONVERSATION,
  pendingUser: "Morning is good.",
  pendingAi: "Let me book that for you.",
  timezone: "Australia/Sydney",
  nameMethod: "repeat-confirm",
  holds: new Map(),
  callSid: "CAtest",
  now: NOW,
  ...over,
});
const FIX = JSON.stringify({ verdict: "fix", problem: "name_unconfirmed" });
const session = (over = {}) => ({
  messages: CONVERSATION,
  organization: { timezone: "Australia/Sydney" },
  precheckHolds: new Map(),
  toolCallAudit: [],
  callSid: "CAtest",
  ...over,
});

describe("hold cap alert", () => {
  it("the capped third attempt raises an [ALERT:warning] under the booking_precheck tag", async () => {
    const m = load();
    replyText(FIX);
    await m.precheckBookingWrite(input({ holds: new Map([["book_appointment", 2]]) }));
    assert.ok(logs.some((l) => /\[ALERT:warning\] \[booking_precheck\] Booking pre-check: book_appointment let through after 2 holds/.test(l)));
  });
});

describe("the request contract", () => {
  it("the NOW line is in the business's timezone", async () => {
    const m = load();
    const seen = replyText('{"verdict":"allow"}');
    await m.precheckBookingWrite(input({ timezone: "America/New_York" }));
    assert.match(seen.body.messages[0].content, /Current date and time: Wednesday, October 14, 2026, 06:56\sAM \(America\/New_York\)/);
  });

  it("posts to the Messages API with the key, the API version and a small token cap", async () => {
    const m = load();
    const seen = replyText('{"verdict":"allow"}');
    await m.precheckBookingWrite(input());
    assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen.headers["x-api-key"], "test-key");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.equal(seen.body.max_tokens, 300);
  });

  // The line the whole "fail open on slow" promise rests on: without a timeout a
  // hung Anthropic call would hold the booking (and the caller) indefinitely.
  it("the request carries a 3 s timeout signal", async () => {
    const m = load();
    const seen = replyText('{"verdict":"allow"}');
    const real = AbortSignal.timeout;
    let ms;
    AbortSignal.timeout = (n) => {
      ms = n;
      return real.call(AbortSignal, n);
    };
    try {
      await m.precheckBookingWrite(input());
    } finally {
      AbortSignal.timeout = real;
    }
    assert.equal(ms, 3000);
    assert.ok(seen.signal instanceof AbortSignal, "the signal is handed to fetch");
  });

  it("tolerates missing args, an empty conversation and no name method", async () => {
    const m = load();
    const seen = replyText('{"verdict":"allow"}');
    await m.precheckBookingWrite(input({ args: undefined, messages: [], pendingUser: "", pendingAi: "", nameMethod: undefined }));
    const prompt = seen.body.messages[0].content;
    assert.match(prompt, /DETAILS THE AI WANTS TO SAVE: \{\}/);
    assert.match(prompt, /\(nothing transcribed yet\)/);
    assert.match(prompt, /the AI must have repeated it back/);
  });

  it("a truncated call starts on a whole line, right after the omitted marker", async () => {
    const m = load();
    const seen = replyText('{"verdict":"allow"}');
    const long = Array.from({ length: 800 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `line ${i} ${"x".repeat(20)}` }));
    await m.precheckBookingWrite(input({ messages: long, pendingUser: "", pendingAi: "" }));
    const after = seen.body.messages[0].content.split("[earlier part of the call omitted]\n")[1];
    assert.match(after, /^(CALLER|AI): line \d+ x+\n/);
  });
});

describe("failure paging", () => {
  const httpStatus = (status) => {
    globalThis.fetch = async () => ({ ok: false, status, json: async () => ({ type: "error", error: { type: "x_error", message: "y" } }) });
  };

  // A bad key (401/403), a refused request field (400) and a bad model (404)
  // fail EVERY check the same way, so one is enough to page.
  for (const status of [400, 401, 403]) {
    it(`HTTP ${status} pages at once`, async () => {
      const m = load();
      httpStatus(status);
      assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
      assert.ok(logs.some((l) => new RegExp(`\\[ALERT:error\\].*\\(HTTP ${status}\\)`).test(l)));
    });
  }

  // ...but a blip at Anthropic (rate limit, 5xx, overloaded) must not page on the first failure.
  for (const status of [429, 500, 529]) {
    it(`a transient HTTP ${status} stays quiet on the first failure`, async () => {
      const m = load();
      httpStatus(status);
      assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
      assert.ok(!logs.some((l) => /\[ALERT:error\]/.test(l)));
    });
  }

  // Ruling 3: one layer failing must never page as the other.
  it("pages under its own service tag, never the Tier-2 checker's", async () => {
    const m = load({ noKey: true });
    await m.precheckBookingWrite(input());
    assert.ok(logs.some((l) => /\[ALERT:error\] \[booking_precheck\] Booking pre-check producing no verdicts \(ANTHROPIC_API_KEY not set\)/.test(l)));
    assert.ok(!logs.some((l) => /tier2_validator/.test(l)));
  });

  it("the page carries Anthropic's error type and message", async () => {
    const m = load({ model: "claude-nope" });
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ type: "error", error: { type: "not_found_error", message: "model: claude-nope" } }) });
    await m.precheckBookingWrite(input());
    assert.ok(logs.some((l) => /\[ALERT:error\].*error_type=not_found_error error_message=model: claude-nope/.test(l)));
  });

  // A thrown fetch counts toward the streak like every other no-verdict.
  it("network failures count toward the streak and page from the third", async () => {
    const m = load();
    globalThis.fetch = async () => {
      throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
    };
    for (let i = 0; i < 2; i++) await m.precheckBookingWrite(input());
    assert.ok(!logs.some((l) => /\[ALERT:error\]/.test(l)));
    await m.precheckBookingWrite(input());
    assert.ok(logs.some((l) => /\[ALERT:error\].*3 unreadable in a row/.test(l)));
  });

  // SCRUM-339: a SyntaxError from a non-JSON 2xx body quotes the body.
  it("a 2xx body that is not JSON is reported without quoting it", async () => {
    const m = load();
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token \'C\', "Caller Makhlouf s"... is not valid JSON');
      },
    });
    assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
    const all = logs.join("\n");
    assert.match(all, /response body is not JSON/);
    assert.doesNotMatch(all, /Makhlouf/);
  });

  it("valid JSON that is not a verdict is reported as no-verdict, never as allow", async () => {
    const m = load();
    for (const reply of ['{"verdict":"maybe"}', "null", "[]", '"allow"', "{}"]) {
      logs.length = 0;
      replyText(reply);
      assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
      assert.ok(logs.some((l) => /cause=no-verdict/.test(l)), reply);
    }
  });

  it("a reply with no text block is reported as no-text", async () => {
    const m = load();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "thinking", thinking: "hmm" }], stop_reason: "max_tokens" }) });
    assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
    assert.ok(logs.some((l) => /cause=no-text stop_reason=max_tokens/.test(l)));
  });

  // The module's headline contract.
  it("never throws: a malformed call (no hold map) lets the write through", async () => {
    const m = load();
    const seen = replyText(FIX);
    assert.deepEqual(await m.precheckBookingWrite(input({ holds: undefined })), { action: "proceed" });
    assert.equal(seen.calls, 0);
    assert.ok(logs.some((l) => /\[Precheck\] Unexpected error — letting book_appointment through/.test(l)));
  });
});

describe("log hygiene on the allow path", () => {
  it("an allow logs no caller words or details either", async () => {
    const m = load();
    replyText('{"verdict":"allow"}');
    await m.precheckBookingWrite(input());
    assert.doesNotMatch(logs.join("\n"), /Makhlouf|Michael|plumber|2026-10-15T09/);
  });
});

describe("nameVerificationMethod field list", () => {
  it("skips a null entry in the field list", () => {
    const m = load();
    assert.equal(m.nameVerificationMethod({ fields: [null, { id: "first_name", verification: "spell-out" }] }), "spell-out");
  });
});

describe("server.js glue mapping", () => {
  it("sends this call's own state to Claude", async () => {
    const m = load();
    const seen = replyText('{"verdict":"allow"}');
    const s = session({ organization: { timezone: "America/New_York" }, callSid: "CAglue" });
    await m.applyBookingPrecheck(
      s,
      { name: "reschedule_appointment", args: { new_datetime: "2026-10-16T14:00" } },
      { pendingUser: "Two pm works.", pendingAi: "Moving it now.", promptConfig: { fields: [{ id: "first_name", verification: "spell-out" }] }, audit: true }
    );
    const prompt = seen.body.messages[0].content;
    assert.match(prompt, /TOOL: reschedule_appointment/);
    assert.match(prompt, /DETAILS THE AI WANTS TO SAVE: \{"new_datetime":"2026-10-16T14:00"\}/);
    assert.match(prompt, /\(America\/New_York\)/);
    assert.match(prompt, /the AI must have spelled it back letter by letter/);
    assert.match(prompt, /CALLER: I need a plumber tomorrow morning\./);
    assert.match(prompt, /CALLER: Two pm works\.\nAI: Moving it now\.$/m);
    assert.ok(logs.some((l) => /callSid=CAglue/.test(l)));
  });

  it("audit:true on a session with no audit array does not throw", async () => {
    const m = load();
    replyText(FIX);
    const r = await m.applyBookingPrecheck(session({ toolCallAudit: undefined }), { name: "book_appointment", args: ARGS }, { audit: true });
    assert.match(r.message, /^NOT DONE YET — nothing was saved\./);
  });
});
