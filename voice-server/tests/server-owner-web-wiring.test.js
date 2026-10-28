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
    // An owner token works once: its jti is claimed (kept until expiry) before the org slot.
    const claim = handler.indexOf("if (!ownerTokenLedger.claim(jti, tokenData.exp)) {");
    assert.ok(flag < claim && claim < slot, `${flag} ${claim} ${slot}`);
    assert.match(handler, /ws\.close\(4003, "Invalid or expired token"\);/);
    // All three refusals give back the /ws/test slot they had reserved, and say why in the log.
    const refusals = handler.slice(flag, handler.indexOf("ownerWebSlotOpen = true;", flag));
    assert.equal((refusals.match(/releaseTestSlot\(\);/g) || []).length, 3);
    for (const why of ["OWNER_ASSISTANT_ENABLED is off", "a reused owner token", "one is already open"]) {
      assert.ok(refusals.includes(why), why);
    }
  });

  it("an owner session gets its own cap (8 minutes); a test call keeps its cap", () => {
    assert.match(handler, /const maxSessionDurationMs = ownerWeb \? OWNER_WEB_MAX_SESSION_MS : getMaxSessionDurationMs\(organizationId\);/);
  });

  it("the org slot is released at the start of teardown (the post-call can take seconds), then the owner post-call runs", () => {
    const cleanup = sliceOf("async function cleanupTestSession() {", "// Auto-disconnect after max duration.");
    // First of all, an ending owner session takes no new turn (handleTestUserSpeech checks it).
    assert.match(cleanup, /^async function cleanupTestSession\(\) \{\s*if \(cleaningUp\) return;\s*cleaningUp = true;\s*(\/\/[^\n]*\n\s*)+if \(session\?\.ownerMode\) session\.ownerSessionEnded = true;/);
    const finish = cleanup.indexOf("await finishOwnerWebSession(");
    const release = cleanup.indexOf("ownerWebSessions.close(organizationId);");
    assert.ok(release > 0 && finish > release, `${release} ${finish}`);
    assert.equal((cleanup.match(/ownerWebSessions\.close\(organizationId\);/g) || []).length, 1);
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
      "metadata: OWNER_WEB_RECORD_METADATA,",
      "session.callRecordId = callRecordId;",
    ]) assert.ok(owner.includes(line), line);
    // A page closed during setup: nothing is created after the context or the name loads.
    assert.match(handler, /const context = await loadTestCallContext\(assistantId, organizationId\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(cleaningUp\) return;/);
    const nameCheck = owner.search(/session\.ownerFirstName = await loadOwnerFirstName\(organizationId\);\s*if \(cleaningUp\) return;/);
    assert.ok(nameCheck >= 0, "a page closed while the name loads must stop setup before the row");
    assert.ok(nameCheck < owner.indexOf("const callRecordId = await createCallRecord({"));
    assert.ok(owner.indexOf("session.callRecordId = callRecordId;") < owner.indexOf("ownerWebPrompt = buildOwnerWebPrompt({"));
    // A row that couldn't be created ends the session with a message; a page closed
    // mid-setup gets its row completed rather than left "in-progress".
    assert.match(owner, /if \(!callRecordId\) \{\s*ws\.send\(JSON\.stringify\(\{ type: "error", message: "Couldn't start your assistant — please try again\." \}\)\);\s*ws\.close\(4500, "Owner call record failed"\);\s*return;/);
    assert.match(owner, /if \(cleaningUp\) \{[\s\S]*?await finishOwnerWebSession\(ownerSession, \{ transcript: "", durationSeconds: 0 \}, ownerWebFinishDeps\(\)\);[\s\S]*?return;/);
    // Nothing ran in that session: it is stored as failed (a completed call is billed).
    assert.match(owner, /if \(callRecordId\) \{\s*ownerSession\.callRecordId = callRecordId;\s*ownerSession\.callFailed = true;\s*await finishOwnerWebSession\(/);
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
    // An error from the Gemini socket after the owner ended the session (one still
    // connecting raises one) is ignored: not shown, not stored as a failure.
    assert.match(handler, /onError: \(err\) => \{\s*(\/\/[^\n]*\n\s*)+if \(session\?\.ownerMode && cleaningUp\) \{\s*console\.log\([^\n]*\);\s*return;\s*\}\s*console\.error\("\[TestGeminiLive\] Session error:", err\.message\);/);
    // The goodbye's audio plays before the session ends; a dropped Gemini session is a failure, said as one.
    assert.match(handler, /onClose: \(code, reason\) => \{/);
    assert.match(handler, /if \(reason === "end_call"\) \{\s*setTimeout\(\(\) => \{\s*if \(ws\.readyState === WebSocket\.OPEN\) \{\s*ws\.send\(JSON\.stringify\(\{ type: "ended", reason: "owner-ended" \}\)\);\s*ws\.close\(1000, "Owner said goodbye"\);\s*\}\s*\}, 1000\);/);
    assert.match(handler, /if \(code !== 1000\) \{\s*session\.callFailed = true;/);
    assert.match(handler, /if \(session\?\.ownerMode\) session\.callFailed = true;\s*if \(ws\.readyState === WebSocket\.OPEN\) \{\s*ws\.send\(JSON\.stringify\(\{ type: "error", message: session\?\.ownerMode \? OWNER_WEB_PROBLEM_MESSAGE : "AI session error" \}\)\);/);
    assert.match(handler, /if \(session\.ownerMode\) \{\s*session\._toolCallInFlight = true;\s*try \{\s*const ownerResult = await runOwnerToolCall\(session, toolCall, \{ executeToolCall, scheduleCache, sendText: \(text\) => session\?\.geminiSession\?\.sendText\(text\) \}\);\s*notifyBookingsChanged\(ws, toolCall\.name, ownerResult\); \/\/ SCRUM-597\s*return ownerResult;/);
  });

  it("classic: no spoken disclosure, the owner greeting, the owner's speech on the gate's clock", () => {
    assert.match(handler, /const testConsentResult = session\.ownerMode\s*\? \{ required: false, callerState: null, reason: "owner-call" \}\s*: requiresRecordingDisclosureHybrid\(/);
    assert.match(handler, /const greeting = ownerWebPrompt \? ownerWebPrompt\.greeting : disclosurePrefix \+ getGreeting\(/);
    assert.match(handler, /if \(session\?\.ownerMode\) noteOwnerSpeech\(session, transcript\);/);
    // Speech recognition lost without an error event ends an owner session too, as on the
    // phone line; a test call only logs it, as before.
    assert.match(handler, /console\.error\(`\[TestSTT\] Deepgram connection closed unexpectedly \(code=\$\{code\}\)`\);\s*(\/\/[^\n]*\n\s*)+if \(session\?\.ownerMode && !cleaningUp && !session\.callFailed\) \{\s*session\.callFailed = true;\s*if \(ws\.readyState === WebSocket\.OPEN\) \{\s*ws\.send\(JSON\.stringify\(\{ type: "error", message: OWNER_WEB_PROBLEM_MESSAGE \}\)\);\s*ws\.close\(4500, "Speech recognition lost"\);/);
    // ...but an error while the owner session closes is ignored, as for Gemini.
    assert.match(handler, /onError: \(err\) => \{\s*(\/\/[^\n]*\n\s*)+if \(session\?\.ownerMode && cleaningUp\) \{\s*console\.log\(`\[TestSTT\] Error while the owner session closes \(ignored\)[^\n]*\);\s*return;\s*\}\s*console\.error\("\[TestSTT\] Error:", err\);/);
    // A speech-recognition failure ends an owner session (stored as failed), not just a message.
    assert.match(handler, /if \(session\?\.ownerMode\) \{\s*session\.callFailed = true;\s*if \(ws\.readyState === WebSocket\.OPEN\) ws\.close\(4500, "Speech recognition error"\);/);
  });

  it("a setup failure on an owner session says so in the owner's words and is stored as failed", () => {
    assert.match(handler, /\/\/ SCRUM-596: an owner session that failed to start is stored as failed\.\s*if \(session\?\.ownerMode\) session\.callFailed = true;/);
    assert.match(handler, /message: ownerWeb \? "Couldn't start your assistant — please try again\." : "Failed to initialize test call"/);
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
function makeLoop({ turns, ownerResults = [], ttsBytes = 8000, onSynth = null }) {
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
    OWNER_MAX_TOOL_ROUNDS: 4,
    LLM_API_KEY: "k",
    DEEPGRAM_API_KEY: "k",
    streamChatResponse: async (key, messages, opts) => {
      calls.push(["llm", opts.tools]);
      const t = turns[turn++];
      if (!t) throw new Error("no more model turns");
      if (t.throws) throw new Error(t.throws);
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
    // default: one second of 8 kHz μ-law; what it was asked to say is recorded (SCRUM-618)
    synthesizeSpeech: async (key, text) => { calls.push(["tts", text]); if (onSynth) onSynth(text); return Buffer.alloc(ttsBytes); },
    WebSocket: { OPEN: 1 },
    logTranscript: () => {},
    parseToolArgs: (tc) => JSON.parse(tc.function.arguments || "{}"),
    executeToolCall: async (name, args, ctx) => { calls.push(["executeToolCall", name, ctx]); return "customer tool ok"; },
    runOwnerToolCall: async (s, tc, deps) => { calls.push(["runOwnerToolCall", tc.name, Object.keys(deps).sort()]); return ownerResults.shift() || { message: "done" }; },
    notifyBookingsChanged: (w, name, ret) => calls.push(["notifyBookingsChanged", name, ret]), // SCRUM-597
    ownerToolLoopReply: (s, last) => `<loop reply after ${last ? last.name : "nothing"}>`,
    scheduleCache: { invalidate() {} },
    noteAssistantSpeech: () => calls.push(["noteAssistantSpeech"]),
    noteAssistantTurnEnd: () => calls.push(["noteAssistantTurnEnd"]),
    getErrorMsg: (lang, key) => `<${key}>`,
    OWNER_WEB_PROBLEM_MESSAGE: "<owner problem>",
    detectExpectedInput: () => "general",
    // SCRUM-618: what the bubble says is cleaned and spelled as on the phone line; its audio is timed for barge-in.
    stripMarkdown: (t) => t.replace(/\*\*/g, ""),
    spellLettersForTts: (t) => t.replace(/\b([A-Z])-(?=[A-Z]\b)/g, "$1 "),
    forgetOwnerReadBacks: () => calls.push(["forgetOwnerReadBacks"]), // SCRUM-618
    noteOwnerWebAudio: (s, bytes, turn) => { calls.push(["webAudio", bytes, turn]); s.webAudioUntil = (s.webAudioUntil || 0) + bytes / 8; s.webAudioTurn = turn; },
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
    s._pendingTranscript = "Wait, one more thing"; // heard while the goodbye plays (queueOrProcess)
    await h.handleTestUserSpeech(s, h.ws, "That's all, thanks");
    await new Promise((r) => setImmediate(r));
    assert.equal(s.ownerSessionEnded, true, "the session is ending from the goodbye on");
    assert.equal(h.calls.filter((c) => c[0] === "llm").length, 1, "the model is not asked again, not even for words heard during the goodbye");
    assert.equal(s.messages.at(-1).content, "Bye for now.");
    const ended = h.ws.sent.find((m) => m && m.type === "ended");
    assert.deepEqual(ended, { type: "ended", reason: "owner-ended" });
    assert.deepEqual(h.calls.find((c) => c[0] === "ws.close"), ["ws.close", 1000, "Owner said goodbye"]);
    assert.equal(h.timers[0], 1500, "one second of audio + half a second");
  });

  it("end_call after a long goodbye: the session waits for its audio, but never more than 15 seconds", async () => {
    const h = makeLoop({
      turns: [{ sentences: ["Thanks Dave, have a good one."], toolCalls: [{ name: "end_call" }] }],
      ownerResults: [{ message: "Ending the call.", __endCall: true }],
      ttsBytes: 200_000, // 25 seconds of audio
    });
    await h.handleTestUserSpeech(ownerWebSession(), h.ws, "That's all");
    assert.equal(h.timers[0], 15_000);
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

  it("gets the phone line's tool budget: list, check, move, then the read-back (3 tool rounds is not the end)", async () => {
    const h = makeLoop({
      turns: [
        { toolCalls: [{ name: "owner_list_appointments", args: { range: "today" } }] },
        { toolCalls: [{ name: "check_availability", args: { date: "2026-10-29" } }] },
        { toolCalls: [{ name: "owner_reschedule_appointment", args: { appointment_id: "a1", new_datetime: "2026-10-29T14:00" } }] },
        { sentences: ["That moves Bob from 9 a.m. today to 2 p.m. Thursday — shall I go ahead?"] },
      ],
    });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "Move Bob's job to Thursday at 2");
    assert.equal(h.calls.filter((c) => c[0] === "runOwnerToolCall").length, 3);
    assert.match(s.messages.at(-1).content, /shall I go ahead\?$/);
  });

  it("SCRUM-597: every owner runner result goes to notifyBookingsChanged with its tool name (the page refreshes after a change)", async () => {
    const h = makeLoop({
      turns: [
        { toolCalls: [{ name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true, notify_customer: "none" } }] },
        { sentences: ["Done."] },
      ],
      ownerResults: [{ message: "Cancelled", data: { outcome: "cancelled" } }],
    });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "Yes, cancel it");
    const n = h.calls.filter((c) => c[0] === "notifyBookingsChanged");
    assert.equal(n.length, 1);
    assert.equal(n[0][1], "owner_cancel_appointment");
    assert.deepEqual(n[0][2], { message: "Cancelled", data: { outcome: "cancelled" } });
  });

  it("a tool loop that never answers ends on the last tool's own words, never 'could you repeat that?'", async () => {
    const tool = { toolCalls: [{ name: "owner_cancel_appointment", args: { appointment_id: "a1" } }] };
    const h = makeLoop({ turns: [tool, tool, tool, tool] });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "Cancel Bob");
    assert.equal(h.calls.filter((c) => c[0] === "runOwnerToolCall").length, 4, "the owner budget, not the test call's 3");
    assert.equal(s.messages.at(-1).content, "<loop reply after owner_cancel_appointment>");
  });
});

describe("handleTestUserSpeech on an owner session: turns that fail (classic, run for real)", () => {
  const fail = { throws: "credit balance is too low" };
  const ok = { sentences: ["You have two jobs today."] };

  it("one failed turn: the owner hears the usual retry line and the session goes on", async () => {
    const h = makeLoop({ turns: [fail] });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "What's on today?");
    assert.equal(s.ownerTurnFailureStreak, 1);
    assert.equal(s.callFailed, false);
    assert.ok(h.ws.sent.some((m) => m && m.content === "<troubleRepeat>"));
    assert.ok(!h.calls.some((c) => c[0] === "ws.close"));
  });

  it("two failed turns in a row end the session: said as a problem, stored as failed, no further turns", async () => {
    const h = makeLoop({ turns: [fail, fail, ok] });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "What's on today?");
    s._pendingTranscript = "Hello?"; // what CallSession.queueOrProcess queues while a turn runs
    await h.handleTestUserSpeech(s, h.ws, "What's on today?");
    assert.equal(s.callFailed, true);
    assert.deepEqual(h.ws.sent.filter((m) => m && m.type === "error"), [{ type: "error", message: "<owner problem>" }]);
    assert.deepEqual(h.calls.filter((c) => c[0] === "ws.close"), [["ws.close", 4500, "Owner turns failing"]]);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls.filter((c) => c[0] === "llm").length, 2, "no turn is taken after the session failed");
  });

  it("an owner session that is ending takes no new turn: a late transcript starts nothing", async () => {
    const h = makeLoop({ turns: [ok] });
    const s = ownerWebSession();
    s.ownerSessionEnded = true; // cleanupTestSession sets it first
    await h.handleTestUserSpeech(s, h.ws, "Yes");
    assert.equal(h.calls.filter((c) => c[0] === "llm").length, 0);
    assert.equal(s.messages.length, 0, "the late words are not added to the conversation");
  });

  it("a turn that answers resets the streak", async () => {
    const h = makeLoop({ turns: [fail, ok, fail] });
    const s = ownerWebSession();
    for (const said of ["One", "Two", "Three"]) await h.handleTestUserSpeech(s, h.ws, said);
    assert.equal(s.ownerTurnFailureStreak, 1);
    assert.equal(s.callFailed, false);
    assert.ok(!h.calls.some((c) => c[0] === "ws.close"));
  });
});

// SCRUM-618: OWNER_PIPELINE=classic carries the bubble — what Gemini did that classic didn't.
describe("handleTestUserSpeech on an owner session: what classic now does as Gemini did (SCRUM-618, run for real)", () => {
  it("the owner talking over the reply: the rest of it isn't said (the turn still counts — its read-backs were forgotten at the barge-in)", async () => {
    let s;
    const h = makeLoop({
      turns: [{ sentences: ["Here's what I'll book: Jane, Thursday at 2 pm.", "Her number is 0412 345 678.", "Shall I book it?"] }],
      // The owner speaks while the first sentence plays (what ownerWebBargeIn does on their speech).
      onSynth: (text) => { if (text.startsWith("Her number")) s.webBargeInSeq = s.webTurnSeq; },
    });
    s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "Book Jane in");
    assert.equal(h.ws.sent.filter((m) => typeof m === "string" && m.startsWith("<audio")).length, 1, "only the sentence before the barge-in reached the browser");
    assert.deepEqual(h.calls.filter((c) => c[0] === "tts").map((c) => c[1]), ["Here's what I'll book: Jane, Thursday at 2 pm.", "Her number is 0412 345 678."], "nothing after it is even synthesised");
    // Code lens (round 2): skipping the count left the read-back pending for the NEXT counted turn.
    assert.equal(h.calls.filter((c) => c[0] === "noteAssistantTurnEnd").length, 1);
    // Code lens (round 3): and what the turn armed after the barge-in (never sent) is forgotten as it ends.
    assert.deepEqual(h.calls.filter((c) => c[0] === "forgetOwnerReadBacks"), [["forgetOwnerReadBacks"]]);
  });

  it("each turn has its own number: a barge-in in one turn never silences the next", async () => {
    const h = makeLoop({ turns: [{ sentences: ["One."] }, { sentences: ["Two."] }] });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "First");
    s.webBargeInSeq = s.webTurnSeq; // barged in on the first turn, after it ended
    await h.handleTestUserSpeech(s, h.ws, "Second");
    assert.deepEqual(h.calls.filter((c) => c[0] === "tts").map((c) => c[1]), ["One.", "Two."]);
    assert.equal(h.calls.filter((c) => c[0] === "noteAssistantTurnEnd").length, 2);
    assert.ok(!h.calls.some((c) => c[0] === "forgetOwnerReadBacks"), "a turn nobody talked over forgets nothing");
  });

  it("the reply's audio is timed for barge-in, and what's said is cleaned and spelled as on the phone line", async () => {
    const h = makeLoop({ turns: [{ sentences: ["**Jane** is spelled J-A-N-E."] }], ttsBytes: 16_000 });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "Spell it");
    assert.deepEqual(h.calls.filter((c) => c[0] === "tts").map((c) => c[1]), ["Jane is spelled J A N E."]);
    assert.deepEqual(h.calls.filter((c) => c[0] === "webAudio"), [["webAudio", 16_000, 1]]);
  });

  it("a failure after an owner tool ran: the owner hears the tool's own words, never 'could you repeat that?' (SF5)", async () => {
    const h = makeLoop({
      turns: [{ toolCalls: [{ name: "owner_book_appointment", args: { confirmed: true } }] }, { throws: "Anthropic API error 529: Overloaded" }],
      ownerResults: [{ message: "Booked Jane for Thursday at 2 pm.", data: { outcome: "booked" } }],
    });
    const s = ownerWebSession();
    await h.handleTestUserSpeech(s, h.ws, "Yes, book it");
    const said = h.ws.sent.filter((m) => m && m.type === "transcript" && m.role === "assistant").map((m) => m.content);
    assert.deepEqual(said, ["<loop reply after owner_book_appointment>"]);
    assert.ok(!said.includes("<troubleRepeat>"));
    assert.equal(s.ownerTurnFailureStreak, 1);
  });

  it("a customer's test call is unchanged: no barge-in numbering, no cleaning", async () => {
    const h = makeLoop({ turns: [{ sentences: ["**Hi** there."] }] });
    const s = new CallSession("test_1");
    s.organizationId = "org-1";
    s.assistantId = "asst-1";
    await h.handleTestUserSpeech(s, h.ws, "Hello");
    assert.deepEqual(h.calls.filter((c) => c[0] === "tts").map((c) => c[1]), ["**Hi** there."]);
    assert.equal(s.webTurnSeq, undefined);
    assert.ok(!h.calls.some((c) => c[0] === "webAudio"));
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

  it("failed turns never end a test call (it hears the retry line each time, as before)", async () => {
    const fail = { throws: "boom" };
    const h = makeLoop({ turns: [fail, fail, fail] });
    const s = new CallSession("test_3");
    s.organizationId = "org-1";
    s.assistantId = "asst-1";
    for (const said of ["One", "Two", "Three"]) await h.handleTestUserSpeech(s, h.ws, said);
    assert.equal(h.ws.sent.filter((m) => m && m.content === "<troubleRepeat>").length, 3);
    assert.ok(!h.calls.some((c) => c[0] === "ws.close"));
    assert.equal(s.callFailed, false);
  });

  it("a test call keeps its own 3-round tool budget", async () => {
    const tool = { toolCalls: [{ name: "check_availability", args: {} }] };
    const h = makeLoop({ turns: [tool, tool, tool, tool] });
    const s = new CallSession("test_2");
    s.organizationId = "org-1";
    s.assistantId = "asst-1";
    await h.handleTestUserSpeech(s, h.ws, "Any times?");
    assert.equal(h.calls.filter((c) => c[0] === "executeToolCall").length, 3);
    assert.equal(s.messages.at(-1).content, "<repeatRequest>");
  });
});
