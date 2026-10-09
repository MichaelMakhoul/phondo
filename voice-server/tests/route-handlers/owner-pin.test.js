// voice-server/tests/route-handlers/owner-pin.test.js
"use strict";
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");
const { performance } = require("node:perf_hooks");
const ownerAuth = require("../../lib/owner-auth");
const ownerPin = require("../../lib/route-handlers/owner-pin");
const { Sentry: sentryShim } = require("../../lib/sentry");
const { maskPhone } = require("../../lib/mask-phone");
const { getPollyVoice } = require("../../lib/polly-voice");

// SCRUM-587 — POST /twiml/owner-pin, the security gate of the owner assistant
// (spec §1 call flow, §8, §9). Every outcome runs through the REAL owner-auth
// helpers (real scrypt verifyPin, real two-window countPinAttempt, real
// resetPinAttempts) over a fake service-role Supabase, a fake token issuer and
// a captured res. Nothing here touches a network.
const SALT = "00112233445566778899aabbccddeeff";
const PIN = "4826";
const WRONG = "9371";
const SAID_PIN = "four eight two six";
const SAID_WRONG = "nine three seven one";
const KEY_15M = "owner-pin:org-1:00112233";
const KEY_24H = "owner-pin-day:org-1:00112233";
const ACCESS = { phone_e164: "+61400000001", pin_hash: ownerAuth.hashPin(PIN, SALT), pin_salt: SALT, pin_length: 4, enabled: true };
const PHONE = { id: "p1", organization_id: "org-1", organizations: { name: "Copperline", country: "AU", owner_access: ACCESS } };
const PUBLIC_URL = "https://voice.example";
const WS_URL = "wss://voice.example/ws/audio";
const VERIFIED = { ownerMode: true, ownerAuth: "verified", ownerFirstName: "Dave" };

// The escaper server.js hands the handler.
function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** A write's outcome: undefined = ok, "pending" = never settles, "reject" = network error, an object = a PostgREST error. */
function writeOutcome(mode) {
  if (mode === "pending") return new Promise(() => {});
  if (mode === "reject") return Promise.reject(new Error("socket hang up"));
  return Promise.resolve({ error: mode && typeof mode === "object" ? mode : null });
}

function makeHarness(o = {}) {
  const state = { lookups: [], tokens: [], rpc: [], updates: [], deletes: [], names: [], scopes: [], captured: [], events: [] };
  const supabase = {
    // check_rate_limit_bucket: the post-increment count, resolved on a LATER turn like a real round-trip.
    rpc: async (fn, args) => {
      state.rpc.push({ fn, args });
      state.events.push(`rpc:${args.p_key}`);
      await new Promise((r) => setImmediate(r));
      state.events.push(`rpc-done:${args.p_key}`);
      if (o.rpcThrows) throw new Error("rpc down");
      if (o.rpcResult) return o.rpcResult;
      const count = args.p_key.startsWith("owner-pin-day:") ? (o.dayCount ?? 1) : (o.count ?? 1);
      return { data: [{ count, reset_time: "2026-10-10T00:15:00Z" }], error: null };
    },
    from: (table) => ({
      update: (payload) => ({ eq: (col, val) => { state.updates.push({ table, payload, col, val }); return writeOutcome(o.update); } }),
      delete: () => ({ eq: (col, val) => { state.deletes.push({ table, col, val }); return writeOutcome(o.delete); } }),
    }),
  };
  const deps = {
    lookupPhoneNumber: async (called, opts) => {
      state.lookups.push({ called, opts });
      if (o.lookupRejects) throw new Error("lookup exploded");
      return "phone" in o ? o.phone : PHONE;
    },
    supabase,
    loadOwnerFirstName: async (orgId) => {
      state.names.push(orgId);
      return o.loadOwnerFirstName ? o.loadOwnerFirstName(orgId) : "Dave";
    },
    issueStreamToken: (called, from, reconnect, phoneRecord, extra) => {
      if (o.failToken && o.failToken(extra)) throw new Error("token store unavailable");
      state.tokens.push({ called, from, reconnect, phoneRecord, extra });
      return `tok${state.tokens.length}`;
    },
    // The production structured-log shim, observed: what it prints lands in the captured console lines.
    Sentry: {
      withScope: (fn) => sentryShim.withScope((scope) => { state.scopes.push(scope); fn(scope); }),
      captureException: (err) => { state.captured.push(err); sentryShim.captureException(err); },
    },
    maskPhone,
    escapeXml,
    getPollyVoice,
    publicUrl: PUBLIC_URL,
    wsUrl: WS_URL,
  };
  const res = {
    body: null,
    contentType: null,
    sends: 0,
    type(t) { this.contentType = t; return this; },
    send(b) { this.sends += 1; this.body = b; return this; },
  };
  const req = { body: { Called: "+61255550000", From: "+61400000001", CallSid: "CA1", ...(o.body || {}) }, query: o.query || {} };
  return { state, deps, res, req };
}

