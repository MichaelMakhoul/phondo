"use strict";

// SCRUM-594 PHASE 2: the fast path's booking guards (B2–B4) inside server.js's
// one classic tool loop, run for real (idiom B: the buildLLMOptions …
// handleUserSpeech text against stubs, with the REAL guards, CancelGate,
// booking key, caller-ID fallback and fast-path settings). Pins: a guarded
// book_appointment never reaches the executor and the model reads why; a
// spelled-back, confirmed surname books; a second booking is redirected to a
// move once; a cancel gets the caller-ID phone and the AI's own confirmation;
// and a session without the guards (classic, Gemini's twin, owner) is untouched.

process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { CallSession } = require("../call-session");
const toolExecutor = require("../services/tool-executor");
const { forwardingFallbackEligible } = require("../lib/transfer-eligibility");
const { bookingKey, normalizeDatetime } = require("../lib/booking-key");
const { classifyRebookAttempt, DUPLICATE_REBOOK_MESSAGE, CORRECTION_ERROR_MESSAGE, CANCEL_NUDGE } = require("../lib/rebook-correction");
const { applyRescheduleToLedger, RESCHEDULE_SUCCESS_SIGNAL } = require("../lib/reschedule-ledger");
const { checkEndCallGuard, END_CALL_BLOCKED_NOTHING_NEW_MESSAGE } = require("../lib/end-call-guard");
const { checkBookingGuards, fastCancelGate, checkCallerDone, withBookedName, noteNameCorrection, forgetCancelledBooking, noteBookingGuardCap, CANCEL_KEPT_NUDGE, SPELLING_HOLD_CAP } = require("../lib/booking-guards");

