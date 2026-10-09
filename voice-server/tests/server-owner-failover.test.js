// voice-server/tests/server-owner-failover.test.js
"use strict";
// SCRUM-587 — an owner call whose Gemini session never comes up is served by the
// OpenAI Realtime adapter (SCRUM-535). Everything the owner gate depends on must
// survive that swap: the owner's ids/outcomes (data), the turn clock, and the
// "yes" that arrives on the adapter's own transcription timing.
//
// The adapter fires onTurnComplete at response.done BEFORE that response's tool
// calls run. It passes { endedWithToolCalls }, and server.js does not count such
// a response as the end of an assistant turn — its spoken follow-up is (Gemini's
// blocking semantics). Without that, a response carrying a filler AND the confirm
// call counted as a second turn after the read-back, and the gate refused every
// owner write on the failover (silent-failure lens, SF1).
//
// Drives the REAL adapter (fake `ws` injected via require.cache, the repo's
// idiom — see openai-realtime-setup-watchdog.test.js) with the REAL server.js
// callback text (runSlice, as server-owner-mode-wiring.test.js) and the REAL runner.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const created = [];
class FakeWebSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; this.readyState = FakeWebSocket.CONNECTING; created.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code, reason) { this.readyState = FakeWebSocket.CLOSED; this.closedWith = { code, reason }; }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
const wsPath = require.resolve("ws");
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket };

process.env.OPENAI_API_KEY = "test-key";
process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";