const LOG_METHODS = ["log", "info", "warn", "error", "debug"];
const turn = () => new Promise((r) => setImmediate(r));
const extras = (h) => h.state.tokens.map((x) => x.extra);

/**
 * Runs the handler with every console method captured as "<method>| <text>"
 * (objects inspected, so nothing hides behind "[object Object]"), keeps
 * capturing for a few turns so the fire-and-forget writes can log, and fails
 * (instead of hanging the suite) if the handler waits on something it must not.
 */
async function run(h) {
  const lines = [];
  const original = LOG_METHODS.map((m) => console[m]);
  for (const m of LOG_METHODS) {
    console[m] = (...args) => lines.push(`${m}| ${args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 8 }))).join(" ")}`);
  }
  let guard;
  try {
    const timedOut = new Promise((resolve) => { guard = setTimeout(resolve, 3000, "timed-out"); });
    const outcome = await Promise.race([ownerPin.handleOwnerPin(h.req, h.res, { deps: h.deps }), timedOut]);
    assert.notEqual(outcome, "timed-out", "handleOwnerPin did not answer within 3 s: it waited on something it must not");
    for (let i = 0; i < 5; i++) await turn();
  } finally {
    clearTimeout(guard);
    LOG_METHODS.forEach((m, i) => { console[m] = original[i]; });
  }
  return lines;
}

/** True once `promise` settles (rethrowing a rejection), false after `ms` of wall time. Polls, so it works while setTimeout is mocked. */
async function settles(promise, ms) {
  let done = false;
  let failure = null;
  promise.then(() => { done = true; }, (err) => { done = true; failure = err; });
  const start = performance.now();
  while (!done && performance.now() - start < ms) await turn();
  if (failure) throw failure;
  return done;
}

/** Exactly one response, sent as XML: a whole TwiML document with nothing left unescaped. */
function assertTwiml(res) {
  assert.equal(res.sends, 1, "exactly one response");
  assert.equal(res.contentType, "text/xml");
  assert.match(res.body, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<Response>\n[\s\S]*\n<\/Response>$/);
  assert.doesNotMatch(res.body, /&(?!(?:amp|lt|gt|quot|apos);)/, "a raw & in the TwiML");
}

const continueSay = `<Say voice="Polly.Nicole">${ownerPin.SAY_CONTINUE}</Say>`;
const regather = (attempt) => ownerPin.buildOwnerPinGatherTwiml({ publicUrl: PUBLIC_URL, pollyVoice: "Polly.Nicole", pinLength: 4, attempt, retry: true, language: "en-AU", escapeXml });