const { fastLanguagesEnabled, setLanguageToolDefinition, planLanguageSwitch, recordLanguageSwitch, LANGUAGE_UNHEARD_MESSAGE, detectCallerLanguage, detectCallerEnglish, FAST_LANGUAGES } = require("../lib/fast-languages");
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function sliceOf(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found after ${JSON.stringify(from)}`);
  return src.slice(start, end);
}
function runSlice({ from, to, scope, names }) {
  const params = Object.keys(scope);
  return new Function(...params, `${sliceOf(from, to)}\nreturn { ${names.join(", ")} };`)(...params.map((p) => scope[p]));
}

const { applyFastConversationSettings, FAST_MAX_MESSAGES } = runSlice({
  from: "const FAST_VOICE_ADDENDUM = [",
  to: "// Gate B: speculative drafts",
  scope: { fastLanguagesEnabled },
  names: ["applyFastConversationSettings", "FAST_MAX_MESSAGES"],
});

const CALLER = "+61412555013";

function makeSession({ fast = true } = {}) {
  const s = new CallSession("CA-guards");
  s.language = "en";
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  s.callRecordId = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
  s.callerPhone = CALLER;
  s.calendarEnabled = true;
  s.serviceTypes = [];
  s.transferRules = [];
  s.behaviors = {};
  s.organization = { timezone: "Australia/Sydney" };
  s.setSystemPrompt("SYSTEM");
  if (fast) applyFastConversationSettings(s);
  return s;
}

/**
 * buildLLMOptions … handleUserSpeech with a scripted model: each step is one
 * response, `content` or `tools`. Tool results come from `results[name]` (an
 * array is used up one call at a time; default: a success line), and every
 * executed call is recorded.
 */
function makeLoop({ steps, results = {} }) {
  const executed = [];
  const queue = [...steps];
  const lines = [];
  const rec = (m) => (...a) => lines.push(`${m}| ${a.join(" ")}`);
  const scope = {
    calendarToolDefinitions: toolExecutor.calendarToolDefinitions,
    listServiceTypesToolDefinition: toolExecutor.listServiceTypesToolDefinition,
    transferToolDefinition: toolExecutor.transferToolDefinition,
    callbackToolDefinition: toolExecutor.callbackToolDefinition,
    endCallToolDefinition: toolExecutor.endCallToolDefinition,
    forwardingFallbackEligible,
    buildOwnerTools: () => [],
    DEFAULT_MODEL: "test-model",
    LLM_API_KEY: "llm",
    streamChatResponse: async (_key, _messages, opts) => {
      const step = queue.shift();
      if (!step) throw new Error("the model was called more often than scripted");
      if (step.content !== undefined) {
        opts.onSentence(step.content);
        return { type: "content", content: step.content };
      }
      const toolCalls = step.tools.map((t, i) => ({ id: `tc${queue.length}-${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }));
      if (step.said !== undefined) opts.onSentence(step.said); // words spoken in the same reply as the tool call
      return { type: "tool_calls", toolCalls, message: { role: "assistant", content: step.said ?? null, tool_calls: toolCalls } };
    },
    startHoldAudio: () => ({ stop: () => {} }),
    sendClear: () => true,
    sendTTS: async () => 1,
    executeToolCall: async (name, args) => {
      executed.push({ name, args });
      if (name === "end_call") return toolExecutor.executeToolCall(name, args, {}); // the real hang-up sentinel
      const scripted = Array.isArray(results[name]) ? results[name].shift() : results[name];
      return scripted || { success: true, message: name === "book_appointment" ? "I've booked your appointment. The appointment is confirmed. Confirmation code 123456." : `${name} ok` };
    },
    applyCallerIdPhoneFallback: toolExecutor.applyCallerIdPhoneFallback,
    checkBookingGuards,
    fastCancelGate,
    checkCallerDone,
    withBookedName,
    noteNameCorrection,
    forgetCancelledBooking,
    noteBookingGuardCap,
    CANCEL_KEPT_NUDGE,
    setLanguageToolDefinition,
    planLanguageSwitch,
    recordLanguageSwitch,
    LANGUAGE_UNHEARD_MESSAGE,
    detectCallerLanguage,
    detectCallerEnglish,
    FAST_LANGUAGES,
    switchFastLanguageStreams: (session, sw) => { session.deepgramVoice = sw.voice; return true; },
    runOwnerToolCall: async () => ({ message: "owner" }),
    scheduleCache: { invalidate: () => {}, applyDelta: () => {} },
    noteAssistantSpeech: () => {},
    noteAssistantTurnEnd: () => {},
    OWNER_MAX_TOOL_CALLS: 6,
    ownerToolLoopReply: () => "",
    getErrorMsg: (_l, key) => key,
    detectExpectedInput: () => "general",
    logTranscript: () => {},
    bookingKey,
    classifyRebookAttempt,
    CORRECTION_ERROR_MESSAGE,
    DUPLICATE_REBOOK_MESSAGE,
    Sentry: { withScope: (fn) => fn({ setTag() {}, setExtras() {}, setExtra() {}, setLevel() {} }), captureMessage: () => {}, captureException: () => {} },
    normalizeDatetime,
    CANCEL_NUDGE,
    RESCHEDULE_SUCCESS_SIGNAL,
    applyRescheduleToLedger,
    saveForTransfer: () => {},
    checkEndCallGuard,
    END_CALL_PLAYBACK_CAP_MS: 0,
    END_CALL_TAIL_MS: 0,
    WebSocket: { OPEN: 1 },
    Date,
    fastFlush: () => assert.fail("a text turn never flushes"),
    beginFastTurn: () => assert.fail("not a fast turn"),
    NOT_A_REPLY: Object.freeze({ reply: false }),
    noteFastTurnFailure: () => assert.fail("not a fast turn"),
    fastAudioBusy: () => assert.fail("not a fast turn"),
    waitForFastTurnStart: () => assert.fail("not a fast turn"),
    console: { log: rec("log"), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") },
  };
  const { handleUserSpeech } = runSlice({
    from: "function buildLLMOptions(session, { includeTransfer = false } = {}) {",
    to: "/**\n * Synthesize text and stream mulaw chunks back to Twilio.",
    scope,
    names: ["handleUserSpeech"],
  });
  const ws = { readyState: 1, send: () => {}, close: () => {} };
  return { say: (s, text) => handleUserSpeech(s, ws, text), executed, lines, left: () => queue.length };
}

