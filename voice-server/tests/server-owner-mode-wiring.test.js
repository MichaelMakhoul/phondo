// voice-server/tests/server-owner-mode-wiring.test.js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";

// SCRUM-587 — source pins for the owner session in the server.js monolith
// (idiom: server-reschedule-ledger-wiring.test.js). Each pin is a place where
// dropping the owner gate silently re-enables a customer guard that would
// mark the owner's own call failed — nothing else would surface the drift.
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const crSrc = fs.readFileSync(path.join(__dirname, "..", "services", "conversationrelay.js"), "utf8");
const cleanup = src.slice(src.indexOf("async function cleanupSession()"), src.indexOf('twilioWs.on("message"'));

describe("SCRUM-587: owner session wiring", () => {
  it("imports the owner modules", () => {
    for (const m of ["./lib/owner-prompt", "./lib/owner-tools", "./lib/owner-tool-runner"]) assert.ok(src.includes(`require("${m}")`), m);
    assert.match(src, /resolveOwnerPipeline/);
  });
  it("owner mode never reaches the ConversationRelay eval path (spec: Twilio /twiml + Gemini/classic only)", () => {
    assert.doesNotMatch(crSrc, /ownerMode|ownerVerified|runOwnerToolCall/);
  });
  it("owner calls get the owner prompt, skip the returning-caller hint and the schedule snapshot", () => {
    assert.match(src, /const systemPrompt = session\.ownerMode\s*\?\s*buildOwnerPrompt\(\{/);
    assert.match(src, /if \(callerPhone && !session\.ownerMode\) \{/);
    assert.match(src, /if \(!session\.ownerMode && !clinikoOwnsAvailability && \(session\.calendarEnabled \|\| session\.serviceTypes\?\.length > 0\)\)/);
  });
  it("owner calls pick their pipeline via OWNER_PIPELINE", () => {
    assert.match(src, /const effectivePipeline = session\.ownerMode \? resolveOwnerPipeline\(\) : VOICE_PIPELINE;/);
    assert.ok((src.match(/effectivePipeline === "gemini-live"/g) || []).length >= 2, "both pipeline-selection checks must use effectivePipeline");
  });
  it("Gemini: owner tools, owner greeting, no disclosure, owner suffix", () => {
    assert.match(src, /const llmOptions = session\.ownerMode \? \{ tools: buildOwnerTools\(\) \} : buildLLMOptions\(session, \{ includeTransfer: true \}\);/);
    assert.match(src, /const consentResult = session\.ownerMode\s*\?\s*\{ required: false, callerState: null, reason: "owner-call" \}/);
    assert.match(src, /const greeting = session\.ownerMode\s*\?\s*buildOwnerGreeting\(session\.ownerFirstName\)/);
    assert.match(src, /geminiSystemPrompt \+= buildOwnerGeminiSuffix\(\);/);
    // The customer CRITICAL RULES block must sit inside the !ownerMode branch.
    const rulesIdx = src.indexOf("CRITICAL RULES FOR THIS CONVERSATION:");
    const gateIdx = src.lastIndexOf("if (!session.ownerMode) {", rulesIdx);
    assert.ok(gateIdx > 0 && rulesIdx - gateIdx < 800, "customer CRITICAL RULES must be gated on !session.ownerMode");
  });
  it("Gemini onToolCall hands owner calls to the runner BEFORE any customer guard", () => {
    const toolCallIdx = src.indexOf('logToolCall("[GeminiLive] Tool call", toolCall.name, toolCall.args);');
    const runnerIdx = src.indexOf("if (session.ownerMode) {\n                    if (session) session._toolCallInFlight = true;\n                    try {\n                      return await runOwnerToolCall(session, toolCall, { executeToolCall, scheduleCache });\n                    } finally {\n                      if (session) session._toolCallInFlight = false;\n                    }", toolCallIdx);
    const funnelIdx = src.indexOf("session.hasUnfinishedBooking(toolCall.args?.reason)", toolCallIdx);
    assert.ok(toolCallIdx > 0 && runnerIdx > toolCallIdx && runnerIdx < funnelIdx, `order: log=${toolCallIdx} runner=${runnerIdx} funnel=${funnelIdx}`);
  });
  it("Gemini turn-complete: phantom detector and Tier-2 validator are off for owner calls", () => {
    assert.match(src, /const phantom = session\.ownerMode \? null : detectPhantomAction\(aiTurnText, session\.toolCallAudit\);/);
    assert.match(src, /if \(!session\.ownerMode && session\._lastToolResult && !session\._phantomActionCount\) \{/);
  });
  it("classic: owner tools, owner greeting, no disclosure, runner before the cancel gate", () => {
    assert.match(src, /function buildLLMOptions\(session, \{ includeTransfer = false \} = \{\}\) \{\n  if \(session\.ownerMode\) return \{ tools: buildOwnerTools\(\) \};/);
    const loopIdx = src.indexOf('const fnArgs = parseToolArgs(toolCall, "ToolCall");');
    const runnerIdx = src.indexOf("runOwnerToolCall(session, { name: fnName, args: fnArgs }, { executeToolCall, scheduleCache })", loopIdx);
    const cancelIdx = src.indexOf('fnName === "cancel_appointment" && !session.confirmCancel(', loopIdx);
    assert.ok(loopIdx > 0 && runnerIdx > loopIdx && runnerIdx < cancelIdx, `order: loop=${loopIdx} runner=${runnerIdx} cancel=${cancelIdx}`);
    assert.ok((src.match(/\{ required: false, callerState: null, reason: "owner-call" \}/g) || []).length >= 2, "both pipelines skip the disclosure for owner calls");
    assert.ok((src.match(/buildOwnerGreeting\(session\.ownerFirstName\)/g) || []).length >= 2, "both pipelines use the owner greeting");
  });
  it("post-call: no phantom scan, no OpenAI analysis, deterministic summary, owner stamps — and the DB write precedes the webhook", () => {
    assert.match(cleanup, /const phantomActions = s\.ownerMode \? \[\] : detectPostCallPhantoms\(s\.fullTranscriptMessages, s\.toolCallAudit\);/);
    assert.match(cleanup, /if \(!s\.ownerMode && transcript && durationSeconds > 5\) \{/);
    assert.match(cleanup, /let ownerSummary = s\.ownerMode \? buildOwnerCallSummary\(s\.toolCallAudit \|\| \[\]\) : null;/);
    assert.match(cleanup, /summary: s\.ownerMode \? ownerSummary : \(analysis\?\.summary \|\| null\),/);
    assert.match(cleanup, /callerName: s\.ownerMode \? \(s\.ownerFirstName \|\| "Owner"\) : \(analysis\?\.callerName \|\| null\),/);
    assert.match(cleanup, /actionTaken: s\.ownerMode\s*\?\s*"owner_call"/);
    assert.match(cleanup, /callType: s\.ownerMode \? "owner" : null,/);
    assert.match(cleanup, /ownerAuth: s\.ownerAuth \|\| null,/);
    const writeIdx = cleanup.indexOf("await completeCallRecord(s.callRecordId, {");
    assert.ok(writeIdx >= 0 && writeIdx < cleanup.indexOf("notifyCallCompleted(INTERNAL_API_URL, INTERNAL_API_SECRET, {"), "PR B reads call_type from the DB — the record must be written (awaited) before the webhook");
  });
  it("counts enough owner gates that a dropped one is visible", () => {
    const n = (src.match(/session\.ownerMode|s\.ownerMode/g) || []).length;
    assert.ok(n >= 16, `expected ≥16 owner-mode gates in server.js, got ${n}`);
  });
});

// ─── Controller overrides — source pins ─────────────────────────────────────

const startHandler = src.slice(src.indexOf('case "start": {'), src.indexOf('case "media": {'));

describe("SCRUM-587: owner session — controller-override pins", () => {
  it("the call record is created (awaited) before either pipeline starts, so no owner tool runs without a callRecordId", () => {
    const recordIdx = startHandler.indexOf("session.callRecordId = callRecordId;");
    const pipelineIdx = startHandler.indexOf("const effectivePipeline =");
    const geminiIdx = startHandler.indexOf("session.geminiSession = _sessionFactory(");
    const classicIdx = startHandler.indexOf("session.deepgramWs = openDeepgramStream(DEEPGRAM_API_KEY, {", pipelineIdx);
    assert.ok(recordIdx > 0 && pipelineIdx > recordIdx && geminiIdx > pipelineIdx && classicIdx > geminiIdx,
      `order: record=${recordIdx} pipeline=${pipelineIdx} gemini=${geminiIdx} classic=${classicIdx}`);
    assert.match(startHandler.slice(0, recordIdx), /const callRecordId = await createCallRecord\(\{/);
  });

  it("resolveOwnerPipeline runs once per call (it warns on every call when misconfigured), in the start handler", () => {
    assert.equal((src.match(/resolveOwnerPipeline\(/g) || []).length, 1);
    assert.ok(startHandler.includes("resolveOwnerPipeline()"));
    // The start handler never consults the global directly any more.
    assert.doesNotMatch(startHandler, /VOICE_PIPELINE === "gemini-live"/);
    assert.match(startHandler, /if \(effectivePipeline === "gemini-live" && !process\.env\.GEMINI_API_KEY\) \{/);
    assert.match(startHandler, /if \(effectivePipeline === "gemini-live" && process\.env\.GEMINI_API_KEY\) \{/);
  });

  it("owner calls never take the eval test-pipeline override (owner mode is Gemini/classic only)", () => {
    assert.match(src, /const _testPipeline = session\.ownerMode \? null : resolveTestPipeline\(session\.orgPhoneNumber\);/);
  });

  it("the turn/speech stamps are wired at exactly these sites (a new site would double-count turns)", () => {
    assert.match(src, /require\("\.\/lib\/owner-turn-stamps"\)/);
    assert.equal((src.match(/noteAssistantSpeech\(session\)/g) || []).length, 2, "Gemini onAudio + classic reply sentence — assistant AUDIO only, never transcription");
    assert.equal((src.match(/noteAssistantTurnEnd\(session\)/g) || []).length, 3, "Gemini onInterrupted + onTurnComplete, classic after the reply");
    assert.equal((src.match(/noteOwnerSpeech\(session, /g) || []).length, 2, "Gemini input transcription + classic STT final");
    for (const m of src.matchAll(/^.*note(?:AssistantSpeech|AssistantTurnEnd|OwnerSpeech)\(session.*$/gm)) {
      assert.match(m[0], /if \(session\??\.ownerMode(?: && [^\n]*?)?\) note/, `ungated stamp site: ${m[0].trim()}`);
    }
  });

  it("server.js never writes the gate's clock directly, and CallSession only declares it (never reset mid-call)", () => {
    for (const field of ["assistantTurnSeq", "lastAssistantTurnAt", "lastAssistantSpeechAt", "lastOwnerSpeechAt", "assistantTurnHadSpeech", "ownerPendingConfirmations", "ownerConfirmSpentSpeechAt"]) {
      assert.doesNotMatch(src, new RegExp(`\\.${field}\\s*(?:[-+*/]?=)(?!=)`), `server.js writes ${field}`);
    }
    const sessionSrc = fs.readFileSync(path.join(__dirname, "..", "call-session.js"), "utf8");
    assert.match(sessionSrc, /this\.assistantTurnSeq = 0;/);
    assert.match(sessionSrc, /this\.lastAssistantTurnAt = 0;/);
    assert.match(sessionSrc, /this\.lastAssistantSpeechAt = 0;/);
    assert.match(sessionSrc, /this\.lastOwnerSpeechAt = 0;/);
    assert.match(sessionSrc, /this\.assistantTurnHadSpeech = false;/);
    assert.match(sessionSrc, /this\.ownerPendingConfirmations = null;/);
    assert.match(sessionSrc, /this\.ownerConfirmSpentSpeechAt = null;/);
    assert.equal((sessionSrc.match(/assistantTurnSeq\s*(?:[-+*/]?=)(?!=)/g) || []).length, 1, "declared once, never reset");
  });

  it("nothing in the owner session calls verifyPin (the PIN is the front door's job)", () => {
    assert.doesNotMatch(src, /verifyPin/);
  });

  it("owner tools never reach a transfer: the classic owner return precedes the transfer hand-off", () => {
    const runnerIdx = src.indexOf("runOwnerToolCall(session, { name: fnName, args: fnArgs }");
    const handoffIdx = src.indexOf("saveForTransfer(session.callSid, {");
    assert.ok(runnerIdx > 0 && handoffIdx > runnerIdx);
    assert.doesNotMatch(src.slice(src.indexOf("session.geminiSession = _sessionFactory("), src.indexOf("// ── Classic pipeline")), /saveForTransfer\(/);
  });

  it("a transfer carries the PIN-gate stamp to every completion path (finish + reconnect)", () => {
    const handoff = src.slice(src.indexOf("saveForTransfer(session.callSid, {"), src.indexOf("// Close Deepgram — stream will close when Twilio starts <Dial>"));
    assert.match(handoff, /ownerAuth: session\.ownerAuth \|\| null,/);
    assert.match(handoff, /callType: session\.ownerMode \? "owner" : null,/);
  });
});

// ─── Functional: the REAL server.js text, run against stubs ─────────────────
// Same technique as server-owner-pin-wiring.test.js (runServerSlice): server.js
// can't be required (live env + a bound port), and a source pin cannot catch an
// inverted gate. The evaluated text is this repo's own checked-in server.js.

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function sliceOf(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}
/** Runs server.js text between two markers as a function body whose parameters are `scope`'s keys. */
function runSlice({ from, to, scope, names = [], isAsync = false, wrap }) {
  const code = sliceOf(from, to);
  const params = Object.keys(scope);
  const body = wrap ? wrap(code) : `${code}\nreturn { ${names.join(", ")} };`;
  const Ctor = isAsync ? AsyncFunction : Function;
  return new Ctor(...params, body)(...params.map((p) => scope[p]));
}
function recordingConsole(lines) {
  const rec = (m) => (...args) => lines.push(`${m}| ${args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 6 }))).join(" ")}`);
  return { log: rec("log"), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeSentry = (calls) => ({
  withScope: (fn) => fn({ setTag() {}, setExtras() {}, setExtra() {}, setLevel() {} }),
  captureMessage: (...a) => calls.push(["Sentry.captureMessage", ...a]),
  captureException: (...a) => calls.push(["Sentry.captureException", ...a]),
});

const { CallSession } = require("../call-session");
const { buildOwnerPrompt, buildOwnerGreeting, buildOwnerGeminiSuffix } = require("../lib/owner-prompt");
const { buildOwnerTools } = require("../lib/owner-tools");
const { runOwnerToolCall, buildOwnerCallSummary, settleOwnerToolRuns } = require("../lib/owner-tool-runner");
const { noteAssistantSpeech, noteAssistantTurnEnd, noteOwnerSpeech } = require("../lib/owner-turn-stamps");
const { forwardingFallbackEligible } = require("../lib/transfer-eligibility");
const { maskPhone } = require("../lib/mask-phone");
const toolExecutor = require("../services/tool-executor");

const { buildLanguageLockDirective } = runSlice({
  from: "const LANG_DISPLAY = {",
  to: "// Cached Twilio REST client for recording and transfer operations",
  scope: {},
  names: ["buildLanguageLockDirective"],
});

const SERVICE_TYPES = [{ id: "st-1", name: "Blocked drain", duration_minutes: 60 }];
function makeContext({ timezone = "Australia/Sydney" } = {}) {
  return {
    organizationId: "org-1",
    assistantId: "asst-1",
    organization: { name: "Copperline Plumbing", timezone, country: "AU", businessState: "NSW", recordingConsentMode: "auto", recording_disclosure_text: null, industry: "home_services" },
    assistant: { voiceId: "v1", language: "en", promptConfig: { fields: [] }, settings: {} },
    knowledgeBase: "",
    serviceTypes: SERVICE_TYPES,
    calendarProvider: null,
  };
}
/** A session as the start event leaves it; owner fields exactly as the stream token sets them. */
function makeSession({ owner = false, ownerAuth = owner ? "verified" : null } = {}) {
  const s = new CallSession(owner ? "CA-owner" : "CA-customer");
  if (owner) {
    // Test fixture: in server.js this comes only from the server-side token.
    s.ownerMode = true;
    s.ownerFirstName = "Dave";
  }
  s.ownerAuth = ownerAuth;
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  s.callRecordId = "call-1";
  s.callerPhone = "+61400000001";
  s.orgPhoneNumber = "+61255550000";
  s.calendarEnabled = true;
  s.serviceTypes = SERVICE_TYPES;
  s.transferRules = [];
  s.behaviors = {};
  s.organization = { timezone: "Australia/Sydney" };
  return s;
}

// Wed 14 Oct 2026 14:30 UTC = Thu 15 Oct 01:30 in Sydney (AEDT, UTC+11).
const FIXED_NOW = Date.UTC(2026, 9, 14, 14, 30);
class FrozenDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED_NOW);
  }
  static now() { return FIXED_NOW; }
}

function fakeSupabase(queries) {
  return {
    from(table) {
      const q = { table, ops: [] };
      queries.push(q);
      const chain = {
        select: (...a) => { q.ops.push(["select", ...a]); return chain; },
        eq: (...a) => { q.ops.push(["eq", ...a]); return chain; },
        in: (...a) => { q.ops.push(["in", ...a]); return chain; },
        then: (resolve, reject) => Promise.resolve({ count: 2, error: null }).then(resolve, reject),
      };
      return chain;
    },
  };
}

/** start event: prompt → schedule snapshot → (Gemini) prompt assembly, all real server.js text. */
async function assemblePrompts({ owner, ownerAuth, timezone }) {
  const context = makeContext({ timezone });
  const session = makeSession({ owner, ownerAuth });
  const lines = [];
  const calls = [];
  const historyQueries = [];
  await runSlice({
    isAsync: true,
    from: "// Build system prompt (guided or legacy)",
    to: "// ── Schedule cache: pre-fetch availability snapshot ──",
    scope: {
      context, session, callerPhone: session.callerPhone,
      effectiveCalendarEnabled: true, isAfterHours: false, afterHoursConfig: null,
      buildSystemPrompt: (...a) => { calls.push(["buildSystemPrompt", ...a]); return "CUSTOMER PROMPT"; },
      buildOwnerPrompt,
      maskPhone,
      require: (id) => { assert.equal(id, "./lib/supabase"); return { getSupabase: () => fakeSupabase(historyQueries) }; },
      buildReturningCallerHint: () => "\nRETURNING CALLER HINT",
      console: recordingConsole(lines),
      Date: FrozenDate,
    },
  });
  const { scheduleSnapshot } = await runSlice({
    isAsync: true,
    from: "// ── Schedule cache: pre-fetch availability snapshot ──",
    to: "// Create call record in database",
    scope: {
      context, session,
      scheduleCache: {
        getSchedule: (...a) => { calls.push(["scheduleCache.getSchedule", ...a]); return { slots: {}, timezone: "Australia/Sydney" }; },
        setSchedule: (...a) => calls.push(["scheduleCache.setSchedule", ...a]),
        onScheduleChanged: (...a) => { calls.push(["scheduleCache.onScheduleChanged"]); return () => {}; },
      },
      loadScheduleSnapshot: async (...a) => { calls.push(["loadScheduleSnapshot", ...a]); return null; },
      buildLiveScheduleSection: () => "LIVE SCHEDULE SECTION",
      console: recordingConsole(lines),
      Date: FrozenDate,
    },
    names: ["scheduleSnapshot"],
  });
  const classicPrompt = session.messages[0].content;
  const gemini = runSlice({
    from: "const llmOptions = session.ownerMode",
    to: "// Transcript buffering — accumulate fragments, flush on turn complete",
    scope: {
      session, context, isAfterHours: false, afterHoursConfig: null,
      buildOwnerTools,
      buildLLMOptions: (...a) => { calls.push(["buildLLMOptions", ...a]); return { tools: [{ type: "function", function: { name: "book_appointment" } }] }; },
      requiresRecordingDisclosureHybrid: (...a) => { calls.push(["requiresRecordingDisclosureHybrid", ...a]); return { required: true, callerState: "NSW", reason: "all-party" }; },
      getRecordingDisclosureText: () => "This call is recorded.",
      getGreeting: () => "Thanks for calling Copperline Plumbing!",
      buildOwnerGreeting,
      buildOwnerGeminiSuffix,
      buildLanguageLockDirective,
      forwardingFallbackEligible,
    },
    names: ["allTools", "consentResult", "greeting", "firstMessage", "disclosureText", "geminiSystemPrompt"],
  });
  return { context, session, lines, calls, historyQueries, scheduleSnapshot, classicPrompt, ...gemini };
}

const CUSTOMER_MARKERS = [
  "CRITICAL RULES FOR THIS CONVERSATION",
  "FINAL CRITICAL RULE — READ THIS LAST",
  "LANGUAGE LOCK",
  "schedule_callback",
  "book_appointment",
  "TRANSFERS — MUST OBEY",
  "NAME COLLECTION IS MANDATORY",
  "CALLER CONTEXT",
  "RETURNING CALLER HINT",
  "LIVE SCHEDULE SECTION",
  "This call is recorded.",
];

describe("SCRUM-587: the assembled owner prompt, run for real", () => {
  it("classic: the LLM's system prompt is exactly buildOwnerPrompt — org-local date, no caller context, no snapshot", async () => {
    const r = await assemblePrompts({ owner: true });
    const expected = buildOwnerPrompt({
      orgName: "Copperline Plumbing",
      ownerFirstName: "Dave",
      timezone: "Australia/Sydney",
      todayStr: "2026-10-15",
      serviceTypes: SERVICE_TYPES,
      practitioners: [],
    });
    assert.equal(r.classicPrompt, expected);
    assert.equal(r.session.messages.length, 1, "nothing else is sent before the first turn");
    assert.ok(r.classicPrompt.includes("Today is Thursday 2026-10-15 (Australia/Sydney)."), "Sydney's date, not the server's UTC Wednesday");
    assert.deepEqual(r.historyQueries, [], "no returning-caller lookup on an owner call");
    assert.equal(r.scheduleSnapshot, null);
    assert.equal(r.session.scheduleSnapshot, null);
    assert.deepEqual(r.calls.filter((c) => /^(scheduleCache|loadScheduleSnapshot|buildSystemPrompt)/.test(c[0])), []);
  });

  it("a malformed org timezone ('AEST') never kills the owner's call: Sydney's date and zone, and one warning", async () => {
    const r = await assemblePrompts({ owner: true, timezone: "AEST" });
    assert.equal(r.classicPrompt, buildOwnerPrompt({
      orgName: "Copperline Plumbing", ownerFirstName: "Dave", timezone: "Australia/Sydney", todayStr: "2026-10-15", serviceTypes: SERVICE_TYPES, practitioners: [],
    }));
    const warnings = r.lines.filter((l) => l.startsWith("warn| "));
    assert.equal(warnings.length, 1, r.lines.join("\n"));
    assert.ok(warnings[0].includes('"AEST"') && warnings[0].includes("Australia/Sydney") && warnings[0].includes("org-1"), warnings[0]);
  });

  it("a missing org timezone is Sydney too (as PR B's owner handlers), without a warning", async () => {
    for (const timezone of [null, ""]) {
      const r = await assemblePrompts({ owner: true, timezone });
      assert.ok(r.classicPrompt.includes("Today is Thursday 2026-10-15 (Australia/Sydney)."), String(timezone));
      assert.deepEqual(r.lines.filter((l) => l.startsWith("warn| ")), []);
    }
  });

  it("customers never evaluate the owner date at all — a malformed zone changes nothing for them", async () => {
    const r = await assemblePrompts({ owner: false, timezone: "AEST" });
    assert.ok(r.classicPrompt.startsWith("CUSTOMER PROMPT"));
    assert.deepEqual(r.lines.filter((l) => l.includes("[OwnerPrompt]")), []);
  });

  it("Gemini: the system prompt is the owner prompt + the first-message line + the owner suffix, and the suffix is the LAST text", async () => {
    const r = await assemblePrompts({ owner: true });
    const firstMessageLine = `\n\nIMPORTANT — YOUR FIRST MESSAGE: When the call connects, you will receive a short text message. Immediately respond by speaking the following greeting (word for word, naturally and warmly): "Hi Dave, what do you need?" — Then wait for the caller to respond. Do NOT add anything extra. Do NOT invent a receptionist name — you are an AI assistant.`;
    assert.equal(r.geminiSystemPrompt, r.classicPrompt + firstMessageLine + buildOwnerGeminiSuffix());
    for (const marker of CUSTOMER_MARKERS) assert.ok(!r.geminiSystemPrompt.includes(marker), `customer text in the owner prompt: ${marker}`);
  });

  it("Gemini: owner tools, owner greeting, no disclosure (not even evaluated)", async () => {
    const r = await assemblePrompts({ owner: true });
    assert.deepEqual(r.allTools, buildOwnerTools());
    assert.deepEqual(r.consentResult, { required: false, callerState: null, reason: "owner-call" });
    assert.equal(r.greeting, "Hi Dave, what do you need?");
    assert.equal(r.firstMessage, r.greeting);
    assert.equal(r.disclosureText, null);
    assert.equal(r.session.pendingDisclosureInFirstMessage, false);
    assert.deepEqual(r.calls.filter((c) => c[0] === "buildLLMOptions" || c[0] === "requiresRecordingDisclosureHybrid"), []);
  });

  it("a customer call — including one that failed the PIN gate — still gets the customer prompt, rules and language lock", async () => {
    for (const ownerAuth of [null, "locked"]) {
      const r = await assemblePrompts({ owner: false, ownerAuth });
      assert.ok(r.classicPrompt.startsWith("CUSTOMER PROMPT\n\nCALLER CONTEXT:"), ownerAuth);
      assert.ok(r.classicPrompt.includes("RETURNING CALLER HINT") && r.classicPrompt.endsWith("\nLIVE SCHEDULE SECTION"), ownerAuth);
      assert.equal(r.historyQueries.length, 2, ownerAuth);
      assert.ok(r.geminiSystemPrompt.includes("CRITICAL RULES FOR THIS CONVERSATION:"), ownerAuth);
      assert.ok(r.geminiSystemPrompt.includes("FINAL CRITICAL RULE — READ THIS LAST"), ownerAuth);
      assert.ok(r.geminiSystemPrompt.endsWith(buildLanguageLockDirective("en")), "the language lock stays last for customers");
      assert.ok(!r.geminiSystemPrompt.includes("OWNER CALL"), ownerAuth);
      assert.equal(r.greeting, "Thanks for calling Copperline Plumbing!");
      assert.equal(r.disclosureText, "This call is recorded.");
      assert.equal(r.session.pendingDisclosureInFirstMessage, true);
      assert.deepEqual(r.allTools.map((t) => t.function.name), ["book_appointment"]);
      assert.deepEqual(r.calls.find((c) => c[0] === "buildLLMOptions").slice(2), [{ includeTransfer: true }]);
    }
  });
});

describe("SCRUM-587: pipeline selection, run for real", () => {
  function select({ owner, ownerPipeline = "classic", voicePipeline = "gemini-live", geminiKey }) {
    const lines = [];
    let resolved = 0;
    const { effectivePipeline } = runSlice({
      from: "// ── Pipeline selection",
      to: 'if (effectivePipeline === "gemini-live" && process.env.GEMINI_API_KEY) {',
      scope: {
        session: makeSession({ owner }),
        resolveOwnerPipeline: () => { resolved += 1; return ownerPipeline; },
        VOICE_PIPELINE: voicePipeline,
        process: { env: geminiKey ? { GEMINI_API_KEY: geminiKey } : {} },
        console: recordingConsole(lines),
      },
      names: ["effectivePipeline"],
    });
    return { effectivePipeline, resolved, lines };
  }

  it("an owner call resolves its pipeline exactly once; a customer call never consults OWNER_PIPELINE", () => {
    assert.deepEqual(select({ owner: true, ownerPipeline: "classic", geminiKey: "k" }), { effectivePipeline: "classic", resolved: 1, lines: [] });
    assert.deepEqual(select({ owner: false, ownerPipeline: "classic", geminiKey: "k" }), { effectivePipeline: "gemini-live", resolved: 0, lines: [] });
  });

  it("the missing-key fallback follows the EFFECTIVE pipeline", () => {
    const owner = select({ owner: true, ownerPipeline: "gemini-live", voicePipeline: "classic" });
    assert.equal(owner.effectivePipeline, "gemini-live");
    assert.equal(owner.lines.length, 1);
    assert.match(owner.lines[0], /^error\| \[GeminiLive\] .*GEMINI_API_KEY not set — falling back to classic pipeline/);
    assert.deepEqual(select({ owner: true, ownerPipeline: "classic", voicePipeline: "gemini-live" }).lines, [], "an owner on classic needs no Gemini key");
    assert.equal(select({ owner: false, voicePipeline: "gemini-live" }).lines.length, 1, "customers unchanged");
  });
});

// ─── Gemini callbacks (onAudio … onTurnComplete), run for real ──────────────

const NEEDS_CONFIRMATION = { success: false, message: "Read this back and get a clear yes before cancelling: cancel Bob Lee's job on Friday, October 16 at 3:00 PM.", data: { outcome: "needs_confirmation", appointment_id: "a1", customer_notified: false } };
const CANCELLED = { success: true, message: "Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM. The customer has NOT been notified.", data: { outcome: "cancelled", appointment_id: "a1", customer_notified: false } };

function makeGeminiCallbacks(session, o = {}) {
  const calls = [];
  const lines = [];
  const scope = {
    twilioWs: { readyState: 1, send: (m) => calls.push(["twilio.send", JSON.parse(m).event]), close: (...a) => calls.push(["twilio.close", ...a]) },
    WebSocket: { OPEN: 1 },
    session,
    logToolCall: () => {},
    runOwnerToolCall: o.runOwnerToolCall || (async (...a) => { calls.push(["runOwnerToolCall", ...a]); return o.ownerResult; }),
    executeToolCall: o.executeToolCall || (async (...a) => { calls.push(["executeToolCall", ...a]); return { message: "customer tool result" }; }),
    scheduleCache: { invalidate: (...a) => calls.push(["scheduleCache.invalidate", ...a]), applyDelta: (...a) => calls.push(["scheduleCache.applyDelta", ...a]) },
    Sentry: fakeSentry(calls),
    bookingKey: () => "k",
    classifyRebookAttempt: () => ({ kind: "duplicate" }),
    CORRECTION_ERROR_MESSAGE: "correction failed",
    DUPLICATE_REBOOK_MESSAGE: "duplicate",
    normalizeDatetime: (x) => x,
    RESCHEDULE_SUCCESS_SIGNAL: /moved/,
    applyRescheduleToLedger: () => ({ moved: false }),
    CANCEL_NUDGE: " (nothing booked now)",
    logTranscript: () => {},
    pendingUserTranscript: "",
    pendingAiTranscript: "",
    detectPhantomAction: (...a) => { calls.push(["detectPhantomAction", ...a]); return null; },
    validateToolResponse: async () => { calls.push(["validateToolResponse"]); return { accurate: true }; },
    DEBUG_TRANSCRIPTS: false,
    noteAssistantSpeech,
    noteAssistantTurnEnd,
    noteOwnerSpeech,
    console: recordingConsole(lines),
  };
  const cbs = runSlice({ from: "onAudio: (twilioBase64) => {", to: "onError: (err) => {", scope, wrap: (code) => `return {\n${code}\n};` });
  return { cbs, calls, lines };
}

describe("SCRUM-587: Gemini callbacks, run for real", () => {
  it("every owner tool call — end_call and hallucinated customer tools included — goes to the runner, whose result is returned whole", async () => {
    const s = makeSession({ owner: true });
    const guardCalls = [];
    s.hasUnfinishedBooking = () => { guardCalls.push("hasUnfinishedBooking"); return true; };
    s.confirmCancel = () => { guardCalls.push("confirmCancel"); return false; };
    s.rememberDetails = () => { guardCalls.push("rememberDetails"); };
    s.toolCallAudit.push({ name: "check_availability", successful: true, at: 1 }); // would trip the end_call funnel
    const ownerResult = { message: "owner says", data: { outcome: "cancelled" }, __endCall: true };
    const inFlight = [];
    const { cbs, calls } = makeGeminiCallbacks(s, { runOwnerToolCall: async (...a) => { calls.push(["runOwnerToolCall", ...a]); inFlight.push(s._toolCallInFlight); return ownerResult; } });
    for (const name of ["end_call", "owner_cancel_appointment", "cancel_appointment", "book_appointment", "transfer_call", "check_availability"]) {
      const toolCall = { id: `t-${name}`, name, args: { appointment_id: "a1", reason: "booking_complete" } };
      const ret = await cbs.onToolCall(toolCall);
      assert.equal(ret, ownerResult, `${name}: the runner's object is the function response`);
      const run = calls.filter((c) => c[0] === "runOwnerToolCall").at(-1);
      assert.equal(run[1], s);
      assert.equal(run[2], toolCall);
      assert.deepEqual(Object.keys(run[3]).sort(), ["executeToolCall", "scheduleCache"]);
    }
    assert.deepEqual(guardCalls, [], "no customer guard ran");
    assert.deepEqual(calls.filter((c) => c[0] === "executeToolCall"), [], "server.js never calls the executor itself on an owner call");
    assert.equal(s.toolCallAudit.length, 1, "server.js adds no customer audit entries");
    assert.equal(s._lastToolResult, undefined, "the Tier-2 validator is never armed");
    assert.ok(inFlight.length === 6 && inFlight.every((v) => v === true), "in flight while the runner runs");
    assert.equal(s._toolCallInFlight, false, "cleared after");
  });

  it("an owner write in flight holds off the goodbye-loop auto-end, and the flag clears even if the runner throws", async () => {
    const s = makeSession({ owner: true });
    let release;
    const { cbs, calls, lines } = makeGeminiCallbacks(s, { runOwnerToolCall: () => new Promise((resolve) => { release = resolve; }) });
    const write = cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    for (let i = 0; i < 3; i++) { cbs.onAudio("AAAA"); cbs.onTranscriptOut("Goodbye, have a great day!"); cbs.onTurnComplete(); }
    assert.ok(lines.some((l) => l.includes("[GoodbyeLoop] Skipping auto-end — tool call in flight")), lines.join("\n"));
    assert.deepEqual(calls.filter((c) => c[0] === "twilio.close"), [], "the call was not closed mid-write");
    release({ message: "done", data: { outcome: "cancelled" } });
    await write;
    assert.equal(s._toolCallInFlight, false);
    const t = makeSession({ owner: true });
    const thrower = makeGeminiCallbacks(t, { runOwnerToolCall: async () => { throw new Error("boom"); } });
    await assert.rejects(thrower.cbs.onToolCall({ id: "t2", name: "owner_list_messages", args: {} }), /boom/);
    assert.equal(t._toolCallInFlight, false, "cleared in finally");
  });

  it("a customer call still meets the end_call funnel and the cancel gate (unchanged)", async () => {
    const s = makeSession({ owner: false });
    s.toolCallAudit.push({ name: "check_availability", successful: true, at: 1 });
    const { cbs, calls } = makeGeminiCallbacks(s);
    const end = await cbs.onToolCall({ id: "t1", name: "end_call", args: { reason: "done" } });
    assert.match(end.message, /^CANNOT END CALL YET/);
    const held = await cbs.onToolCall({ id: "t2", name: "cancel_appointment", args: { phone: "+61400000999", date: "2026-10-16" } });
    assert.match(held.message, /^DO NOT CANCEL YET/);
    assert.deepEqual(calls.filter((c) => c[0] === "runOwnerToolCall" || c[0] === "executeToolCall"), []);
  });

  it("owner turn clock: a spoken turn counts once (interrupted + turnComplete), a tool-call-only turn not at all", () => {
    const s = makeSession({ owner: true });
    const { cbs } = makeGeminiCallbacks(s);
    cbs.onAudio("AAAA"); cbs.onAudio("BBBB"); // the greeting
    assert.ok(s.lastAssistantSpeechAt > 0, "assistant audio is stamped");
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 1);
    assert.ok(s.lastAssistantTurnAt > 0);
    cbs.onAudio("CCCC"); cbs.onTranscriptOut("Bob Lee, Friday 3pm — cancel it?"); // a read-back, barged in on
    cbs.onInterrupted();
    assert.equal(s.assistantTurnSeq, 2, "the interrupted turn ends AT the interruption");
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 2, "interrupted + turnComplete of one turn is ONE turn");
    cbs.onTurnComplete(); // a tool-call-only turn (no audio, no transcription)
    assert.equal(s.assistantTurnSeq, 2);
  });

  it("owner turn clock (realtime failover): a response that ends in tool calls is not a turn — its spoken follow-up counts once", () => {
    const s = makeSession({ owner: true });
    const { cbs } = makeGeminiCallbacks(s);
    cbs.onAudio("AAAA"); // "one moment" …
    cbs.onTurnComplete({ endedWithToolCalls: true }); // … said with a tool call: the adapter runs it next
    assert.equal(s.assistantTurnSeq, 0, "not the end of the assistant's turn");
    cbs.onAudio("BBBB"); // the follow-up, spoken after the tool result
    cbs.onTurnComplete({ endedWithToolCalls: false });
    assert.equal(s.assistantTurnSeq, 1, "filler + follow-up: one turn");
    cbs.onAudio("CCCC");
    cbs.onTurnComplete(); // Gemini passes nothing: a spoken turn counts as before
    assert.equal(s.assistantTurnSeq, 2);
    const customer = makeSession({ owner: false });
    const c = makeGeminiCallbacks(customer);
    c.cbs.onAudio("AAAA"); c.cbs.onTranscriptOut("You're all set for Friday."); c.cbs.onTurnComplete({ endedWithToolCalls: true });
    assert.equal(customer.assistantTurnSeq, 0, "customers are never stamped");
    assert.equal(c.calls.filter((x) => x[0] === "detectPhantomAction").length, 1, "a customer turn still runs its turn-complete guards, whatever the adapter passes");
  });

  it("reviewer probes: output transcription never makes a turn spoken — a late fragment can't double-count or count a tool-call-only turn", async () => {
    const s = makeSession({ owner: true });
    const { cbs } = makeGeminiCallbacks(s);
    // A late fragment between interrupted and a SEPARATE turnComplete: one turn.
    cbs.onAudio("AAAA");
    cbs.onInterrupted();
    assert.equal(s.assistantTurnSeq, 1);
    cbs.onTranscriptOut(" …cancel it?"); // trails the interrupted turn
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 1, "the late fragment did not make its turnComplete a second turn");
    // A late fragment followed by a tool-call-only turn: that turn doesn't count.
    cbs.onAudio("BBBB");
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 2);
    const heard = s.lastAssistantSpeechAt;
    await sleep(3);
    cbs.onTranscriptOut(" Goodbye."); // trails the turn that just ended
    cbs.onTurnComplete(); // Gemini 3.8's extra turnComplete for a tool call
    assert.equal(s.assistantTurnSeq, 2, "a tool-call-only turn after a late fragment is not a turn");
    assert.equal(s.lastAssistantSpeechAt, heard, "transcription never stamps assistant speech");
    // Transcription alone never makes a turn spoken.
    cbs.onTranscriptOut("text with no audio");
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 2);
  });

  it("owner speech: the first non-empty input fragment after an assistant turn stamps, once per utterance", async () => {
    const s = makeSession({ owner: true });
    const { cbs } = makeGeminiCallbacks(s);
    cbs.onTranscriptIn("   ");
    assert.equal(s.lastOwnerSpeechAt, 0, "noise is not speech");
    cbs.onTranscriptIn("<noise>");
    cbs.onTranscriptIn(" [inaudible] ");
    assert.equal(s.lastOwnerSpeechAt, 0, "transcription markers are not speech");
    cbs.onTranscriptIn("ok");
    const first = s.lastOwnerSpeechAt;
    assert.ok(first > 0);
    await sleep(3);
    cbs.onTranscriptIn(" thanks");
    assert.equal(s.lastOwnerSpeechAt, first, "same utterance");
    cbs.onAudio("AAAA");
    cbs.onTurnComplete();
    await sleep(3);
    cbs.onTranscriptIn("yes");
    assert.ok(s.lastOwnerSpeechAt > first, "a new utterance after the assistant spoke");
  });

  it("owner turn-complete never runs the phantom detector or the Tier-2 validator; a customer turn still does", async () => {
    const owner = makeSession({ owner: true });
    owner._lastToolResult = { name: "owner_cancel_appointment", message: "x", at: Date.now() };
    const o = makeGeminiCallbacks(owner);
    o.cbs.onTranscriptOut("Done — I've cancelled Bob Lee's job.");
    o.cbs.onTurnComplete();
    assert.deepEqual(o.calls.filter((c) => c[0] === "detectPhantomAction" || c[0] === "validateToolResponse"), []);
    const customer = makeSession({ owner: false });
    const c = makeGeminiCallbacks(customer);
    c.cbs.onTranscriptOut("You're all set for Friday.");
    c.cbs.onTurnComplete();
    assert.equal(c.calls.filter((x) => x[0] === "detectPhantomAction").length, 1);
  });

  it("customer sessions are never stamped", () => {
    const s = makeSession({ owner: false });
    const { cbs } = makeGeminiCallbacks(s);
    cbs.onAudio("AAAA"); cbs.onTranscriptOut("hello"); cbs.onTurnComplete(); cbs.onInterrupted(); cbs.onTranscriptIn("yes");
    assert.equal(s.assistantTurnSeq, 0);
    assert.equal(s.lastAssistantTurnAt, 0);
    assert.equal(s.lastOwnerSpeechAt, 0);
  });

  it("end to end with the REAL runner: arm → read-back → owner 'yes' → the confirm reaches PR B as confirmed:true", async () => {
    const s = makeSession({ owner: true });
    const executed = [];
    const executeToolCall = async (name, args, context) => { executed.push({ name, args, context }); return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION; };
    const { cbs } = makeGeminiCallbacks(s, { runOwnerToolCall, executeToolCall });
    cbs.onAudio("AAAA"); cbs.onTurnComplete(); // greeting
    await sleep(3);
    cbs.onTranscriptIn("cancel Bob's job on Friday");
    const armed = await cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1" } });
    assert.deepEqual(armed, { message: NEEDS_CONFIRMATION.message, data: NEEDS_CONFIRMATION.data }, "message AND data reach Gemini");
    await sleep(3);
    cbs.onAudio("AAAA"); cbs.onTranscriptOut("Bob Lee, Friday 3pm — cancel it?"); cbs.onTurnComplete(); // the read-back
    await sleep(3);
    cbs.onTranscriptIn("yes");
    const done = await cbs.onToolCall({ id: "t2", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    assert.equal(executed.at(-1).args.confirmed, true);
    assert.equal(executed.at(-1).context.ownerMode, true);
    assert.equal(executed.at(-1).context.callId, "call-1");
    assert.equal(done.data.outcome, "cancelled");
  });

  it("end to end: the owner barges in on the read-back with 'yes' — the confirm goes through before any turnComplete", async () => {
    const s = makeSession({ owner: true });
    const executed = [];
    const executeToolCall = async (name, args) => { executed.push(args); return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION; };
    const { cbs } = makeGeminiCallbacks(s, { runOwnerToolCall, executeToolCall });
    await cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1" } });
    await sleep(3);
    cbs.onAudio("AAAA"); // the read-back starts…
    cbs.onInterrupted(); // …and the owner talks over it
    await sleep(3);
    cbs.onTranscriptIn("yes, do it");
    await cbs.onToolCall({ id: "t2", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    assert.equal(executed.at(-1).confirmed, true);
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 1, "the interrupted read-back was one turn");
  });

  it("end to end: a confirm the model sends WITHOUT waiting for the owner is forwarded as confirmed:false (after the 1500 ms settle wait)", async (t) => {
    const s = makeSession({ owner: true });
    const executed = [];
    const executeToolCall = async (name, args) => { executed.push(args); return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION; };
    const { cbs } = makeGeminiCallbacks(s, { runOwnerToolCall, executeToolCall });
    await cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1" } });
    await sleep(3);
    cbs.onAudio("AAAA"); cbs.onTurnComplete(); // read-back, but the owner never answers
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const confirm = cbs.onToolCall({ id: "t2", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    for (let i = 0; i < 16; i++) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(100); }
    await confirm;
    assert.equal(executed.at(-1).confirmed, false);
  });

  it("end to end: the owner's 'yes' transcript lands AFTER the model's confirm — the settle wait lets it through", async (t) => {
    const s = makeSession({ owner: true });
    const executed = [];
    const executeToolCall = async (name, args) => { executed.push(args); return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION; };
    const { cbs } = makeGeminiCallbacks(s, { runOwnerToolCall, executeToolCall });
    await cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1" } });
    await sleep(3);
    cbs.onAudio("AAAA"); cbs.onTurnComplete(); // the read-back
    await sleep(3);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const confirm = cbs.onToolCall({ id: "t2", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    for (let i = 0; i < 3; i++) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(100); }
    cbs.onTranscriptIn("yes"); // Gemini delivers the input transcription ~300 ms late
    for (let i = 0; i < 3; i++) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(100); }
    await confirm;
    assert.equal(executed.at(-1).confirmed, true);
  });
});

// ─── Classic pipeline, run for real ─────────────────────────────────────────

function makeClassicStt(session) {
  let callbacks = null;
  const lines = [];
  runSlice({
    from: "// ── Classic pipeline (Deepgram STT + OpenAI LLM + Deepgram TTS) ──",
    to: "// Recording disclosure + greeting — pre-synthesize disclosure while STT connects",
    scope: {
      session,
      openDeepgramStream: (key, cbs) => { callbacks = cbs; return { readyState: 1 }; },
      DEEPGRAM_API_KEY: "dg",
      logTranscript: () => {},
      handleUserSpeech: async () => {},
      twilioWs: { readyState: 1, send: () => {}, close: () => {} },
      sendTTS: async () => 0,
      getErrorMsg: () => "",
      noteOwnerSpeech,
      console: recordingConsole(lines),
    },
  });
  return callbacks;
}

function classicGreeting(session) {
  const calls = [];
  const r = runSlice({
    from: "// Recording disclosure + greeting — pre-synthesize disclosure while STT connects",
    to: "const greetingAudioPromise = synthesizeSpeech(",
    scope: {
      session, context: makeContext(), isAfterHours: false, afterHoursConfig: null,
      requiresRecordingDisclosureHybrid: (...a) => { calls.push(["requiresRecordingDisclosureHybrid", ...a]); return { required: true, callerState: "NSW", reason: "all-party" }; },
      getRecordingDisclosureText: () => "This call is recorded.",
      synthesizeSpeech: (...a) => { calls.push(["synthesizeSpeech", a[1]]); return Promise.resolve(null); },
      DEEPGRAM_API_KEY: "dg",
      getGreeting: () => "Thanks for calling Copperline Plumbing!",
      buildOwnerGreeting,
      console: recordingConsole([]),
    },
    names: ["consentResult", "greeting", "disclosureText"],
  });
  return { ...r, calls };
}

/** buildLLMOptions … handleUserSpeech, live. */
function makeClassic(o = {}) {
  const calls = [];
  const lines = [];
  const steps = [...(o.steps || [])];
  const scope = {
    calendarToolDefinitions: toolExecutor.calendarToolDefinitions,
    listServiceTypesToolDefinition: toolExecutor.listServiceTypesToolDefinition,
    transferToolDefinition: toolExecutor.transferToolDefinition,
    callbackToolDefinition: toolExecutor.callbackToolDefinition,
    endCallToolDefinition: toolExecutor.endCallToolDefinition,
    forwardingFallbackEligible,
    buildOwnerTools,
    DEFAULT_MODEL: "test-model",
    LLM_API_KEY: "llm",
    streamChatResponse: async (key, messages, opts) => {
      calls.push(["llm", opts.tools.map((t) => t.function.name)]);
      const step = steps.shift();
      assert.ok(step, "the LLM was called more often than scripted");
      if (step.throws) throw new Error(step.throws);
      if (step.content !== undefined) {
        for (const sentence of step.sentences || [step.content]) opts.onSentence(sentence);
        return { type: "content", content: step.content };
      }
      const toolCalls = step.tools.map((t, i) => ({ id: `tc${i}`, type: "function", function: { name: t.name, arguments: t.arguments } }));
      return { type: "tool_calls", toolCalls, message: { role: "assistant", content: null, tool_calls: toolCalls } };
    },
    startHoldAudio: () => ({ stop: () => {} }),
    sendClear: () => {},
    // Real TTS takes far longer than a millisecond; 2 ms keeps a read-back's audio stamp after its arm.
    sendTTS: async (s, ws, text) => { calls.push(["sendTTS", text]); await sleep(2); if (o.ttsFails) throw new Error("tts down"); return 100; },
    executeToolCall: o.executeToolCall || (async (...a) => { calls.push(["executeToolCall", ...a]); return { message: "customer tool result" }; }),
    runOwnerToolCall: o.runOwnerToolCall || (async (...a) => { calls.push(["runOwnerToolCall", ...a]); return { message: "owner result" }; }),
    scheduleCache: { invalidate: () => {}, applyDelta: () => {} },
    noteAssistantSpeech,
    noteAssistantTurnEnd,
    getErrorMsg: (lang, key) => `ERR:${key}`,
    detectExpectedInput: () => "general",
    logTranscript: () => {},
    bookingKey: () => "k",
    classifyRebookAttempt: () => ({ kind: "duplicate" }),
    CORRECTION_ERROR_MESSAGE: "correction failed",
    DUPLICATE_REBOOK_MESSAGE: "duplicate",
    Sentry: fakeSentry(calls),
    normalizeDatetime: (x) => x,
    CANCEL_NUDGE: " (nothing booked now)",
    RESCHEDULE_SUCCESS_SIGNAL: /moved/,
    applyRescheduleToLedger: () => ({ moved: false }),
    saveForTransfer: (...a) => calls.push(["saveForTransfer", ...a]),
    console: recordingConsole(lines),
  };
  const fns = runSlice({
    from: "function buildLLMOptions(session, { includeTransfer = false } = {}) {",
    to: "/**\n * Synthesize text and stream mulaw chunks back to Twilio.",
    scope,
    names: ["buildLLMOptions", "handleUserSpeech"],
  });
  return { ...fns, calls, lines, steps };
}
const twilio = { readyState: 1, send: () => {} };
const toolMessages = (s) => s.messages.filter((m) => m.role === "tool");

describe("SCRUM-587: classic pipeline, run for real", () => {
  it("buildLLMOptions gives an owner session exactly the owner tools, whatever the org has configured", () => {
    const { buildLLMOptions } = makeClassic();
    const s = makeSession({ owner: true });
    s.transferRules = [{ id: "tr1", phone: "+61400000002" }];
    assert.deepEqual(buildLLMOptions(s, { includeTransfer: true }), { tools: buildOwnerTools() });
    assert.deepEqual(buildLLMOptions(s), { tools: buildOwnerTools() });
    const customer = buildLLMOptions(makeSession({ owner: false }), { includeTransfer: true }).tools.map((t) => t.function.name);
    assert.ok(customer.includes("schedule_callback") && customer.includes("book_appointment"), "customers unchanged");
  });

  it("owner greeting, and no disclosure (not even evaluated); customers unchanged", () => {
    const owner = classicGreeting(makeSession({ owner: true }));
    assert.deepEqual(owner.consentResult, { required: false, callerState: null, reason: "owner-call" });
    assert.equal(owner.greeting, "Hi Dave, what do you need?");
    assert.equal(owner.disclosureText, "");
    assert.deepEqual(owner.calls, []);
    const customer = classicGreeting(makeSession({ owner: false }));
    assert.equal(customer.greeting, "Thanks for calling Copperline Plumbing!");
    assert.equal(customer.disclosureText, "This call is recorded.");
    assert.deepEqual(customer.calls.map((c) => c[0]), ["requiresRecordingDisclosureHybrid", "synthesizeSpeech"]);
  });

  it("STT finals stamp owner speech once per utterance; echo-suppressed and interim transcripts don't", async () => {
    const s = makeSession({ owner: true });
    s.bufferTranscript = () => {};
    const stt = makeClassicStt(s);
    stt.onTranscript({ transcript: "yes", isFinal: false });
    assert.equal(s.lastOwnerSpeechAt, 0, "interim");
    s.isSpeaking = true;
    stt.onTranscript({ transcript: "yes", isFinal: true });
    assert.equal(s.lastOwnerSpeechAt, 0, "dropped as echo while the AI speaks");
    s.isSpeaking = false;
    stt.onTranscript({ transcript: "yes", isFinal: true });
    const first = s.lastOwnerSpeechAt;
    assert.ok(first > 0);
    await sleep(3);
    stt.onTranscript({ transcript: "go ahead", isFinal: true });
    assert.equal(s.lastOwnerSpeechAt, first, "same utterance");
    const customer = makeSession({ owner: false });
    customer.bufferTranscript = () => {};
    makeClassicStt(customer).onTranscript({ transcript: "yes", isFinal: true });
    assert.equal(customer.lastOwnerSpeechAt, 0);
  });

  it("end to end with the REAL runner: parsed args, message+data as the tool message, one turn per spoken reply, confirm after the owner's yes", async () => {
    const s = makeSession({ owner: true });
    const executed = [];
    const executeToolCall = async (name, args, context) => { executed.push({ name, args, context }); return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION; };
    const guardCalls = [];
    s.confirmCancel = () => { guardCalls.push("confirmCancel"); return false; };
    s.rememberDetails = () => { guardCalls.push("rememberDetails"); };
    const c = makeClassic({
      runOwnerToolCall,
      executeToolCall,
      steps: [
        { tools: [{ name: "owner_cancel_appointment", arguments: '{"appointment_id":"a1"}' }] },
        { content: "Bob Lee, Friday at 3 p.m. — cancel it?" },
        { tools: [{ name: "owner_cancel_appointment", arguments: '{"appointment_id":"a1","confirmed":true}' }] },
        { content: "Done. Bob hasn't been told." },
      ],
    });
    await c.handleUserSpeech(s, twilio, "cancel Bob's job on Friday");
    assert.deepEqual(c.calls.find((x) => x[0] === "llm")[1], buildOwnerTools().map((t) => t.function.name));
    assert.deepEqual(executed[0].args, { appointment_id: "a1" }, "the JSON string arrives parsed");
    assert.equal(toolMessages(s)[0].content, JSON.stringify({ message: NEEDS_CONFIRMATION.message, data: NEEDS_CONFIRMATION.data }));
    assert.equal(s.assistantTurnSeq, 1, "the read-back was spoken: one turn");
    await sleep(3);
    noteOwnerSpeech(s, "yes"); // as the classic STT final does (pinned above)
    await c.handleUserSpeech(s, twilio, "yes");
    assert.equal(executed[1].args.confirmed, true, "the owner answered the read-back");
    assert.equal(executed[1].context.ownerMode, true);
    assert.equal(toolMessages(s)[1].content, JSON.stringify({ message: CANCELLED.message, data: CANCELLED.data }));
    assert.equal(s.assistantTurnSeq, 2);
    assert.deepEqual(guardCalls, [], "no customer guard ran");
    assert.deepEqual(c.steps, []);
  });

  it("a malformed argument string reaches the runner as {}", async () => {
    const s = makeSession({ owner: true });
    const c = makeClassic({ steps: [{ tools: [{ name: "owner_list_messages", arguments: "{not json" }] }, { content: "Here they are." }] });
    await c.handleUserSpeech(s, twilio, "any messages?");
    const run = c.calls.find((x) => x[0] === "runOwnerToolCall");
    assert.deepEqual(run[2], { name: "owner_list_messages", args: {} });
    assert.equal(run[1], s);
    assert.deepEqual(Object.keys(run[3]).sort(), ["executeToolCall", "scheduleCache"]);
    assert.equal(toolMessages(s)[0].content, "owner result", "a result without data is its message");
  });

  it("no turn is counted when the reply never reached the caller, or the turn ended in an error", async () => {
    const tts = makeSession({ owner: true });
    const c1 = makeClassic({ ttsFails: true, steps: [{ content: "Bob Lee, Friday at 3 p.m. — cancel it?" }] });
    await c1.handleUserSpeech(tts, twilio, "cancel Bob's job on Friday");
    assert.equal(tts.assistantTurnSeq, 0, "TTS failed: nothing was heard");
    const err = makeSession({ owner: true });
    const c2 = makeClassic({ steps: [{ tools: [{ name: "owner_cancel_appointment", arguments: '{"appointment_id":"a1"}' }] }, { throws: "OpenAI down" }] });
    await c2.handleUserSpeech(err, twilio, "cancel Bob's job on Friday");
    assert.equal(err.assistantTurnSeq, 0, "an apology is not a read-back");
    const loop = makeSession({ owner: true });
    const c3 = makeClassic({ steps: [1, 2, 3].map(() => ({ tools: [{ name: "owner_list_messages", arguments: "{}" }] })) });
    await c3.handleUserSpeech(loop, twilio, "any messages for me today?");
    assert.equal(loop.assistantTurnSeq, 0, "the loop-exhausted fallback is not a read-back");
  });

  it("a customer call still meets the cancel gate, never the runner, and is never stamped", async () => {
    const s = makeSession({ owner: false });
    const c = makeClassic({ steps: [{ tools: [{ name: "cancel_appointment", arguments: '{"phone":"+61400000999","date":"2026-10-16"}' }] }, { content: "Just to confirm — cancel Friday?" }] });
    await c.handleUserSpeech(s, twilio, "cancel my Friday appointment");
    assert.match(toolMessages(s)[0].content, /^DO NOT CANCEL YET/);
    assert.deepEqual(c.calls.filter((x) => x[0] === "runOwnerToolCall" || x[0] === "executeToolCall"), []);
    assert.equal(s.assistantTurnSeq, 0);
  });
});

// ─── Post-call (cleanupSession), run for real ───────────────────────────────

function makeCleanup(session, o = {}) {
  const calls = [];
  const lines = [];
  const scope = {
    session,
    cleaningUp: false,
    sessions: new Map(),
    Sentry: fakeSentry(calls),
    detectPostCallPhantoms: () => { calls.push(["detectPostCallPhantoms"]); return o.phantoms || []; },
    summarizePhantoms: () => ({ bugTag: "hallucinated_cancellation", reason: "hallucinated-cancellation" }),
    analyzeCallTranscript: async () => { calls.push(["analyzeCallTranscript"]); return o.analysis || null; },
    buildToolOutcomeDigest: () => "",
    DEBUG_TRANSCRIPTS: false,
    maybeEmitUnhappyCall: () => calls.push(["maybeEmitUnhappyCall"]),
    netLiveOutcome: () => 0,
    setReasonTag: () => {},
    SENTRY_REASONS: { BOOKING_STATE_MISMATCH: "booking-state-mismatch" },
    detectAndRedact: o.detectAndRedact || ((t) => ({ piiFound: false, redacted: t })),
    redactObject: (x) => ({ piiFound: false, redacted: x }),
    completeCallRecord: async (id, fields) => {
      calls.push(["completeCallRecord", id, fields]);
      await sleep(5);
      if ((o.failWrites || 0) > calls.filter((c) => c[0] === "completeCallRecord").length - 1) throw new Error("db write failed: connection reset");
      calls.push(["completeCallRecord:done"]);
    },
    // The owner retry's back-off, without real waiting.
    setTimeout: (fn, ms) => { calls.push(["retry-delay", ms]); fn(); },
    notifyCallCompleted: async (url, secret, payload) => { calls.push(["notifyCallCompleted", payload]); },
    INTERNAL_API_URL: "http://next.internal",
    INTERNAL_API_SECRET: "secret",
    maskPhone,
    buildOwnerCallSummary,
    settleOwnerToolRuns: o.settleOwnerToolRuns || settleOwnerToolRuns,
    console: recordingConsole(lines),
  };
  const { cleanupSession } = runSlice({ from: "async function cleanupSession() {", to: 'twilioWs.on("message", async (raw) => {', scope, names: ["cleanupSession"] });
  return { cleanupSession, calls, lines };
}
function endedCall(session) {
  session.startedAt = Date.now() - 60_000;
  session.addMessage("user", "Cancel Bob Lee's job on Friday.");
  session.addMessage("assistant", "Done — I've cancelled Bob Lee's job on Friday.");
  return session;
}

describe("SCRUM-587: post-call (cleanupSession), run for real", () => {
  it("an owner call: no claim scan, no OpenAI analysis, the deterministic record — written before the webhook — and no audit in the logs", async () => {
    const s = endedCall(makeSession({ owner: true }));
    s.toolCallAudit.push({ name: "owner_cancel_appointment", successful: true, at: 1, ownerDetail: "Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM." });
    const audit = [...s.toolCallAudit];
    const { cleanupSession, calls, lines } = makeCleanup(s, { phantoms: ["cancellation"], analysis: { summary: "LLM summary", callerName: "Bob" } });
    await cleanupSession();
    const names = calls.map((c) => c[0]);
    for (const skipped of ["detectPostCallPhantoms", "analyzeCallTranscript", "maybeEmitUnhappyCall"]) assert.ok(!names.includes(skipped), skipped);
    const [, id, fields] = calls.find((c) => c[0] === "completeCallRecord");
    assert.equal(id, "call-1");
    assert.equal(fields.status, "completed");
    assert.equal(fields.callType, "owner");
    assert.equal(fields.ownerAuth, "verified");
    assert.equal(fields.actionTaken, "owner_call");
    assert.equal(fields.callerName, "Dave");
    assert.equal(fields.summary, buildOwnerCallSummary(audit));
    assert.equal(fields.summary, "Owner call: Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM.");
    const written = names.indexOf("completeCallRecord:done");
    assert.ok(written >= 0 && written < names.indexOf("notifyCallCompleted"), "the DB row is written (awaited) before the webhook");
    const payload = calls.find((c) => c[0] === "notifyCallCompleted")[1];
    assert.equal(payload.callType, "owner");
    assert.equal(payload.ownerAuth, "verified");
    assert.ok(!lines.join("\n").includes("Bob Lee"), "customer names in the owner audit never reach a log line");
  });

  it("an owner whose first name is unknown is recorded as 'Owner'", async () => {
    const s = endedCall(makeSession({ owner: true }));
    s.ownerFirstName = null;
    const { cleanupSession, calls } = makeCleanup(s);
    await cleanupSession();
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].callerName, "Owner");
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].summary, "Owner call: no changes made.");
  });

  it("a customer call is unchanged; one that failed the PIN gate only adds owner_auth", async () => {
    for (const ownerAuth of [null, "locked"]) {
      const s = endedCall(makeSession({ owner: false, ownerAuth }));
      const analysis = { summary: "Caller asked to cancel.", callerName: "Bob", successEvaluation: "successful" };
      const { cleanupSession, calls } = makeCleanup(s, { analysis });
      await cleanupSession();
      const names = calls.map((c) => c[0]);
      assert.ok(names.includes("detectPostCallPhantoms") && names.includes("analyzeCallTranscript"), String(ownerAuth));
      const fields = calls.find((c) => c[0] === "completeCallRecord")[2];
      assert.equal(fields.callType, null);
      assert.equal(fields.ownerAuth, ownerAuth);
      assert.equal(fields.summary, "Caller asked to cancel.");
      assert.equal(fields.callerName, "Bob");
      assert.equal(fields.actionTaken, null);
      const body = JSON.stringify(calls.find((c) => c[0] === "notifyCallCompleted")[1]);
      assert.ok(!body.includes("callType"), "a customer webhook body never carries callType");
      assert.equal(body.includes("ownerAuth"), ownerAuth !== null, String(ownerAuth));
    }
  });
});

describe("SCRUM-587: post-call — an owner record that can't be written never reaches PR B as a customer call", () => {
  const ALERT = "[ALERT:error]";
  it("a failed owner write is retried once; when the retry lands, the webhook goes and nothing pages", async () => {
    const s = endedCall(makeSession({ owner: true }));
    const { cleanupSession, calls, lines } = makeCleanup(s, { failWrites: 1 });
    await cleanupSession();
    assert.equal(calls.filter((c) => c[0] === "completeCallRecord").length, 2);
    assert.deepEqual(calls.filter((c) => c[0] === "retry-delay").map((c) => c[1]), [1000]);
    assert.equal(calls.filter((c) => c[0] === "notifyCallCompleted").length, 1);
    assert.deepEqual(lines.filter((l) => l.includes(ALERT)), []);
  });

  it("an owner write that fails twice skips the webhook and pages once — ids only", async () => {
    const s = endedCall(makeSession({ owner: true }));
    s.toolCallAudit.push({ name: "owner_cancel_appointment", successful: true, at: 1, ownerDetail: "Cancelled Bob Lee's job on Friday." });
    const { cleanupSession, calls, lines } = makeCleanup(s, { failWrites: 2 });
    await cleanupSession();
    assert.equal(calls.filter((c) => c[0] === "completeCallRecord").length, 2, "one retry, no more");
    assert.deepEqual(calls.filter((c) => c[0] === "notifyCallCompleted"), [], "PR B never sees the owner's call as a customer call");
    const alerts = lines.filter((l) => l.includes(ALERT));
    assert.equal(alerts.length, 1, lines.join("\n"));
    for (const id of ["CA-owner", "call-1", "org-1"]) assert.ok(alerts[0].includes(id), `${id} missing: ${alerts[0]}`);
    for (const secret of ["Bob Lee", "Cancel", "+61400000001", "connection reset"]) assert.ok(!alerts[0].includes(secret), `${secret} leaked: ${alerts[0]}`);
  });

  it("an owner call with no call record at all skips the webhook and pages once", async () => {
    const s = endedCall(makeSession({ owner: true }));
    s.callRecordId = null;
    const { cleanupSession, calls, lines } = makeCleanup(s);
    await cleanupSession();
    assert.deepEqual(calls.filter((c) => c[0] === "completeCallRecord" || c[0] === "notifyCallCompleted"), []);
    assert.equal(lines.filter((l) => l.includes(ALERT)).length, 1);
  });

  it("customer calls are unchanged: one attempt, no retry, and the webhook still goes", async () => {
    for (const ownerAuth of [null, "locked"]) {
      const s = endedCall(makeSession({ owner: false, ownerAuth }));
      const { cleanupSession, calls, lines } = makeCleanup(s, { failWrites: 1 });
      await cleanupSession();
      assert.equal(calls.filter((c) => c[0] === "completeCallRecord").length, 1, String(ownerAuth));
      assert.deepEqual(calls.filter((c) => c[0] === "retry-delay"), []);
      assert.equal(calls.filter((c) => c[0] === "notifyCallCompleted").length, 1, String(ownerAuth));
      assert.deepEqual(lines.filter((l) => l.includes(ALERT)), []);
    }
  });
});

// ─── The owner hangs up while a change is in flight (silent-failure lens SF2) ───
describe("SCRUM-587: post-call — the owner hangs up while a change is in flight", () => {
  const STALL = "I'm having a little trouble right now. Could you give me a moment?";
  /** The gate's clock as server.js leaves it once the owner has answered a read-back of a1. */
  function answeredReadBack(s) {
    const t = Date.now();
    s.ownerPendingConfirmations = new Map([["owner_cancel_appointment|a1", { at: t - 3000, seq: 0 }]]);
    s.assistantTurnSeq = 1; s.lastAssistantTurnAt = t - 1000; s.lastAssistantSpeechAt = t - 1500; s.lastOwnerSpeechAt = t - 500;
  }
  /** An executor whose answer the test hands over. */
  function heldExecutor() {
    let release;
    const executeToolCall = () => new Promise((resolve) => { release = resolve; });
    return { executeToolCall, release: (r) => release(r) };
  }
  /** Captures the real console (the runner logs there, not through the slices' stand-ins). */
  function globalConsole(t) {
    const lines = [];
    for (const level of ["log", "warn", "error"]) t.mock.method(console, level, (...a) => lines.push(`${level}| ${util.format(...a)}`));
    return lines;
  }

  it("Gemini: cleanup waits for the confirmed write in flight, so the stored summary names the change that landed", async (t) => {
    const logged = globalConsole(t);
    const s = endedCall(makeSession({ owner: true }));
    answeredReadBack(s);
    const held = heldExecutor();
    const { cbs } = makeGeminiCallbacks(s, { runOwnerToolCall, executeToolCall: held.executeToolCall });
    const inFlight = cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    await sleep(5);
    assert.equal(s._toolCallInFlight, true, "precondition: the write is in flight");
    const { cleanupSession, calls } = makeCleanup(s);
    const cleanup = cleanupSession(); // the owner hangs up right after "yes"
    await sleep(10);
    assert.equal(calls.some((c) => c[0] === "completeCallRecord"), false, "the record is not finalised while the write is still running");
    held.release(CANCELLED);
    assert.equal((await inFlight).data.outcome, "cancelled");
    await cleanup;
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].summary, "Owner call: Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM.");
    assert.deepEqual(logged.filter((l) => l.includes("[ALERT:error]")), [], "it landed inside the wait: nothing to page");
  });

  it("classic: the same wait covers a write the classic tool loop has in flight", async () => {
    const s = endedCall(makeSession({ owner: true }));
    answeredReadBack(s);
    const held = heldExecutor();
    const c = makeClassic({
      runOwnerToolCall,
      executeToolCall: held.executeToolCall,
      steps: [{ tools: [{ name: "owner_cancel_appointment", arguments: '{"appointment_id":"a1","confirmed":true}' }] }, { content: "Done." }],
    });
    const turn = c.handleUserSpeech(s, twilio, "yes");
    await sleep(5);
    assert.equal(s.ownerToolRunsInFlight.size, 1, "precondition: the write is in flight");
    const { cleanupSession, calls } = makeCleanup(s);
    const cleanup = cleanupSession();
    await sleep(10);
    assert.equal(calls.some((x) => x[0] === "completeCallRecord"), false);
    held.release(CANCELLED);
    await cleanup;
    assert.equal(calls.find((x) => x[0] === "completeCallRecord")[2].summary, "Owner call: Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM.");
    await turn;
  });

  it("a confirmed write whose answer never came back is stored as 'could not be confirmed', never 'no changes made'", async (t) => {
    globalConsole(t);
    const s = endedCall(makeSession({ owner: true }));
    answeredReadBack(s);
    const { cbs } = makeGeminiCallbacks(s, { runOwnerToolCall, executeToolCall: async () => ({ message: STALL }) });
    await cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    const { cleanupSession, calls } = makeCleanup(s);
    await cleanupSession();
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].summary, "Owner call: a change could not be confirmed — check the dashboard.");
  });

  it("a write still running when the wait runs out: the record is written without it, and its late landing pages — ids only", async (t) => {
    const logged = globalConsole(t);
    const s = endedCall(makeSession({ owner: true }));
    answeredReadBack(s);
    const held = heldExecutor();
    const { cbs } = makeGeminiCallbacks(s, { runOwnerToolCall, executeToolCall: held.executeToolCall });
    const inFlight = cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    await sleep(5);
    // A 20 ms budget stands in for the 8 s one (the budget itself: tests/owner-tool-runner.test.js).
    const { cleanupSession, calls } = makeCleanup(s, { settleOwnerToolRuns: (session) => settleOwnerToolRuns(session, 20) });
    await cleanupSession();
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].summary, "Owner call: no changes made.", "written without the write that is still out");
    assert.equal(calls.filter((c) => c[0] === "notifyCallCompleted").length, 1);
    held.release(CANCELLED);
    await inFlight;
    const paged = logged.filter((l) => l.includes("[ALERT:error]"));
    assert.equal(paged.length, 1, logged.join("\n"));
    for (const part of ["owner_cancel_appointment", "outcome=cancelled", "callSid=CA-owner", "org=org-1"]) assert.ok(paged[0].includes(part), `${part}: ${paged[0]}`);
    assert.ok(!paged[0].includes("Bob Lee"));
  });

  it("customer cleanup never waits on owner tool calls", async () => {
    const s = endedCall(makeSession({ owner: false }));
    let consulted = 0;
    const { cleanupSession, calls } = makeCleanup(s, { analysis: { summary: "Caller asked to cancel." }, settleOwnerToolRuns: async () => { consulted += 1; } });
    await cleanupSession();
    assert.equal(consulted, 0);
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].summary, "Caller asked to cancel.");
  });
});

