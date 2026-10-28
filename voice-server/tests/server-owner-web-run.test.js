"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

// SCRUM-596: the owner branch of /ws/test, run for real. Each piece is sliced out
// of server.js and run with stubbed sockets: the gate that admits an owner token,
// the teardown, the post-call's dependencies, and the Gemini callbacks that drive
// the owner confirmation gate. The owner modules (turn stamps, tool runner) are
// the real ones. Source pins and the classic loop: server-owner-web-wiring.test.js;
// the helpers: owner-web-session.test.js.

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const handlerAt = src.indexOf('testWss.on("connection", (ws, req) => {');
assert.ok(handlerAt > 0, "the /ws/test handler");

/** server.js text between two markers, searched from the /ws/test handler on (the phone path has the same markers earlier). */
function sliceInHandler(from, to) {
  const start = src.indexOf(from, handlerAt);
  assert.ok(start > 0, `marker not found in /ws/test: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}

/** Runs `body` as a function whose parameters are `scope`'s keys. */
function run(body, scope) {
  const params = Object.keys(scope);
  return new Function(...params, body)(...params.map((p) => scope[p]));
}

function recordingConsole(lines) {
  const rec = (m) => (...args) => lines.push(`${m}| ${args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4 }))).join(" ")}`);
  return { log: rec("log"), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
}

function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    closed: [],
    send(x) { this.sent.push(Buffer.isBuffer(x) ? `<audio ${x.length}>` : JSON.parse(x)); },
    close(code, reason) { this.closed.push([code, reason]); this.readyState = 3; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { CallSession } = require("../call-session");
const { isOwnerWebToken } = require("../lib/owner-web-session");
const { noteAssistantSpeech, noteAssistantTurnEnd, noteOwnerSpeech } = require("../lib/owner-turn-stamps");
const { runOwnerToolCall, noteCancelledOwnerToolCalls } = require("../lib/owner-tool-runner");

function ownerSession() {
  const s = new CallSession("web_owner_abc");
  s.ownerMode = true;
  s.ownerAuth = "verified";
  s.ownerFirstName = "Dave";
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  s.callRecordId = "call-1";
  s.language = "en";
  return s;
}

function customerSession() {
  const s = new CallSession("test_1");
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  return s;
}

// ─── The gate ────────────────────────────────────────────────────────────────

describe("/ws/test: the owner gate, run for real", () => {
  const GATE = sliceInHandler("  const ownerWeb = isOwnerWebToken(tokenData);", "  let session = null;");
  const OWNER = { mode: "owner", assistantId: "asst-1", organizationId: "org-1", userId: "user-1", exp: 2_000_000_000_000, jti: "jti-1" };
  const CUSTOMER = { assistantId: "asst-1", organizationId: "org-1", exp: 2_000_000_000_000, jti: "jti-2" };

  function gate(tokenData, { flagOn = true, claim = true, slotFree = true } = {}) {
    const consulted = [];
    const releases = [];
    const lines = [];
    const ws = fakeWs();
    const admitted = run(`${GATE}\nreturn { ownerWebSlotOpen };`, {
      tokenData,
      isOwnerWebToken,
      ownerAssistantEnabled: () => { consulted.push("flag"); return flagOn; },
      ownerTokenLedger: { claim: (jti, exp) => { consulted.push(["claim", jti, exp]); return claim; } },
      ownerWebSessions: { tryOpen: (org) => { consulted.push(["tryOpen", org]); return slotFree; } },
      releaseTestSlot: () => releases.push("release"),
      ws,
      jti: tokenData.jti,
      organizationId: tokenData.organizationId,
      console: recordingConsole(lines),
    });
    return { admitted, consulted, releases, ws, lines };
  }

  it("a customer's (or the demo's) token goes straight through: nothing owner is consulted, even with the flag off", () => {
    for (const flagOn of [true, false]) {
      const g = gate(CUSTOMER, { flagOn, claim: false, slotFree: false });
      assert.deepEqual(g.admitted, { ownerWebSlotOpen: false });
      assert.deepEqual(g.consulted, []);
      assert.deepEqual(g.releases, []);
      assert.deepEqual(g.ws.closed, []);
      assert.deepEqual(g.ws.sent, []);
    }
  });

  it("an owner token is admitted with the flag on, an unused token and a free slot, and holds the org's slot", () => {
    const g = gate(OWNER);
    assert.deepEqual(g.admitted, { ownerWebSlotOpen: true });
    assert.deepEqual(g.consulted, ["flag", ["claim", "jti-1", OWNER.exp], ["tryOpen", "org-1"]]);
    assert.deepEqual(g.releases, []);
    assert.deepEqual(g.ws.closed, []);
  });

  it("flag off: refused with 4004 and the owner's message, its /ws/test slot given back, nothing else consulted", () => {
    const g = gate(OWNER, { flagOn: false });
    assert.equal(g.admitted, undefined, "not admitted");
    assert.deepEqual(g.consulted, ["flag"]);
    assert.deepEqual(g.releases, ["release"]);
    assert.deepEqual(g.ws.sent, [{ type: "error", message: "The owner assistant is switched off." }]);
    assert.deepEqual(g.ws.closed, [[4004, "Owner assistant off"]]);
    assert.ok(g.lines.some((l) => l.startsWith("warn|") && l.includes("OWNER_ASSISTANT_ENABLED is off") && l.includes("org=org-1")));
  });

  it("a reused owner token: refused with 4003, its slot given back, the org's slot never asked", () => {
    const g = gate(OWNER, { claim: false });
    assert.equal(g.admitted, undefined);
    assert.deepEqual(g.consulted, ["flag", ["claim", "jti-1", OWNER.exp]]);
    assert.deepEqual(g.releases, ["release"]);
    assert.deepEqual(g.ws.closed, [[4003, "Invalid or expired token"]]);
    assert.ok(g.lines.some((l) => l.startsWith("warn|") && l.includes("a reused owner token")));
  });

  it("the org already has a session open: refused with 4029 and the reason, its slot given back", () => {
    const g = gate(OWNER, { slotFree: false });
    assert.equal(g.admitted, undefined);
    assert.deepEqual(g.consulted, ["flag", ["claim", "jti-1", OWNER.exp], ["tryOpen", "org-1"]]);
    assert.deepEqual(g.releases, ["release"]);
    assert.deepEqual(g.ws.closed, [[4029, "Your assistant is already open in another tab."]]);
    assert.ok(g.lines.some((l) => l.startsWith("warn|") && l.includes("one is already open")));
  });
});

// ─── The teardown ────────────────────────────────────────────────────────────

describe("/ws/test: the teardown, run for real", () => {
  const CLEANUP = sliceInHandler("  async function cleanupTestSession() {", "  // Auto-disconnect after max duration.");

  function teardown({ session = null, ownerWebSlotOpen = false, finish } = {}) {
    const calls = [];
    const lines = [];
    if (session) {
      const destroy = session.destroy.bind(session);
      session.destroy = () => { calls.push(["destroy"]); destroy(); };
    }
    const h = run(`${CLEANUP}\nreturn { cleanupTestSession, state: () => ({ cleaningUp, ownerWebSlotOpen, session }) };`, {
      cleaningUp: false,
      session,
      ownerWebSlotOpen,
      autoEndTimer: null,
      organizationId: "org-1",
      releaseTestSlot: () => calls.push(["releaseTestSlot"]),
      ownerWebSessions: { close: (org) => calls.push(["ownerWebSessions.close", org]) },
      finishOwnerWebSession: finish || (async (s, args, deps) => { calls.push(["finish", s.ownerSessionEnded, args, deps]); }),
      ownerWebFinishDeps: () => ({ the: "deps" }),
      clearTimeout,
      console: recordingConsole(lines),
    });
    return { ...h, calls, lines };
  }

  it("a page closed before setup made a session still frees the org's owner slot (or the owner is locked out until a restart)", async () => {
    const t = teardown({ session: null, ownerWebSlotOpen: true });
    await t.cleanupTestSession();
    assert.deepEqual(t.calls, [["releaseTestSlot"], ["ownerWebSessions.close", "org-1"]]);
    assert.equal(t.state().ownerWebSlotOpen, false);
  });

  it("an owner session: marked ending, both slots freed, Gemini closed, then the owner post-call, then destroyed", async () => {
    const s = ownerSession();
    const geminiClosed = [];
    s.geminiSession = { close: () => geminiClosed.push(true) };
    s.addMessage("user", "What's on today?");
    s.addMessage("assistant", "Two jobs.");
    const t = teardown({ session: s, ownerWebSlotOpen: true });
    await t.cleanupTestSession();
    assert.deepEqual(t.calls.map((c) => c[0]), ["releaseTestSlot", "ownerWebSessions.close", "finish", "destroy"]);
    const finish = t.calls.find((c) => c[0] === "finish");
    assert.equal(finish[1], true, "the session was marked ending before its post-call");
    assert.match(finish[2].transcript, /What's on today\?/);
    assert.equal(typeof finish[2].durationSeconds, "number");
    assert.deepEqual(finish[3], { the: "deps" });
    assert.deepEqual(geminiClosed, [true]);
    assert.deepEqual(t.state(), { cleaningUp: true, ownerWebSlotOpen: false, session: null });
    await t.cleanupTestSession();
    assert.equal(t.calls.length, 4, "a second teardown does nothing");
  });

  it("a post-call that throws is paged, and teardown still finishes (a rejection here would take the voice server down)", async () => {
    const s = ownerSession();
    const t = teardown({ session: s, ownerWebSlotOpen: true, finish: async () => { throw new Error("db down"); } });
    await assert.doesNotReject(t.cleanupTestSession());
    assert.ok(t.lines.some((l) => l.startsWith("error|") && l.includes("[ALERT:error] [OwnerWeb] owner web session post-call failed") && l.includes("db down")), t.lines.join("\n"));
    assert.deepEqual(t.calls.map((c) => c[0]), ["releaseTestSlot", "ownerWebSessions.close", "destroy"]);
    assert.equal(t.state().session, null);
  });

  it("a customer's test call: no owner post-call, no owner slot", async () => {
    const s = customerSession();
    const t = teardown({ session: s });
    await t.cleanupTestSession();
    assert.deepEqual(t.calls.map((c) => c[0]), ["releaseTestSlot", "destroy"]);
    assert.equal(s.ownerSessionEnded, false);
  });
});

// ─── The post-call's dependencies ────────────────────────────────────────────

describe("ownerWebFinishDeps, run for real", () => {
  it("hands the owner post-call the real helpers and the internal API's settings", () => {
    const start = src.indexOf("function ownerWebFinishDeps() {");
    const code = src.slice(start, src.indexOf("\n}\n", start) + 3);
    const scope = {
      settleOwnerToolRuns: () => "settle",
      buildOwnerCallSummary: () => "summary",
      detectAndRedact: () => "redact",
      completeCallRecord: () => "complete",
      notifyCallCompleted: () => "notify",
      INTERNAL_API_URL: "https://app.example.com",
      INTERNAL_API_SECRET: "internal-secret",
    };
    const deps = run(`${code}\nreturn ownerWebFinishDeps();`, scope);
    assert.deepEqual(Object.keys(deps).sort(), ["buildOwnerCallSummary", "completeCallRecord", "detectAndRedact", "internalApiSecret", "internalApiUrl", "notifyCallCompleted", "settleOwnerToolRuns"]);
    for (const name of ["settleOwnerToolRuns", "buildOwnerCallSummary", "detectAndRedact", "completeCallRecord", "notifyCallCompleted"]) {
      assert.equal(deps[name], scope[name], `${name} is the real helper`);
    }
    assert.equal(deps.internalApiUrl, "https://app.example.com");
    assert.equal(deps.internalApiSecret, "internal-secret");
  });
});

// ─── The Gemini callbacks ────────────────────────────────────────────────────

const NEEDS_CONFIRMATION = { success: false, message: "Read this back and get a clear yes before cancelling: cancel Bob Lee's job on Friday, October 16 at 3:00 PM.", data: { outcome: "needs_confirmation", appointment_id: "a1", customer_notified: false } };
const CANCELLED = { success: true, message: "Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM. The customer has NOT been notified.", data: { outcome: "cancelled", appointment_id: "a1", customer_notified: false } };

const GEMINI_CALLBACKS = sliceInHandler("onAudio: (twilioBase64) => {", "\n          }\n        );\n\n        // Gemini handles greeting via system prompt");

function makeCallbacks(session, o = {}) {
  const calls = [];
  const lines = [];
  const timers = [];
  const ws = fakeWs();
  const h = run(`return {\n  cbs: {\n${GEMINI_CALLBACKS}\n  },\n  setCleaningUp: (v) => { cleaningUp = v; },\n};`, {
    ws,
    WebSocket: { OPEN: 1 },
    session,
    noteAssistantSpeech,
    noteAssistantTurnEnd,
    noteOwnerSpeech,
    noteCancelledOwnerToolCalls,
    runOwnerToolCall: o.runOwnerToolCall || (async (...a) => { calls.push(["runOwnerToolCall", ...a]); return o.ownerResult || { message: "done" }; }),
    notifyBookingsChanged: (w, name, result) => calls.push(["notifyBookingsChanged", w, name, result]), // SCRUM-597
    executeToolCall: o.executeToolCall || (async (...a) => { calls.push(["executeToolCall", ...a]); return { message: "customer tool result" }; }),
    scheduleCache: { invalidate: () => {} },
    logToolCall: () => {},
    pendingUserTranscript: "",
    pendingAiTranscript: "",
    cleaningUp: false,
    OWNER_WEB_PROBLEM_MESSAGE: "<owner problem>",
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    console: recordingConsole(lines),
  });
  return { cbs: h.cbs, setCleaningUp: h.setCleaningUp, calls, lines, timers, ws };
}

describe("/ws/test Gemini callbacks: tool calls, run for real", () => {
  it("every owner tool call (hallucinated customer tools included) goes to the owner runner, in flight while it runs, cleared after", async () => {
    const s = ownerSession();
    const inFlight = [];
    const runs = [];
    const ownerResult = { message: "owner says", data: { outcome: "listed" } };
    const { cbs, calls } = makeCallbacks(s, { runOwnerToolCall: async (...a) => { runs.push(a); inFlight.push(s._toolCallInFlight); return ownerResult; } });
    for (const name of ["owner_list_appointments", "owner_cancel_appointment", "cancel_appointment", "book_appointment", "end_call"]) {
      const toolCall = { id: `t-${name}`, name, args: { appointment_id: "a1" } };
      assert.equal(await cbs.onToolCall(toolCall), ownerResult, `${name}: the runner's result goes back to Gemini whole`);
      const [session, call, deps] = runs.at(-1);
      assert.equal(session, s);
      assert.equal(call, toolCall);
      assert.deepEqual(Object.keys(deps).sort(), ["executeToolCall", "scheduleCache", "sendText"]);
    }
    assert.deepEqual(calls.filter((c) => c[0] === "executeToolCall"), [], "never the test-mode executor");
    assert.ok(inFlight.length === 5 && inFlight.every((v) => v === true));
    assert.equal(s._toolCallInFlight, false);
    // sendText reaches the live Gemini session.
    const injected = [];
    s.geminiSession = { sendText: (text) => injected.push(text) };
    runs.at(-1)[2].sendText("hello");
    assert.deepEqual(injected, ["hello"]);
  });

  it("the in-flight flag clears even if the runner throws", async () => {
    const s = ownerSession();
    const { cbs } = makeCallbacks(s, { runOwnerToolCall: async () => { throw new Error("boom"); } });
    await assert.rejects(cbs.onToolCall({ id: "t1", name: "owner_list_messages", args: {} }), /boom/);
    assert.equal(s._toolCallInFlight, false);
  });

  it("a customer's test call runs its tools in test mode through the executor, never the owner runner", async () => {
    const c = customerSession();
    const { cbs, calls } = makeCallbacks(c);
    assert.deepEqual(await cbs.onToolCall({ id: "t1", name: "check_availability", args: { date: "2026-10-29" } }), { message: "customer tool result" });
    const exec = calls.find((x) => x[0] === "executeToolCall");
    assert.equal(exec[1], "check_availability");
    assert.equal(exec[3].testMode, true);
    assert.equal(exec[3].ownerMode, undefined);
    assert.ok(!calls.some((x) => x[0] === "runOwnerToolCall"));
  });

  it("Gemini's cancellations are recorded on an owner session; a test call ignores them", () => {
    const s = ownerSession();
    makeCallbacks(s).cbs.onToolCallCancellation(["g-1", "g-2"]);
    assert.deepEqual([...s.ownerCancelledToolCallIds], ["g-1", "g-2"]);
    const c = customerSession();
    makeCallbacks(c).cbs.onToolCallCancellation(["g-1"]);
    assert.equal(c.ownerCancelledToolCallIds, null);
  });
});