const toolResults = (s) => s.messages.filter((m) => m.role === "tool").map((m) => m.content);
const BOOK = { name: "book_appointment", args: { datetime: "2026-10-19T09:00:00", first_name: "Sami", last_name: "Curry" } };

describe("SCRUM-594 PHASE 2: the fast path's settings", () => {
  it("keep the whole call in context and turn the guards on", () => {
    const s = makeSession();
    assert.equal(s.maxMessages, FAST_MAX_MESSAGES);
    assert.equal(s.bookingGuards, true);
    assert.match(s.messages[0].content, /^SYSTEM\nVOICE STYLE/);
  });
});

describe("SCRUM-594 PHASE 2 (B2): no booking until the surname was spelled back and confirmed", () => {
  it("the baseline's booking — straight after hearing 'Sami Curry' — is held: nothing is booked, the model reads what to spell", async () => {
    const s = makeSession();
    s.addMessage("assistant", "Can I get your first and last name?");
    s.addMessage("user", "It's Sami Curry.");
    const loop = makeLoop({ steps: [{ tools: [BOOK] }, { content: "Just to check, is that C-U-R-R-Y?" }] });
    await loop.say(s, "Monday at 9 works.");
    assert.deepEqual(loop.executed, [], "nothing reached the executor");
    assert.match(toolResults(s)[0], /^DO NOT BOOK YET.*C-U-R-R-Y/);
    assert.ok(loop.lines.some((l) => l.startsWith("warn| [BookingGuard] Holding book_appointment (spelling 1/2, reason=not-read-back). callSid=CA-guards")), loop.lines.join("\n"));
    assert.deepEqual(s.toolCallAudit.map((a) => a.name), ["book_appointment_held"]);
  });

  it("a spelled-back, confirmed surname books", async () => {
    const s = makeSession();
    const KHOURY = { name: "book_appointment", args: { ...BOOK.args, last_name: "Khoury" } };
    const loop = makeLoop({ steps: [{ content: "That's K-H-O-U-R-Y?" }, { tools: [KHOURY] }, { content: "You're booked." }] });
    await loop.say(s, "It's Sami, K h o u r y.");
    await loop.say(s, "Yes, that's right.");
    assert.deepEqual(loop.executed.map((e) => [e.name, e.args.last_name]), [["book_appointment", "Khoury"]]);
  });

  it(`after ${SPELLING_HOLD_CAP} caller turns of holds the booking goes through (a misread yes never strands a call) — logged and alerted`, async (t) => {
    const alerts = [];
    t.mock.method(console, "warn", (...a) => alerts.push(a.join(" ")));
    const s = makeSession();
    const steps = [];
    for (let i = 0; i < SPELLING_HOLD_CAP; i++) steps.push({ tools: [BOOK] }, { content: "Is that C-U-R-R-Y?" });
    steps.push({ tools: [BOOK] }, { content: "Booked." });
    const loop = makeLoop({ steps });
    for (let i = 0; i <= SPELLING_HOLD_CAP; i++) await loop.say(s, "Mm, book it.");
    assert.equal(loop.executed.filter((e) => e.name === "book_appointment").length, 1);
    assert.ok(alerts.some((l) => l.startsWith("[BookingGuard] spelling guard stepped aside after its cap")), alerts.join("\n"));
    assert.ok(alerts.some((l) => l.includes("[ALERT:warning] [booking_guard] Booking guard cap reached (spelling)")), alerts.join("\n"));
  });

  it("the model's instant retries in one turn never spend the cap: no booking without the caller speaking", async () => {
    const s = makeSession();
    const loop = makeLoop({ steps: [{ tools: [BOOK] }, { tools: [BOOK] }, { tools: [BOOK] }] });
    await loop.say(s, "Monday at 9.");
    assert.deepEqual(loop.executed, []);
  });

  it("a session without the guards books at once (classic and every other pipeline are unchanged)", async () => {
    const s = makeSession({ fast: false });
    const loop = makeLoop({ steps: [{ tools: [BOOK] }, { content: "Booked." }] });
    await loop.say(s, "Monday at 9.");
    assert.deepEqual(loop.executed.map((e) => e.name), ["book_appointment"]);
  });
});