describe("SCRUM-587: post-call — the owner summary gets the org's PII redaction", () => {
  const { detectAndRedact } = require("../lib/pii-detector");
  const DETAIL = "Moved Bob Lee (bob@example.com) to Friday 9 am";
  it("redaction on: the summary is redacted like the transcript before it is stored", async () => {
    const s = endedCall(makeSession({ owner: true }));
    s.piiRedactionEnabled = true;
    s.toolCallAudit.push({ name: "owner_reschedule_appointment", successful: true, at: 1, ownerDetail: DETAIL });
    const { cleanupSession, calls } = makeCleanup(s, { detectAndRedact });
    await cleanupSession();
    const fields = calls.find((c) => c[0] === "completeCallRecord")[2];
    assert.equal(fields.summary, detectAndRedact(`Owner call: ${DETAIL}.`).redacted);
    assert.ok(fields.summary.includes("[REDACTED-EMAIL]") && !fields.summary.includes("bob@example.com"), fields.summary);
    assert.equal(fields.piiRedacted, true);
  });
  it("redaction off: the summary is stored as built", async () => {
    const s = endedCall(makeSession({ owner: true }));
    s.toolCallAudit.push({ name: "owner_reschedule_appointment", successful: true, at: 1, ownerDetail: DETAIL });
    const { cleanupSession, calls } = makeCleanup(s, { detectAndRedact });
    await cleanupSession();
    const fields = calls.find((c) => c[0] === "completeCallRecord")[2];
    assert.equal(fields.summary, `Owner call: ${DETAIL}.`);
    assert.equal(fields.piiRedacted, false);
  });
});

describe("SCRUM-587: a transfer reconnect keeps the PIN-gate stamp, never owner mode", () => {
  it("restoreFrom carries ownerAuth and nothing that could make the session an owner session", () => {
    const s = new CallSession("CA-1");
    s.restoreFrom({ messages: [], ownerAuth: "locked", ownerMode: true, callType: "owner", ownerFirstName: "Dave" });
    assert.equal(s.ownerAuth, "locked");
    assert.equal(s.ownerMode, false);
    assert.equal(s.ownerFirstName, null);
    const junk = new CallSession("CA-2");
    junk.restoreFrom({ messages: [], ownerAuth: 7 });
    assert.equal(junk.ownerAuth, null);
    const plain = new CallSession("CA-3");
    plain.restoreFrom({ messages: [] });
    assert.equal(plain.ownerAuth, null);
  });
});