describe("/ws/test Gemini callbacks: the confirmation gate's clock, run for real", () => {
  it("a spoken turn counts once (interrupted + turnComplete); a tool-call-only turn not at all", () => {
    const s = ownerSession();
    const { cbs } = makeCallbacks(s);
    cbs.onAudio("AAAA"); cbs.onAudio("BBBB"); // the greeting
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 1);
    assert.ok(s.lastAssistantTurnAt > 0);
    cbs.onAudio("CCCC"); cbs.onTranscriptOut("Bob Lee, Friday 3pm — cancel it?"); // a read-back, barged in on
    cbs.onInterrupted();
    assert.equal(s.assistantTurnSeq, 2, "the interrupted turn ends at the interruption");
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 2, "interrupted + turnComplete of one turn is one turn");
    cbs.onTurnComplete(); // a tool-call-only turn
    assert.equal(s.assistantTurnSeq, 2);
    cbs.onAudio("DDDD"); // "one moment" said with a tool call…
    cbs.onTurnComplete({ endedWithToolCalls: true });
    assert.equal(s.assistantTurnSeq, 2, "…is not the end of the assistant's turn");
  });

  it("a spoken turn whose transcription arrives in fragments is one turn, ended by turnComplete, never by a fragment", () => {
    const s = ownerSession();
    const { cbs } = makeCallbacks(s);
    cbs.onAudio("AAAA"); cbs.onTranscriptOut("Bob Lee, ");
    cbs.onAudio("BBBB"); cbs.onTranscriptOut("Friday 3pm — ");
    cbs.onAudio("CCCC"); cbs.onTranscriptOut("cancel it?");
    assert.equal(s.assistantTurnSeq, 0, "still speaking: no turn has ended");
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 1);
  });

  it("assistant speech is stamped by audio, never by transcription", () => {
    const s = ownerSession();
    const { cbs } = makeCallbacks(s);
    cbs.onTranscriptOut("text with no audio");
    assert.equal(s.lastAssistantSpeechAt, 0, "transcription is not speech");
    cbs.onTurnComplete();
    assert.equal(s.assistantTurnSeq, 0, "a turn of transcription alone is not a spoken turn");
    cbs.onAudio("AAAA");
    assert.ok(s.lastAssistantSpeechAt > 0, "audio is");
  });

  it("owner speech: stamped by the owner's transcription (once per utterance, never noise), never by the assistant's", async () => {
    const s = ownerSession();
    const { cbs } = makeCallbacks(s);
    cbs.onTranscriptOut("Bob Lee, Friday 3pm — cancel it?");
    assert.equal(s.lastOwnerSpeechAt, 0, "the assistant's words are never the owner's");
    cbs.onTranscriptIn("   ");
    cbs.onTranscriptIn("<noise>");
    assert.equal(s.lastOwnerSpeechAt, 0, "noise is not speech");
    cbs.onTranscriptIn("ok");
    const first = s.lastOwnerSpeechAt;
    assert.ok(first > 0);
    await sleep(3);
    cbs.onTranscriptIn(" thanks");
    assert.equal(s.lastOwnerSpeechAt, first, "same utterance");
    cbs.onAudio("AAAA"); cbs.onTurnComplete();
    await sleep(3);
    cbs.onTranscriptOut(" Anything else?"); // the assistant's transcription, trailing its turn
    assert.equal(s.lastOwnerSpeechAt, first, "still not the owner's");
    cbs.onTranscriptIn("yes");
    assert.ok(s.lastOwnerSpeechAt > first, "a new utterance after the assistant spoke");
  });

  it("a customer's test call is never stamped", () => {
    const c = customerSession();
    const { cbs } = makeCallbacks(c);
    cbs.onAudio("AAAA"); cbs.onTranscriptOut("hello"); cbs.onTurnComplete(); cbs.onInterrupted(); cbs.onTranscriptIn("yes");
    assert.equal(c.assistantTurnSeq, 0);
    assert.equal(c.lastAssistantSpeechAt, 0);
    assert.equal(c.lastOwnerSpeechAt, 0);
  });

  it("end to end with the real runner: arm → read-back → the owner's 'yes' → the change goes out confirmed, as the owner, never in test mode", async () => {
    const s = ownerSession();
    const executed = [];
    const executeToolCall = async (name, args, context) => { executed.push({ name, args, context }); return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION; };
    const { cbs } = makeCallbacks(s, { runOwnerToolCall, executeToolCall });
    cbs.onAudio("AAAA"); cbs.onTurnComplete(); // the greeting
    await sleep(3);
    cbs.onTranscriptIn("cancel Bob's job on Friday");
    const armed = await cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1" } });
    assert.deepEqual(armed, { message: NEEDS_CONFIRMATION.message, data: NEEDS_CONFIRMATION.data });
    await sleep(3);
    cbs.onAudio("AAAA"); cbs.onTranscriptOut("Bob Lee, Friday 3pm — cancel it?"); cbs.onTurnComplete(); // the read-back
    await sleep(3);
    cbs.onTranscriptIn("yes");
    const done = await cbs.onToolCall({ id: "t2", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    const last = executed.at(-1);
    assert.equal(last.args.confirmed, true);
    assert.equal(last.context.ownerMode, true);
    assert.equal(last.context.callId, "call-1");
    assert.equal(last.context.organizationId, "org-1");
    assert.notEqual(last.context.testMode, true);
    assert.equal(done.data.outcome, "cancelled");
  });

  it("end to end: a confirm the model sends without the owner's yes goes out unconfirmed — the read-back's own transcription is never the owner's yes", async (t) => {
    const s = ownerSession();
    const executed = [];
    const executeToolCall = async (name, args) => { executed.push(args); return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION; };
    const { cbs } = makeCallbacks(s, { runOwnerToolCall, executeToolCall });
    await cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1" } });
    await sleep(3);
    cbs.onAudio("AAAA"); cbs.onTranscriptOut("Bob Lee, Friday 3pm"); cbs.onTurnComplete(); // the read-back…
    await sleep(3);
    cbs.onTranscriptOut(" — cancel it?"); // …its transcription trailing the turn; the owner says nothing
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const confirm = cbs.onToolCall({ id: "t2", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } });
    for (let i = 0; i < 16; i++) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(100); }
    await confirm;
    assert.equal(executed.at(-1).confirmed, false);
  });
});