describe("SCRUM-594 PHASE 2 (B3): a second booking while this call holds one is redirected to a move, once", () => {
  it("nudged to reschedule_appointment with both times; the model's second try goes through", async () => {
    const s = makeSession();
    const KHOURY = { name: "book_appointment", args: { ...BOOK.args, last_name: "Khoury" } };
    const TUESDAY = { name: "book_appointment", args: { ...KHOURY.args, datetime: "2026-10-20T09:00:00" } };
    const loop = makeLoop({
      steps: [
        { content: "That's K-H-O-U-R-Y?" },
        { tools: [KHOURY] }, { content: "Booked for Monday at 9." },
        { tools: [TUESDAY] }, { content: "Do you want to move Monday, or keep both?" },
        { tools: [TUESDAY] }, { content: "Booked Tuesday too." },
      ],
    });
    await loop.say(s, "Sami Khoury.");
    await loop.say(s, "Yes.");
    await loop.say(s, "How about Tuesday?");
    const nudge = toolResults(s).find((m) => m.startsWith("NOT BOOKED — no new appointment was made."));
    assert.ok(nudge, toolResults(s).join("\n"));
    assert.match(nudge, /reschedule_appointment/);
    assert.match(nudge, /current_datetime "2026-10-19T09:00:00", new_datetime "2026-10-20T09:00:00"/);
    assert.equal(loop.executed.filter((e) => e.name === "book_appointment").length, 1, "Tuesday was not booked on the first try");
    await loop.say(s, "Keep both, please.");
    assert.equal(loop.executed.filter((e) => e.name === "book_appointment").length, 2);
  });
});