const { createOpenAIRealtimeSession } = require("../services/openai-realtime");
const { CallSession } = require("../call-session");
const { runOwnerToolCall } = require("../lib/owner-tool-runner");
const { noteAssistantSpeech, noteAssistantTurnEnd, noteOwnerSpeech } = require("../lib/owner-turn-stamps");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
function sliceOf(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}
/** Runs server.js text between two markers; the evaluated text is this repo's own checked-in server.js. */
function runSlice({ from, to, scope, wrap }) {
  const code = sliceOf(from, to);
  const params = Object.keys(scope);
  return new Function(...params, wrap(code))(...params.map((p) => scope[p]));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function ownerSession() {
  const s = new CallSession("CA-owner");
  // Test fixture: in server.js this comes only from the server-side stream token.
  s.ownerMode = true; s.ownerFirstName = "Dave";
  s.organizationId = "org-1"; s.assistantId = "asst-1"; s.callRecordId = "call-1";
  s.callerPhone = "+61400000001"; s.orgPhoneNumber = "+61255550000";
  s.organization = { timezone: "Australia/Sydney" };
  return s;
}

const LIST = { success: true, message: "2 jobs today.", data: { range: "today", count: 1, appointments: [{ appointment_id: "a1", customer_name: "Bob Lee", when: "Friday, October 16 at 3:00 PM" }] } };
const NEEDS_CONFIRMATION = { success: false, message: "Read this back and get a clear yes before cancelling: cancel Bob Lee's job on Friday, October 16 at 3:00 PM.", data: { outcome: "needs_confirmation", appointment_id: "a1", customer_notified: false } };
const CANCELLED = { success: true, message: "Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM. The customer has NOT been notified.", data: { outcome: "cancelled", appointment_id: "a1", customer_notified: false } };
/** PR B's real gate: only the boolean true acts; anything else gets the read-back. */
const prB = (executed) => async (name, args) => { executed.push({ name, args }); return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION; };

/** The real server.js Gemini/Realtime callback block, with the real runner behind it. */
function serverCallbacks(session, executeToolCall) {
  const lines = [];
  const scope = {
    twilioWs: { readyState: 1, send: () => {}, close: () => {} },
    WebSocket: { OPEN: 1 },
    session,
    logToolCall: () => {},
    runOwnerToolCall,
    executeToolCall,
    scheduleCache: { invalidate: () => {}, applyDelta: () => {} },
    Sentry: { withScope: (fn) => fn({ setTag() {}, setExtras() {}, setExtra() {}, setLevel() {} }), captureMessage() {}, captureException() {} },
    bookingKey: () => "k", classifyRebookAttempt: () => ({ kind: "duplicate" }),
    CORRECTION_ERROR_MESSAGE: "x", DUPLICATE_REBOOK_MESSAGE: "x", normalizeDatetime: (x) => x,
    RESCHEDULE_SUCCESS_SIGNAL: /moved/, applyRescheduleToLedger: () => ({ moved: false }), CANCEL_NUDGE: "",
    logTranscript: () => {}, pendingUserTranscript: "", pendingAiTranscript: "",
    detectPhantomAction: () => null, validateToolResponse: async () => ({ accurate: true }), DEBUG_TRANSCRIPTS: false,
    noteAssistantSpeech, noteAssistantTurnEnd, noteOwnerSpeech,
    console: { log: (...a) => lines.push(a.join(" ")), warn: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")), info() {}, debug() {} },
  };
  return runSlice({ from: "onAudio: (twilioBase64) => {", to: "onError: (err) => {", scope, wrap: (code) => `return {\n${code}\n};` });
}

function openRealtime(cbs) {
  createOpenAIRealtimeSession({ systemPrompt: "owner prompt", tools: [], voiceName: "marin", language: "en", triggerGreeting: false }, { onError() {}, onClose() {}, ...cbs });
  const ws = created[created.length - 1];
  ws.readyState = FakeWebSocket.OPEN;
  ws.emit("open");
  ws.emit("message", JSON.stringify({ type: "session.updated" }));
  const ev = (msg) => ws.emit("message", JSON.stringify(msg));
  // Closing the socket clears the adapter's response watchdog (15 s), which would otherwise keep the test process alive.
  const close = () => ws.emit("close", 1000, "");
  return { ws, ev, close };
}
const outputsOf = (ws) => ws.sent.filter((m) => m.type === "conversation.item.create" && m.item?.type === "function_call_output");
const audio = (label) => ({ type: "response.output_audio.delta", delta: Buffer.from(label).toString("base64") });
const callArgs = (callId, args) => ({ type: "response.function_call_arguments.done", call_id: callId, name: "owner_cancel_appointment", arguments: JSON.stringify(args) });
/** One assistant response: response.created, its events, response.done. */
function respond(ev, id, events = [], done = {}) {
  ev({ type: "response.created", response: { id } });
  for (const e of events) ev(e);
  ev({ type: "response.done", response: { id, ...done } });
}
const ownerSays = (ev, itemId, transcript) => ev({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript });

describe("SCRUM-587: the realtime adapter tells the call site when a response ends in tool calls", () => {
  function recordTurns() {
    const events = [];
    const { ev, close } = openRealtime({
      onTurnComplete: (info) => events.push(["turnComplete", info]),
      onToolCall: async ({ name }) => { events.push(["toolCall", name]); return { message: "ok" }; },
    });
    return { events, ev, close };
  }
  it("a spoken response with no tool calls ends a turn: { endedWithToolCalls: false }", async () => {
    const { events, ev, close } = recordTurns();
    respond(ev, "r1", [audio("hello")]);
    await tick();
    assert.deepEqual(events, [["turnComplete", { endedWithToolCalls: false }]]);
    close();
  });
  it("a response carrying tool calls says so, BEFORE those calls run (the adapter's order)", async () => {
    const { events, ev, close } = recordTurns();
    respond(ev, "r1", [audio("one moment"), callArgs("c1", { appointment_id: "a1" })]);
    await sleep(5); await tick();
    assert.deepEqual(events, [["turnComplete", { endedWithToolCalls: true }], ["toolCall", "owner_cancel_appointment"]]);
    close();
  });
  it("a cancelled response's calls are dropped, so it never ends in tool calls", async () => {
    const { events, ev, close } = recordTurns();
    respond(ev, "r1", [audio("one moment"), callArgs("c1", { appointment_id: "a1" })], { status: "cancelled" });
    await sleep(5); await tick();
    assert.deepEqual(events, [["turnComplete", { endedWithToolCalls: false }]]);
    close();
  });
});

describe("SCRUM-587: an owner call served by the OpenAI Realtime failover adapter", () => {
  it("an owner_* tool's output is its message AND data as JSON; a customer tool's output stays the message", async () => {
    const s = ownerSession();
    const executed = [];
    const cbs = serverCallbacks(s, async (name) => { executed.push(name); return name === "owner_list_appointments" ? LIST : { message: "9 a.m. or 10 a.m." }; });
    const { ws, ev, close } = openRealtime(cbs);
    respond(ev, "r1", [
      { type: "response.function_call_arguments.done", call_id: "c1", name: "owner_list_appointments", arguments: '{"range":"today"}' },
      { type: "response.function_call_arguments.done", call_id: "c2", name: "check_availability", arguments: '{"date":"2026-10-16"}' },
    ]);
    await sleep(10); await tick();
    const outs = outputsOf(ws);
    assert.deepEqual(executed, ["owner_list_appointments", "check_availability"]);
    assert.equal(outs.length, 2);
    assert.equal(outs[0].item.call_id, "c1");
    assert.deepEqual(JSON.parse(outs[0].item.output), { message: LIST.message, data: LIST.data }, "appointment ids reach the model");
    assert.equal(outs[1].item.call_id, "c2");
    assert.equal(outs[1].item.output, "9 a.m. or 10 a.m.", "a shared tool's output is unchanged");
    close();
  });

  it("arm → read-back → the owner's 'yes' → the confirm reaches PR B as confirmed:true, with the outcome handed back whole", async () => {
    const s = ownerSession();
    const executed = [];
    const { ws, ev, close } = openRealtime(serverCallbacks(s, prB(executed)));
    respond(ev, "r0", [audio("greeting")]); // the greeting: one assistant turn
    await sleep(3);
    // "cancel Bob's job" — a filler, then the tool call, in ONE response.
    ev({ type: "input_audio_buffer.speech_started" });
    ownerSays(ev, "u1", "cancel Bob's job on Friday");
    respond(ev, "r1", [audio("one moment"), callArgs("c1", { appointment_id: "a1" })]);
    await sleep(10); await tick();
    assert.equal(executed.length, 1);
    assert.equal(executed[0].args.confirmed, undefined);
    assert.deepEqual(JSON.parse(outputsOf(ws)[0].item.output), { message: NEEDS_CONFIRMATION.message, data: NEEDS_CONFIRMATION.data });
    assert.ok(ws.sent.some((m) => m.type === "response.create"), "the follow-up response (the read-back) was requested");
    await sleep(3);
    respond(ev, "r2", [audio("readback")]); // the read-back
    await sleep(3);
    // "yes" — its transcription lands AFTER the server's own response.created (typical for this adapter).
    ev({ type: "input_audio_buffer.speech_started" });
    ev({ type: "response.created", response: { id: "r3" } });
    ev(callArgs("c2", { appointment_id: "a1", confirmed: true }));
    ownerSays(ev, "u2", "yes, do it");
    ev({ type: "response.done", response: { id: "r3" } });
    await sleep(20); await tick();
    assert.equal(executed.length, 2);
    assert.equal(executed[1].args.confirmed, true, "the owner's yes (stamped via the adapter's transcription) opened the gate");
    assert.deepEqual(JSON.parse(outputsOf(ws)[1].item.output), { message: CANCELLED.message, data: CANCELLED.data });
    close();
  });

  it("after the owner's 'yes', a filler AND the confirm in ONE response still go through — that response is not a second turn", async () => {
    const s = ownerSession();
    const executed = [];
    const { ev, close } = openRealtime(serverCallbacks(s, prB(executed)));
    respond(ev, "r0", [audio("greeting")]);
    await sleep(3);
    ownerSays(ev, "u1", "cancel Bob's job on Friday");
    respond(ev, "r1", [audio("one moment"), callArgs("c1", { appointment_id: "a1" })]); // arms the read-back
    await sleep(10); await tick();
    assert.equal(s.assistantTurnSeq, 1, "the response that carried the tool call did not end a turn");
    await sleep(3);
    respond(ev, "r2", [audio("readback")]); // the read-back: audio, no tools
    assert.equal(s.assistantTurnSeq, 2);
    await sleep(3);
    ownerSays(ev, "u2", "yes");
    await sleep(3);
    respond(ev, "r3", [audio("one moment"), callArgs("c2", { appointment_id: "a1", confirmed: true })]);
    await sleep(10); await tick();
    assert.equal(executed.length, 2);
    assert.equal(executed[1].args.confirmed, true, "the filler said with the confirm call is not a turn after the read-back");
    assert.equal(s.assistantTurnSeq, 2);
    respond(ev, "r4", [audio("done")]); // the spoken follow-up after the tool result
    assert.equal(s.assistantTurnSeq, 3, "the follow-up — filler and all — counts once");
    close();
  });

  it("a read-back AND its confirm in the SAME response is refused at once by the turn count (no settle wait); the next read-back + yes then go through", async () => {
    const s = ownerSession();
    const executed = [];
    const { ev, close } = openRealtime(serverCallbacks(s, prB(executed)));
    respond(ev, "r0", [audio("greeting")]);
    await sleep(3);
    ownerSays(ev, "u1", "cancel Bob's job on Friday");
    respond(ev, "r1", [callArgs("c1", { appointment_id: "a1" })]); // arms
    await sleep(10); await tick();
    await sleep(3);
    // The eager model reads back and confirms in one breath — the owner has said nothing.
    respond(ev, "r2", [audio("readback"), callArgs("c2", { appointment_id: "a1", confirmed: true })]);
    // A few event-loop turns, far inside the gate's first 100 ms poll: a confirm that
    // waited for speech would not have been forwarded yet.
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(executed.length, 2, "forwarded without the settle wait");
    assert.equal(executed[1].args.confirmed, false, "refused: no turn has ended since the arm");
    // PR B answered with the read-back again (re-armed); the model reads it back and the owner answers.
    respond(ev, "r3", [audio("readback again")]);
    assert.equal(s.assistantTurnSeq, 2);
    await sleep(3);
    ownerSays(ev, "u2", "yes");
    await sleep(3);
    respond(ev, "r4", [audio("one moment"), callArgs("c3", { appointment_id: "a1", confirmed: true })]);
    await sleep(10); await tick();
    assert.equal(executed.length, 3);
    assert.equal(executed[2].args.confirmed, true);
    close();
  });

  it("the owner's 'yes' transcript lands AFTER the model's confirm call (the adapter's usual order): the gate's settle wait lets it through", async (t) => {
    const s = ownerSession();
    const executed = [];
    const { ev, close } = openRealtime(serverCallbacks(s, prB(executed)));
    respond(ev, "r1", [callArgs("c1", { appointment_id: "a1" })]);
    await sleep(10); await tick();
    await sleep(3);
    respond(ev, "r2", [audio("readback")]);
    await sleep(3);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    respond(ev, "r3", [callArgs("c2", { appointment_id: "a1", confirmed: true })]); // the confirm runs now; no owner speech stamped yet
    for (let i = 0; i < 3; i++) { await tick(); t.mock.timers.tick(100); }
    ownerSays(ev, "u1", "yes"); // ~300 ms late
    for (let i = 0; i < 3; i++) { await tick(); t.mock.timers.tick(100); }
    assert.equal(executed.at(-1).args.confirmed, true);
    close();
  });

  it("a barge-in 'yes' over the read-back: speech_started cancels it, and the confirm still goes through once", async () => {
    const s = ownerSession();
    const executed = [];
    const { ev, close } = openRealtime(serverCallbacks(s, prB(executed)));
    respond(ev, "r1", [callArgs("c1", { appointment_id: "a1" })]);
    await sleep(10); await tick();
    await sleep(3);
    ev({ type: "response.created", response: { id: "r2" } });
    ev(audio("readback"));
    ev({ type: "input_audio_buffer.speech_started" }); // the owner talks over the read-back
    ev({ type: "response.done", response: { id: "r2", status: "cancelled" } });
    await sleep(3);
    ownerSays(ev, "u1", "yes");
    respond(ev, "r3", [callArgs("c2", { appointment_id: "a1", confirmed: true })]);
    await sleep(20); await tick();
    assert.equal(executed.at(-1).args.confirmed, true);
    assert.equal(s.assistantTurnSeq, 1, "the interrupted read-back is one turn (speech_started + cancelled done count once)");
    close();
  });

  it("a confirm with no owner answer after the read-back is forwarded as confirmed:false (the adapter's timing never opens the gate)", async (t) => {
    const s = ownerSession();
    const executed = [];
    const { ev, close } = openRealtime(serverCallbacks(s, prB(executed)));
    respond(ev, "r1", [callArgs("c1", { appointment_id: "a1" })]);
    await sleep(10); await tick();
    await sleep(3);
    respond(ev, "r2", [audio("readback")]);
    await sleep(3);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    respond(ev, "r3", [audio("one moment"), callArgs("c2", { appointment_id: "a1", confirmed: true })]); // the model confirms by itself
    for (let i = 0; i < 20; i++) { await tick(); t.mock.timers.tick(100); }
    assert.equal(executed.at(-1).args.confirmed, false);
    close();
  });
});