describe("/ws/test Gemini callbacks: how a session ends, run for real", () => {
  it("end_call: the goodbye plays for a second, then the session ends as the owner's; nothing ends it sooner", () => {
    const s = ownerSession();
    const { cbs, ws, timers } = makeCallbacks(s);
    cbs.onClose(1000, "end_call");
    assert.deepEqual(ws.sent, [], "nothing at once");
    assert.deepEqual(ws.closed, []);
    assert.deepEqual(timers.map((x) => x.ms), [1000]);
    timers[0].fn();
    assert.deepEqual(ws.sent, [{ type: "ended", reason: "owner-ended" }]);
    assert.deepEqual(ws.closed, [[1000, "Owner said goodbye"]]);
    assert.equal(s.callFailed, false);
  });

  it("any other close from Gemini on an owner session is a failure, said in the owner's words and stored as failed", () => {
    const s = ownerSession();
    const { cbs, ws, lines } = makeCallbacks(s);
    cbs.onClose(1011, "internal error");
    assert.equal(s.callFailed, true);
    assert.deepEqual(ws.sent, [{ type: "error", message: "<owner problem>" }]);
    assert.deepEqual(ws.closed, [[4500, "Gemini session closed"]]);
    assert.ok(lines.some((l) => l.startsWith("error|") && l.includes("Gemini closed the owner session unexpectedly (code=1011")));
  });

  it("a normal close (1000, not end_call) ends an owner session as before, not as a failure", () => {
    const s = ownerSession();
    const { cbs, ws } = makeCallbacks(s);
    cbs.onClose(1000, "");
    assert.deepEqual(ws.sent, [{ type: "ended", reason: "ai-session-closed" }]);
    assert.deepEqual(ws.closed, [[1000, "Gemini session closed"]]);
    assert.equal(s.callFailed, false);
  });

  it("a customer's test call: any close ends it as before, with no owner handling", () => {
    const c = customerSession();
    const { cbs, ws, timers } = makeCallbacks(c);
    cbs.onClose(1011, "end_call");
    assert.deepEqual(timers, []);
    assert.deepEqual(ws.sent, [{ type: "ended", reason: "ai-session-closed" }]);
    assert.deepEqual(ws.closed, [[1000, "Gemini session closed"]]);
    assert.equal(c.callFailed, false);
  });

  it("during teardown a close does nothing", () => {
    const s = ownerSession();
    const { cbs, ws, setCleaningUp } = makeCallbacks(s);
    setCleaningUp(true);
    cbs.onClose(1011, "x");
    assert.deepEqual(ws.sent, []);
    assert.deepEqual(ws.closed, []);
    assert.equal(s.callFailed, false);
  });

  it("onError: an owner session that breaks is stored as failed and told in the owner's words", () => {
    const s = ownerSession();
    const { cbs, ws } = makeCallbacks(s);
    cbs.onError(new Error("boom"));
    assert.equal(s.callFailed, true);
    assert.deepEqual(ws.sent, [{ type: "error", message: "<owner problem>" }]);
    assert.deepEqual(ws.closed, [[4500, "Gemini session error"]]);
  });

  it("onError while the owner session closes (a socket still connecting raises one) is ignored", () => {
    const s = ownerSession();
    const { cbs, ws, lines, setCleaningUp } = makeCallbacks(s);
    setCleaningUp(true);
    cbs.onError(new Error("WebSocket was closed before the connection was established"));
    assert.equal(s.callFailed, false);
    assert.deepEqual(ws.sent, []);
    assert.deepEqual(ws.closed, []);
    assert.ok(lines.some((l) => l.startsWith("log|") && l.includes("(ignored)")));
  });

  it("onError on a customer's test call: as before", () => {
    const c = customerSession();
    const { cbs, ws } = makeCallbacks(c);
    cbs.onError(new Error("boom"));
    assert.equal(c.callFailed, false);
    assert.deepEqual(ws.sent, [{ type: "error", message: "AI session error" }]);
    assert.deepEqual(ws.closed, [[4500, "Gemini session error"]]);
  });
});