describe("SCRUM-594 PHASE 2 (B4): the fast path's CancelGate — the caller-ID phone, one hold per booking, a retry after the caller's answer", () => {
  const CANCEL = { name: "cancel_appointment", args: { datetime: "2026-10-19T09:00:00", name: "Sami Khoury" } };
  const CANCELLED = { success: true, message: "Your appointment has been cancelled." };

  it("held first (even after the AI asked and the caller said yes), then the retry after the caller's yes goes through with the caller-ID phone", async () => {
    const s = makeSession();
    s.addMessage("assistant", "Do you want me to cancel the Monday 9 AM booking?");
    const loop = makeLoop({ steps: [{ tools: [CANCEL] }, { content: "To confirm: cancel Monday the 19th at 9 AM?" }, { tools: [CANCEL] }, { content: "It's cancelled." }], results: { cancel_appointment: CANCELLED } });
    await loop.say(s, "Yes please.");
    assert.deepEqual(loop.executed, [], "never on a 'yes' read off the transcript");
    assert.match(toolResults(s)[0], /^DO NOT CANCEL YET/);
    await loop.say(s, "Yes.");
    assert.deepEqual(loop.executed, [{ name: "cancel_appointment", args: { ...CANCEL.args, phone: CALLER } }]);
    assert.ok(loop.lines.some((l) => l.startsWith("log| [CancelGate] Proceeding (fast path, via=retry).")), loop.lines.join("\n"));
  });

  it("the retry after the handler's refusal is not held again", async () => {
    const s = makeSession();
    const loop = makeLoop({
      steps: [{ tools: [CANCEL] }, { content: "Cancel Monday at 9, yes?" }, { tools: [CANCEL] }, { content: "What's the name on it?" }, { tools: [CANCEL] }, { content: "Cancelled." }],
      results: { cancel_appointment: [{ success: false, message: "For security, could you confirm the name on the booking before I make that change?" }, CANCELLED] },
    });
    await loop.say(s, "Cancel it please.");
    assert.match(toolResults(s)[0], /^DO NOT CANCEL YET/);
    await loop.say(s, "Yes.");
    assert.equal(loop.executed.length, 1, "confirmed: executed");
    await loop.say(s, "Sami Khoury.");
    assert.equal(loop.executed.length, 2, "the retry for the same booking was not held a second time");
    assert.equal(toolResults(s).filter((m) => m.startsWith("DO NOT CANCEL YET")).length, 1);
  });

  it("a cancel with no arguments of its own is held every time (SCRUM-372: the caller-ID phone is no identifier)", async () => {
    const s = makeSession();
    const EMPTY = { name: "cancel_appointment", args: {} };
    const loop = makeLoop({ steps: [{ tools: [EMPTY] }, { content: "Which booking?" }, { tools: [EMPTY] }, { content: "Which one?" }] });
    await loop.say(s, "Cancel it.");
    await loop.say(s, "Yes.");
    assert.deepEqual(loop.executed, []);
  });

  it("'cancel both': each keeps its own hold, and both go through after the caller's yes", async () => {
    const s = makeSession();
    const TUESDAY = { name: "cancel_appointment", args: { datetime: "2026-10-20T14:00:00", name: "Sami Khoury" } };
    const loop = makeLoop({
      steps: [{ tools: [CANCEL, TUESDAY] }, { content: "Cancel Monday at 9 and Tuesday at 2?" }, { tools: [CANCEL, TUESDAY] }, { content: "Both cancelled." }],
      results: { cancel_appointment: CANCELLED },
    });
    await loop.say(s, "Cancel both of them please.");
    assert.deepEqual(loop.executed, []);
    await loop.say(s, "Yes, both.");
    assert.deepEqual(loop.executed.map((e) => e.args.datetime), ["2026-10-19T09:00:00", "2026-10-20T14:00:00"]);
  });

  it("the caller's no after the read-back stops the model's retry", async () => {
    const s = makeSession();
    const loop = makeLoop({ steps: [{ tools: [CANCEL] }, { content: "Cancel Monday at 9?" }, { tools: [CANCEL] }, { content: "Okay, I'll leave it." }] });
    await loop.say(s, "Cancel Monday.");
    await loop.say(s, "No, don't cancel it, I'll keep it.");
    assert.deepEqual(loop.executed, []);
    assert.ok(loop.lines.some((l) => l.includes("[CancelGate] Holding cancel_appointment pending confirmation (fast path, reason=caller-declined)")), loop.lines.join("\n"));
    assert.ok(loop.lines.some((l) => l.startsWith("log| [CancelGate] The caller declined — dropped 1 held or confirmed cancel(s) (fast path). callSid=CA-guards")), loop.lines.join("\n"));
  });

  it("cancelling one of two bookings this call made keeps the other, and says so", async () => {
    const s = makeSession();
    s.confirmedBookings = new Map([
      [bookingKey({ datetime: "2026-10-19T09:00:00", first_name: "Sami" }), { datetime: "2026-10-19T09:00:00", name: "Sami Khoury", at: 1 }],
      [bookingKey({ datetime: "2026-10-20T10:00:00", first_name: "Lina" }), { datetime: "2026-10-20T10:00:00", name: "Lina Khoury", at: 2 }],
    ]);
    const NAMELESS = { name: "cancel_appointment", args: { datetime: "2026-10-19T09:00:00" } };
    const loop = makeLoop({ steps: [{ tools: [NAMELESS] }, { content: "Cancel Monday at 9?" }, { tools: [NAMELESS] }, { content: "Done." }], results: { cancel_appointment: CANCELLED } });
    await loop.say(s, "Cancel the Monday one.");
    await loop.say(s, "Yes.");
    assert.equal(loop.executed[0].args.name, "Sami Khoury", "B6: the booked name, logged");
    assert.ok(loop.lines.some((l) => l.startsWith("log| [BookingGuard] cancel_appointment: passing the name this call booked under.")), loop.lines.join("\n"));
    assert.deepEqual([...s.confirmedBookings.values()].map((e) => e.name), ["Lina Khoury"]);
    assert.ok(toolResults(s).at(-1).endsWith(CANCEL_KEPT_NUDGE));
  });

  it("a cancel whose request failed in transport (no success flag) is not a cancel on the fast path", async () => {
    const s = makeSession();
    s.confirmedBookings = new Map([[bookingKey({ datetime: "2026-10-19T09:00:00", first_name: "Sami" }), { datetime: "2026-10-19T09:00:00", name: "Sami Khoury", at: 1 }]]);
    const loop = makeLoop({
      steps: [{ tools: [CANCEL] }, { content: "Cancel Monday at 9?" }, { tools: [CANCEL] }, { content: "Sorry, I couldn't do that just now." }],
      results: { cancel_appointment: { message: "I'm having trouble with that right now. Would you like me to take your information instead?" } },
    });
    await loop.say(s, "Cancel Monday.");
    await loop.say(s, "Yes.");
    assert.equal(s.confirmedBookings.size, 1, "the booking is still this call's");
    assert.doesNotMatch(toolResults(s).at(-1), /NOTE: the caller now has NO appointment/);
    assert.equal(s.toolCallAudit.find((a) => a.name === "cancel_appointment").successful, false);
  });

  it("a fast-path hold says why", async () => {
    const s = makeSession();
    const loop = makeLoop({ steps: [{ tools: [CANCEL] }, { content: "Cancel Monday at 9, is that right?" }] });
    await loop.say(s, "Cancel it.");
    assert.ok(loop.lines.some((l) => l.startsWith("warn| [CancelGate] Holding cancel_appointment pending confirmation (fast path, reason=first-attempt). callSid=CA-guards")), loop.lines.join("\n"));
  });

  it("a second booking redirected to a move, then 'leave it, bye' — the call ends; nothing new is booked", async () => {
    const s = makeSession();
    const KHOURY = { name: "book_appointment", args: { ...BOOK.args, last_name: "Khoury" } };
    const TUESDAY = { name: "book_appointment", args: { ...KHOURY.args, datetime: "2026-10-20T09:00:00" } };
    const END = { name: "end_call", args: { reason: "caller finished" } };
    const loop = makeLoop({
      steps: [
        { content: "That's K-H-O-U-R-Y?" },
        { tools: [KHOURY] }, { content: "Booked for Monday at 9." },
        { tools: [TUESDAY] }, { content: "Do you want to move Monday to Tuesday instead?" },
        { tools: [END] },
      ],
    });
    await loop.say(s, "Sami Khoury.");
    await loop.say(s, "Yes.");
    await loop.say(s, "How about Tuesday?");
    await loop.say(s, "Actually leave it. Bye!");
    assert.equal(loop.executed.filter((e) => e.name === "book_appointment").length, 1);
    assert.equal(s.endedReason, "end_call_tool", toolResults(s).join("\n"));
  });

  it("a failed booking ('already booked at this time') never enters this call's ledger", async () => {
    const s = makeSession();
    const KHOURY = { name: "book_appointment", args: { ...BOOK.args, last_name: "Khoury" } };
    const loop = makeLoop({
      steps: [{ content: "That's K-H-O-U-R-Y?" }, { tools: [KHOURY] }, { content: "That time's taken." }],
      results: { book_appointment: { success: false, message: "That practitioner is already booked at this time. Please choose another." } },
    });
    await loop.say(s, "Sami Khoury.");
    await loop.say(s, "Yes.");
    assert.equal(s.confirmedBookings?.size || 0, 0);
  });

  it("…nor a success that booked nothing (Cliniko's 'what type of appointment?' question)", async () => {
    const s = makeSession();
    const KHOURY = { name: "book_appointment", args: { ...BOOK.args, last_name: "Khoury" } };
    const loop = makeLoop({
      steps: [{ content: "That's K-H-O-U-R-Y?" }, { tools: [KHOURY] }, { content: "What type of appointment?" }],
      results: { book_appointment: { success: true, message: "Before I check availability, what type of appointment would you like?" } },
    });
    await loop.say(s, "Sami Khoury.");
    await loop.say(s, "Yes.");
    assert.equal(s.confirmedBookings?.size || 0, 0);
  });

  it("…nor a booking result without the handler's success flag, whatever its words", async () => {
    const s = makeSession();
    const KHOURY = { name: "book_appointment", args: { ...BOOK.args, last_name: "Khoury" } };
    const loop = makeLoop({
      steps: [{ content: "That's K-H-O-U-R-Y?" }, { tools: [KHOURY] }, { content: "Hmm." }],
      results: { book_appointment: { message: "I've booked your appointment for Monday at 9." } },
    });
    await loop.say(s, "Sami Khoury.");
    await loop.say(s, "Yes.");
    assert.equal(s.confirmedBookings?.size || 0, 0);
  });

  it("a lookup that found the caller's booking is marked found (fast path only); a no-match lookup is not", async () => {
    const LOOKUP = { name: "lookup_appointment", args: { name: "Sami Khoury" } };
    const FOUND = { success: true, message: "I found your appointment: Monday 19 October 2026 at 10:00 am. Is there anything else you'd like to know about it?" };
    const NO_MATCH = { success: true, message: "I couldn't find a match under that name. Sometimes a name gets misheard on a call — could you spell your last name for me?" };
    const run = async (fast, result) => {
      const s = makeSession({ fast });
      const loop = makeLoop({ steps: [{ tools: [LOOKUP] }, { content: "Monday at 10." }], results: { lookup_appointment: result } });
      await loop.say(s, "When's my booking?");
      return s.toolCallAudit.find((a) => a.name === "lookup_appointment");
    };
    assert.equal((await run(true, FOUND)).found, true);
    assert.equal((await run(true, NO_MATCH)).found, undefined);
    assert.equal((await run(false, FOUND)).found, undefined, "Gemini/classic audit entries are unchanged");
  });

  it("a session without the guards keeps the old gate and passes no phone", async () => {
    const s = makeSession({ fast: false });
    s.addMessage("assistant", "Do you want me to cancel the Monday 9 AM booking?");
    const loop = makeLoop({ steps: [{ tools: [CANCEL] }, { content: "Confirm?" }] });
    await loop.say(s, "Yes please.");
    assert.deepEqual(loop.executed, [], "held, as before");
    assert.match(toolResults(s)[0], /^DO NOT CANCEL YET/);
    assert.ok(loop.lines.some((l) => l.startsWith("warn| [CancelGate] Holding cancel_appointment pending confirmation (classic).")), loop.lines.join("\n"));
  });

  it("a successful cancel ends the confirmation: the next cancel needs its own", async () => {
    const s = makeSession();
    const loop = makeLoop({
      steps: [{ tools: [CANCEL] }, { content: "Cancel Monday?" }, { tools: [CANCEL] }, { content: "Cancelled." }, { tools: [CANCEL] }, { content: "Confirm?" }],
      results: { cancel_appointment: CANCELLED },
    });
    await loop.say(s, "Cancel Monday.");
    await loop.say(s, "Yes.");
    await loop.say(s, "Cancel it again.");
    assert.equal(loop.executed.length, 1);
    assert.match(toolResults(s).at(-1), /^DO NOT CANCEL YET/);
  });
});

