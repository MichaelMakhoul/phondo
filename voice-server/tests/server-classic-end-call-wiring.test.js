"use strict";

// SCRUM-594: the classic pipeline honours end_call. Before this, handleUserSpeech
// ignored the executor's __endCall sentinel: the model was asked again, kept
// talking, and the line stayed open. These run the REAL buildLLMOptions …
// handleUserSpeech text against stubs (idiom B: server.js can't be required)
// with the real end_call guard, the real end_call sentinel and the real
// localised messages, and pin: an allowed end_call closes the socket once the
// turn's speech has played and never asks the model again; a blocked one is
// answered with the guard's nudge and the loop goes on.

process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

const { CallSession } = require("../call-session");
const toolExecutor = require("../services/tool-executor");
const { forwardingFallbackEligible } = require("../lib/transfer-eligibility");
const { buildOwnerTools } = require("../lib/owner-tools");
const { runOwnerToolCall, OWNER_MAX_TOOL_ROUNDS, ownerToolLoopReply } = require("../lib/owner-tool-runner");
const { noteAssistantSpeech, noteAssistantTurnEnd } = require("../lib/owner-turn-stamps");
const { checkEndCallGuard, END_CALL_BLOCKED_MESSAGE, END_CALL_BLOCKED_RESCHEDULE_MESSAGE } = require("../lib/end-call-guard");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function sliceOf(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}
/** Runs server.js text between two markers as a function body whose parameters are `scope`'s keys. */
function runSlice({ from, to, scope, names }) {
  const params = Object.keys(scope);
  return new Function(...params, `${sliceOf(from, to)}\nreturn { ${names.join(", ")} };`)(...params.map((p) => scope[p]));
}
function recordingConsole(lines) {
  const rec = (m) => (...args) => lines.push(`${m}| ${args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4 }))).join(" ")}`);
  return { log: rec("log"), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
}
/** The end_call guard is a lib module: it logs (and raises its alerts) through the global console. */
function captureConsole(t) {
  const lines = [];
  for (const m of ["log", "warn", "error"]) t.mock.method(console, m, (...a) => lines.push(`${m}| ${a.join(" ")}`));
  return lines;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Node timers may fire a millisecond or so early relative to Date.now(). */
const SLOP = 5;

// The real localised messages (the goodbye lives in ERROR_MESSAGES).
const { getErrorMsg } = runSlice({ from: "const ERROR_MESSAGES = {", to: "/**\n * Resolve after-hours state from call context.", scope: {}, names: ["getErrorMsg"] });

function makeSession({ owner = false, language = "en" } = {}) {
  const s = new CallSession(owner ? "CA-owner" : "CA-customer");
  if (owner) { s.ownerMode = true; s.ownerAuth = "verified"; s.ownerFirstName = "Dave"; } // as the stream token sets it
  s.language = language;
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  s.callRecordId = "call-1";
  s.callerPhone = "+61400000001";
  s.orgPhoneNumber = "+61238205672";
  s.calendarEnabled = true;
  s.serviceTypes = [];
  s.transferRules = [];
  s.behaviors = {};
  s.organization = { timezone: "Australia/Sydney" };
  s.setSystemPrompt("SYSTEM");
  return s;
}

/**
 * buildLLMOptions … handleUserSpeech, live. Each `steps` entry is one LLM
 * response: `sentences` are streamed through onSentence first, then either
 * `content` (a reply) or `tools` (tool calls) is returned.
 */
function makeClassic(o = {}) {
  const calls = [];
  const lines = [];
  const timeline = [];
  const steps = [...(o.steps || [])];
  const twilioWs = {
    readyState: 1,
    send: () => {},
    close: (...a) => {
      calls.push(["twilio.close", ...a]);
      timeline.push({ event: "close", at: Date.now(), lastTranscript: o.session?.fullTranscriptMessages.at(-1)?.content });
      if (o.closeThrows) throw new Error("socket write after end");
      twilioWs.readyState = 2; // CLOSING, set synchronously inside close() — as `ws` does
    },
  };
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
      if (!step) throw new Error("the LLM was called more often than scripted");
      for (const sentence of step.sentences || (step.content !== undefined ? [step.content] : [])) opts.onSentence(sentence);
      if (step.content !== undefined) return { type: "content", content: step.content };
      const toolCalls = step.tools.map((t, i) => ({ id: `tc${calls.length}-${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }));
      return { type: "tool_calls", toolCalls, message: { role: "assistant", content: null, tool_calls: toolCalls } };
    },
    startHoldAudio: () => ({ stop: () => calls.push(["hold.stop"]) }),
    sendClear: () => { calls.push(["sendClear"]); return true; }, // classic always clears
    sendTTS: async (s, ws, text) => {
      calls.push(["sendTTS", text]);
      await sleep(o.ttsDelay ? o.ttsDelay(text) : 2);
      if (o.ttsFails) throw new Error("tts down");
      const ms = (o.ttsMsFor && o.ttsMsFor(text)) ?? o.ttsMs ?? 40;
      timeline.push({ event: "tts", at: Date.now(), text, ms });
      if (o.onTts) o.onTts(text, twilioWs);
      return ms;
    },
    executeToolCall: async (name, args, ctx) => {
      calls.push(["executeToolCall", name, args]);
      if (o.onTool) await o.onTool(name);
      if (name === "end_call") return toolExecutor.executeToolCall(name, args, ctx); // the real sentinel
      return (o.toolResults && o.toolResults[name]) || { success: true, message: `${name} ok` };
    },
    runOwnerToolCall,
    scheduleCache: { invalidate: () => {}, applyDelta: () => {} },
    noteAssistantSpeech,
    noteAssistantTurnEnd,
    OWNER_MAX_TOOL_ROUNDS,
    ownerToolLoopReply,
    getErrorMsg,
    detectExpectedInput: () => "general",
    logTranscript: () => {},
    bookingKey: () => "k",
    classifyRebookAttempt: () => ({ kind: "duplicate" }),
    CORRECTION_ERROR_MESSAGE: "correction failed",
    DUPLICATE_REBOOK_MESSAGE: "duplicate",
    Sentry: { withScope: (fn) => fn({ setTag() {}, setExtras() {}, setExtra() {}, setLevel() {} }), captureMessage: (...a) => calls.push(["Sentry.captureMessage", ...a]), captureException: () => {} },
    normalizeDatetime: (x) => x,
    CANCEL_NUDGE: " (nothing booked now)",
    RESCHEDULE_SUCCESS_SIGNAL: /moved/,
    applyRescheduleToLedger: () => ({ moved: false }),
    saveForTransfer: () => {},
    checkEndCallGuard,
    END_CALL_PLAYBACK_CAP_MS: o.capMs ?? 400,
    END_CALL_TAIL_MS: o.tailMs ?? 30,
    WebSocket: { OPEN: 1 },
    Date: o.clock ? { now: o.clock } : Date,
    fastFlush: () => assert.fail("SCRUM-594: a classic turn never flushes an Aura stream"),
    beginFastTurn: () => assert.fail("SCRUM-594: a classic turn is never a fast turn"),
    NOT_A_REPLY: Object.freeze({ reply: false }), // SCRUM-594 gate H1: fillers and apologies (REST ignores it)
    noteFastTurnFailure: () => assert.fail("SCRUM-594: a classic turn's failure is not a fast turn's"),
    fastAudioBusy: () => assert.fail("SCRUM-594: a classic turn never waits for the fast path's audio"),
    waitForFastTurnStart: () => assert.fail("SCRUM-594: a classic turn never waits for the fast path's audio"),
    console: recordingConsole(lines),
  };
  const { handleUserSpeech } = runSlice({
    from: "function buildLLMOptions(session, { includeTransfer = false } = {}) {",
    to: "/**\n * Synthesize text and stream mulaw chunks back to Twilio.",
    scope,
    names: ["handleUserSpeech"],
  });
  const of = (name) => calls.filter((c) => c[0] === name);
  return {
    handleUserSpeech: (s, text) => handleUserSpeech(s, twilioWs, text),
    calls, lines, steps, twilioWs, timeline,
    llmCalls: () => of("llm").length,
    spoken: () => of("sendTTS").map((c) => c[1]),
    closes: () => of("twilio.close").map((c) => c.slice(1)),
    lastAudioAt: () => timeline.filter((e) => e.event === "tts").at(-1).at,
    closedAt: () => timeline.find((e) => e.event === "close").at,
  };
}
const END = (reason = "caller finished") => ({ name: "end_call", args: { reason } });
/** When the audio in the timeline has finished playing: Twilio plays each send after the one before it, in real time. */
const playbackEnd = (timeline) => timeline.filter((e) => e.event === "tts").reduce((end, e) => Math.max(e.at, end) + e.ms, 0);
const toolMessages = (s) => s.messages.filter((m) => m.role === "tool").map((m) => m.content);

describe("SCRUM-594: classic end_call hangs up", () => {
  it("an allowed end_call closes the socket once its goodbye has played — and the model is not asked again", async () => {
    const s = makeSession();
    s.toolCallAudit.push({ name: "check_availability", successful: true, at: 1 }, { name: "book_appointment", successful: true, at: 2 }); // booked earlier in the call
    const c = makeClassic({ session: s, ttsMs: 60, tailMs: 30, steps: [{ sentences: ["You're all set for Tuesday at ten. Have a great day!"], tools: [END("booking complete")] }] });
    await c.handleUserSpeech(s, "No, that's everything, thanks.");
    assert.equal(c.llmCalls(), 1, "no second LLM call after end_call");
    assert.deepEqual(c.closes(), [[1000, "end_call"]]);
    assert.equal(s.endedReason, "end_call_tool");
    assert.deepEqual(c.spoken(), ["You're all set for Tuesday at ten. Have a great day!"], "no tool filler, and no extra goodbye: the model said it");
    const waited = c.closedAt() - c.lastAudioAt();
    assert.ok(waited >= 60 + 30 - SLOP, `closed ${waited}ms after the goodbye was sent — it needed 60ms to play plus the 30ms tail`);
    assert.ok(waited < 60 + 30 + 300, `waited ${waited}ms`);
    assert.deepEqual(toolMessages(s), ["Ending the call. Goodbye."], "the tool result is recorded");
    assert.equal(c.timeline.find((e) => e.event === "close").lastTranscript, "You're all set for Tuesday at ten. Have a great day!",
      "the goodbye is in the transcript BEFORE the close (cleanup reads it as soon as the socket closes)");
    assert.deepEqual(c.calls.filter((x) => x[0] === "hold.stop").length, 1, "hold audio was stopped once, by the reply — the hang-up sends no extra clear");
    assert.ok(c.lines.some((l) => /^log\| \[EndCall\] Hanging up .*callSid=CA-customer/.test(l)), c.lines.join("\n"));
    assert.ok(!c.lines.join("\n").includes("everything, thanks"), "no caller words in the logs");
  });

  it("an end_call response that says nothing gets a short goodbye — after the hold audio stops", async () => {
    const s = makeSession();
    const c = makeClassic({ session: s, ttsMs: 50, tailMs: 20, steps: [{ tools: [END()] }] });
    await c.handleUserSpeech(s, "bye");
    assert.deepEqual(c.spoken(), ["Thanks for calling — goodbye."]);
    const order = c.calls.map((x) => x[0]).filter((n) => n === "hold.stop" || n === "sendTTS" || n === "twilio.close");
    assert.deepEqual(order, ["hold.stop", "sendTTS", "twilio.close"]);
    assert.ok(c.closedAt() - c.lastAudioAt() >= 50 + 20 - SLOP);
    assert.equal(s.fullTranscriptMessages.at(-1).role, "assistant");
    assert.equal(s.fullTranscriptMessages.at(-1).content, "Thanks for calling — goodbye.");
  });

  it("the goodbye is localised where the message map has the language, English otherwise", async () => {
    for (const [language, goodbye] of [["es", "Gracias por llamar. ¡Adiós!"], ["ar", "Thanks for calling — goodbye."]]) {
      const s = makeSession({ language });
      const c = makeClassic({ ttsMs: 1, tailMs: 1, steps: [{ tools: [END()] }] });
      await c.handleUserSpeech(s, "adiós");
      assert.deepEqual(c.spoken(), [goodbye], language);
    }
  });

  it("a blocked end_call is answered with the guard's nudge, the loop goes on, and nothing closes", async (t) => {
    const alerts = captureConsole(t);
    const s = makeSession();
    s.toolCallAudit.push({ name: "check_availability", successful: true, at: 1 }); // a booking was started …
    const c = makeClassic({ steps: [{ tools: [END("booking complete")] }, { content: "Sorry — I couldn't finish that booking. Can I take a message?" }] });
    await c.handleUserSpeech(s, "great, thanks, bye");
    assert.equal(c.llmCalls(), 2, "the model is asked again with the nudge");
    assert.deepEqual(toolMessages(s), [END_CALL_BLOCKED_MESSAGE]);
    assert.deepEqual(c.closes(), []);
    assert.equal(s.endedReason, null);
    assert.ok(!c.calls.some((x) => x[0] === "executeToolCall" && x[1] === "end_call"), "a blocked end_call is never executed");
    assert.deepEqual(c.spoken().at(-1), "Sorry — I couldn't finish that booking. Can I take a message?");
    assert.ok(alerts.some((l) => l.startsWith("warn| [ALERT:warning] [hallucination_guard] end_call blocked")), alerts.join("\n"));
  });

  it("phone test F1: after a booking and a failed reschedule, the nudge says the appointment is unchanged — never 'NO appointment'", async (t) => {
    captureConsole(t);
    const s = makeSession();
    s.toolCallAudit.push(
      { name: "check_availability", successful: true, at: 1 },
      { name: "book_appointment", successful: true, at: 2 }, // 9:30 booked …
      { name: "reschedule_appointment", successful: false, at: 3 }, // … the move to 10:30 refused
    );
    const c = makeClassic({ steps: [{ tools: [END("caller done")] }, { content: "I couldn't move it, but you're still booked for 9:30. Shall I take a message?" }] });
    await c.handleUserSpeech(s, "okay, thanks, bye");
    assert.deepEqual(toolMessages(s), [END_CALL_BLOCKED_RESCHEDULE_MESSAGE]);
    assert.doesNotMatch(toolMessages(s)[0], /NO appointment/);
    assert.deepEqual(c.closes(), []);
    assert.equal(c.llmCalls(), 2, "the model reads the nudge");
  });

  it("nudge, then allow: the next end_call on the same call hangs up (and pages at error level)", async (t) => {
    const alerts = captureConsole(t);
    const s = makeSession();
    s.toolCallAudit.push({ name: "check_availability", successful: true, at: 1 });
    const first = makeClassic({ steps: [{ tools: [END()] }, { content: "Can I take a message instead?" }] });
    await first.handleUserSpeech(s, "bye");
    assert.deepEqual(first.closes(), []);
    const second = makeClassic({ ttsMs: 5, tailMs: 5, steps: [{ sentences: ["No problem. Goodbye!"], tools: [END()] }] });
    await second.handleUserSpeech(s, "no, just hang up");
    assert.deepEqual(second.closes(), [[1000, "end_call"]]);
    assert.equal(second.llmCalls(), 1);
    assert.ok(alerts.some((l) => l.startsWith("error| [ALERT:error] [hallucination_guard] end_call allowed on unfinished booking after nudge")), alerts.join("\n"));
  });

  it("an owner's end_call (the runner's __endCall) hangs up the same way — and the customer booking guard is not consulted", async () => {
    const s = makeSession({ owner: true });
    s.toolCallAudit.push({ name: "check_availability", successful: true, at: 1 }); // would trip the customer guard
    const c = makeClassic({ ttsMs: 5, tailMs: 5, steps: [{ sentences: ["Done. Talk soon."], tools: [END("owner finished")] }] });
    await c.handleUserSpeech(s, "that's all");
    assert.deepEqual(c.closes(), [[1000, "end_call"]]);
    assert.equal(c.llmCalls(), 1);
    assert.ok(!s.toolCallAudit.some((e) => e.name === "end_call_blocked"));
    assert.deepEqual(c.calls.filter((x) => x[0] === "executeToolCall").map((x) => x[1]), ["end_call"], "through the REAL owner runner");
  });

  it("the other tools in an end_call batch still run, then the call hangs up", async () => {
    const s = makeSession();
    const c = makeClassic({ ttsMs: 5, tailMs: 5, steps: [{ sentences: ["I've passed that on. Bye!"], tools: [{ name: "schedule_callback", args: { name: "Sam" } }, END("message captured")] }] });
    await c.handleUserSpeech(s, "please have someone call me, bye");
    assert.deepEqual(c.calls.filter((x) => x[0] === "executeToolCall").map((x) => x[1]), ["schedule_callback", "end_call"]);
    assert.equal(toolMessages(s).length, 2, "every tool call gets its result");
    assert.deepEqual(c.spoken(), ["I've passed that on. Bye!"], "no tool filler after the goodbye");
    assert.deepEqual(c.closes(), [[1000, "end_call"]]);
    assert.equal(c.llmCalls(), 1);
  });

  it("a booking made in the goodbye batch: the caller never hears 'Let me book that for you.' after 'Goodbye!'", async () => {
    const s = makeSession();
    const c = makeClassic({
      ttsMs: 5,
      tailMs: 5,
      toolResults: { book_appointment: { success: true, message: "Booked! Your confirmation code is 482913." } },
      steps: [{ sentences: ["You're booked for Tuesday at ten. Goodbye!"], tools: [{ name: "book_appointment", args: { datetime: "2026-10-20T10:00:00" } }, END("booking complete")] }],
    });
    await c.handleUserSpeech(s, "yes please, book it, thanks bye");
    assert.deepEqual(c.spoken(), ["You're booked for Tuesday at ten. Goodbye!"]);
    assert.deepEqual(c.closes(), [[1000, "end_call"]]);
  });

  it("a blocked end_call batch plays no filler either — the next round's waiting filler covers the gap", async (t) => {
    captureConsole(t);
    const s = makeSession();
    s.toolCallAudit.push({ name: "check_availability", successful: true, at: 1 });
    const c = makeClassic({ ttsMs: 5, tailMs: 5, steps: [{ sentences: ["All done. Bye!"], tools: [{ name: "get_current_datetime" }, END("booking complete")] }, { content: "Actually — I couldn't finish your booking. Shall I take a message?" }] });
    await c.handleUserSpeech(s, "thanks, bye");
    assert.deepEqual(toolMessages(s), ["get_current_datetime ok", END_CALL_BLOCKED_MESSAGE], "blocked: a booking was started and never finished");
    assert.deepEqual(c.spoken(), ["All done. Bye!", "Actually — I couldn't finish your booking. Shall I take a message?"]);
    assert.deepEqual(c.closes(), []);
  });

  it("two end_calls in one batch: both get the nudge — the guard is asked once, so its one nudge is never spent unread", async (t) => {
    const alerts = captureConsole(t);
    const s = makeSession();
    s.toolCallAudit.push({ name: "check_availability", successful: true, at: 1 }); // a booking was started …
    const c = makeClassic({ steps: [{ tools: [END("done"), END("caller left")] }, { content: "Before you go — I couldn't finish that booking. Can I take a message?" }] });
    await c.handleUserSpeech(s, "bye");
    assert.deepEqual(toolMessages(s), [END_CALL_BLOCKED_MESSAGE, END_CALL_BLOCKED_MESSAGE]);
    assert.equal(s.toolCallAudit.filter((e) => e.name === "end_call_blocked").length, 1);
    assert.deepEqual(c.closes(), []);
    assert.equal(c.llmCalls(), 2, "the model reads the nudge");
    assert.equal(alerts.filter((l) => l.includes("[ALERT:")).length, 1, alerts.join("\n"));
    assert.ok(!alerts.some((l) => l.includes("end_call allowed on unfinished booking after nudge")));
  });

  it("a block holds for its own batch only: once a later round books, that round's end_call hangs up", async (t) => {
    captureConsole(t);
    const s = makeSession();
    s.toolCallAudit.push({ name: "check_availability", successful: true, at: 1 }); // a booking was started …
    const c = makeClassic({
      ttsMs: 5,
      tailMs: 5,
      toolResults: { book_appointment: { success: true, message: "Booked! Your confirmation code is 482913." } },
      steps: [
        { tools: [END("done")] },
        { sentences: ["Booking that now."], tools: [{ name: "book_appointment", args: { datetime: "2026-10-20T10:00:00" } }] },
        { sentences: ["You're booked. Goodbye!"], tools: [END("booking complete")] },
      ],
    });
    await c.handleUserSpeech(s, "book me in for Tuesday at ten, thanks, bye");
    assert.equal(c.llmCalls(), 3);
    assert.deepEqual(c.closes(), [[1000, "end_call"]], "a round-one block must not veto the end_call after the booking succeeded");
    const endCallIds = s.messages.filter((m) => m.role === "assistant" && m.tool_calls).flatMap((m) => m.tool_calls)
      .filter((tc) => tc.function.name === "end_call").map((tc) => tc.id);
    const endCallResults = s.messages.filter((m) => m.role === "tool" && endCallIds.includes(m.tool_call_id)).map((m) => m.content);
    assert.equal(endCallResults.length, 2);
    assert.equal(endCallResults[0], END_CALL_BLOCKED_MESSAGE);
    assert.notEqual(endCallResults.at(-1), END_CALL_BLOCKED_MESSAGE);
  });

  it("speech from an EARLIER round of the turn is waited for too, and a silent end_call response still gets its goodbye", async () => {
    const s = makeSession();
    const c = makeClassic({
      ttsMs: 40,
      tailMs: 20,
      // The round-one filler is slow to synthesise; round two (end_call) comes back at once.
      ttsDelay: (text) => (text.startsWith("One moment") ? 60 : 2),
      steps: [{ sentences: ["Let me look."], tools: [{ name: "get_current_datetime" }] }, { tools: [END()] }],
    });
    await c.handleUserSpeech(s, "what's the date today? ok, never mind, bye");
    const audio = c.timeline.filter((e) => e.event === "tts").map((e) => e.text);
    assert.deepEqual(audio, ["Let me look.", "One moment, let me check that.", "Thanks for calling — goodbye."],
      "the goodbye goes out after the earlier round's audio, never before it — and round one's preamble is not a goodbye");
    assert.ok(c.closedAt() >= playbackEnd(c.timeline) + 20 - SLOP, "the line stays open until every send of the turn has played, plus the tail");
    assert.equal(c.llmCalls(), 2);
  });

  it("audio that already played is not waited for again: the wait runs to the end of what is still queued", async () => {
    const s = makeSession();
    let skew = 0; // the injected clock: the round-one tool takes a (virtual) second, during which its filler plays out
    const c = makeClassic({
      clock: () => Date.now() + skew,
      ttsMsFor: (text) => (text.startsWith("One moment") ? 300 : 50),
      tailMs: 20,
      capMs: 2000,
      onTool: async (name) => { if (name === "get_current_datetime") { await sleep(10); skew += 1000; } },
      steps: [{ tools: [{ name: "get_current_datetime" }] }, { tools: [END()] }],
    });
    await c.handleUserSpeech(s, "what's today's date? actually, never mind, bye");
    assert.deepEqual(c.spoken(), ["One moment, let me check that.", "Thanks for calling — goodbye."]);
    const waited = c.closedAt() - c.lastAudioAt();
    assert.ok(waited >= 50 + 20 - SLOP, `waited ${waited}ms: the goodbye (50ms) and the tail must play out`);
    assert.ok(waited < 300, `waited ${waited}ms: the filler's 300ms had already played — a summed estimate would wait ~370ms`);
  });

  it("the wait is capped: a long estimate never holds the line open past the cap", async () => {
    const s = makeSession();
    const c = makeClassic({ ttsMs: 60_000, capMs: 120, tailMs: 20, steps: [{ sentences: ["Goodbye!"], tools: [END()] }] });
    const t0 = Date.now();
    await c.handleUserSpeech(s, "bye");
    const waited = c.closedAt() - c.lastAudioAt();
    assert.ok(waited >= 120 + 20 - SLOP, `waited ${waited}ms`);
    assert.ok(Date.now() - t0 < 2000, "capped, not the 60 s estimate");
  });
});

describe("SCRUM-594: session.awaitPlaybackEnd — a pipeline's own playback signal", () => {
  it("when present it replaces the estimate (and is called once, after endedReason is stamped)", async () => {
    const s = makeSession();
    const seen = [];
    s.awaitPlaybackEnd = async () => { seen.push(s.endedReason); await sleep(50); };
    const c = makeClassic({ ttsMs: 60_000, capMs: 400, tailMs: 20, steps: [{ sentences: ["Bye now!"], tools: [END()] }] });
    await c.handleUserSpeech(s, "bye");
    assert.deepEqual(seen, ["end_call_tool"]);
    const waited = c.closedAt() - c.lastAudioAt();
    assert.ok(waited >= 50 + 20 - SLOP && waited < 400, `waited ${waited}ms: the hook (50ms), not the capped estimate (400ms)`);
  });

  it("a hook that never settles is cut off at the cap", async () => {
    const s = makeSession();
    s.awaitPlaybackEnd = () => new Promise(() => {});
    const c = makeClassic({ ttsMs: 1, capMs: 100, tailMs: 10, steps: [{ sentences: ["Bye!"], tools: [END()] }] });
    await c.handleUserSpeech(s, "bye");
    assert.ok(c.closedAt() - c.lastAudioAt() >= 100 + 10 - SLOP);
    assert.deepEqual(c.closes(), [[1000, "end_call"]]);
  });

  it("a hook that fails falls back to the estimate, says so, and the call still hangs up", async () => {
    const s = makeSession();
    s.awaitPlaybackEnd = async () => { throw new Error("player gone"); };
    const c = makeClassic({ ttsMs: 40, capMs: 400, tailMs: 10, steps: [{ sentences: ["Bye!"], tools: [END()] }] });
    await c.handleUserSpeech(s, "bye");
    assert.ok(c.closedAt() - c.lastAudioAt() >= 40 + 10 - SLOP);
    assert.deepEqual(c.closes(), [[1000, "end_call"]]);
    assert.ok(c.lines.some((l) => l.startsWith("warn| [EndCall] Playback signal failed") && l.includes("player gone")), c.lines.join("\n"));
  });
});

describe("SCRUM-594: the hang-up is final", () => {
  it("what the caller says over the goodbye is not answered", async () => {
    const s = makeSession();
    const c = makeClassic({
      ttsMs: 20,
      tailMs: 10,
      steps: [{ sentences: ["Have a lovely day!"], tools: [END()] }],
      // The caller talks over the goodbye: the STT path queues it while the turn is still processing.
      onTts: () => s.queueOrProcess("oh wait, one more thing", (text) => c.handleUserSpeech(s, text)),
    });
    await c.handleUserSpeech(s, "that's all, bye");
    await sleep(20); // drainPending dispatches on setImmediate
    assert.equal(c.llmCalls(), 1);
    assert.equal(s._pendingTranscript, null);
    assert.equal(s.isProcessing, false);
  });

  it("a caller who hangs up during the goodbye: no close on a dead socket, the reason still says the AI ended it", async () => {
    const s = makeSession();
    const c = makeClassic({ ttsMs: 20, tailMs: 10, steps: [{ sentences: ["Goodbye!"], tools: [END()] }], onTts: (text, ws) => { ws.readyState = 3; } });
    await c.handleUserSpeech(s, "bye");
    assert.deepEqual(c.closes(), []);
    assert.equal(s.endedReason, "end_call_tool");
  });

  it("no turn starts on a closing or closed stream (a final that arrives after the hang-up)", async () => {
    for (const readyState of [2, 3]) {
      const s = makeSession();
      const c = makeClassic({ steps: [] });
      c.twilioWs.readyState = readyState;
      await c.handleUserSpeech(s, "hello? are you still there?");
      assert.deepEqual(c.calls, [], `readyState=${readyState}: no hold audio, no LLM, no TTS`);
      assert.equal(s.isProcessing, false);
      assert.equal(s.fullTranscriptMessages.length, 0);
    }
  });

  it("after the hang-up the stream is CLOSING, so a late turn does nothing", async () => {
    const s = makeSession();
    const c = makeClassic({ ttsMs: 5, tailMs: 5, steps: [{ sentences: ["Bye now!"], tools: [END()] }] });
    await c.handleUserSpeech(s, "bye");
    assert.equal(c.twilioWs.readyState, 2);
    await c.handleUserSpeech(s, "oh, one more thing");
    assert.equal(c.llmCalls(), 1);
    assert.equal(c.spoken().length, 1);
  });

  it("a close that throws is logged, and the speech queued over the goodbye is still not answered", async () => {
    const s = makeSession();
    const c = makeClassic({
      closeThrows: true,
      ttsMs: 10,
      tailMs: 5,
      steps: [{ sentences: ["Take care!"], tools: [END()] }],
      onTts: () => s.queueOrProcess("wait, wait", (text) => c.handleUserSpeech(s, text)),
    });
    await c.handleUserSpeech(s, "bye");
    await sleep(20); // drainPending dispatches on setImmediate
    assert.equal(c.twilioWs.readyState, 1, "the throwing close left the stream open");
    assert.equal(c.llmCalls(), 1, "the queued speech was dropped, not answered");
    assert.ok(c.lines.some((l) => l.startsWith("warn| [EndCall] Error closing the Twilio stream")), c.lines.join("\n"));
  });

  it("a goodbye whose TTS fails still hangs up", async () => {
    const s = makeSession();
    const c = makeClassic({ ttsFails: true, ttsMs: 20, tailMs: 10, steps: [{ tools: [END()] }] });
    await c.handleUserSpeech(s, "bye");
    assert.deepEqual(c.closes(), [[1000, "end_call"]]);
    assert.ok(c.lines.some((l) => l.startsWith("error| [EndCall] Goodbye TTS failed")), c.lines.join("\n"));
  });
});

describe("SCRUM-594: end_call hang-up — source pins", () => {
  it("the hang-up timing constants are the production values: an 8 s playback cap, then 500 ms", () => {
    assert.match(src, /^const END_CALL_PLAYBACK_CAP_MS = 8000;$/m);
    assert.match(src, /^const END_CALL_TAIL_MS = 500;$/m);
  });
  it("the guard runs before the cancel gate and after the owner runner, in the one classic tool loop", () => {
    const loop = src.indexOf('let fnArgs = parseToolArgs(toolCall, "ToolCall");');
    const runner = src.indexOf("runOwnerToolCall(session, { name: fnName, args: fnArgs }, { executeToolCall, scheduleCache })", loop);
    const guard = src.indexOf('if (fnName === "end_call") {', loop);
    const cancel = src.indexOf('fnName === "cancel_appointment" && !session.confirmCancel(', loop);
    assert.ok(loop > 0 && runner > loop && guard > runner && cancel > guard, `order: loop=${loop} runner=${runner} guard=${guard} cancel=${cancel}`);
    assert.equal((src.match(/checkEndCallGuard\(/g) || []).length, 1, "one classic call site; the Gemini inline guard is untouched");
  });
  it("the goodbye has an entry in the localised message map", () => {
    assert.equal(getErrorMsg("en", "goodbye"), "Thanks for calling — goodbye.");
    assert.equal(getErrorMsg("es", "goodbye"), "Gracias por llamar. ¡Adiós!");
    assert.equal(getErrorMsg("zz", "goodbye"), "Thanks for calling — goodbye.");
  });
});