// ─── Setup: the owner block ──────────────────────────────────────────────────

describe("/ws/test setup: the owner block, run for real", () => {
  const SETUP = sliceInHandler("      let ownerWebPrompt = null;", "      // After-hours detection");
  const AsyncFunction = (async () => {}).constructor;
  const { OWNER_WEB_RECORD_METADATA } = require("../lib/owner-web-session");

  /** closeDuring: the await during which the page closes ("name" | "row"). */
  async function setup({ ownerWeb = true, closeDuring = null, recordId = "call-1" } = {}) {
    const calls = [];
    const lines = [];
    const ws = fakeWs();
    const session = new CallSession(ownerWeb ? "web_owner_jti-1" : "test_1");
    let setCleaningUp = null;
    const scope = {
      hooks: { ready: (fn) => { setCleaningUp = fn; } },
      ownerWeb,
      session,
      context: {
        assistant: { settings: { piiRedactionEnabled: true } },
        organization: { name: "Copperline Plumbing", timezone: "Australia/Sydney" },
        serviceTypes: [{ id: "st-1", name: "Blocked drain" }],
      },
      organizationId: "org-1",
      assistantId: "asst-1",
      cleaningUp: false,
      loadOwnerFirstName: async (org) => { calls.push(["loadOwnerFirstName", org]); if (closeDuring === "name") setCleaningUp(true); return "Dave"; },
      createCallRecord: async (fields) => { calls.push(["createCallRecord", fields]); if (closeDuring === "row") setCleaningUp(true); return recordId; },
      OWNER_WEB_RECORD_METADATA,
      finishOwnerWebSession: async (s, args, deps) => { calls.push(["finish", { callFailed: s.callFailed, callRecordId: s.callRecordId }, args, deps]); },
      ownerWebFinishDeps: () => ({ the: "deps" }),
      buildOwnerWebPrompt: (args) => { calls.push(["buildOwnerWebPrompt", args]); return { systemPrompt: "<owner prompt>" }; },
      applyOwnerSessionSettings: (s) => calls.push(["applyOwnerSessionSettings", s.ownerMode]), // SCRUM-618
      ws,
      console: recordingConsole(lines),
    };
    const params = Object.keys(scope);
    const fn = new AsyncFunction(...params, `hooks.ready((v) => { cleaningUp = v; });\n${SETUP}\nreturn { ownerWebPrompt };`);
    const result = await fn(...params.map((p) => scope[p]));
    return { result, session, calls, ws, lines };
  }

  it("a customer's test call (or the demo): nothing owner happens — no owner mode, no row, no owner prompt", async () => {
    const r = await setup({ ownerWeb: false });
    assert.deepEqual(r.result, { ownerWebPrompt: null });
    assert.equal(r.session.ownerMode, false);
    assert.equal(r.session.ownerAuth, null);
    assert.deepEqual(r.calls, []);
  });

  it("an owner token: owner mode as the phone PIN leaves it, the row stamped as an owner call before any tool can run, then the owner prompt", async () => {
    const r = await setup();
    assert.deepEqual(r.result, { ownerWebPrompt: { systemPrompt: "<owner prompt>" } });
    assert.equal(r.session.ownerMode, true);
    assert.equal(r.session.ownerAuth, "verified");
    assert.equal(r.session.piiRedactionEnabled, true);
    assert.equal(r.session.ownerFirstName, "Dave");
    assert.equal(r.session.callRecordId, "call-1");
    assert.deepEqual(r.calls.map((c) => c[0]), ["applyOwnerSessionSettings", "loadOwnerFirstName", "createCallRecord", "buildOwnerWebPrompt"]);
    const fields = r.calls[2][1];
    assert.deepEqual({ ...fields, metadata: undefined }, { orgId: "org-1", assistantId: "asst-1", phoneNumberId: null, callerPhone: null, callSid: "web_owner_jti-1", metadata: undefined });
    assert.equal(fields.metadata, OWNER_WEB_RECORD_METADATA);
    assert.deepEqual(r.calls[3][1], { organization: { name: "Copperline Plumbing", timezone: "Australia/Sydney" }, serviceTypes: [{ id: "st-1", name: "Blocked drain" }], ownerFirstName: "Dave" });
    assert.deepEqual(r.calls[0], ["applyOwnerSessionSettings", true], "SCRUM-618: the owner's settings, applied once owner mode is on");
  });

  it("the page closes while the name loads: no row is written", async () => {
    const r = await setup({ closeDuring: "name" });
    assert.equal(r.result, undefined);
    assert.deepEqual(r.calls.map((c) => c[0]), ["applyOwnerSessionSettings", "loadOwnerFirstName"]);
  });

  it("the page closes while the row is written: it is completed at once, as failed (a completed call is billed)", async () => {
    const r = await setup({ closeDuring: "row" });
    assert.equal(r.result, undefined);
    assert.deepEqual(r.calls.map((c) => c[0]), ["applyOwnerSessionSettings", "loadOwnerFirstName", "createCallRecord", "finish"]);
    assert.deepEqual(r.calls[3].slice(1), [{ callFailed: true, callRecordId: "call-1" }, { transcript: "", durationSeconds: 0 }, { the: "deps" }]);
  });

  it("the page closes while a row that failed is written: there is nothing to complete", async () => {
    const r = await setup({ closeDuring: "row", recordId: null });
    assert.deepEqual(r.calls.map((c) => c[0]), ["applyOwnerSessionSettings", "loadOwnerFirstName", "createCallRecord"]);
  });

  it("the row can't be written: the owner is told and the session closes before anything runs", async () => {
    const r = await setup({ recordId: null });
    assert.equal(r.result, undefined);
    assert.deepEqual(r.ws.sent, [{ type: "error", message: "Couldn't start your assistant — please try again." }]);
    assert.deepEqual(r.ws.closed, [[4500, "Owner call record failed"]]);
    assert.ok(!r.calls.some((c) => c[0] === "buildOwnerWebPrompt"));
  });
});

