"use strict";

// SCRUM-594: the demo-line pipeline switch in server.js. Source pins for the
// shape (idiom A), and the real server.js text run against stubs for the
// behaviour (idiom B, runSlice — the same technique as
// server-owner-mode-wiring.test.js: server.js can't be required, and a source
// pin can't catch an inverted condition).

process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";
// Hermetic: the switch's value comes from each test's fake env, never the shell
// (the real resolver's default reads process.env when the slice passes undefined).
delete process.env.DEMO_LINE_PIPELINE;

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

const { CallSession } = require("../call-session");
const { resolveCallPipeline } = require("../lib/pipeline-routing");
const { maskPhone } = require("../lib/mask-phone");
const { buildOwnerCallSummary, settleOwnerToolRuns } = require("../lib/owner-tool-runner");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const startHandler = src.slice(src.indexOf('case "start": {'), src.indexOf('case "media": {'));
const cleanup = src.slice(src.indexOf("async function cleanupSession()"), src.indexOf('twilioWs.on("message"'));

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function sliceOf(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}
/** Runs server.js text between two markers as a function body whose parameters are `scope`'s keys. */
function runSlice({ from, to, scope, names = [], isAsync = false }) {
  const params = Object.keys(scope);
  const body = `${sliceOf(from, to)}\nreturn { ${names.join(", ")} };`;
  const Ctor = isAsync ? AsyncFunction : Function;
  return new Ctor(...params, body)(...params.map((p) => scope[p]));
}
function recordingConsole(lines) {
  const rec = (m) => (...args) => lines.push(`${m}| ${args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4 }))).join(" ")}`);
  return { log: rec("log"), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
}
/** Every line the REAL resolver writes (it logs through the global console). */
function captureConsole(t) {
  const lines = [];
  for (const m of ["log", "warn", "error"]) t.mock.method(console, m, (...a) => lines.push(`${m}| ${a.join(" ")}`));
  return lines;
}

const DEMO = "+61238205672";
const CUSTOMER_LINE = "+61255550000";
function makeSession({ owner = false, language = "en", calledNumber = CUSTOMER_LINE } = {}) {
  const s = new CallSession(owner ? "CA-owner" : "CA-customer");
  s.ownerMode = owner; // test fixture: server.js sets this only from the server-side stream token
  if (owner) { s.ownerAuth = "verified"; s.ownerFirstName = "Dave"; }
  s.language = language;
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  s.callRecordId = "call-1";
  s.callerPhone = "+61400000001";
  s.orgPhoneNumber = calledNumber;
  s.organization = { timezone: "Australia/Sydney", industry: "dental" };
  return s;
}

// ─── Source pins ────────────────────────────────────────────────────────────

describe("SCRUM-594: demo-line switch — source pins", () => {
  it("imports the resolver and routes non-owner calls through it; owner calls keep resolveOwnerPipeline()", () => {
    assert.match(src, /const \{ [^}]*\bresolveCallPipeline\b[^}]* \} = require\("\.\/lib\/pipeline-routing"\);/);
    assert.match(startHandler, /const effectivePipeline = session\.ownerMode\s*\?\s*resolveOwnerPipeline\(\)\s*:\s*resolveCallPipeline\(\{/);
    assert.equal((src.match(/resolveOwnerPipeline\(/g) || []).length, 1, "owner calls resolve their pipeline once, at this site");
    assert.equal((src.match(/resolveCallPipeline\(/g) || []).length, 1, "one routing decision per call");
  });

  it("the session records the selection before either pipeline starts", () => {
    const sel = startHandler.indexOf("const effectivePipeline =");
    const stamp = startHandler.indexOf("session.effectivePipeline = effectivePipeline;", sel);
    const gemini = startHandler.indexOf('if (effectivePipeline === "gemini-live" && process.env.GEMINI_API_KEY) {');
    assert.ok(sel > 0 && stamp > sel && stamp < gemini, `order: select=${sel} stamp=${stamp} gemini=${gemini}`);
  });

  it("the classic block flags the fast variant as its first statement, before any STT opens", () => {
    const marker = "// ── Classic pipeline (Deepgram STT + OpenAI LLM + Deepgram TTS) ──\n";
    const top = startHandler.indexOf(marker);
    assert.ok(top > 0);
    const block = startHandler.slice(top + marker.length);
    const flag = block.indexOf('session.fastPath = !session.ownerMode && effectivePipeline === "classic-fast";');
    assert.ok(flag >= 0, "the classic block sets session.fastPath");
    assert.ok(flag < block.indexOf("openDeepgramStream("), "Task 5 picks the STT from session.fastPath — it must be set first");
    assert.doesNotMatch(block.slice(0, flag), /;\s*$/m, "nothing runs before the flag");
  });

  it("cleanup hands the pipeline to completeCallRecord for demo-line customer calls only", () => {
    assert.match(cleanup, /pipeline: !s\.ownerMode && isDemoLineNumber\(s\.orgPhoneNumber\) \? s\.effectivePipeline : null,/);
    assert.match(cleanup, /pipelineFailover: s\.pipelineFailover \|\| null,\n/);
  });

  it("the demo-line cap condition is not reused (its text is pinned at exactly two sites)", () => {
    assert.equal((src.match(/organizationId === DEMO_ORG_ID \|\| isDemoLineNumber\(calledNumber\)/g) || []).length, 2);
  });
});

// ─── Pipeline selection, run for real ───────────────────────────────────────

/**
 * Runs the real selection text. `resolver` defaults to the real resolveCallPipeline;
 * `env` is the process.env the slice sees.
 */
function select({ owner = false, language = "en", calledNumber = CUSTOMER_LINE, voicePipeline = "gemini-live", env = { GEMINI_API_KEY: "k" }, demoLine = (n) => n === DEMO, resolver = resolveCallPipeline, ownerPipeline = "classic" } = {}) {
  const lines = [];
  const calls = [];
  const session = makeSession({ owner, language, calledNumber });
  const { effectivePipeline } = runSlice({
    from: "// ── Pipeline selection",
    to: 'if (effectivePipeline === "gemini-live" && process.env.GEMINI_API_KEY) {',
    scope: {
      session,
      calledNumber,
      resolveOwnerPipeline: () => { calls.push(["resolveOwnerPipeline"]); return ownerPipeline; },
      resolveCallPipeline: (opts) => { calls.push(["resolveCallPipeline", opts]); return resolver(opts); },
      isDemoLineNumber: demoLine,
      VOICE_PIPELINE: voicePipeline,
      process: { env },
      console: recordingConsole(lines),
    },
    names: ["effectivePipeline"],
  });
  return { effectivePipeline, session, calls, lines };
}

describe("SCRUM-594: pipeline selection, run for real", () => {
  it("a customer call asks the resolver, with the dialled number, the assistant's language, VOICE_PIPELINE, DEMO_LINE_PIPELINE as read NOW, and the demo-line predicate", () => {
    const demoLine = (n) => n === DEMO;
    const r = select({ calledNumber: DEMO, language: "en", voicePipeline: "gemini-live", env: { GEMINI_API_KEY: "k", DEMO_LINE_PIPELINE: "classic-fast" }, demoLine, resolver: () => "classic-fast" });
    assert.deepEqual(r.calls, [["resolveCallPipeline", { calledNumber: DEMO, ownerMode: false, language: "en", globalPipeline: "gemini-live", demoLinePipeline: "classic-fast", isDemoLine: demoLine }]]);
    assert.equal(r.effectivePipeline, "classic-fast");
    assert.equal(r.session.effectivePipeline, "classic-fast", "the session records it (calls.metadata.pipeline, Task 5)");
    assert.deepEqual(r.lines, []);
  });

  it("an owner call never reaches the switch: resolveOwnerPipeline() decides, once", () => {
    const r = select({ owner: true, calledNumber: DEMO, env: { GEMINI_API_KEY: "k", DEMO_LINE_PIPELINE: "classic-fast" }, ownerPipeline: "gemini-live" });
    assert.deepEqual(r.calls, [["resolveOwnerPipeline"]]);
    assert.equal(r.effectivePipeline, "gemini-live");
    assert.equal(r.session.effectivePipeline, "gemini-live");
  });

  it("with the real resolver: only the demo line moves, and only for an English assistant", (t) => {
    const consoleLines = captureConsole(t);
    const env = { GEMINI_API_KEY: "k", DEMO_LINE_PIPELINE: "classic-fast" };
    assert.equal(select({ calledNumber: DEMO, env }).effectivePipeline, "classic-fast");
    assert.equal(select({ calledNumber: CUSTOMER_LINE, env }).effectivePipeline, "gemini-live", "every other number: VOICE_PIPELINE");
    assert.equal(select({ calledNumber: CUSTOMER_LINE, env, voicePipeline: "classic" }).effectivePipeline, "classic");
    assert.equal(select({ calledNumber: DEMO, env, language: "es" }).effectivePipeline, "gemini-live", "Flux is English-only");
    assert.equal(select({ calledNumber: DEMO, env: { GEMINI_API_KEY: "k" } }).effectivePipeline, "gemini-live", "unset: no change");
    assert.equal(select({ calledNumber: DEMO, env: { GEMINI_API_KEY: "k", DEMO_LINE_PIPELINE: "classic" } }).effectivePipeline, "classic", "pinned to classic");
    assert.equal(consoleLines.length, 1, consoleLines.join("\n"));
    assert.match(consoleLines[0], /\[PipelineRouting\] DEMO_LINE_PIPELINE=classic-fast ignored — the assistant's language is "es"/);
  });

  it("the missing-key fallback still follows the EFFECTIVE pipeline (a demo line pinned to gemini-live without a key)", () => {
    const r = select({ calledNumber: DEMO, voicePipeline: "classic", env: { DEMO_LINE_PIPELINE: "gemini-live" } });
    assert.equal(r.effectivePipeline, "gemini-live");
    assert.equal(r.lines.length, 1);
    assert.match(r.lines[0], /^error\| \[GeminiLive\] pipeline=gemini-live but GEMINI_API_KEY not set — falling back to classic pipeline/);
  });
});

// ─── The classic block's first statement, run for real ──────────────────────

function classicTop({ effectivePipeline, sessionPipeline = effectivePipeline, owner = false }) {
  const session = makeSession({ owner, calledNumber: DEMO });
  session.effectivePipeline = sessionPipeline;
  let fastPathAtSttOpen = "not opened";
  /** Which STT the block opened: "nova" (openDeepgramStream) or "flux" (Task 5's startFastPath). */
  let stt = null;
  runSlice({
    from: "// ── Classic pipeline (Deepgram STT + OpenAI LLM + Deepgram TTS) ──",
    to: "// Recording disclosure + greeting — pre-synthesize disclosure while STT connects",
    scope: {
      session,
      effectivePipeline,
      openDeepgramStream: () => { fastPathAtSttOpen = session.fastPath; stt = "nova"; return { readyState: 1 }; },
      startFastPath: () => { fastPathAtSttOpen = session.fastPath; stt = "flux"; },
      DEEPGRAM_API_KEY: "dg",
      logTranscript: () => {},
      handleUserSpeech: async () => {},
      twilioWs: { readyState: 1, send: () => {}, close: () => {} },
      sendTTS: async () => 0,
      getErrorMsg: () => "",
      noteOwnerSpeech: () => {},
      console: recordingConsole([]),
    },
  });
  return { session, fastPathAtSttOpen, stt };
}

describe("SCRUM-594: the classic block flags the fast variant, run for real", () => {
  it("classic-fast sets session.fastPath before the STT opens; nothing else does", () => {
    const fast = classicTop({ effectivePipeline: "classic-fast" });
    assert.equal(fast.session.fastPath, true);
    assert.equal(fast.fastPathAtSttOpen, true);
    assert.equal(fast.stt, "flux", "the fast path starts Flux (Task 5), not Nova");
    assert.equal(fast.session.effectivePipeline, "classic-fast");
    for (const p of ["classic", "gemini-live"]) {
      const r = classicTop({ effectivePipeline: p });
      assert.equal(r.session.fastPath, false, p);
      assert.equal(r.fastPathAtSttOpen, false, p);
      assert.equal(r.stt, "nova", p);
    }
  });

  it("an owner call is never the fast variant, even when its pipeline resolves to classic-fast (a raw VOICE_PIPELINE=classic-fast)", () => {
    const r = classicTop({ effectivePipeline: "classic-fast", owner: true });
    assert.equal(r.session.fastPath, false);
    assert.equal(r.fastPathAtSttOpen, false);
    assert.equal(r.stt, "nova");
    assert.equal(r.session.effectivePipeline, "classic", "recorded as the classic call it is");
  });

  it("a Gemini selection that fell back to classic (no GEMINI_API_KEY) is recorded as the classic call it is", () => {
    assert.equal(classicTop({ effectivePipeline: "gemini-live" }).session.effectivePipeline, "classic");
    assert.equal(classicTop({ effectivePipeline: "classic" }).session.effectivePipeline, "classic");
  });
});

// ─── calls.metadata.pipeline via cleanupSession, run for real ───────────────

async function runCleanup(session, { demoLine = (n) => n === DEMO } = {}) {
  const calls = [];
  const lines = [];
  const scope = {
    session,
    cleaningUp: false,
    sessions: new Map(),
    Sentry: { withScope: (fn) => fn({ setTag() {}, setExtras() {}, setExtra() {}, setLevel() {} }), captureMessage() {}, captureException() {} },
    detectPostCallPhantoms: () => [],
    summarizePhantoms: () => ({ bugTag: "x", reason: "x" }),
    analyzeCallTranscript: async () => null,
    buildToolOutcomeDigest: () => "",
    DEBUG_TRANSCRIPTS: false,
    maybeEmitUnhappyCall: () => {},
    netLiveOutcome: () => 0,
    setReasonTag: () => {},
    SENTRY_REASONS: { BOOKING_STATE_MISMATCH: "booking-state-mismatch" },
    detectAndRedact: (t) => ({ piiFound: false, redacted: t }),
    redactObject: (x) => ({ piiFound: false, redacted: x }),
    completeCallRecord: async (id, fields) => { calls.push(["completeCallRecord", id, fields]); },
    setTimeout: (fn) => fn(),
    notifyCallCompleted: async () => {},
    INTERNAL_API_URL: "http://next.internal",
    INTERNAL_API_SECRET: "secret",
    maskPhone,
    buildOwnerCallSummary,
    settleOwnerToolRuns,
    isDemoLineNumber: demoLine,
    closeFastPath: () => {}, // these sessions never started the fast path (no fastState)
    console: recordingConsole(lines),
  };
  const { cleanupSession } = runSlice({ from: "async function cleanupSession() {", to: 'twilioWs.on("message", async (raw) => {', scope, names: ["cleanupSession"] });
  await cleanupSession();
  const record = calls.find((c) => c[0] === "completeCallRecord");
  assert.ok(record, lines.join("\n"));
  return record[2];
}
function endedCall(s, pipeline) {
  s.effectivePipeline = pipeline;
  s.startedAt = Date.now() - 60_000;
  s.addMessage("user", "I'd like to book a check-up.");
  s.addMessage("assistant", "Sure — what day suits you?");
  return s;
}

describe("SCRUM-594: calls.metadata.pipeline, run for real", () => {
  it("a demo-line customer call records the pipeline that served it", async () => {
    for (const p of ["classic-fast", "classic", "gemini-live"]) {
      const fields = await runCleanup(endedCall(makeSession({ calledNumber: DEMO }), p));
      assert.equal(fields.pipeline, p);
    }
  });

  it("every other call passes null — so it writes no new metadata", async () => {
    assert.equal((await runCleanup(endedCall(makeSession({ calledNumber: CUSTOMER_LINE }), "gemini-live"))).pipeline, null);
    assert.equal((await runCleanup(endedCall(makeSession({ owner: true, calledNumber: DEMO }), "classic"))).pipeline, null, "an owner call is not part of the comparison");
    assert.equal((await runCleanup(endedCall(makeSession({ calledNumber: DEMO }), null))).pipeline, null, "a call that never reached selection");
  });
});
