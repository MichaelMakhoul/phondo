"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// SCRUM-596: the owner assistant in the dashboard. A verified owner token on
// /ws/test opens the phone line's owner assistant in the browser. The helpers are
// unit-tested in owner-web-session.test.js; this pins server.js's wiring and runs
// the classic owner loop (handleTestUserSpeech) for real with stubbed audio/models.

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function sliceOf(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}

const handler = sliceOf('testWss.on("connection", (ws, req) => {', "async function handleTestUserSpeech(session, ws, transcript) {");

describe("/ws/test: the owner branch (source)", () => {
  it("an owner token needs OWNER_ASSISTANT_ENABLED and a free org slot, checked in that order before anything is set up", () => {
    const gate = handler.indexOf("const ownerWeb = isOwnerWebToken(tokenData);");
    const flag = handler.indexOf("if (!ownerAssistantEnabled()) {");
    const slot = handler.indexOf("if (!ownerWebSessions.tryOpen(organizationId)) {");
    const init = handler.indexOf("const context = await loadTestCallContext(assistantId, organizationId);");
    assert.ok(gate > 0 && gate < flag && flag < slot && slot < init, `${gate} ${flag} ${slot} ${init}`);
    assert.match(handler, /ws\.send\(JSON\.stringify\(\{ type: "error", message: "The owner assistant is switched off\." \}\)\);\s*ws\.close\(4004, "Owner assistant off"\);/);
    assert.match(handler, /ws\.close\(4029, "Your assistant is already open in another tab\."\);/);
    // Both refusals give back the /ws/test slot they had reserved.
    const refusals = handler.slice(flag, handler.indexOf("ownerWebSlotOpen = true;", flag));
    assert.equal((refusals.match(/releaseTestSlot\(\);/g) || []).length, 2);
  });

  it("the org slot is released on teardown, after the owner post-call", () => {
    const cleanup = sliceOf("async function cleanupTestSession() {", "// Auto-disconnect after max duration.");
    const finish = cleanup.indexOf("await finishOwnerWebSession(");
    const release = cleanup.indexOf("ownerWebSessions.close(organizationId);");
    assert.ok(finish > 0 && release > finish, `${finish} ${release}`);
    assert.match(cleanup, /if \(session\.ownerMode\) \{/);
    assert.match(cleanup, /transcript: ended\.getTranscript\(\), durationSeconds: ended\.getDurationSeconds\(\)/);
  });

  it("the owner session: identity, then its call row before any tool can run, then the owner prompt", () => {
    assert.match(handler, /session = new CallSession\(ownerWeb \? ownerWebCallSid\(jti\) : `test_\$\{Date\.now\(\)\}`\);/);
    const owner = sliceOf("let ownerWebPrompt = null;", "// After-hours detection");
    for (const line of [
      "session.ownerMode = true;",
      'session.ownerAuth = "verified";',
      "session.piiRedactionEnabled = !!(context.assistant.settings?.piiRedactionEnabled);",
      "session.ownerFirstName = await loadOwnerFirstName(organizationId);",
      "const callRecordId = await createCallRecord({",
      "phoneNumberId: null,",
      "callerPhone: null,",
      "session.callRecordId = callRecordId;",
    ]) assert.ok(owner.includes(line), line);
    assert.ok(owner.indexOf("session.callRecordId = callRecordId;") < owner.indexOf("ownerWebPrompt = buildOwnerWebPrompt({"));
    // A row that couldn't be created ends the session with a message; a page closed
    // mid-setup gets its row completed rather than left "in-progress".
    assert.match(owner, /if \(!callRecordId\) \{\s*ws\.send\(JSON\.stringify\(\{ type: "error", message: "Couldn't start your assistant — please try again\." \}\)\);\s*ws\.close\(4500, "Owner call record failed"\);\s*return;/);
    assert.match(owner, /if \(cleaningUp\) \{[\s\S]*?await finishOwnerWebSession\(ownerSession, \{ transcript: "", durationSeconds: 0 \}, ownerWebFinishDeps\(\)\);[\s\S]*?return;/);
    assert.match(handler, /const systemPrompt = ownerWebPrompt\s*\? ownerWebPrompt\.systemPrompt\s*: buildSystemPrompt\(/);
    assert.match(handler, /if \(!session\.ownerMode && \(session\.calendarEnabled \|\| session\.serviceTypes\?\.length > 0\)\) \{/, "no schedule snapshot on an owner session");
  });

  it("the owner session follows OWNER_PIPELINE; a test call follows VOICE_PIPELINE as before", () => {
    assert.match(handler, /const sessionPipeline = session\.ownerMode \? resolveOwnerPipeline\(\) : VOICE_PIPELINE;\s*const useGeminiLive = sessionPipeline === "gemini-live" && process\.env\.GEMINI_API_KEY;/);
  });

  it("Gemini: owner tools, the greeting then the owner rules last (no customer rules), every hook of the phone line", () => {
    assert.match(handler, /const llmOptions = session\.ownerMode \? \{ tools: buildOwnerTools\(\) \} : buildLLMOptions\(session\);/);
    const ownerPrompt = sliceOf("if (ownerWebPrompt) {", "} else {");
    assert.ok(ownerPrompt.indexOf("YOUR FIRST MESSAGE") < ownerPrompt.indexOf("buildOwnerGeminiSuffix()"));
    assert.ok(!ownerPrompt.includes("CRITICAL RULES FOR THIS CONVERSATION"));
    assert.match(handler, /if \(session\?\.ownerMode\) noteAssistantSpeech\(session\);/);
    assert.match(handler, /if \(session\?\.ownerMode\) noteOwnerSpeech\(session, text\);/);
    assert.match(handler, /if \(session\.ownerMode\) noteAssistantTurnEnd\(session\);/);
    assert.match(handler, /onTurnComplete: \(turnInfo\) => \{/);
    assert.match(handler, /if \(session\.ownerMode && turnInfo\?\.endedWithToolCalls !== true\) noteAssistantTurnEnd\(session\);/);
    assert.match(handler, /onToolCallCancellation: \(ids\) => \{\s*if \(session\?\.ownerMode\) noteCancelledOwnerToolCalls\(session, ids\);/);
    assert.match(handler, /if \(session\.ownerMode\) \{\s*session\._toolCallInFlight = true;\s*try \{\s*return await runOwnerToolCall\(session, toolCall, \{ executeToolCall, scheduleCache, sendText: \(text\) => session\?\.geminiSession\?\.sendText\(text\) \}\);/);
  });

  it("classic: no spoken disclosure, the owner greeting, the owner's speech on the gate's clock", () => {
    assert.match(handler, /const testConsentResult = session\.ownerMode\s*\? \{ required: false, callerState: null, reason: "owner-call" \}\s*: requiresRecordingDisclosureHybrid\(/);
    assert.match(handler, /const greeting = ownerWebPrompt \? ownerWebPrompt\.greeting : disclosurePrefix \+ getGreeting\(/);
    assert.match(handler, /if \(session\?\.ownerMode\) noteOwnerSpeech\(session, transcript\);/);
  });

  it("a customer's browser test call is unchanged: its tools still run in test mode", () => {
    assert.equal((handler.match(/testMode: true,/g) || []).length, 1, "the Gemini test path");
    const classicLoop = sliceOf("async function handleTestUserSpeech(session, ws, transcript) {", "// Warm the Gemini Live path on boot");
    assert.equal((classicLoop.match(/testMode: true,/g) || []).length, 1, "the classic test path");
  });
});

// ─── handleTestUserSpeech, run for real ─────────────────────────────────────

const { CallSession } = require("../call-session");

/**
 * Runs the real handleTestUserSpeech with its outside helpers stubbed:
 * `turns` is the model's answers in order (each { sentences?, toolCalls? }), and
 * `ownerResults` the owner runner's results in order.
 */
function makeLoop({ turns, ownerResults = [] }) {
  const calls = [];
  const timers = [];
  const ws = {
    readyState: 1,
    sent: [],
    send(x) { this.sent.push(Buffer.isBuffer(x) ? `<audio ${x.length}>` : JSON.parse(x)); },
    close(code, reason) { calls.push(["ws.close", code, reason]); this.readyState = 3; },
  };
  let turn = 0;
  const scope = {
    startHoldAudio: () => ({ stop() {} }),
    buildLLMOptions: () => ({ tools: ["customer tools"] }),
    buildOwnerTools: () => ["owner tools"],
    MAX_TOOL_ITERATIONS: 3,
    LLM_API_KEY: "k",
    DEEPGRAM_API_KEY: "k",
    streamChatResponse: async (key, messages, opts) => {
      calls.push(["llm", opts.tools]);
      const t = turns[turn++];
      if (!t) throw new Error("no more model turns");
      for (const s of t.sentences || []) opts.onSentence(s);
      if (t.toolCalls) {
        return {
          type: "tool_calls",
          message: { role: "assistant", content: null, tool_calls: t.toolCalls },
          toolCalls: t.toolCalls.map((tc, i) => ({ id: `tc${turn}-${i}`, function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } })),
        };
      }
      return { type: "content", content: (t.sentences || []).join(" ") };
    },
    synthesizeSpeech: async () => Buffer.alloc(8000), // one second of 8 kHz μ-law
    WebSocket: { OPEN: 1 },
    logTranscript: () => {},
    parseToolArgs: (tc) => JSON.parse(tc.function.arguments || "{}"),
    executeToolCall: async (name, args, ctx) => { calls.push(["executeToolCall", name, ctx]); return "customer tool ok"; },
    runOwnerToolCall: async (s, tc, deps) => { calls.push(["runOwnerToolCall", tc.name, Object.keys(deps).sort()]); return ownerResults.shift() || { message: "done" }; },
    ownerToolLoopReply: (s, last) => `<loop reply after ${last ? last.name : "nothing"}>`,
    scheduleCache: { invalidate() {} },
    noteAssistantSpeech: () => calls.push(["noteAssistantSpeech"]),
    noteAssistantTurnEnd: () => calls.push(["noteAssistantTurnEnd"]),
    getErrorMsg: (lang, key) => `<${key}>`,
    detectExpectedInput: () => "general",
    setTimeout: (fn, ms) => { timers.push(ms); fn(); },
    console: { log() {}, warn() {}, error() {} },
  };
  const code = sliceOf("async function handleTestUserSpeech(session, ws, transcript) {", "// Warm the Gemini Live path on boot");
  const params = Object.keys(scope);
  const { handleTestUserSpeech } = new Function(...params, `${code}\nreturn { handleTestUserSpeech };`)(...params.map((p) => scope[p]));
  return { handleTestUserSpeech, calls, timers, ws };
}

function ownerWebSession() {
  const s = new CallSession("web_owner_abc");
  s.ownerMode = true;
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  s.language = "en";
  return s;
}

describe("handleTestUserSpeech on an owner session (classic, run for real)", () => {
  it("offers the owner tools, runs each tool call through the owner runner (never in test mode), and returns its message and data", async () => {
    const h = makeLoop({
      turns: [
        { toolCalls: [{ name: "owner_list_appointments", args: { range: "today" } }] },
        { sentences: ["You have two jobs today."] },
      ],
      ownerResults: [{ message: "2 jobs today.", data: { count: 2 } }],
    });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "What's on today?");
    assert.deepEqual(h.calls.filter((c) => c[0] === "llm").map((c) => c[1]), [["owner tools"], ["owner tools"]]);
    assert.deepEqual(h.calls.find((c) => c[0] === "runOwnerToolCall"), ["runOwnerToolCall", "owner_list_appointments", ["executeToolCall", "scheduleCache"]]);
    assert.ok(!h.calls.some((c) => c[0] === "executeToolCall"), "no customer tool path");
    const toolMsg = s.messages.find((m) => m.role === "tool");
    assert.deepEqual(JSON.parse(toolMsg.content), { message: "2 jobs today.", data: { count: 2 } });
    assert.equal(s.messages.at(-1).content, "You have two jobs today.");
  });

  it("a spoken reply stamps the owner confirmation gate's clock: speech, then the end of the turn", async () => {
    const h = makeLoop({ turns: [{ sentences: ["Sure.", "Which job?"] }] });
    await h.handleTestUserSpeech(ownerWebSession(), h.ws, "Move a job");
    const stamps = h.calls.filter((c) => c[0].startsWith("note")).map((c) => c[0]);
    assert.deepEqual(stamps, ["noteAssistantSpeech", "noteAssistantSpeech", "noteAssistantTurnEnd"]);
  });

  it("end_call: no further model call; the owner hears the goodbye, then the session ends after its audio", async () => {
    const h = makeLoop({
      turns: [{ sentences: ["Bye for now."], toolCalls: [{ name: "end_call" }] }],
      ownerResults: [{ message: "Ending the call.", __endCall: true }],
    });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "That's all, thanks");
    assert.equal(h.calls.filter((c) => c[0] === "llm").length, 1, "the model is not asked again");
    assert.equal(s.messages.at(-1).content, "Bye for now.");
    const ended = h.ws.sent.find((m) => m && m.type === "ended");
    assert.deepEqual(ended, { type: "ended", reason: "owner-ended" });
    assert.deepEqual(h.calls.find((c) => c[0] === "ws.close"), ["ws.close", 1000, "Owner said goodbye"]);
    assert.equal(h.timers[0], 1500, "one second of audio + half a second");
  });

  it("end_call with nothing said: a short goodbye first", async () => {
    const h = makeLoop({
      turns: [{ toolCalls: [{ name: "end_call" }] }],
      ownerResults: [{ message: "Ending the call.", __endCall: true }],
    });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "Bye");
    assert.equal(s.messages.at(-1).content, "<goodbye>");
    assert.ok(h.ws.sent.some((m) => m && m.type === "transcript" && m.content === "<goodbye>"));
    assert.ok(h.ws.sent.some((m) => m && m.type === "ended"));
  });

  it("a tool loop that never answers ends on the last tool's own words, never 'could you repeat that?'", async () => {
    const tool = { toolCalls: [{ name: "owner_cancel_appointment", args: { appointment_id: "a1" } }] };
    const h = makeLoop({ turns: [tool, tool, tool] });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "Cancel Bob");
    assert.equal(s.messages.at(-1).content, "<loop reply after owner_cancel_appointment>");
  });
});

describe("handleTestUserSpeech on a customer's test call (unchanged)", () => {
  it("customer tools, run in test mode; no owner runner, no stamps", async () => {
    const h = makeLoop({
      turns: [
        { toolCalls: [{ name: "check_availability", args: { date: "2026-10-27" } }] },
        { sentences: ["We have 9 AM."] },
      ],
    });
    const s = new CallSession("test_1");
    s.organizationId = "org-1";
    s.assistantId = "asst-1";
    await h.handleTestUserSpeech(s, h.ws, "Any times tomorrow?");
    assert.deepEqual(h.calls.filter((c) => c[0] === "llm").map((c) => c[1]), [["customer tools"], ["customer tools"]]);
    const [, name, ctx] = h.calls.find((c) => c[0] === "executeToolCall");
    assert.equal(name, "check_availability");
    assert.equal(ctx.testMode, true);
    assert.ok(!h.calls.some((c) => c[0] === "runOwnerToolCall" || c[0].startsWith("note")));
    assert.ok(!h.ws.sent.some((m) => m && m.type === "ended"));
  });
});