// ─── Classic: speech recognition ─────────────────────────────────────────────

describe("/ws/test classic speech recognition on an owner session, run for real", () => {
  const STT_CALLBACKS = sliceInHandler("onTranscript: ({ transcript, isFinal }) => {", "\n      }, { industry: session.organization?.industry });");

  /** what reached the barge-in check (SCRUM-618) */
  let bargeIns = [];
  function makeStt(session) {
    bargeIns = [];
    const calls = [];
    const lines = [];
    const ws = fakeWs();
    session.bufferTranscript = (text, cb) => cb(text, "general");
    const h = run(`return {\n  cbs: {\n${STT_CALLBACKS}\n  },\n  setCleaningUp: (v) => { cleaningUp = v; },\n};`, {
      ws,
      WebSocket: { OPEN: 1 },
      session,
      noteOwnerSpeech,
      logTranscript: () => {},
      handleTestUserSpeech: (s, w, text) => calls.push(["turn", text]),
      ownerWebBargeIn: (s, w, text) => { bargeIns.push(text); return false; }, // SCRUM-618
      cleaningUp: false,
      OWNER_WEB_PROBLEM_MESSAGE: "<owner problem>",
      console: recordingConsole(lines),
    });
    return { cbs: h.cbs, setCleaningUp: h.setCleaningUp, calls, lines, ws };
  }

  it("the owner's speech is stamped on a final transcript, never an interim one (as on the phone line), and the final starts a turn", () => {
    const s = ownerSession();
    const { cbs, calls } = makeStt(s);
    cbs.onTranscript({ transcript: "yes", isFinal: false });
    assert.equal(s.lastOwnerSpeechAt, 0, "an interim is not stamped");
    assert.deepEqual(calls, []);
    cbs.onTranscript({ transcript: "yes", isFinal: true });
    assert.ok(s.lastOwnerSpeechAt > 0);
    assert.deepEqual(calls, [["turn", "yes"]]);
  });

  it("a customer's test call is never stamped", () => {
    const c = customerSession();
    makeStt(c).cbs.onTranscript({ transcript: "yes", isFinal: true });
    assert.equal(c.lastOwnerSpeechAt, 0);
  });

  it("an error ends an owner session as failed, in the owner's words; a test call only hears it, as before", () => {
    const s = ownerSession();
    const o = makeStt(s);
    o.cbs.onError(new Error("dg down"));
    assert.equal(s.callFailed, true);
    assert.deepEqual(o.ws.sent, [{ type: "error", message: "<owner problem>" }]);
    assert.deepEqual(o.ws.closed, [[4500, "Speech recognition error"]]);
    const c = customerSession();
    const t = makeStt(c);
    t.cbs.onError(new Error("dg down"));
    assert.equal(c.callFailed, false);
    assert.deepEqual(t.ws.sent, [{ type: "error", message: "Speech recognition error" }]);
    assert.deepEqual(t.ws.closed, []);
  });

  it("an error while the owner session closes is ignored", () => {
    const s = ownerSession();
    const o = makeStt(s);
    o.setCleaningUp(true);
    o.cbs.onError(new Error("dg reset"));
    assert.equal(s.callFailed, false);
    assert.deepEqual(o.ws.sent, []);
    assert.ok(o.lines.some((l) => l.startsWith("log|") && l.includes("(ignored)")));
  });

  it("speech recognition lost without an error ends an owner session as failed; a normal close, teardown, or a failure already said do not", () => {
    for (const code of [1000, 1005]) {
      const s = ownerSession();
      const o = makeStt(s);
      o.cbs.onClose(code);
      assert.equal(s.callFailed, false, `close ${code} is normal`);
      assert.deepEqual(o.ws.closed, []);
    }
    const s = ownerSession();
    const o = makeStt(s);
    o.cbs.onClose(1006);
    assert.equal(s.callFailed, true);
    assert.deepEqual(o.ws.sent, [{ type: "error", message: "<owner problem>" }]);
    assert.deepEqual(o.ws.closed, [[4500, "Speech recognition lost"]]);
    const closing = ownerSession();
    const c = makeStt(closing);
    c.setCleaningUp(true);
    c.cbs.onClose(1006);
    assert.equal(closing.callFailed, false, "teardown");
    const said = ownerSession();
    const d = makeStt(said);
    d.cbs.onError(new Error("dg down"));
    d.ws.readyState = 1; // were the socket still open, the close that follows the error says nothing twice
    d.cbs.onClose(1006);
    assert.deepEqual(d.ws.sent, [{ type: "error", message: "<owner problem>" }]);
  });

  it("a customer's test call: a lost connection is only logged, as before", () => {
    const c = customerSession();
    const t = makeStt(c);
    t.cbs.onClose(1006);
    assert.equal(c.callFailed, false);
    assert.deepEqual(t.ws.closed, []);
    assert.ok(t.lines.some((l) => l.startsWith("error|") && l.includes("Deepgram connection closed unexpectedly (code=1006)")));
  });
});