describe("owner PIN TwiML builders", () => {
  it("emits the spec's Gather verbatim, with the attempt on the signed action URL", () => {
    const xml = ownerPin.buildOwnerPinGatherTwiml({ publicUrl: PUBLIC_URL, pollyVoice: "Polly.Nicole", pinLength: 6, attempt: 2, retry: true, language: "en-AU", escapeXml });
    for (const attr of ['input="dtmf speech"', 'numDigits="6"', 'speechModel="numbers_and_commands"', 'speechTimeout="2"', 'timeout="6"', 'language="en-AU"', 'hints="0,1,2,3,4,5,6,7,8,9"', 'actionOnEmptyResult="true"', 'action="https://voice.example/twiml/owner-pin?attempt=2"', 'method="POST"']) {
      assert.ok(xml.includes(attr), `missing ${attr}`);
    }
    // The prompt sits INSIDE the Gather (keypad entry interrupts it) and nothing follows it:
    // actionOnEmptyResult makes Twilio post the action even on silence.
    assert.match(xml, /<Gather [^>]*>\n {4}<Say voice="Polly\.Nicole">That&apos;s not right, try again\.<\/Say>\n {2}<\/Gather>\n<\/Response>$/);
    assert.equal(escapeXml(ownerPin.SAY_RETRY), "That&apos;s not right, try again.");
    const first = ownerPin.buildOwnerPinGatherTwiml({ publicUrl: "https://v", pollyVoice: "Polly.Joanna", pinLength: 4, attempt: 1, retry: false, language: "en-US", escapeXml });
    assert.ok(first.includes(`<Say voice="Polly.Joanna">${ownerPin.SAY_PROMPT}</Say>`));
    assert.ok(first.includes('action="https://v/twiml/owner-pin?attempt=1"') && first.includes('numDigits="4"') && first.includes('language="en-US"'));
  });

  it("escapes every interpolated value", () => {
    const xml = ownerPin.buildOwnerPinGatherTwiml({ publicUrl: 'https://v.example/x?a=1&b="2"', pollyVoice: 'Polly."N"', pinLength: 4, attempt: 1, retry: false, language: 'en-AU"><Hangup/><Say>', escapeXml });
    assert.ok(xml.includes('action="https://v.example/x?a=1&amp;b=&quot;2&quot;/twiml/owner-pin?attempt=1"'));
    assert.ok(xml.includes('voice="Polly.&quot;N&quot;"'));
    assert.ok(!xml.includes("<Hangup/>"));
    assert.doesNotMatch(xml, /&(?!(?:amp|lt|gt|quot|apos);)/);
  });

  it("buildConnectStreamTwiml is /twiml's <Connect><Stream>, optionally after one <Say>", () => {
    assert.equal(
      ownerPin.buildConnectStreamTwiml({ wsUrl: WS_URL, token: "a&b", escapeXml }),
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://voice.example/ws/audio">
      <Parameter name="auth_token" value="a&amp;b" />
    </Stream>
  </Connect>
</Response>`,
    );
    const withSay = ownerPin.buildConnectStreamTwiml({ wsUrl: WS_URL, token: "t", escapeXml, sayFirst: { voice: "Polly.Nicole", text: "It's <fine>" } });
    assert.ok(withSay.includes('<Response>\n  <Say voice="Polly.Nicole">It&apos;s &lt;fine&gt;</Say>\n  <Connect>'));
  });

  it("HANGUP_TWIML is a bare hang-up", () => {
    assert.equal(ownerPin.HANGUP_TWIML, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup/>\n</Response>');
  });

  it("picks en-AU only for AU orgs", () => {
    assert.equal(ownerPin.gatherLanguageFor("AU"), "en-AU");
    assert.equal(ownerPin.gatherLanguageFor("au"), "en-AU");
    assert.equal(ownerPin.gatherLanguageFor("US"), "en-US");
    assert.equal(ownerPin.gatherLanguageFor(undefined), "en-US");
    assert.equal(ownerPin.gatherLanguageFor(null), "en-US");
  });

  it("parseAttempt accepts exactly 1..3 from the query string and falls back to 1", () => {
    assert.equal(ownerPin.parseAttempt("1"), 1);
    assert.equal(ownerPin.parseAttempt("2"), 2);
    assert.equal(ownerPin.parseAttempt("3"), 3);
    for (const raw of ["4", "0", "-1", "2.5", "1e0", "x", "", undefined, null, 2, ["2"], { a: "2" }]) {
      assert.equal(ownerPin.parseAttempt(raw), 1, `parseAttempt(${util.inspect(raw)})`);
    }
  });
});

describe("handleOwnerPin", () => {
  let prevFlag;
  beforeEach(() => { prevFlag = process.env.OWNER_ASSISTANT_ENABLED; process.env.OWNER_ASSISTANT_ENABLED = "true"; });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.OWNER_ASSISTANT_ENABLED;
    else process.env.OWNER_ASSISTANT_ENABLED = prevFlag;
  });

  describe("outcomes (spec §1)", () => {
    it("hangs up, with a logged error, when the phone record vanished mid-call (spec §8)", async () => {
      const h = makeHarness({ phone: null, body: { Digits: PIN } });
      const lines = await run(h);
      assertTwiml(h.res);
      assert.equal(h.res.body, ownerPin.HANGUP_TWIML);
      assert.equal(h.state.tokens.length, 0);
      assert.equal(h.state.rpc.length, 0);
      assert.deepEqual(h.state.lookups, [{ called: "+61255550000", opts: { callSid: "CA1" } }]);
      assert.ok(lines.some((l) => l.startsWith("error| ") && l.includes("No phone record") && l.includes("CA1")), lines.join("\n"));
    });

    it("no input → the receptionist: nothing counted or verified, no owner_auth stamp, no <Say>", async (t) => {
      const verify = t.mock.method(ownerAuth, "verifyPin");
      for (const body of [{ Digits: "", SpeechResult: "" }, {}, { Digits: "#" }, { SpeechResult: "um, hello?" }]) {
        const h = makeHarness({ body, query: { attempt: "2" } });
        await run(h);
        assertTwiml(h.res);
        assert.equal(h.state.rpc.length, 0, JSON.stringify(body));
        assert.deepEqual(extras(h), [{}]);
        assert.equal(h.res.body, ownerPin.buildConnectStreamTwiml({ wsUrl: WS_URL, token: "tok1", escapeXml }));
      }
      assert.equal(verify.mock.callCount(), 0);
    });

    it("right keyed PIN → both windows counted, then the owner stream; only the 15-minute window is cleared and last_verified_at is stamped", async () => {
      const h = makeHarness({ body: { Digits: PIN } });
      const lines = await run(h);
      assertTwiml(h.res);
      assert.deepEqual(h.state.rpc, [
        { fn: "check_rate_limit_bucket", args: { p_key: KEY_15M, p_window_ms: 900000, p_max_requests: 5 } },
        { fn: "check_rate_limit_bucket", args: { p_key: KEY_24H, p_window_ms: 86400000, p_max_requests: 20 } },
      ]);
      assert.equal(h.state.tokens.length, 1);
      const [token] = h.state.tokens;
      assert.deepEqual(token.extra, VERIFIED);
      assert.equal(token.phoneRecord, PHONE);
      assert.equal(token.called, "+61255550000");
      assert.equal(token.from, "+61400000001");
      assert.equal(token.reconnect, undefined);
      assert.deepEqual(h.state.names, ["org-1"]);
      assert.deepEqual(h.state.deletes, [{ table: "rate_limit_buckets", col: "key", val: KEY_15M }]);
      assert.equal(h.state.updates.length, 1);
      const [update] = h.state.updates;
      assert.deepEqual([update.table, update.col, update.val], ["owner_access", "organization_id", "org-1"]);
      assert.deepEqual(Object.keys(update.payload), ["last_verified_at"]);
      assert.ok(!Number.isNaN(Date.parse(update.payload.last_verified_at)));
      assert.equal(h.res.body, ownerPin.buildConnectStreamTwiml({ wsUrl: WS_URL, token: "tok1", escapeXml }), "the owner stream, with no <Say>");
      assert.ok(!lines.some((l) => l.includes("[ALERT:")), lines.join("\n"));
    });

    it("right spoken PIN works the same; a failed last_verified_at write never blocks the call", async () => {
      for (const update of ["reject", { code: "42501", message: "permission denied for table owner_access" }]) {
        const h = makeHarness({ body: { SpeechResult: SAID_PIN }, update });
        const lines = await run(h);
        assertTwiml(h.res);
        assert.deepEqual(extras(h), [VERIFIED]);
        assert.ok(lines.some((l) => l.includes("last_verified_at")), lines.join("\n"));
      }
    });

    it("a right PIN on the third and last attempt still gets in", async () => {
      const h = makeHarness({ body: { Digits: PIN }, query: { attempt: "3" } });
      await run(h);
      assertTwiml(h.res);
      assert.deepEqual(extras(h), [VERIFIED]);
    });

    it("wrong PIN with tries left → counted in both windows BEFORE it is checked, then a re-Gather with attempt+1 (real scrypt verify)", async () => {
      for (const [body, attempt] of [[{ Digits: WRONG }, "1"], [{ SpeechResult: SAID_WRONG }, "2"]]) {
        const h = makeHarness({ body, query: { attempt } });
        await run(h);
        assertTwiml(h.res);
        assert.equal(h.state.tokens.length, 0);
        assert.deepEqual(h.state.rpc.map((r) => r.args.p_key), [KEY_15M, KEY_24H]);
        assert.equal(h.state.deletes.length + h.state.updates.length + h.state.names.length, 0, "nothing of the verified path runs");
        assert.equal(h.res.body, regather(Number(attempt) + 1));
      }
    });

    it("third wrong PIN in the call → 'Continuing as a normal call' + the receptionist, stamped failed", async () => {
      const h = makeHarness({ body: { Digits: WRONG }, query: { attempt: "3" } });
      await run(h);
      assertTwiml(h.res);
      assert.deepEqual(extras(h), [{ ownerAuth: "failed" }]);
      assert.equal(h.state.rpc.length, 2);
      assert.ok(h.res.body.includes(`${continueSay}\n  <Connect>`), h.res.body);
    });

    it("wrong length is a per-call failure that is never counted: no RPC, no verify; the last try goes to the receptionist", async (t) => {
      const verify = t.mock.method(ownerAuth, "verifyPin");
      for (const [body, attempt] of [[{ Digits: "48261" }, "1"], [{ Digits: "482" }, "2"], [{ SpeechResult: "four eight two" }, "1"]]) {
        const h = makeHarness({ body, query: { attempt } });
        await run(h);
        assertTwiml(h.res);
        assert.equal(h.state.rpc.length, 0, JSON.stringify(body));
        assert.equal(h.state.tokens.length, 0);
        assert.equal(h.res.body, regather(Number(attempt) + 1));
      }
      const last = makeHarness({ body: { Digits: "48261" }, query: { attempt: "3" } });
      await run(last);
      assertTwiml(last.res);
      assert.equal(last.state.rpc.length, 0);
      assert.deepEqual(extras(last), [{ ownerAuth: "failed" }]);
      assert.ok(last.res.body.includes(continueSay));
      assert.equal(verify.mock.callCount(), 0);
    });

    it("15-minute window exhausted → locked, right PIN or wrong: never verified, the 24-hour window untouched, no page", async (t) => {
      const verify = t.mock.method(ownerAuth, "verifyPin");
      for (const digits of [PIN, WRONG]) {
        const h = makeHarness({ body: { Digits: digits }, count: 6 });
        const lines = await run(h);
        assertTwiml(h.res);
        assert.deepEqual(h.state.rpc.map((r) => r.args.p_key), [KEY_15M]);
        assert.deepEqual(extras(h), [{ ownerAuth: "locked" }]);
        assert.ok(h.res.body.includes(`${continueSay}\n  <Connect>`), h.res.body);
        assert.equal(h.state.deletes.length + h.state.updates.length + h.state.names.length, 0);
        assert.ok(!lines.some((l) => l.includes("[ALERT:")), "a lockout is not an infrastructure fault");
        assert.equal(h.state.captured.length, 0);
      }
      assert.equal(verify.mock.callCount(), 0);
    });

    it("24-hour window exhausted → locked even with the right PIN", async (t) => {
      const verify = t.mock.method(ownerAuth, "verifyPin");
      const h = makeHarness({ body: { Digits: PIN }, dayCount: 21 });
      await run(h);
      assertTwiml(h.res);
      assert.deepEqual(h.state.rpc.map((r) => r.args.p_key), [KEY_15M, KEY_24H]);
      assert.deepEqual(extras(h), [{ ownerAuth: "locked" }]);
      assert.ok(h.res.body.includes(continueSay));
      assert.equal(h.state.deletes.length, 0);
      assert.equal(verify.mock.callCount(), 0);
    });

    it("an RPC failure fails CLOSED: locked + [ALERT:error] + Sentry, even with the right PIN", async (t) => {
      const verify = t.mock.method(ownerAuth, "verifyPin");
      const h = makeHarness({ body: { Digits: PIN }, rpcThrows: true });
      const lines = await run(h);
      assertTwiml(h.res);
      assert.deepEqual(extras(h), [{ ownerAuth: "locked" }]);
      assert.ok(h.res.body.includes(continueSay));
      assert.equal(verify.mock.callCount(), 0);
      assert.equal(h.state.captured.length, 1);
      assert.ok(h.state.captured[0] instanceof Error && h.state.captured[0].message === "rpc down");
      const [scope] = h.state.scopes;
      assert.equal(scope._tags.service, "owner_pin");
      assert.equal(scope._level, "error");
      assert.deepEqual([scope._extras.callSid, scope._extras.organizationId], ["CA1", "org-1"]);
      assert.ok(lines.some((l) => l.startsWith("error| [ALERT:error] [OwnerPin]") && l.includes("check_rate_limit_bucket") && l.includes("rpc down")), lines.join("\n"));
    });

    it("anything but an explicit 'not locked' from the lockout check is locked and paged", async (t) => {
      const verify = t.mock.method(ownerAuth, "verifyPin");
      let result;
      t.mock.method(ownerAuth, "countPinAttempt", async () => result);
      for (const r of [undefined, null, { reason: "ok" }, { locked: "false", reason: "ok" }, { locked: 0, reason: "ok" }]) {
        result = r;
        const h = makeHarness({ body: { Digits: PIN } });
        const lines = await run(h);
        assertTwiml(h.res);
        assert.deepEqual(extras(h), [{ ownerAuth: "locked" }], util.inspect(r));
        assert.ok(lines.some((l) => l.startsWith("error| [ALERT:error] [OwnerPin]")), util.inspect(r));
        assert.equal(h.state.captured.length, 1, util.inspect(r));
      }
      assert.equal(verify.mock.callCount(), 0);
    });

    it("honours the row's pin_length: a 6-digit PIN gets in, a 4-digit entry is the wrong length", async () => {
      const access6 = { ...ACCESS, pin_hash: ownerAuth.hashPin("482613", SALT), pin_length: 6 };
      const phone6 = { ...PHONE, organizations: { ...PHONE.organizations, owner_access: access6 } };
      const right = makeHarness({ phone: phone6, body: { Digits: "482613" } });
      await run(right);
      assert.deepEqual(extras(right), [VERIFIED]);
      const short = makeHarness({ phone: phone6, body: { Digits: PIN }, query: { attempt: "1" } });
      await run(short);
      assert.equal(short.state.rpc.length, 0);
      assert.equal(short.res.body, ownerPin.buildOwnerPinGatherTwiml({ publicUrl: PUBLIC_URL, pollyVoice: "Polly.Nicole", pinLength: 6, attempt: 2, retry: true, language: "en-AU", escapeXml }));
    });

    it("a PostgREST error object is paged by its message only", async () => {
      const h = makeHarness({ body: { Digits: PIN }, rpcResult: { data: null, error: { code: "PGRST301", message: "JWT expired", details: null, hint: null } } });
      const lines = await run(h);
      assertTwiml(h.res);
      assert.deepEqual(extras(h), [{ ownerAuth: "locked" }]);
      assert.ok(h.state.captured[0] instanceof Error && h.state.captured[0].message === "JWT expired");
      assert.ok(lines.some((l) => l.startsWith("error| [ALERT:error] [OwnerPin]") && l.includes("JWT expired")), lines.join("\n"));
      assert.ok(!lines.some((l) => l.includes("[object Object]") || l.includes("details:")), lines.join("\n"));
    });

    it("a caller who no longer matches at action time → the receptionist, nothing counted or verified", async (t) => {
      const verify = t.mock.method(ownerAuth, "verifyPin");
      const variants = [
        { body: { Digits: PIN, ForwardedFrom: "+61299990000" } },
        { body: { Digits: PIN, From: "+61400000002" } },
        { body: { Digits: PIN }, phone: { ...PHONE, organizations: { ...PHONE.organizations, owner_access: { ...ACCESS, enabled: false } } } },
        { body: { Digits: PIN }, phone: { ...PHONE, organizations: { ...PHONE.organizations, owner_access: null } } },
      ];
      for (const v of variants) {
        const h = makeHarness(v);
        await run(h);
        assertTwiml(h.res);
        assert.equal(h.state.rpc.length, 0);
        assert.deepEqual(extras(h), [{ ownerAuth: "failed" }]);
        assert.ok(h.res.body.includes("<Connect>"));
      }
      assert.equal(verify.mock.callCount(), 0);
    });

    it("flag off at action time → the receptionist, nothing counted", async () => {
      process.env.OWNER_ASSISTANT_ENABLED = "false";
      const h = makeHarness({ body: { Digits: PIN } });
      await run(h);
      assertTwiml(h.res);
      assert.equal(h.state.rpc.length, 0);
      assert.deepEqual(extras(h), [{ ownerAuth: "failed" }]);
    });
  });

  describe("ordering and the fire-and-forget writes", () => {
    it("counts BOTH windows, to completion, before verifyPin is reached, right PIN or wrong", async (t) => {
      const realVerify = ownerAuth.verifyPin;
      let h;
      t.mock.method(ownerAuth, "verifyPin", async (args) => { h.state.events.push("verify"); return realVerify(args); });
      for (const digits of [PIN, WRONG]) {
        h = makeHarness({ body: { Digits: digits } });
        await run(h);
        assert.deepEqual(h.state.events, [`rpc:${KEY_15M}`, `rpc-done:${KEY_15M}`, `rpc:${KEY_24H}`, `rpc-done:${KEY_24H}`, "verify"], digits === PIN ? "right PIN" : "wrong PIN");
      }
    });

    it("a failed 15-minute reset pages ([ALERT:error] + Sentry) by its message only and never costs the owner the call", async () => {
      const h = makeHarness({ body: { Digits: PIN }, delete: { code: "42501", message: "permission denied for table rate_limit_buckets", details: null, hint: null } });
      const lines = await run(h);
      assertTwiml(h.res);
      assert.deepEqual(extras(h), [VERIFIED]);
      assert.ok(lines.some((l) => l.startsWith("error| [ALERT:error] [OwnerPin] resetPinAttempts failed") && l.includes("permission denied for table rate_limit_buckets")), lines.join("\n"));
      assert.ok(!lines.some((l) => l.includes("[object Object]") || l.includes("42501")), lines.join("\n"));
      assert.equal(h.state.captured.length, 1);
      assert.ok(h.state.captured[0] instanceof Error && h.state.captured[0].message === "permission denied for table rate_limit_buckets");
      assert.equal(h.state.scopes[0]._tags.service, "owner_pin");
    });

    it("the reset and the last_verified_at write never delay the TwiML", async () => {
      const h = makeHarness({ body: { Digits: PIN }, delete: "pending", update: "pending" });
      await run(h);
      assertTwiml(h.res);
      assert.deepEqual(extras(h), [VERIFIED]);
      assert.equal(h.state.deletes.length, 1);
      assert.equal(h.state.updates.length, 1);
    });
  });

  describe("the owner's first name", () => {
    it("a stalled name lookup is abandoned after 1500 ms: the owner is greeted without a name, never left waiting", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      for (const m of LOG_METHODS) t.mock.method(console, m, () => {});
      let lookupStarted;
      const started = new Promise((resolve) => { lookupStarted = resolve; });
      const h = makeHarness({ body: { Digits: PIN }, loadOwnerFirstName: (orgId) => { lookupStarted(orgId); return new Promise(() => {}); } });
      const done = ownerPin.handleOwnerPin(h.req, h.res, { deps: h.deps });
      assert.equal(await started, "org-1");
      try {
        t.mock.timers.tick(1499);
        for (let i = 0; i < 10; i++) await turn();
        assert.equal(h.res.body, null, "answered before the 1500 ms budget was spent");
      } finally {
        t.mock.timers.tick(1);
      }
      assert.equal(await settles(done, 3000), true, "the owner must be answered once the 1500 ms budget is spent");
      assertTwiml(h.res);
      assert.deepEqual(extras(h), [{ ownerMode: true, ownerAuth: "verified", ownerFirstName: null }]);
    });

    it("a failing name lookup costs the greeting its name, never the call", async () => {
      const h = makeHarness({ body: { Digits: PIN }, loadOwnerFirstName: async () => { throw new Error("pool exhausted"); } });
      const lines = await run(h);
      assertTwiml(h.res);
      assert.deepEqual(extras(h), [{ ownerMode: true, ownerAuth: "verified", ownerFirstName: null }]);
      assert.ok(lines.some((l) => l.includes("pool exhausted")), lines.join("\n"));
    });
  });

  describe("always answers with TwiML", () => {
    it("an unexpected fault after a right PIN fails toward the receptionist, never owner mode, with [ALERT:error] + Sentry", async () => {
      const h = makeHarness({ body: { Digits: PIN }, failToken: (extra) => extra && extra.ownerMode === true });
      const lines = await run(h);
      assertTwiml(h.res);
      assert.deepEqual(extras(h), [{ ownerAuth: "failed" }]);
      assert.ok(h.res.body.includes(`${continueSay}\n  <Connect>`), h.res.body);
      assert.ok(lines.some((l) => l.startsWith("error| [ALERT:error] [OwnerPin]") && l.includes("token store unavailable")), lines.join("\n"));
      assert.equal(h.state.captured.length, 1);
    });

    it("hangs up when not even the receptionist call can be built", async () => {
      const h = makeHarness({ body: { Digits: PIN }, failToken: () => true });
      const lines = await run(h);
      assertTwiml(h.res);
      assert.equal(h.res.body, ownerPin.HANGUP_TWIML);
      assert.ok(lines.some((l) => l.includes("[ALERT:error] [OwnerPin]")), lines.join("\n"));
    });

    it("a phone lookup that throws hangs up: there is no org to continue as", async () => {
      const h = makeHarness({ body: { Digits: PIN }, lookupRejects: true });
      const lines = await run(h);
      assertTwiml(h.res);
      assert.equal(h.res.body, ownerPin.HANGUP_TWIML);
      assert.equal(h.state.tokens.length, 0);
      assert.ok(lines.some((l) => l.includes("[ALERT:error] [OwnerPin]") && l.includes("lookup exploded")), lines.join("\n"));
    });
  });

  it("never logs, pages, stamps or echoes the PIN, keyed or spoken, on any path", async () => {
    const LEAK = /4826|9371|four eight two six|nine three seven one/i;
    const scenarios = [
      { body: { Digits: PIN } },
      { body: { SpeechResult: SAID_PIN } },
      { body: { Digits: WRONG }, query: { attempt: "1" } },
      { body: { SpeechResult: SAID_WRONG }, query: { attempt: "3" } },
      { body: { Digits: "48261" }, query: { attempt: "1" } },
      { body: { Digits: "48261" }, query: { attempt: "3" } },
      { body: { Digits: PIN }, count: 6 },
      { body: { Digits: PIN }, rpcThrows: true },
      { body: { Digits: PIN }, delete: { message: "permission denied" } },
      { body: { Digits: PIN }, failToken: (extra) => extra && extra.ownerMode === true },
      { body: { Digits: PIN, ForwardedFrom: "+61299990000" } },
    ];
    for (const s of scenarios) {
      const label = JSON.stringify({ body: s.body, query: s.query, count: s.count, rpcThrows: s.rpcThrows });
      const h = makeHarness(s);
      const lines = await run(h);
      assert.ok(lines.length > 0, `${label}: this path should log something`);
      for (const l of lines) assert.doesNotMatch(l, LEAK, `${label}: a log line leaks the PIN`);
      assert.doesNotMatch(h.res.body, LEAK, `${label}: the TwiML echoes the PIN`);
      assert.doesNotMatch(util.inspect(extras(h)), LEAK, `${label}: the token extras carry the PIN`);
      for (const scope of h.state.scopes) assert.doesNotMatch(util.inspect(scope, { depth: 8 }), LEAK, `${label}: a Sentry scope carries the PIN`);
      for (const err of h.state.captured) assert.doesNotMatch(`${err && err.message} ${err && err.stack}`, LEAK, `${label}: a paged error carries the PIN`);
    }
  });
});