describe("SCRUM-594 PHASE 2 (B5): the call ends only once the caller is done", () => {
  const END = { name: "end_call", args: { reason: "caller finished" } }; // (a "booking" reason with nothing booked is SCRUM-373's own block)

  it("an end_call after 'Yep, that's all correct. Thanks.' is held: the model is told to ask for anything else", async () => {
    const s = makeSession();
    s.addMessage("assistant", "You're booked for Monday at 9. Is everything correct?");
    const closes = [];
    const loop = makeLoop({ steps: [{ tools: [END] }, { content: "Great. Anything else I can help with?" }] });
    await loop.say(s, "Yep, that's all correct. Thanks.");
    assert.match(toolResults(s)[0], /^DON'T END THE CALL YET/);
    assert.deepEqual(loop.executed, [], "end_call never ran");
    assert.equal(s.endedReason, null, closes);
  });

  it("gate review: 'I've booked you in…' said in the same reply as end_call, on a call that found the caller's booking — held once with the nothing-new nudge", async () => {
    const s = makeSession();
    s.toolCallAudit.push({ name: "lookup_appointment", successful: true, found: true, at: 1 });
    const CLAIM = { name: "end_call", args: { reason: "booked new appointment for Tuesday 2pm" } };
    const loop = makeLoop({ steps: [{ tools: [CLAIM], said: "Done — I've booked you in for Tuesday at 2 PM. Have a great day!" }, { content: "Sorry — that new booking isn't made yet. Shall I book Tuesday at 2?" }] });
    await loop.say(s, "Thanks, bye.");
    assert.equal(toolResults(s)[0], END_CALL_BLOCKED_NOTHING_NEW_MESSAGE);
    assert.deepEqual(loop.executed, [], "end_call never ran");
  });

  it("an end_call after the caller's goodbye runs", async () => {
    const s = makeSession();
    s.addMessage("assistant", "Anything else I can help with?");
    const loop = makeLoop({ steps: [{ tools: [END] }] });
    await loop.say(s, "No, that's it. Bye!");
    assert.deepEqual(loop.executed.map((e) => e.name), ["end_call"]);
    assert.equal(s.endedReason, "end_call_tool");
  });

  it("a session without the guards hangs up as before", async () => {
    const s = makeSession({ fast: false });
    s.addMessage("assistant", "Is everything correct?");
    const loop = makeLoop({ steps: [{ tools: [END] }] });
    await loop.say(s, "Yep, that's all correct. Thanks.");
    assert.deepEqual(loop.executed.map((e) => e.name), ["end_call"]);
  });
});

describe("SCRUM-594 PHASE 2 (B6): changing this call's own booking never asks for the name again", () => {
  it("a reschedule without `name` carries the booked one; after an update_appointment it carries the corrected one", async () => {
    const s = makeSession();
    const KHOURY = { name: "book_appointment", args: { ...BOOK.args, last_name: "Curry" } };
    const FIX = { name: "update_appointment", args: { last_name: "Khoury" } };
    const MOVE = { name: "reschedule_appointment", args: { current_datetime: "2026-10-19T09:00:00", new_datetime: "2026-10-20T10:00:00", first_name: "Sami", last_name: "Khoury" } };
    const loop = makeLoop({
      steps: [
        { content: "That's C-U-R-R-Y?" },
        { tools: [KHOURY] }, { content: "Booked." },
        { tools: [FIX] }, { content: "Fixed." },
        { tools: [MOVE] }, { content: "Moved." },
      ],
      results: { update_appointment: { success: true, message: "NAME CORRECTED: name is now \"Sami Khoury\"." }, reschedule_appointment: { success: true, message: "Done — I've moved your appointment." } },
    });
    await loop.say(s, "Sami Curry.");
    await loop.say(s, "Yes.");
    await loop.say(s, "Actually it's Khoury, K-H-O-U-R-Y.");
    await loop.say(s, "Can we make it Tuesday at 10?");
    const move = loop.executed.find((e) => e.name === "reschedule_appointment");
    assert.equal(move.args.name, "Sami Khoury");
  });

  it("a session without the guards passes the model's arguments untouched", async () => {
    const s = makeSession({ fast: false });
    s.confirmedBookings = new Map([[bookingKey(BOOK.args), { datetime: BOOK.args.datetime, name: "Sami Curry", at: 1 }]]);
    const MOVE = { name: "reschedule_appointment", args: { current_datetime: "2026-10-19T09:00:00", new_datetime: "2026-10-20T10:00:00" } };
    const loop = makeLoop({ steps: [{ tools: [MOVE] }, { content: "Moved." }] });
    await loop.say(s, "Tuesday at 10 please.");
    assert.equal("name" in loop.executed[0].args, false);
  });
});