// ─── SCRUM-597: the owner's lines come from Deepgram ─────────────────────────

describe("/ws/test Gemini: the owner's transcript from Deepgram, run for real", () => {
  const { createOwnerTranscriber } = require("../lib/owner-transcript");
  const SETUP = sliceInHandler("        // Transcript buffering for test calls", "        session.geminiSession = createGeminiSession(");

  function fakeDeepgram() {
    const dg = { opened: [], cb: null, ws: null };
    dg.open = (apiKey, callbacks, options) => {
      dg.opened.push({ apiKey, language: callbacks.language, options });
      dg.cb = callbacks;
      dg.ws = { readyState: 1, sent: [], closed: [], send(b) { this.sent.push(b); }, close(c) { this.closed.push(c); this.readyState = 3; } };
      return dg.ws;
    };
    return dg;
  }

  function wire(session, opts = {}) {
    const apiKey = "apiKey" in opts ? opts.apiKey : "dg-key"; // an explicit undefined means no key
    const dg = fakeDeepgram();
    const lines = [];
    const ws = fakeWs();
    const h = run(`${SETUP}\nreturn {\n  cbs: {\n${GEMINI_CALLBACKS}\n  },\n  pending: () => pendingUserTranscript,\n};`, {
      session,
      DEEPGRAM_API_KEY: apiKey,
      createOwnerTranscriber,
      openDeepgramStream: dg.open,
      ws,
      WebSocket: { OPEN: 1 },
      noteAssistantSpeech,
      noteAssistantTurnEnd,
      noteOwnerSpeech,
      noteCancelledOwnerToolCalls,
      runOwnerToolCall: async () => ({ message: "ok" }),
      notifyBookingsChanged: () => {},
      executeToolCall: async () => ({ message: "ok" }),
      scheduleCache: { invalidate: () => {} },
      logToolCall: () => {},
      cleaningUp: false,
      OWNER_WEB_PROBLEM_MESSAGE: "<owner problem>",
      setTimeout: () => {},
      console: recordingConsole(lines),
    });
    return { ...h, dg, ws, lines };
  }
  const userLines = (ws) => ws.sent.filter((m) => m && m.type === "transcript" && m.role === "user").map((m) => m.content);

  it("an owner session opens Deepgram (English, the org's industry) and its finals — not Gemini's garbled text — are the owner's lines", () => {
    const s = ownerSession();
    s.organization = { industry: "plumbing" };
    const { cbs, dg, ws } = wire(s);
    assert.deepEqual(dg.opened, [{ apiKey: "dg-key", language: "en", options: { industry: "plumbing" } }]);
    assert.equal(s.ownerTranscriber.active, true);
    cbs.onAudio("AAAA"); cbs.onTurnComplete({}); // the greeting
    cbs.onTranscriptIn("강의도 그래.");
    dg.cb.onTranscript({ transcript: "Can you cancel", isFinal: false });
    dg.cb.onTranscript({ transcript: "Can you cancel it?", isFinal: true });
    cbs.onTranscriptOut("Sure.");
    cbs.onAudio("BBBB");
    cbs.onTurnComplete({});
    assert.deepEqual(userLines(ws), ["Can you cancel it?"]);
    assert.deepEqual(s.getTranscript().split("\n").filter((l) => l.startsWith("User:")), ["User: Can you cancel it?"]);
  });

  it("Gemini's text still stamps the confirmation gate's clock (content-blind) while Deepgram writes the line", () => {
    const s = ownerSession();
    const { cbs } = wire(s);
    cbs.onAudio("AAAA"); cbs.onTurnComplete({});
    const before = s.lastOwnerSpeechAt;
    cbs.onTranscriptIn("¿Qué pasa a menudo?");
    assert.ok(s.lastOwnerSpeechAt > before || (before === undefined && typeof s.lastOwnerSpeechAt === "number"), "the owner's speech is stamped from Gemini's input transcription");
  });

  it("several Deepgram finals in one turn join with spaces, in order", () => {
    const s = ownerSession();
    const { cbs, dg, ws } = wire(s);
    dg.cb.onTranscript({ transcript: "Move the 2pm", isFinal: true });
    dg.cb.onTranscript({ transcript: "to Thursday.", isFinal: true });
    cbs.onTranscriptOut("Okay."); cbs.onAudio("A"); cbs.onTurnComplete({});
    assert.deepEqual(userLines(ws), ["Move the 2pm to Thursday."]);
  });

  it("Deepgram lost mid-session: a warning, and from then on the owner's lines are Gemini's text", () => {
    const s = ownerSession();
    const { cbs, dg, ws, lines } = wire(s);
    dg.cb.onError(new Error("1011 internal"));
    assert.equal(s.ownerTranscriber.active, false);
    assert.ok(lines.some((l) => l.startsWith("warn|") && l.includes("[OwnerWeb] Deepgram transcript lost (error: 1011 internal)") && l.includes("callSid=web_owner_abc")), lines.join("\n"));
    cbs.onTranscriptIn("Any messages?");
    cbs.onTranscriptOut("None."); cbs.onAudio("A"); cbs.onTurnComplete({});
    assert.deepEqual(userLines(ws), ["Any messages?"]);
  });

  it("while Deepgram is still connecting, the owner's words come from Gemini's text — never dropped", () => {
    const s = ownerSession();
    const { cbs, dg, ws } = wire(s);
    dg.ws.readyState = 0; // the handshake hasn't completed yet
    cbs.onAudio("AAAA"); cbs.onTurnComplete({}); // the greeting
    cbs.onTranscriptIn("Any messages for me?");
    cbs.onTranscriptOut("Two."); cbs.onAudio("B"); cbs.onTurnComplete({});
    assert.deepEqual(userLines(ws), ["Any messages for me?"]);
    s.ownerTranscriber.close();
  });

  it("no Deepgram key, or a customer's test call: no transcriber, Gemini's text as before", () => {
    for (const [session, apiKey] of [[ownerSession(), undefined], [customerSession(), "dg-key"]]) {
      const { cbs, dg, ws } = wire(session, { apiKey });
      assert.deepEqual(dg.opened, []);
      assert.equal(session.ownerTranscriber, null);
      cbs.onTranscriptIn("What times are free?");
      cbs.onTranscriptOut("Nine."); cbs.onAudio("A"); cbs.onTurnComplete({});
      assert.deepEqual(userLines(ws), ["What times are free?"]);
    }
  });
});

