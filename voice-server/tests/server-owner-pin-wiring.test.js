// voice-server/tests/server-owner-pin-wiring.test.js
"use strict";
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const util = require("node:util");

const ownerAuth = require("../lib/owner-auth");
const ownerPin = require("../lib/route-handlers/owner-pin");
const streamToken = require("../lib/stream-token");
const { maskPhone } = require("../lib/mask-phone");
const { getPollyVoice } = require("../lib/polly-voice");
const { SENTRY_REASONS, setReasonTag } = require("../lib/sentry-reasons");
const { CallSession } = require("../call-session");

// SCRUM-587 — pins the PIN front door's wiring in the server.js monolith
// (idiom: server-reschedule-ledger-wiring.test.js). What these guard: the
// owner check must sit AFTER the kill switch + demo gate and BEFORE ring-first
// (an owner whose ring-first target is their own mobile must not ring
// themselves); the action route must be Twilio-signed; owner mode must come
// from the server-side token only; and the PIN must never be logged.
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const sessionSrc = fs.readFileSync(path.join(__dirname, "..", "call-session.js"), "utf8");
const pinSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "route-handlers", "owner-pin.js"), "utf8");

describe("SCRUM-587: owner PIN front-door wiring", () => {
  it("server.js imports the owner modules", () => {
    assert.match(src, /require\("\.\/lib\/owner-auth"\)/);
    assert.match(src, /require\("\.\/lib\/route-handlers\/owner-pin"\)/);
    assert.match(src, /require\("\.\/lib\/owner-context"\)/);
  });

  it("the /twiml owner check runs after the demo gate and before ring-first", () => {
    const twimlStart = src.indexOf('app.post("/twiml", async (req, res) => {');
    const demoGate = src.indexOf("isDemoLineCall(called, phoneRecord)", twimlStart);
    const ownerCheck = src.indexOf("isOwnerCall({", twimlStart);
    const ringFirst = src.indexOf("getAnswerMode(called, phoneRecord)", twimlStart);
    assert.ok(twimlStart > 0 && demoGate > twimlStart && ownerCheck > demoGate && ringFirst > ownerCheck,
      `order wrong: twiml=${twimlStart} demo=${demoGate} owner=${ownerCheck} ringFirst=${ringFirst}`);
  });

  it("the owner check reads the flag at call time and fails toward a customer call", () => {
    assert.match(src, /isOwnerCall\(\{ from, forwardedFrom: req\.body\.ForwardedFrom, ownerAccess, enabled: ownerAssistantEnabled\(\) \}\)/);
    assert.match(src, /\[ALERT:error\] \[OwnerPin\] owner check failed — continuing as a customer call/);
  });

  it("/twiml/owner-pin is registered, Twilio-signed, and delegates to the injectable handler", () => {
    const route = src.indexOf('app.post("/twiml/owner-pin", async (req, res) => {');
    assert.ok(route > 0, "route missing");
    const body = src.slice(route, route + 600);
    assert.match(body, /if \(!validateTwilioSignature\(req\)\)/);
    assert.match(body, /handleOwnerPin\(req, res, \{ deps: makeOwnerPinDeps\(\) \}\)/);
  });

  it("the stream token carries the owner flags server-side and the start event copies them", () => {
    assert.match(src, /function issueStreamToken\(calledNumber, callerPhone, reconnectCallSid, phoneRecord, extra = \{\}\)/);
    assert.match(src, /ownerMode: extra\.ownerMode === true/);
    assert.match(src, /session\.ownerMode = tokenData\.ownerMode === true;/);
    assert.match(src, /session\.ownerAuth = tokenData\.ownerAuth \|\| null;/);
    assert.match(src, /session\.ownerFirstName = tokenData\.ownerFirstName \|\| null;/);
  });

  it("CallSession declares the owner fields (checkJs) with owner mode OFF by default", () => {
    assert.match(sessionSrc, /this\.ownerMode = false;/);
    assert.match(sessionSrc, /this\.ownerAuth = null;/);
    assert.match(sessionSrc, /this\.ownerFirstName = null;/);
    assert.match(sessionSrc, /this\.ownerToolCalls = 0;/);
  });

  it("the PIN is never logged: no console call references Digits or SpeechResult", () => {
    const re = /console\.(log|warn|error)\([^;]*\b(Digits|SpeechResult)\b/;
    assert.doesNotMatch(src, re);
    assert.doesNotMatch(pinSrc, re);
  });

  it("owner mode is never read from Twilio custom parameters", () => {
    assert.doesNotMatch(src, /customParameters\?\.(ownerMode|owner_mode|ownerAuth)/);
    // Census: the stream's custom parameters are read for the opaque auth
    // token and nothing else. A new read (destructured or not) must be a
    // deliberate edit here — anything a client sends can be forged.
    const reads = (src.match(/^.*customParameters.*$/gm) || []).map((l) => l.trim());
    assert.deepEqual(reads, [
      "const { callSid, streamSid, customParameters } = msg.start;",
      "const token = customParameters?.auth_token;",
    ]);
  });
});

describe("SCRUM-587: controller overrides — pins", () => {
  it("issueStreamToken mints a nonce'd token and stores the phone record WITHOUT owner_access", () => {
    const start = src.indexOf("function issueStreamToken(");
    const fn = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(fn, /const token = mintStreamToken\(WS_SECRET\);/);
    assert.match(fn, /pendingTokens\.set\(token, \{/);
    assert.match(fn, /phoneRecord: withoutOwnerAccess\(phoneRecord\),/);
    assert.doesNotMatch(fn, /^\s*phoneRecord,\s*$/m, "the raw record must not be stored");
  });

  it("consumeStreamToken verifies the token format that mintStreamToken produces", () => {
    const start = src.indexOf("function consumeStreamToken(");
    const fn = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(fn, /if \(!verifyStreamToken\(WS_SECRET, token\)\) return null;/);
    assert.match(src, /require\("\.\/lib\/stream-token"\)/);
  });

  it("session.ownerMode is assigned at exactly one site: the stream start, from tokenData", () => {
    const sites = src.match(/session\.ownerMode\s*=(?!=)/g) || [];
    assert.equal(sites.length, 1, "owner mode must have one source of truth: the server-side token");
    assert.match(src, /session\.callerPhone = callerPhone;\s*\n(?:\s*\/\/[^\n]*\n)*\s*session\.ownerMode = tokenData\.ownerMode === true;/);
  });

  it("the first Gather is attempt 1, not a retry, sized and voiced for the org", () => {
    const at = src.indexOf("isOwnerCall({", src.indexOf('app.post("/twiml", async (req, res) => {'));
    const block = src.slice(at, at + 900);
    assert.match(block, /pinLength: pinLengthOf\(ownerAccess\),/);
    assert.match(block, /attempt: 1,/);
    assert.match(block, /retry: false,/);
    assert.match(block, /language: gatherLanguageFor\(phoneRecord\?\.organizations\?\.country\),/);
  });
});

// ─── Functional: the REAL server.js text, run against stubs ─────────────────

/**
 * Runs a slice of the real server.js text (from the `from` marker up to the
 * next `to` marker) as the body of a function whose parameters are exactly
 * `scope`'s keys, and returns the bindings named in `names`. server.js cannot
 * be required (it validates live env and binds a port on load), and a source
 * pin cannot catch an inverted gate (the SCRUM-576 lesson in
 * gemini-live-greeting-guard-functional.test.js), so these run the code
 * itself. A moved marker fails the assert; a missing stub is a ReferenceError.
 * The evaluated text is this repo's own checked-in server.js and `names` are
 * literals in this file: nothing external reaches the Function body.
 */
function runServerSlice({ from, to, scope, names }) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  const params = Object.keys(scope);
  const body = `${src.slice(start, end)}\nreturn { ${names.join(", ")} };`;
  return new Function(...params, body)(...params.map((p) => scope[p]));
}

const { escapeXml } = runServerSlice({
  from: "function escapeXml(s) {",
  to: "/**\n * Validate Twilio request signature.",
  scope: {},
  names: ["escapeXml"],
});

const WS_SECRET = "test-twilio-auth-token";
const PUBLIC_URL = "https://voice.example";
const WS_URL = "wss://voice.example/ws/audio";
const CR_WS_URL = "wss://voice.example/ws/conversationrelay";
const BUSINESS = "+61255550000";
const OWNER_MOBILE = "+61400000001";
const CUSTOMER = "+61400000999";
const SALT = "00112233445566778899aabbccddeeff";
const PIN = "482615";
const PIN_HASH = ownerAuth.hashPin(PIN, SALT);

const ownerAccessRow = () => ({ phone_e164: OWNER_MOBILE, pin_hash: PIN_HASH, pin_salt: SALT, pin_length: 6, enabled: true });
function phoneRecordFor({ country = "AU", owner = true } = {}) {
  return {
    id: "pn-1",
    organization_id: "org-1",
    assistant_id: "as-1",
    ai_enabled: true,
    organizations: {
      name: "Copperline Plumbing",
      country,
      recording_consent_mode: "auto",
      ...(owner ? { owner_access: ownerAccessRow() } : {}),
    },
  };
}

/** console stand-in that records "<method>| <text>" lines. */
function recordingConsole(lines) {
  const rec = (m) => (...args) => lines.push(`${m}| ${args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 8 }))).join(" ")}`);
  return { log: rec("log"), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
}

/** server.js's token section, live: pendingTokens + issueStreamToken + consumeStreamToken. */
function loadTokenSlice(lines = []) {
  return runServerSlice({
    from: "const pendingTokens = new Map();",
    to: "// Clean up expired tokens every 60s",
    scope: {
      WS_SECRET,
      crypto: nodeCrypto,
      mintStreamToken: streamToken.mintStreamToken,
      verifyStreamToken: streamToken.verifyStreamToken,
      withoutOwnerAccess: streamToken.withoutOwnerAccess,
      console: recordingConsole(lines),
    },
    names: ["pendingTokens", "TOKEN_TTL_MS", "issueStreamToken", "consumeStreamToken"],
  });
}

/** Runs fn with Date.now pinned to a clock the test controls (restored after). */
function withClock(fn) {
  const realNow = Date.now;
  const clock = { t: realNow() };
  Date.now = () => clock.t;
  try {
    return fn(clock);
  } finally {
    Date.now = realNow;
  }
}

const ownerExtra = () => ({ ownerMode: true, ownerAuth: "verified", ownerFirstName: "Dave" });
const TOKEN_KEYS = ["calledNumber", "callerPhone", "reconnectCallSid", "phoneRecord", "ownerMode", "ownerAuth", "ownerFirstName"].sort();

describe("SCRUM-587: stream token — server.js issueStreamToken / consumeStreamToken, run for real", () => {
  it("two tokens issued in the same millisecond differ, and each resolves to its OWN entry", () => {
    const tokens = loadTokenSlice();
    withClock(() => {
      const owner = tokens.issueStreamToken(BUSINESS, OWNER_MOBILE, undefined, phoneRecordFor(), ownerExtra());
      const customer = tokens.issueStreamToken(BUSINESS, CUSTOMER, undefined, phoneRecordFor());
      assert.equal(owner.split(".")[0], customer.split(".")[0], "precondition: same millisecond");
      assert.notEqual(owner, customer);
      assert.equal(tokens.pendingTokens.size, 2, "the second set must not overwrite the first");

      // The customer's stream starts first: it must get the customer entry, never the owner's.
      const c = tokens.consumeStreamToken(customer);
      assert.equal(c.callerPhone, CUSTOMER);
      assert.equal(c.ownerMode, false);
      assert.equal(c.ownerAuth, null);
      assert.equal(c.ownerFirstName, null);

      const o = tokens.consumeStreamToken(owner);
      assert.equal(o.callerPhone, OWNER_MOBILE);
      assert.equal(o.ownerMode, true);
      assert.equal(o.ownerAuth, "verified");
      assert.equal(o.ownerFirstName, "Dave");
    });
  });

  it("returns exactly the call metadata + the three owner fields, once (single use)", () => {
    const tokens = loadTokenSlice();
    withClock(() => {
      const record = phoneRecordFor({ owner: false });
      const token = tokens.issueStreamToken(BUSINESS, CUSTOMER, "CA-reconnect", record);
      const data = tokens.consumeStreamToken(token);
      assert.deepEqual(Object.keys(data).sort(), TOKEN_KEYS);
      assert.equal(data.calledNumber, BUSINESS);
      assert.equal(data.reconnectCallSid, "CA-reconnect");
      assert.equal(data.phoneRecord, record, "a record with no owner_access is stored as-is (flag-off: unchanged)");
      assert.equal(tokens.consumeStreamToken(token), null, "a token is single-use");
    });
  });

  it("stores the phone record WITHOUT organizations.owner_access and leaves the caller's record intact", () => {
    const lines = [];
    const tokens = loadTokenSlice(lines);
    withClock(() => {
      const record = phoneRecordFor();
      const token = tokens.issueStreamToken(BUSINESS, OWNER_MOBILE, undefined, record, ownerExtra());
      const stored = JSON.stringify([...tokens.pendingTokens.values()]);
      assert.doesNotMatch(stored, /owner_access|pin_hash|pin_salt/);
      assert.ok(!stored.includes(PIN_HASH) && !stored.includes(SALT), "no PIN material in pendingTokens");
      assert.deepEqual(record, phoneRecordFor(), "the /twiml handler's record is not mutated");

      const data = tokens.consumeStreamToken(token);
      assert.equal(Object.hasOwn(data.phoneRecord.organizations, "owner_access"), false);
      assert.equal(data.phoneRecord.organizations.country, "AU", "the rest of the record survives");
      assert.equal(data.phoneRecord.organization_id, "org-1");
    });
    assert.deepEqual(lines, []);
  });

  it("owner mode needs a literal true; owner fields default to off", () => {
    const tokens = loadTokenSlice();
    withClock(() => {
      for (const extra of [undefined, {}, { ownerMode: "true" }, { ownerMode: 1 }, { ownerMode: {} }, { ownerAuth: 7, ownerFirstName: ["Dave"] }]) {
        const data = tokens.consumeStreamToken(tokens.issueStreamToken(BUSINESS, CUSTOMER, undefined, null, extra));
        assert.equal(data.ownerMode, false, `extra=${util.inspect(extra)}`);
        assert.equal(data.ownerAuth, null, `extra=${util.inspect(extra)}`);
        assert.equal(data.ownerFirstName, null, `extra=${util.inspect(extra)}`);
      }
      const failed = tokens.consumeStreamToken(tokens.issueStreamToken(BUSINESS, CUSTOMER, undefined, null, { ownerAuth: "failed" }));
      assert.equal(failed.ownerMode, false);
      assert.equal(failed.ownerAuth, "failed", "a customer call that failed the gate carries its stamp");
    });
  });

  it("rejects an expired token, an unknown token and an entry whose token does not verify", () => {
    const tokens = loadTokenSlice();
    withClock((clock) => {
      const stale = tokens.issueStreamToken(BUSINESS, CUSTOMER, undefined, null, ownerExtra());
      clock.t += tokens.TOKEN_TTL_MS + 1;
      assert.equal(tokens.consumeStreamToken(stale), null, "expired");
      assert.equal(tokens.consumeStreamToken(streamToken.mintStreamToken(WS_SECRET)), null, "well-formed but never issued");
      const forged = `${clock.t}.${"0".repeat(32)}.${"f".repeat(64)}`;
      tokens.pendingTokens.set(forged, { issuedAt: clock.t, calledNumber: BUSINESS, callerPhone: OWNER_MOBILE, ownerMode: true });
      assert.equal(tokens.consumeStreamToken(forged), null, "the MAC is still checked on consume");
    });
  });
});

// ─── Functional: /twiml + /twiml/owner-pin ──────────────────────────────────

// What /twiml answered before SCRUM-587 (the template at the end of the
// pre-change handler), with the stub token "TOKEN-1": the flag-off golden.
const LEGACY_STREAM_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://voice.example/ws/audio">
      <Parameter name="auth_token" value="TOKEN-1" />
    </Stream>
  </Connect>
</Response>`;

function fakeRes() {
  return {
    statusCode: 200,
    contentType: null,
    body: null,
    sends: 0,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    type(t) { this.contentType = t; return this; },
    send(b) { this.sends += 1; this.body = b; this.headersSent = true; return this; },
  };
}

const twimlReq = (body = {}) => ({ headers: {}, query: {}, body: { Called: BUSINESS, From: OWNER_MOBILE, CallSid: "CA-1", ...body } });

/** A service-role Supabase double for the real handleOwnerPin (lockout RPC, reset, last_verified_at). */
function fakeServiceRole() {
  const state = { rpc: [], writes: [] };
  return {
    state,
    rpc: async (fn, args) => {
      state.rpc.push({ fn, args });
      return { data: [{ count: 1 }], error: null };
    },
    from: (table) => ({
      delete: () => ({ eq: async (col, val) => { state.writes.push({ table, op: "delete", col, val }); return { error: null }; } }),
      update: (payload) => ({ eq: async (col, val) => { state.writes.push({ table, op: "update", payload, col, val }); return { error: null }; } }),
    }),
  };
}

/**
 * server.js from `app.post("/twiml"` up to the /texml section (the /twiml
 * handler, makeOwnerPinDeps and the /twiml/owner-pin route), live against
 * stubs. Owner helpers, TwiML builders, maskPhone and getPollyVoice are real.
 */
function makeFrontDoor(o = {}) {
  const calls = [];
  const lines = [];
  const scopes = [];
  const captured = [];
  const routes = {};
  const supabase = o.supabase || { tag: "service-role client" };
  const Sentry = {
    withScope: (fn) => {
      const scope = {
        tags: {}, extras: {}, level: null,
        setTag(k, v) { this.tags[k] = v; },
        setExtras(e) { Object.assign(this.extras, e); },
        setExtra(k, v) { this.extras[k] = v; },
        setLevel(l) { this.level = l; },
      };
      scopes.push(scope);
      fn(scope);
    },
    captureException: (err) => captured.push(err),
  };
  const issueStreamToken = o.issueStreamToken || ((...args) => {
    calls.push(["issueStreamToken", args]);
    return "TOKEN-1";
  });
  const scope = {
    app: { post: (p, handler) => { routes[p] = handler; } },
    console: recordingConsole(lines),
    validateTwilioSignature: () => { calls.push(["validateTwilioSignature"]); return o.signatureValid !== false; },
    lookupPhoneNumber: async (called, opts) => {
      calls.push(["lookupPhoneNumber", called, opts]);
      return "phoneRecord" in o ? o.phoneRecord : phoneRecordFor();
    },
    killSwitch: {
      handleAiDisabledBranch: async (req, res, args) => {
        calls.push(["killSwitch", args.provider]);
        if (!o.aiDisabled) return false;
        res.type("text/xml").send("<Response><Say>AI is off</Say></Response>");
        return true;
      },
    },
    makeKillSwitchDeps: () => ({}),
    isDemoLineCall: () => { calls.push(["isDemoLineCall"]); return o.demoLine === true; },
    checkDemoLineCall: () => ({ allowed: o.demoAllowed !== false, reason: "cap" }),
    buildDemoLineRejectTwiml: () => "<Response><Say>demo line busy</Say></Response>",
    maskPhone,
    getPollyVoice,
    getEmbeddedOwnerAccess: o.getEmbeddedOwnerAccess || ownerAuth.getEmbeddedOwnerAccess,
    isOwnerCall: ownerAuth.isOwnerCall,
    ownerAssistantEnabled: ownerAuth.ownerAssistantEnabled,
    pinLengthOf: ownerAuth.pinLengthOf,
    buildOwnerPinGatherTwiml: ownerPin.buildOwnerPinGatherTwiml,
    gatherLanguageFor: ownerPin.gatherLanguageFor,
    handleOwnerPin: o.handleOwnerPin || (async (...args) => { calls.push(["handleOwnerPin", args]); }),
    HANGUP_TWIML: ownerPin.HANGUP_TWIML,
    loadOwnerFirstName: o.loadOwnerFirstName || (async () => "Dave"),
    getSupabase: () => supabase,
    Sentry,
    getAnswerMode: async () => {
      calls.push(["getAnswerMode"]);
      return o.answerMode || { answerMode: "ai_first" };
    },
    setReasonTag,
    SENTRY_REASONS,
    issueStreamToken,
    resolveTestPipeline: () => null,
    buildConversationRelayTwiml: () => "<Response><Connect><ConversationRelay /></Connect></Response>",
    escapeXml,
    PUBLIC_URL,
    WS_URL,
    CR_WS_URL,
  };
  const { makeOwnerPinDeps } = runServerSlice({
    from: 'app.post("/twiml", async (req, res) => {',
    to: "/**\n * TeXML endpoint",
    scope,
    names: ["makeOwnerPinDeps"],
  });
  return { routes, calls, lines, scopes, captured, supabase, scope, makeOwnerPinDeps };
}

const callNames = (fd) => fd.calls.map((c) => c[0]);
const expectedGather = ({ country = "AU", pinLength = 6 } = {}) => ownerPin.buildOwnerPinGatherTwiml({
  publicUrl: PUBLIC_URL,
  pollyVoice: getPollyVoice(country),
  pinLength,
  attempt: 1,
  retry: false,
  language: ownerPin.gatherLanguageFor(country),
  escapeXml,
});

describe("SCRUM-587: /twiml owner check, run for real", () => {
  let savedFlag;
  beforeEach(() => { savedFlag = process.env.OWNER_ASSISTANT_ENABLED; });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.OWNER_ASSISTANT_ENABLED;
    else process.env.OWNER_ASSISTANT_ENABLED = savedFlag;
  });

  for (const flag of [undefined, "false"]) {
    it(`flag ${flag === undefined ? "unset" : `="${flag}"`}: /twiml is byte-identical to before, even for the registered owner`, async () => {
      if (flag === undefined) delete process.env.OWNER_ASSISTANT_ENABLED;
      else process.env.OWNER_ASSISTANT_ENABLED = flag;
      for (const from of [OWNER_MOBILE, CUSTOMER]) {
        const fd = makeFrontDoor();
        const res = fakeRes();
        await fd.routes["/twiml"](twimlReq({ From: from }), res);
        assert.equal(res.body, LEGACY_STREAM_TWIML);
        assert.equal(res.contentType, "text/xml");
        assert.equal(res.sends, 1);
        assert.deepEqual(callNames(fd), ["validateTwilioSignature", "lookupPhoneNumber", "killSwitch", "isDemoLineCall", "getAnswerMode", "issueStreamToken"]);
        const tokenArgs = fd.calls.find((c) => c[0] === "issueStreamToken")[1];
        assert.equal(tokenArgs.length, 4, "no owner extras on the plain stream token");
        assert.deepEqual(tokenArgs.slice(0, 3), [BUSINESS, from, undefined]);
        assert.deepEqual(fd.lines, [`log| [TwiML] Incoming call from=${maskPhone(from)} to=${BUSINESS}, streaming to ${WS_URL}`]);
        assert.equal(fd.captured.length, 0);
      }
    });
  }

  it("flag on + the owner's mobile: the first PIN Gather, before ring-first and before any stream token", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    const fd = makeFrontDoor({ answerMode: { answerMode: "ring_first", ringFirstNumber: OWNER_MOBILE, ringFirstTimeout: 20 } });
    const res = fakeRes();
    await fd.routes["/twiml"](twimlReq(), res);
    assert.equal(res.body, expectedGather());
    assert.match(res.body, /action="https:\/\/voice\.example\/twiml\/owner-pin\?attempt=1"/);
    assert.match(res.body, /numDigits="6"/);
    assert.match(res.body, /language="en-AU"/);
    assert.ok(res.body.includes(ownerPin.SAY_PROMPT), "first prompt, not the retry line");
    assert.equal(res.contentType, "text/xml");
    assert.deepEqual(callNames(fd), ["validateTwilioSignature", "lookupPhoneNumber", "killSwitch", "isDemoLineCall"],
      "no ring-first (the owner must not ring themselves) and no token before the PIN");
    assert.equal(fd.lines.length, 1);
    assert.match(fd.lines[0], /^log\| \[OwnerPin\] Owner caller ID matched/);
    assert.ok(!fd.lines[0].includes(OWNER_MOBILE), "the owner's number is masked in the log");
  });

  it("flag on: the Gather speaks the org's language (en-US outside AU)", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    const fd = makeFrontDoor({ phoneRecord: phoneRecordFor({ country: "US" }) });
    const res = fakeRes();
    await fd.routes["/twiml"](twimlReq(), res);
    assert.equal(res.body, expectedGather({ country: "US" }));
    assert.match(res.body, /language="en-US"/);
  });

  it("the flag is read at CALL time: one handler flips with the env", async () => {
    const fd = makeFrontDoor();
    const answer = async () => { const res = fakeRes(); await fd.routes["/twiml"](twimlReq(), res); return res.body; };
    delete process.env.OWNER_ASSISTANT_ENABLED;
    assert.equal(await answer(), LEGACY_STREAM_TWIML);
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    assert.equal(await answer(), expectedGather());
    process.env.OWNER_ASSISTANT_ENABLED = "false";
    assert.equal(await answer(), LEGACY_STREAM_TWIML);
  });

  it("flag on: customers, forwarded calls, a disabled row and a failed lookup all get the plain stream", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    const disabled = phoneRecordFor();
    disabled.organizations.owner_access.enabled = false;
    for (const [label, o, body] of [
      ["a customer", {}, { From: CUSTOMER }],
      ["a forwarded call from the owner's number", {}, { ForwardedFrom: "+61299998888" }],
      ["a disabled owner_access row", { phoneRecord: disabled }, {}],
      ["no phone record (lookup failed open)", { phoneRecord: null }, {}],
      ["an org with no owner_access", { phoneRecord: phoneRecordFor({ owner: false }) }, {}],
    ]) {
      const fd = makeFrontDoor(o);
      const res = fakeRes();
      await fd.routes["/twiml"](twimlReq(body), res);
      assert.equal(res.body, LEGACY_STREAM_TWIML, label);
      assert.ok(callNames(fd).includes("getAnswerMode"), `${label}: ring-first still consulted`);
      assert.ok(!fd.lines.some((l) => l.includes("[OwnerPin]")), `${label}: no owner log`);
    }
  });

  it("flag on: a throwing owner check pages and continues as a customer call", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    const fd = makeFrontDoor({ getEmbeddedOwnerAccess: () => { throw new Error("embed shape changed"); } });
    const res = fakeRes();
    await fd.routes["/twiml"](twimlReq(), res);
    assert.equal(res.body, LEGACY_STREAM_TWIML);
    assert.ok(fd.lines.some((l) => l.startsWith("error| [ALERT:error] [OwnerPin] owner check failed — continuing as a customer call: embed shape changed")));
    assert.equal(fd.captured.length, 1);
    assert.equal(fd.scopes[0].tags.service, "owner_pin");
    assert.deepEqual(fd.scopes[0].extras, { calledMasked: maskPhone(BUSINESS), callSid: "CA-1" });
  });

  it("the kill switch and a rejected demo-line call still win over the owner check", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    const off = makeFrontDoor({ aiDisabled: true });
    const offRes = fakeRes();
    await off.routes["/twiml"](twimlReq(), offRes);
    assert.equal(offRes.body, "<Response><Say>AI is off</Say></Response>");
    assert.equal(offRes.sends, 1);

    const demo = makeFrontDoor({ demoLine: true, demoAllowed: false });
    const demoRes = fakeRes();
    await demo.routes["/twiml"](twimlReq(), demoRes);
    assert.equal(demoRes.body, "<Response><Say>demo line busy</Say></Response>");
    assert.equal(demoRes.sends, 1);
  });
});

describe("SCRUM-587: /twiml/owner-pin route, run for real", () => {
  let savedFlag;
  beforeEach(() => { savedFlag = process.env.OWNER_ASSISTANT_ENABLED; });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.OWNER_ASSISTANT_ENABLED;
    else process.env.OWNER_ASSISTANT_ENABLED = savedFlag;
  });

  it("an unsigned request is refused before the handler runs", async () => {
    const fd = makeFrontDoor({ signatureValid: false });
    const res = fakeRes();
    await fd.routes["/twiml/owner-pin"](twimlReq({ Digits: PIN }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, "Forbidden");
    assert.deepEqual(callNames(fd), ["validateTwilioSignature"]);
  });

  it("a signed request reaches handleOwnerPin with the full real-deps bundle", async () => {
    const fd = makeFrontDoor();
    const req = twimlReq({ Digits: PIN });
    const res = fakeRes();
    await fd.routes["/twiml/owner-pin"](req, res);
    const call = fd.calls.find((c) => c[0] === "handleOwnerPin");
    assert.ok(call, "handler not called");
    const [gotReq, gotRes, { deps }] = call[1];
    assert.equal(gotReq, req);
    assert.equal(gotRes, res);
    assert.deepEqual(Object.keys(deps).sort(), [
      "Sentry", "escapeXml", "getPollyVoice", "issueStreamToken", "loadOwnerFirstName",
      "lookupPhoneNumber", "maskPhone", "publicUrl", "supabase", "wsUrl",
    ]);
    for (const k of ["Sentry", "escapeXml", "getPollyVoice", "issueStreamToken", "loadOwnerFirstName", "lookupPhoneNumber", "maskPhone"]) {
      assert.equal(deps[k], fd.scope[k], `deps.${k} is server.js's own ${k}`);
    }
    assert.equal(deps.supabase, fd.supabase, "the service-role client from getSupabase()");
    assert.equal(deps.publicUrl, PUBLIC_URL);
    assert.equal(deps.wsUrl, WS_URL);
  });

  it("a handler that throws still answers Twilio (hang-up), once", async () => {
    const fd = makeFrontDoor({ handleOwnerPin: async () => { throw new Error("boom"); } });
    const res = fakeRes();
    await fd.routes["/twiml/owner-pin"](twimlReq({ Digits: PIN }), res);
    assert.equal(res.sends, 1);
    assert.equal(res.body, ownerPin.HANGUP_TWIML);
    assert.match(res.body, /<Response>\s*<Hangup\/>\s*<\/Response>/);
    assert.deepEqual(fd.lines, ["error| [ALERT:error] [OwnerPin] handler threw: boom"], "one alert line, the message only");

    const late = makeFrontDoor({ handleOwnerPin: async (req, res) => { res.type("text/xml").send("<Response/>"); throw new Error("after send"); } });
    const lateRes = fakeRes();
    await late.routes["/twiml/owner-pin"](twimlReq(), lateRes);
    assert.equal(lateRes.sends, 1, "no second response after the handler already answered");
  });

  it("end to end: the owner's PIN becomes an owner token that resolves without the PIN material; a silent caller stays a customer", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    const tokens = loadTokenSlice();
    const supabase = fakeServiceRole();
    const fd = makeFrontDoor({ issueStreamToken: tokens.issueStreamToken, handleOwnerPin: ownerPin.handleOwnerPin, supabase });
    const LOGS = ["log", "info", "warn", "error", "debug"];
    const globalLines = [];
    const saved = LOGS.map((m) => console[m]);
    for (const m of LOGS) console[m] = (...a) => globalLines.push(a.map((x) => (typeof x === "string" ? x : util.inspect(x, { depth: 8 }))).join(" "));
    try {
      const gather = fakeRes();
      await fd.routes["/twiml"](twimlReq(), gather);
      assert.equal(gather.body, expectedGather());

      const verified = fakeRes();
      await fd.routes["/twiml/owner-pin"]({ headers: {}, query: { attempt: "1" }, body: { Called: BUSINESS, From: OWNER_MOBILE, CallSid: "CA-1", Digits: PIN } }, verified);
      const ownerToken = /name="auth_token" value="([^"]+)"/.exec(verified.body)[1];
      const owner = tokens.consumeStreamToken(ownerToken);
      assert.equal(owner.ownerMode, true);
      assert.equal(owner.ownerAuth, "verified");
      assert.equal(owner.ownerFirstName, "Dave");
      assert.equal(owner.callerPhone, OWNER_MOBILE);
      assert.equal(Object.hasOwn(owner.phoneRecord.organizations, "owner_access"), false, "no PIN material past the token");
      assert.equal(supabase.state.rpc.length, 2, "both lockout windows counted before the verify");

      const silent = fakeRes();
      await fd.routes["/twiml/owner-pin"]({ headers: {}, query: { attempt: "1" }, body: { Called: BUSINESS, From: OWNER_MOBILE, CallSid: "CA-2" } }, silent);
      const customer = tokens.consumeStreamToken(/name="auth_token" value="([^"]+)"/.exec(silent.body)[1]);
      assert.equal(customer.ownerMode, false);
      assert.equal(customer.ownerAuth, null);
      await new Promise((r) => setImmediate(r)); // let the fire-and-forget writes log, if they do
    } finally {
      LOGS.forEach((m, i) => { console[m] = saved[i]; });
    }
    const everything = [...fd.lines, ...globalLines].join("\n");
    assert.ok(!everything.includes(PIN), "the PIN never reaches a log line");
    assert.ok(!everything.includes(PIN_HASH) && !everything.includes(SALT), "nor the hash or salt");
  });
});

describe("SCRUM-587: CallSession owner fields", () => {
  it("a new session is a customer session", () => {
    const s = new CallSession("CA-1");
    assert.equal(s.ownerMode, false);
    assert.equal(s.ownerAuth, null);
    assert.equal(s.ownerFirstName, null);
    assert.equal(s.ownerToolCalls, 0);
  });
});