describe("/ws/test: inbound audio and teardown feed and close the owner's transcriber, run for real", () => {
  const MESSAGE = sliceInHandler('  ws.on("message", (data, isBinary) => {', '  ws.on("close", () => {');

  it("each inbound frame goes to Gemini and to the owner's Deepgram stream", () => {
    const s = ownerSession();
    const gemini = [];
    const dgFrames = [];
    s.geminiSession = { sendAudio: (b64) => gemini.push(b64) };
    s.ownerTranscriber = { send: (b) => dgFrames.push(b), close: () => {}, active: true };
    const handlers = {};
    const ws = { on: (ev, fn) => { handlers[ev] = fn; }, readyState: 1, send: () => {}, close: () => {} };
    run(MESSAGE, { ws, session: s, WebSocket: { OPEN: 1 }, console: recordingConsole([]) });
    const frame = Buffer.from([0x7f, 0xff, 0x00]);
    handlers.message(frame, true);
    assert.deepEqual(gemini, [frame.toString("base64")]);
    assert.deepEqual(dgFrames, [frame]);
  });

  it("teardown closes the transcriber and forgets it", async () => {
    const CLEANUP = sliceInHandler("  async function cleanupTestSession() {", "  // Auto-disconnect after max duration.");
    const s = ownerSession();
    const closed = [];
    s.geminiSession = { close: () => {} };
    s.ownerTranscriber = { send: () => {}, close: () => closed.push(true), active: true };
    let seen;
    const h = run(`${CLEANUP}\nreturn { cleanupTestSession };`, {
      cleaningUp: false, session: s, ownerWebSlotOpen: false, autoEndTimer: null, organizationId: "org-1",
      releaseTestSlot: () => {}, ownerWebSessions: { close: () => {} },
      finishOwnerWebSession: async (ended) => { seen = ended.ownerTranscriber; },
      ownerWebFinishDeps: () => ({}), clearTimeout, console: recordingConsole([]),
    });
    await h.cleanupTestSession();
    assert.deepEqual(closed, [true]);
    assert.equal(seen, null, "closed before the post-call takes the transcript");
  });
});

// ─── SCRUM-597: the page behind the bubble hears about a changed booking ──────

describe("notifyBookingsChanged, run for real", () => {
  const start = src.indexOf("function notifyBookingsChanged(ws, name, result) {");
  const code = src.slice(start, src.indexOf("\n}\n", start) + 3);
  const { OWNER_CHANGE_TOOL_NAMES } = require("../lib/owner-tools");
  const { ownerResultSucceeded } = require("../lib/owner-tool-runner");
  const notify = (ws, name, result) => run(`${code}\nnotifyBookingsChanged(ws, name, result);`, { ws, name, result, OWNER_CHANGE_TOOL_NAMES, ownerResultSucceeded, WebSocket: { OPEN: 1 } });

  it("a successful owner cancel or move tells the page; nothing else does", () => {
    const cases = [
      ["owner_cancel_appointment", { message: "Cancelled", data: { outcome: "cancelled" } }, true],
      ["owner_reschedule_appointment", { message: "Moved", data: { outcome: "rescheduled" } }, true],
      ["owner_cancel_appointment", { message: "Read this back", data: { outcome: "needs_confirmation" } }, false],
      ["owner_reschedule_appointment", { success: false, message: "taken", data: { outcome: "slot_taken" } }, false],
      ["owner_cancel_appointment", { message: "trouble" }, false],
      ["owner_list_appointments", { message: "2 jobs", data: { count: 2 } }, false],
      ["check_availability", { message: "free at 9" }, false],
      // SCRUM-598: placing a call to a customer changes no booking.
      ["owner_call_customer", { message: "Calling Jane", data: { outcome: "calling" } }, false],
    ];
    for (const [name, result, tells] of cases) {
      const ws = fakeWs();
      notify(ws, name, result);
      assert.deepEqual(ws.sent, tells ? [{ type: "bookings_changed" }] : [], `${name} ${JSON.stringify(result.data)}`);
    }
  });

  it("a closed page is never written to", () => {
    const ws = fakeWs();
    ws.readyState = 3;
    notify(ws, "owner_cancel_appointment", { message: "Cancelled", data: { outcome: "cancelled" } });
    assert.deepEqual(ws.sent, []);
  });

  it("the Gemini owner path hands every runner result to it, with the tool's name", async () => {
    const s = ownerSession();
    const ownerResult = { message: "Cancelled", data: { outcome: "cancelled" } };
    const { cbs, calls, ws } = makeCallbacks(s, { ownerResult });
    await cbs.onToolCall({ id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true, notify_customer: "none" } });
    const n = calls.find((c) => c[0] === "notifyBookingsChanged");
    assert.equal(n[1], ws);
    assert.equal(n[2], "owner_cancel_appointment");
    assert.equal(n[3], ownerResult);
  });
});
