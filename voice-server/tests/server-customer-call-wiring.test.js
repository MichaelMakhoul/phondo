// voice-server/tests/server-customer-call-wiring.test.js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const util = require("util");

// SCRUM-598: the notify session — a call the assistant placed to a customer — as
// server.js runs it. server.js can't be required (live env + a bound port), and a
// source pin can't catch an inverted gate (feedback: regex pins hid 14/16 wiring
// mutants), so each piece below is this repo's own server.js text, run for real.

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function sliceOf(from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `server.js marker not found: ${JSON.stringify(from)}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `server.js end marker not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(start, end);
}
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
const fakeSentry = (calls) => ({
  withScope: (fn) => fn({ setTag() {}, setExtras() {}, setExtra() {}, setLevel() {} }),
  captureMessage: (...a) => calls.push(["Sentry.captureMessage", ...a]),
  captureException: (...a) => calls.push(["Sentry.captureException", ...a]),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { CallSession } = require("../call-session");
const notifyPrompt = require("../lib/notify-call-prompt");
const customerCall = require("../lib/customer-call");
const { buildOwnerTools } = require("../lib/owner-tools");
const { buildOwnerGreeting, buildOwnerGeminiSuffix } = require("../lib/owner-prompt");
const { forwardingFallbackEligible } = require("../lib/transfer-eligibility");
const { maskPhone } = require("../lib/mask-phone");
const { timingSafeEqualStr } = require("../lib/timing-safe");
const { buildOwnerCallSummary, settleOwnerToolRuns } = require("../lib/owner-tool-runner");
const { noteAssistantSpeech, noteAssistantTurnEnd, noteOwnerSpeech } = require("../lib/owner-turn-stamps");
const { bookingNeeds, listWords: listNeeds, bookingPathSteps } = require("../lib/booking-collection"); // SCRUM-617

const { buildLanguageLockDirective, languageName } = runSlice({
  from: "const LANG_DISPLAY = {",
  to: "// Cached Twilio REST client for recording and transfer operations",
  scope: {},
  names: ["buildLanguageLockDirective", "languageName"],
});

const START = "2026-10-28T03:30:00Z";
const WHEN = "Wednesday 28 October at 2:30 pm";
const NOTIFY = Object.freeze({
  callId: "55555555-5555-4555-8555-555555555555",
  organizationId: "org-1",
  appointmentId: "appt-1",
  purpose: "cancelled",
  requestedByCallId: "owner-call-1",
  mode: "conversation",
  answeredBy: "human",
});
const BRIEFING = Object.freeze({ customerName: "Jane Smith", startTime: START, previousStartTime: null, window: null });

function makeContext({ language = "en", fields = [] } = {}) {
  return {
    organizationId: "org-1",
    assistantId: "asst-1",
    organization: { name: "Copperline Plumbing", timezone: "Australia/Sydney", country: "AU", businessState: "NSW", recordingConsentMode: "auto", recording_disclosure_text: null, industry: "home_services" },
    assistant: { voiceId: "v1", language, promptConfig: { fields }, settings: {} },
    knowledgeBase: "",
    serviceTypes: [],
    calendarProvider: null,
  };
}
function makeSession({ notify = NOTIFY, briefing = BRIEFING, language = "en" } = {}) {
  const s = new CallSession("CA-notify");
  s.streamSid = "MZ1";
  s.callerPhone = "+61412345678";
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  s.language = language;
  if (notify) {
    // Test fixture: in server.js this comes only from the server-side stream token.
    s.notify = { ...notify };
    s.notifyBriefing = briefing ? { ...briefing } : null;
  }
  s.setSystemPrompt("CUSTOMER PROMPT");
  return s;
}

// ─── The Gemini assembly: prompt, opener, tools ─────────────────────────────

const RECEPTIONIST_TOOLS = [{ type: "function", function: { name: "check_availability" } }, { type: "function", function: { name: "book_appointment" } }];
function assemble(session, { consentRequired = true, language = "en", fields = [] } = {}) {
  const calls = [];
  const context = makeContext({ language, fields });
  const r = runSlice({
    from: 'const notifyVoicemail = session.notify?.mode === "voicemail";',
    to: "// Transcript buffering — accumulate fragments, flush on turn complete",
    scope: {
      session, context, isAfterHours: false, afterHoursConfig: null,
      buildOwnerTools,
      buildLLMOptions: (...a) => { calls.push(["buildLLMOptions", ...a.slice(1)]); return { tools: RECEPTIONIST_TOOLS }; },
      requiresRecordingDisclosureHybrid: (...a) => { calls.push(["requiresRecordingDisclosureHybrid", ...a]); return { required: consentRequired, callerState: "NSW", reason: "all-party" }; },
      getRecordingDisclosureText: () => "Please note, this call may be recorded.",
      getGreeting: () => "Thanks for calling Copperline Plumbing!",
      buildOwnerGreeting,
      buildOwnerGeminiSuffix,
      buildLanguageLockDirective,
      forwardingFallbackEligible,
      notifyPrompt,
      languageName,
      bookingNeeds, listNeeds, bookingPathSteps, // SCRUM-617
    },
    names: ["allTools", "consentResult", "firstMessage", "disclosureText", "geminiSystemPrompt"],
  });
  return { ...r, calls, context };
}

describe("SCRUM-598: the customer call's Gemini setup, run for real", () => {
  it("a conversation: the receptionist's tools WITHOUT transfer, plus record_call_outcome", () => {
    const r = assemble(makeSession());
    assert.deepEqual(r.calls.find((c) => c[0] === "buildLLMOptions").slice(1), [{ includeTransfer: false }]);
    assert.deepEqual(r.allTools.map((t) => t.function.name), ["check_availability", "book_appointment", "record_call_outcome"]);
  });

  it("opens with the AI's own words and the recording notice, word for word, and the notice is a legal one", () => {
    const s = makeSession();
    const r = assemble(s);
    const opener = "Hi, this is the AI assistant at Copperline Plumbing, calling for Jane. Please note, this call may be recorded. Is that you?";
    assert.ok(r.geminiSystemPrompt.includes(`IMPORTANT — YOUR FIRST MESSAGE: When the call connects, you will receive a short text message. Respond by speaking this opening, word for word, naturally and warmly: "${opener}"`));
    assert.match(r.geminiSystemPrompt, /The recording notice in it is a legal notice: say it EXACTLY as written/);
    assert.doesNotMatch(r.geminiSystemPrompt, /Thanks for calling Copperline Plumbing/, "never the inbound greeting");
    assert.equal(s.pendingDisclosureInFirstMessage, true, "the disclosure is tracked as for any customer call");
    const consent = r.calls.find((c) => c[0] === "requiresRecordingDisclosureHybrid");
    assert.equal(consent[4], "+61412345678", "the consent rules see the customer's number");
  });

  it("without a required notice: no notice and no legal line", () => {
    const r = assemble(makeSession(), { consentRequired: false });
    assert.ok(r.geminiSystemPrompt.includes('"Hi, this is the AI assistant at Copperline Plumbing, calling for Jane. Is that you?"'));
    assert.doesNotMatch(r.geminiSystemPrompt, /legal notice/);
  });

  it("keeps the customer rules, and puts the OUTBOUND CALL section LAST (after the language lock)", () => {
    const r = assemble(makeSession());
    assert.match(r.geminiSystemPrompt, /CRITICAL RULES FOR THIS CONVERSATION/);
    assert.match(r.geminiSystemPrompt, /LANGUAGE LOCK/);
    const section = notifyPrompt.buildNotifyCallSection({
      businessName: "Copperline Plumbing",
      customerName: "Jane Smith",
      purpose: "cancelled",
      when: WHEN,
      previousWhen: null,
      window: null,
      voicemailScript: notifyPrompt.buildVoicemailScript({ businessName: "Copperline Plumbing", firstName: "Jane", purpose: "cancelled", when: WHEN }),
      canTransfer: false,
    });
    assert.ok(r.geminiSystemPrompt.endsWith(section), "the notify section is the freshest instruction");
    assert.ok(r.geminiSystemPrompt.indexOf("LANGUAGE LOCK") < r.geminiSystemPrompt.indexOf("OUTBOUND CALL"));
  });

  it("a move says where it moved from; finding a new time carries the owner's window", () => {
    const moved = assemble(makeSession({ notify: { ...NOTIFY, purpose: "moved" }, briefing: { ...BRIEFING, previousStartTime: "2026-10-26T22:00:00Z" } }));
    assert.match(moved.geminiSystemPrompt, /has moved Jane's booking from Tuesday 27 October at 9:00 am to Wednesday 28 October at 2:30 pm/);
    const find = assemble(makeSession({ notify: { ...NOTIFY, purpose: "find_new_time" }, briefing: { ...BRIEFING, window: { earliest: "2026-11-02", latest: "2026-11-06", timeOfDay: "morning" } } }));
    assert.match(find.geminiSystemPrompt, /can only do the new time between Monday 2 November and Friday 6 November, in the morning: offer and book only times that fit it\./);
  });

  it("the business's line is said out loud in the voicemail and the relayed message (clients lens M6)", () => {
    const s = makeSession();
    s.orgPhoneNumber = "+61257015064";
    const r = assemble(s);
    assert.match(r.geminiSystemPrompt, /please call us back on 02 5701 5064\. Thanks, bye\./);
    assert.match(r.geminiSystemPrompt, /to call back on 02 5701 5064, thank them/);
    const vm = makeSession({ notify: { ...NOTIFY, mode: "voicemail", answeredBy: "machine_end_beep" } });
    vm.orgPhoneNumber = "+61257015064";
    assemble(vm);
    assert.match(vm.notifyVoicemailText, /please call us back on 02 5701 5064\./);
  });

  it("a title on the booking: 'calling for Mrs Johnson', never 'Mrs' (clients lens M3)", () => {
    const r = assemble(makeSession({ briefing: { ...BRIEFING, customerName: "Mrs Johnson" } }));
    assert.ok(r.geminiSystemPrompt.includes('"Hi, this is the AI assistant at Copperline Plumbing, calling for Mrs Johnson. Please note, this call may be recorded. Is that you?"'));
  });

  it("an org with transfer rules: a customer call drops them, so its prompt says to take a message (code lens G2, clients lens M5)", () => {
    const rule = { id: "r1", destination: "+61400000000" };
    const run = (session) =>
      runSlice({
        from: "session.transferRules = context.transferRules || [];",
        to: "// Start call recording if consent mode allows.",
        scope: {
          session,
          context: { ...makeContext(), transferRules: [rule], assistant: { ...makeContext().assistant, settings: { transferToForwardedNumber: true } } },
          getDeepgramVoice: () => "aura",
          getHoldPreset: () => null,
          calledNumber: "+61257015064",
        },
        wrap: (code) => code,
      });
    const s = makeSession();
    run(s);
    assert.deepEqual(s.transferRules, []);
    assert.equal(s.transferToForwardedNumber, false);
    const r = assemble(s);
    assert.match(r.geminiSystemPrompt, /this business has not configured a transfer destination, so you MUST IMMEDIATELY acknowledge the request and call schedule_callback/);
    assert.doesNotMatch(r.geminiSystemPrompt, /call the transfer_call tool/);
    const plain = makeSession({ notify: null });
    run(plain);
    assert.deepEqual(plain.transferRules, [rule], "any other call keeps the org's rules");
    assert.equal(plain.transferToForwardedNumber, true);
  });

  it("never the after-hours script on a call we placed (clients lens M4)", () => {
    const run = (session) =>
      runSlice({
        from: "// After-hours detection",
        to: "const effectiveCalendarEnabled = afterHoursState.effectiveCalendarEnabled;",
        scope: { session, context: {}, resolveAfterHoursState: () => ({ isAfterHours: true, afterHoursConfig: { message: "closed" }, effectiveCalendarEnabled: true }) },
        wrap: (code) => `${code}\nreturn { isAfterHours, afterHoursConfig };`,
      });
    assert.deepEqual(run(makeSession()), { isAfterHours: false, afterHoursConfig: null });
    assert.deepEqual(run(makeSession({ notify: null })), { isAfterHours: true, afterHoursConfig: { message: "closed" } });
  });

  it("a non-English assistant may say the opener in its language, names kept", () => {
    const r = assemble(makeSession({ language: "es" }), { language: "es" });
    assert.match(r.geminiSystemPrompt, /You may say it in Spanish, keeping the business name and the customer's name exactly\./);
  });

  it("a voicemail: no tools, no consent check, and the prompt is the voicemail prompt alone", () => {
    const s = makeSession({ notify: { ...NOTIFY, mode: "voicemail", answeredBy: "machine_end_beep" } });
    const r = assemble(s);
    assert.equal(r.calls.filter((c) => c[0] === "buildLLMOptions").length, 0);
    assert.deepEqual(r.allTools, []);
    assert.equal(r.calls.filter((c) => c[0] === "requiresRecordingDisclosureHybrid").length, 0);
    assert.equal(r.consentResult.required, false);
    const script = notifyPrompt.buildVoicemailScript({ businessName: "Copperline Plumbing", firstName: "Jane", purpose: "cancelled", when: WHEN });
    assert.equal(r.geminiSystemPrompt, notifyPrompt.buildVoicemailPrompt({ businessName: "Copperline Plumbing", script, languageName: "English" }));
    assert.equal(s.notifyVoicemailText, script, "the message left is kept for the row");
    assert.equal(s.pendingDisclosureInFirstMessage, false);
  });

  it("a plain customer call is unchanged: transfer on, no outcome tool, no outbound section", () => {
    const r = assemble(makeSession({ notify: null }));
    assert.deepEqual(r.calls.find((c) => c[0] === "buildLLMOptions").slice(1), [{ includeTransfer: true }]);
    assert.deepEqual(r.allTools.map((t) => t.function.name), ["check_availability", "book_appointment"]);
    assert.doesNotMatch(r.geminiSystemPrompt, /OUTBOUND CALL|record_call_outcome/);
    assert.match(r.geminiSystemPrompt, /Thanks for calling Copperline Plumbing/);
  });
});

// ─── The Gemini callbacks: record_call_outcome and the voicemail's end ──────

function makeCallbacks(session, o = {}) {
  const calls = [];
  const lines = [];
  const scope = {
    twilioWs: { readyState: 1, send: (m) => calls.push(["twilio.send", JSON.parse(m)]), close: (...a) => calls.push(["twilio.close", ...a]) },
    WebSocket: { OPEN: 1 },
    session,
    logToolCall: () => {},
    runOwnerToolCall: async () => assert.fail("never the owner runner on a customer call"),
    executeToolCall: o.executeToolCall || (async (...a) => { calls.push(["executeToolCall", ...a]); return { message: "customer tool result" }; }),
    scheduleCache: { invalidate: () => {}, applyDelta: () => {} },
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
    detectPhantomAction: o.detectPhantomAction || (() => null),
    validateToolResponse: async () => ({ accurate: true }),
    DEBUG_TRANSCRIPTS: false,
    noteAssistantSpeech,
    noteAssistantTurnEnd,
    noteOwnerSpeech,
    noteCancelledOwnerToolCalls: () => {},
    notifyPrompt,
    customerCall: { ...customerCall, recordDoNotCall: o.recordDoNotCall || (async () => true) },
    getSupabase: () => ({ client: "supabase" }),
    endVoicemailAfterPlayback: (...a) => calls.push(["endVoicemailAfterPlayback", ...a]),
    console: recordingConsole(lines),
  };
  const cbs = runSlice({ from: "onAudio: (twilioBase64) => {", to: "onError: (err) => {", scope, wrap: (code) => `return {\n${code}\n};` });
  return { cbs, calls, lines };
}

describe("SCRUM-598: the customer call's callbacks, run for real", () => {
  it("record_call_outcome is kept on the session and never sent on", async () => {
    const s = makeSession();
    const { cbs, calls } = makeCallbacks(s);
    const ret = await cbs.onToolCall({ id: "t1", name: "record_call_outcome", args: { outcome: "rebooked", note: "Moved to Thursday\n3pm" } });
    assert.deepEqual(ret, { message: "Noted. Now say goodbye and call end_call." });
    assert.deepEqual(s.notifyOutcome, { outcome: "rebooked", note: "Moved to Thursday 3pm" });
    assert.equal(calls.filter((c) => c[0] === "executeToolCall").length, 0);
    assert.deepEqual(s.toolCallAudit.map((a) => [a.name, a.successful]), [["record_call_outcome", true]]);
  });

  it("an outcome it doesn't know is refused with the list, and nothing is stored", async () => {
    const s = makeSession();
    const { cbs } = makeCallbacks(s);
    const ret = await cbs.onToolCall({ id: "t1", name: "record_call_outcome", args: { outcome: "upsold" } });
    assert.match(ret.message, /^Use one of these outcomes: confirmed, rebooked, declined, will_call_back, wrong_person, do_not_call, other\./);
    assert.equal(s.notifyOutcome, null);
    assert.deepEqual(s.toolCallAudit.map((a) => [a.name, a.successful]), [["record_call_outcome", false]]);
  });

  it("silent lens N3: do_not_call is kept on the row at once, and no later outcome overwrites it", async () => {
    const s = makeSession();
    const persisted = [];
    const { cbs } = makeCallbacks(s, { recordDoNotCall: async (...a) => { persisted.push(a[1]); return true; } });
    await cbs.onToolCall({ id: "t1", name: "record_call_outcome", args: { outcome: "do_not_call", note: "asked not to be called" } });
    assert.deepEqual(persisted, [s.notify]);
    await cbs.onToolCall({ id: "t2", name: "record_call_outcome", args: { outcome: "confirmed" } });
    assert.deepEqual(s.notifyOutcome, { outcome: "do_not_call", note: "asked not to be called" });
    assert.equal(persisted.length, 1);
  });

  it("on any other call the tool doesn't exist", async () => {
    const s = makeSession({ notify: null });
    const { cbs, calls } = makeCallbacks(s);
    assert.deepEqual(await cbs.onToolCall({ id: "t1", name: "record_call_outcome", args: { outcome: "do_not_call" } }), { message: "Unknown function: record_call_outcome" });
    assert.equal(s.notifyOutcome, null);
    assert.equal(calls.filter((c) => c[0] === "executeToolCall").length, 0);
  });

  it("transfer_call is refused on a customer call, whatever the model emits (code lens G2)", async () => {
    const s = makeSession();
    const { cbs, calls } = makeCallbacks(s);
    const ret = await cbs.onToolCall({ id: "t1", name: "transfer_call", args: { reason: "caller asked" } });
    assert.deepEqual(ret, { message: "Transfers aren't available on this call. Offer to take a message with schedule_callback instead." });
    assert.equal(calls.filter((c) => c[0] === "executeToolCall").length, 0);
    assert.deepEqual(s.toolCallAudit.map((a) => [a.name, a.successful]), [["transfer_call_refused", false]]);
  });

  it("end_call after a look at the diary isn't blocked as 'NO appointment' on a customer call (code lens N3); it still is on any other", async () => {
    const funnel = { name: "check_availability", successful: true, at: 1 };
    const s = makeSession();
    s.toolCallAudit.push(funnel);
    const a = makeCallbacks(s);
    await a.cbs.onToolCall({ id: "t1", name: "end_call", args: { reason: "customer will call back" } });
    assert.equal(a.calls.filter((c) => c[0] === "executeToolCall").length, 1);
    assert.equal(s.toolCallAudit.some((t) => t.name === "end_call_blocked"), false);
    const plain = makeSession({ notify: null });
    plain.toolCallAudit.push(funnel);
    const b = makeCallbacks(plain);
    const ret = await b.cbs.onToolCall({ id: "t1", name: "end_call", args: { reason: "booking_complete" } });
    assert.match(ret.message, /^CANNOT END CALL YET/);
    assert.equal(b.calls.filter((c) => c[0] === "executeToolCall").length, 0);
  });

  it("the made-up-action check never runs on a customer call — its news is the owner's change (code lens G1)", () => {
    const run = (session) => {
      const checked = [];
      const { cbs } = makeCallbacks(session, {
        detectPhantomAction: (text) => { checked.push(text); return { action: "cancellation", primaryTool: "cancel_appointment", negated: false }; },
      });
      cbs.onTranscriptOut("Your appointment on Wednesday has been cancelled, and you're all set.");
      cbs.onTurnComplete({});
      return checked;
    };
    const s = makeSession();
    assert.deepEqual(run(s), []);
    assert.equal(s._phantomActionCount, undefined, "no correction is ever sent");
    const plain = makeSession({ notify: null });
    assert.deepEqual(run(plain), ["Your appointment on Wednesday has been cancelled, and you're all set."], "any other call is still checked");
    assert.equal(plain._phantomActionCount, 1);
  });

  it("the receptionist's own tools still go through the customer path", async () => {
    const s = makeSession();
    const { cbs, calls } = makeCallbacks(s);
    await cbs.onToolCall({ id: "t1", name: "check_availability", args: { date: "2026-10-29" } });
    assert.equal(calls.filter((c) => c[0] === "executeToolCall").length, 1);
  });

  it("a voicemail ends once spoken — after its audio went out, once — and a conversation never does", () => {
    const vm = makeSession({ notify: { ...NOTIFY, mode: "voicemail" } });
    const v = makeCallbacks(vm);
    v.cbs.onTurnComplete({});
    assert.equal(v.calls.filter((c) => c[0] === "endVoicemailAfterPlayback").length, 0, "nothing spoken yet");
    v.cbs.onAudio("AAAA");
    assert.equal(vm.notifyAudioSent, true);
    v.cbs.onTurnComplete({});
    v.cbs.onTurnComplete({});
    const ends = v.calls.filter((c) => c[0] === "endVoicemailAfterPlayback");
    assert.equal(ends.length, 1);
    assert.equal(ends[0][1], vm);
    assert.equal(vm.notifyVoicemailDone, true);

    const conv = makeSession();
    const c = makeCallbacks(conv);
    c.cbs.onAudio("AAAA");
    c.cbs.onTurnComplete({});
    assert.equal(c.calls.filter((x) => x[0] === "endVoicemailAfterPlayback").length, 0);
  });
});

// ─── Taking the call row over at the start ──────────────────────────────────

function runRecordSection(session, o = {}) {
  const calls = [];
  const lines = [];
  const live = new Set(["CA-notify"]);
  const scope = {
    session, context: makeContext(), callerPhone: session.callerPhone, callSid: "CA-notify",
    createCallRecord: async (...a) => { calls.push(["createCallRecord", ...a]); return "new-row"; },
    customerCall: {
      loadNotifyBriefing: async (...a) => { calls.push(["loadNotifyBriefing", ...a.slice(1)]); return o.briefing === undefined ? { ...BRIEFING } : o.briefing; },
      markCustomerCallStarted: async (...a) => {
        calls.push(["markCustomerCallStarted", ...a.slice(1)]);
        const reason = o.markReason || "ok";
        return { marked: reason === "ok", startedAt: "2026-10-27T03:00:01.000Z", reason };
      },
      markSetupFailed: async (...a) => { calls.push(["markSetupFailed", ...a.slice(1)]); return true; },
    },
    getSupabase: () => ({ client: "supabase" }),
    liveCustomerCalls: live,
    twilioWs: { close: (...a) => calls.push(["twilio.close", ...a]) },
    console: recordingConsole(lines),
  };
  return runSlice({ isAsync: true, from: "// Create call record in database", to: "// ── Pipeline selection", scope, wrap: (code) => `${code}\nreturn "done";` })
    .then((ret) => ({ ret, calls, lines, live }));
}

describe("SCRUM-598: the session takes over the row the call was placed with", () => {
  it("briefing first, then the claimed row goes in-progress — no new row", async () => {
    const s = makeSession({ briefing: null });
    const r = await runRecordSection(s);
    assert.deepEqual(r.calls.map((c) => c[0]), ["loadNotifyBriefing", "markCustomerCallStarted"]);
    assert.deepEqual(r.calls[0][1], s.notify);
    assert.equal(s.callRecordId, NOTIFY.callId);
    assert.deepEqual(s.notifyBriefing, { ...BRIEFING });
    assert.equal(s.notifyStartedAt, "2026-10-27T03:00:01.000Z");
    assert.ok(r.live.has("CA-notify"), "still live: the status callback leaves it to this session");
  });

  it("no briefing: the call ends with nothing said, stamped as our failure, and the status callback finishes the row", async () => {
    const s = makeSession({ briefing: null });
    const r = await runRecordSection(s, { briefing: null });
    assert.notEqual(r.ret, "done");
    assert.deepEqual(r.calls.map((c) => c[0]), ["loadNotifyBriefing", "markSetupFailed", "twilio.close"], "stamped BEFORE the line drops (the status callback reads it)");
    assert.equal(r.calls[1][2], "no-briefing");
    assert.equal(s.callRecordId, null, "the session never took the row");
    assert.equal(s.callFailed, true);
    assert.equal(s.endedReason, "customer-call-no-briefing");
    assert.equal(r.live.has("CA-notify"), false);
    assert.ok(r.lines.some((l) => l.includes("[ALERT:error]")));
  });

  it("a row its TwiML fetch didn't claim isn't this session's (security lens H1): the call ends without touching it", async () => {
    const s = makeSession({ briefing: null });
    const r = await runRecordSection(s, { markReason: "not_claimable" });
    assert.notEqual(r.ret, "done");
    assert.equal(s.callRecordId, null, "never takes the row over, so cleanup never writes it");
    assert.equal(s.endedReason, "customer-call-not-claimable");
    assert.ok(r.calls.some((c) => c[0] === "twilio.close"));
    assert.equal(r.calls.some((c) => c[0] === "markSetupFailed"), false, "never stamps a row that isn't ours");
    assert.equal(r.live.has("CA-notify"), false);
  });

  it("a failed start write goes on (the TwiML claim already guarded the call)", async () => {
    const s = makeSession({ briefing: null });
    const r = await runRecordSection(s, { markReason: "db_error" });
    assert.equal(r.ret, "done");
    assert.equal(s.callRecordId, NOTIFY.callId);
    assert.ok(r.lines.some((l) => l.startsWith("warn|") && l.includes("couldn't be marked started")));
  });

  it("any other call creates its row exactly as before", async () => {
    const s = makeSession({ notify: null });
    const r = await runRecordSection(s);
    assert.deepEqual(r.calls.map((c) => c[0]), ["createCallRecord"]);
    assert.equal(s.callRecordId, "new-row");
    assert.equal("metadata" in r.calls[0][1], false, "a customer call's row starts with no call type");
  });

  it("an owner phone session's row is an owner call from the moment it exists (a customer call it asks for checks that)", async () => {
    const s = makeSession({ notify: null });
    s.ownerMode = true;
    s.ownerAuth = "verified";
    const r = await runRecordSection(s);
    assert.deepEqual(r.calls[0][1].metadata, { call_type: "owner", owner_auth: "verified" });
  });
});

// ─── Post-call (cleanupSession) ─────────────────────────────────────────────

function makeCleanup(session, o = {}) {
  const calls = [];
  const lines = [];
  const live = new Set([session.callSid]);
  const scope = {
    session,
    cleaningUp: false,
    sessions: new Map(),
    Sentry: fakeSentry(calls),
    detectPostCallPhantoms: () => { calls.push(["detectPostCallPhantoms"]); return []; },
    summarizePhantoms: () => ({ bugTag: "x", reason: "x" }),
    analyzeCallTranscript: async () => { calls.push(["analyzeCallTranscript"]); return { summary: "Jane booked Thursday.", callerName: "Jane", successEvaluation: "successful" }; },
    getSupabase: () => ({}),
    bookedNamesForAnalysis: async () => [],
    buildToolOutcomeDigest: () => "",
    DEBUG_TRANSCRIPTS: false,
    netLiveOutcome: () => 0,
    setReasonTag: () => {},
    SENTRY_REASONS: {},
    detectAndRedact: (t) => ({ piiFound: false, redacted: t }),
    redactObject: (x) => ({ piiFound: false, redacted: x }),
    completeCallRecord: async (id, fields) => {
      calls.push(["completeCallRecord", id, fields]);
      if ((o.failWrites || 0) >= calls.filter((c) => c[0] === "completeCallRecord").length) throw new Error("db write failed");
    },
    setTimeout: (fn) => fn(),
    notifyCallCompleted: async (url, secret, payload) => { calls.push(["notifyCallCompleted", payload]); if (o.posted) await o.posted; },
    INTERNAL_API_URL: "http://next.internal",
    INTERNAL_API_SECRET: "secret",
    maskPhone,
    buildOwnerCallSummary,
    settleOwnerToolRuns,
    isDemoLineNumber: () => false,
    closeFastPath: () => assert.fail("no fast path"),
    summarizeFastCall: () => assert.fail("no fast path"),
    getTransfer: () => assert.fail("no transfer"),
    customerCall,
    liveCustomerCalls: live,
    console: recordingConsole(lines),
  };
  const { cleanupSession } = runSlice({ from: "async function cleanupSession() {", to: 'twilioWs.on("message", async (raw) => {', scope, names: ["cleanupSession"] });
  return { cleanupSession, calls, lines, live };
}
function ended(session) {
  session.startedAt = Date.now() - 60_000;
  session.callRecordId = NOTIFY.callId;
  session.notifyStartedAt = "2026-10-27T03:00:01.000Z";
  session.addMessage("assistant", "Hi, this is the AI assistant at Copperline Plumbing, calling for Jane.");
  session.addMessage("user", "Yes, that's me.");
  return session;
}

describe("SCRUM-598: post-call for a customer call, run for real", () => {
  it("a conversation: analysed like a customer call, its type and request re-sent whole, the outcome kept, live released", async () => {
    const s = ended(makeSession());
    s.notifyOutcome = { outcome: "rebooked", note: "Booked Thursday 3pm" };
    s.endedReason = "end_call_tool";
    const { cleanupSession, calls, live } = makeCleanup(s);
    await cleanupSession();
    assert.ok(calls.some((c) => c[0] === "analyzeCallTranscript"), "the owner's email gets the summary");
    assert.ok(!calls.some((c) => c[0] === "detectPostCallPhantoms"), "code lens G1: no claim scan — the call's news is the owner's change");
    const [, id, fields] = calls.find((c) => c[0] === "completeCallRecord");
    assert.equal(id, NOTIFY.callId);
    assert.equal(fields.callType, "customer_notify");
    assert.equal(fields.outcome, "answered");
    assert.equal(fields.summary, "Jane booked Thursday.");
    assert.deepEqual(fields.notify, {
      purpose: "cancelled",
      appointment_id: "appt-1",
      requested_by_call_id: "owner-call-1",
      mode: "conversation",
      answered_by: "human",
      stream_started_at: "2026-10-27T03:00:01.000Z",
      outcome: "rebooked",
      note: "Booked Thursday 3pm",
      ended_reason: "end_call_tool",
    });
    const webhook = calls.find((c) => c[0] === "notifyCallCompleted")[1];
    assert.equal(webhook.callId, NOTIFY.callId);
    assert.equal(webhook.callType, "customer_notify");
    assert.ok(calls.findIndex((c) => c[0] === "completeCallRecord") < calls.findIndex((c) => c[0] === "notifyCallCompleted"), "the row is written before call-completed reads it");
    assert.equal(live.has(s.callSid), false);
  });

  it("silent lens R2-2: a customer call stays live — the drain waits — until its call-completed POST (the email) has gone out", async () => {
    const s = ended(makeSession());
    s.notifyOutcome = { outcome: "confirmed", note: null };
    let release;
    const posted = new Promise((r) => { release = r; });
    const { cleanupSession, calls, live } = makeCleanup(s, { posted });
    const done = cleanupSession();
    await sleep(20);
    assert.ok(calls.some((c) => c[0] === "notifyCallCompleted"), "the POST is out");
    assert.equal(live.has(s.callSid), true, "still live while it's in flight");
    release();
    await done;
    assert.equal(live.has(s.callSid), false);
  });

  it("a voicemail spoken and played: no analysis or claim scan, outcome 'voicemail', the message kept", async () => {
    const s = ended(makeSession({ notify: { ...NOTIFY, mode: "voicemail", answeredBy: "machine_end_beep" } }));
    s.notifyVoicemailText = "Hi Jane, this is the AI assistant at Copperline Plumbing.";
    s.notifyVoicemailDone = true;
    s.notifyVoicemailPlayed = true;
    s.endedReason = "customer-call-voicemail-left";
    const { cleanupSession, calls } = makeCleanup(s);
    await cleanupSession();
    assert.ok(!calls.some((c) => c[0] === "analyzeCallTranscript"));
    assert.ok(!calls.some((c) => c[0] === "detectPostCallPhantoms"));
    const fields = calls.find((c) => c[0] === "completeCallRecord")[2];
    assert.equal(fields.outcome, "voicemail");
    assert.equal(fields.notify.voicemail_text, "Hi Jane, this is the AI assistant at Copperline Plumbing.");
    assert.equal(fields.notify.voicemail_played, true);
    assert.equal(fields.notify.ended_reason, "customer-call-voicemail-left");
    assert.equal("outcome" in fields.notify, false, "no outcome recorded on a voicemail");
  });

  it("silent lens G1: a voicemail never spoken is never 'voicemail' — and its script isn't kept as 'the message left'", async () => {
    const s = ended(makeSession({ notify: { ...NOTIFY, mode: "voicemail", answeredBy: "machine_end_beep" } }));
    s.notifyVoicemailText = "Hi Jane, this is the AI assistant at Copperline Plumbing.";
    s.endedReason = "customer-call-voicemail-not-spoken";
    s.callFailed = true;
    const { cleanupSession, calls } = makeCleanup(s);
    await cleanupSession();
    const fields = calls.find((c) => c[0] === "completeCallRecord")[2];
    assert.equal(fields.outcome, "failed");
    assert.equal("voicemail_text" in fields.notify, false);
    const spokenUnplayed = ended(makeSession({ notify: { ...NOTIFY, mode: "voicemail", answeredBy: "machine_end_beep" } }));
    spokenUnplayed.notifyVoicemailText = "Hi Jane.";
    spokenUnplayed.notifyVoicemailDone = true;
    const c2 = makeCleanup(spokenUnplayed);
    await c2.cleanupSession();
    const f2 = c2.calls.find((c) => c[0] === "completeCallRecord")[2];
    assert.equal(f2.outcome, "voicemail");
    assert.equal(f2.notify.voicemail_played, false, "spoken, but Twilio never confirmed it played to the end");
  });

  it("silent lens N2: a record that can't be written pages, and call-completed never emails off the stale row", async () => {
    const s = ended(makeSession());
    const { cleanupSession, calls, lines, live } = makeCleanup(s, { failWrites: 2 });
    await cleanupSession();
    assert.equal(calls.filter((c) => c[0] === "completeCallRecord").length, 2);
    assert.equal(calls.some((c) => c[0] === "notifyCallCompleted"), false);
    assert.ok(lines.some((l) => l.includes("[ALERT:error]") && l.includes("record was not written")));
    assert.equal(live.has(s.callSid), false, "released, so the status callback (or the sweeper) finishes it");
  });

  it("a failed write is retried once (call-completed's email reads the row)", async () => {
    const s = ended(makeSession());
    const { cleanupSession, calls } = makeCleanup(s, { failWrites: 1 });
    await cleanupSession();
    assert.equal(calls.filter((c) => c[0] === "completeCallRecord").length, 2);
    assert.ok(calls.some((c) => c[0] === "notifyCallCompleted"));
  });

  it("a session that never took its row over: no write, no call-completed, released for the status callback", async () => {
    const s = makeSession();
    s.startedAt = Date.now() - 2000;
    const { cleanupSession, calls, lines, live } = makeCleanup(s);
    await cleanupSession();
    assert.deepEqual(calls.filter((c) => ["completeCallRecord", "notifyCallCompleted", "analyzeCallTranscript"].includes(c[0])), []);
    assert.equal(live.has(s.callSid), false);
    assert.ok(lines.some((l) => l.startsWith("warn|") && l.includes("the status callback finishes it")));
  });

  it("any other call keeps no notify metadata and no customer_notify type", async () => {
    const s = ended(makeSession({ notify: null }));
    s.callRecordId = "row-1";
    const { cleanupSession, calls } = makeCleanup(s);
    await cleanupSession();
    const fields = calls.find((c) => c[0] === "completeCallRecord")[2];
    assert.equal(fields.callType, null);
    assert.equal("notify" in fields, false);
    assert.equal(calls.find((c) => c[0] === "notifyCallCompleted")[1].callType, undefined);
  });
});

// ─── The routes and the voicemail's hang-up ─────────────────────────────────

function loadRoutes(o = {}) {
  const handlers = {};
  const calls = [];
  const lines = [];
  const timers = [];
  const intervals = [];
  const app = { post: (route, handler) => { handlers[route] = handler; } };
  const scope = {
    app,
    timingSafeEqualStr,
    INTERNAL_API_SECRET: "internal-secret",
    customerCall: {
      isCustomerCallsEnabled: (env) => env.OWNER_CUSTOMER_CALLS_ENABLED === "true",
      sweepStuckCustomerCalls: async (...a) => { calls.push(["sweep", ...a]); return { swept: 0, checked: 0 }; },
      checkCustomerCall: async (...a) => { calls.push(["check", ...a]); return o.check || { ok: true, plan: {} }; },
      placeCustomerCall: async (...a) => { calls.push(["place", ...a]); return o.place || { placed: true, callId: "c-1", callSid: "CA1" }; },
      handleCustomerCallTwiml: async (...a) => { calls.push(["twiml", ...a]); return "<Response/>"; },
      handleCustomerCallStatus: async (...a) => { calls.push(["status", ...a]); return { finalized: true, reason: "x" }; },
    },
    getSupabase: () => ({ client: "supabase" }),
    process: { env: { GEMINI_API_KEY: o.geminiKey === undefined ? "g-key" : o.geminiKey, ...(o.enabled ? { OWNER_CUSTOMER_CALLS_ENABLED: "true" } : {}) } },
    DEMO_ORG_ID: "demo-org",
    getTwilioRestClient: () => {
      const fn = (sid) => ({ update: async (p) => { calls.push(["twilio.update", sid, p]); }, fetch: async () => { calls.push(["twilio.fetch", sid]); return { status: "completed" }; } });
      fn.create = async (p) => { calls.push(["twilio.create", p]); return { sid: "CA1" }; };
      return { calls: Object.assign(fn, { create: fn.create }) };
    },
    PUBLIC_URL: "https://voice.example",
    validateTwilioSignature: () => o.signed !== false,
    WS_URL: "wss://voice.example/ws/audio",
    escapeXml: (x) => x,
    issueStreamToken: () => "stream-token",
    INTERNAL_API_URL: "http://next.internal",
    notifyCallCompleted: async (...a) => { calls.push(["notifyCallCompleted", ...a]); },
    WebSocket: { OPEN: 1 },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref: () => {} }; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return { unref: () => {} }; },
    console: recordingConsole(lines),
  };
  const exported = runSlice({
    from: "// ── SCRUM-598: the AI's call to a customer, on the owner's request",
    to: 'app.post("/preview", async (req, res) => {',
    scope,
    names: ["liveCustomerCalls", "hangUpNotifyCall", "endVoicemailAfterPlayback", "NOTIFY_VOICEMAIL_MARK"],
  });
  return { handlers, calls, lines, timers, intervals, ...exported };
}
function fakeRes() {
  const res = { statusCode: 200, body: undefined, type: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.sendStatus = (c) => { res.statusCode = c; return res; };
  res.type = (t) => { res.type = t; return res; };
  return res;
}

describe("SCRUM-598: the customer-call routes, run for real", () => {
  it("both internal routes need the internal secret", async () => {
    const r = loadRoutes();
    for (const route of ["/internal/customer-call/check", "/internal/customer-call"]) {
      for (const headers of [{}, { "x-internal-secret": "wrong" }, { "x-internal-secret": "" }]) {
        const res = fakeRes();
        await r.handlers[route]({ headers, body: {} }, res);
        assert.equal(res.statusCode, 401, `${route} ${JSON.stringify(headers)}`);
      }
    }
    assert.deepEqual(r.calls, [], "nothing ran");
  });

  it("check: 'check' phase, Gemini key as the pipeline test, the demo org, and a yes/no answer", async () => {
    const r = loadRoutes({ check: { ok: false, reason: "outside_hours" } });
    const res = fakeRes();
    await r.handlers["/internal/customer-call/check"]({ headers: { "x-internal-secret": "internal-secret" }, body: { organizationId: "o" } }, res);
    assert.deepEqual(res.body, { canCall: false, reason: "outside_hours" });
    const [, body, phase, deps] = r.calls[0];
    assert.deepEqual(body, { organizationId: "o" });
    assert.equal(phase, "check");
    assert.equal(deps.pipelineAvailable(), true);
    assert.equal(deps.demoOrgId, "demo-org");
    assert.equal(loadRoutes({ geminiKey: "" }).calls.length, 0);
    const noKey = loadRoutes({ geminiKey: "" });
    await noKey.handlers["/internal/customer-call/check"]({ headers: { "x-internal-secret": "internal-secret" }, body: {} }, fakeRes());
    assert.equal(noKey.calls[0][3].pipelineAvailable(), false, "no Gemini key, no calls");
    const yes = loadRoutes();
    const res2 = fakeRes();
    await yes.handlers["/internal/customer-call/check"]({ headers: { "x-internal-secret": "internal-secret" }, body: {} }, res2);
    assert.deepEqual(res2.body, { canCall: true }, "the plan never leaves the voice server");
  });

  it("place: Twilio wired to create and to cancel, the public URL and the secret passed", async () => {
    const r = loadRoutes();
    const res = fakeRes();
    await r.handlers["/internal/customer-call"]({ headers: { "x-internal-secret": "internal-secret" }, body: { purpose: "confirm" } }, res);
    assert.deepEqual(res.body, { placed: true, callId: "c-1", callSid: "CA1" });
    const deps = r.calls[0][2];
    assert.equal(deps.publicUrl, "https://voice.example");
    assert.equal(deps.secret, "internal-secret");
    await deps.twilio.createCall({ to: "+61400000000" });
    await deps.twilio.cancelCall("CA9");
    assert.deepEqual(r.calls.slice(1), [["twilio.create", { to: "+61400000000" }], ["twilio.update", "CA9", { status: "canceled" }]]);
  });

  it("the TwiML and status routes need Twilio's signature", async () => {
    const r = loadRoutes({ signed: false });
    for (const route of ["/twiml/customer-call/:token", "/twiml/customer-call-status/:token"]) {
      const res = fakeRes();
      await r.handlers[route]({ headers: {}, body: {}, params: { token: "t" } }, res);
      assert.equal(res.statusCode, 403, route);
    }
    assert.deepEqual(r.calls, []);
  });

  it("status: Twilio is answered at once; the handler sees this process's live calls", async () => {
    const r = loadRoutes();
    const res = fakeRes();
    r.handlers["/twiml/customer-call-status/:token"]({ headers: {}, body: { CallStatus: "no-answer" }, params: { token: "t" } }, res);
    assert.equal(res.statusCode, 204);
    await sleep(0);
    const deps = r.calls.find((c) => c[0] === "status")[2];
    r.liveCustomerCalls.add("CA-live");
    assert.equal(deps.hasLiveSession("CA-live"), true);
    assert.equal(deps.hasLiveSession("CA-other"), false);
    await deps.notifyCallCompleted({ callId: "c-1" });
    assert.deepEqual(r.calls.find((c) => c[0] === "notifyCallCompleted"), ["notifyCallCompleted", "http://next.internal", "internal-secret", { callId: "c-1" }]);
  });

  it("silent lens N1: every 5 minutes the sweeper finishes customer calls nobody finished — only while calls are on", async () => {
    const off = loadRoutes();
    assert.equal(off.intervals.length, 1);
    assert.equal(off.intervals[0].ms, 5 * 60 * 1000);
    off.intervals[0].fn();
    await sleep(0);
    assert.equal(off.calls.some((c) => c[0] === "sweep"), false, "calls switched off: nothing to sweep");
    const on = loadRoutes({ enabled: true });
    on.intervals[0].fn();
    await sleep(0);
    const deps = on.calls.find((c) => c[0] === "sweep")[1];
    on.liveCustomerCalls.add("CA-live");
    assert.equal(deps.hasLiveSession("CA-live"), true);
    await deps.fetchTwilioCall("CA9");
    await deps.notifyCallCompleted({ callId: "c-9" });
    assert.ok(on.calls.some((c) => c[0] === "notifyCallCompleted" && c[3]?.callId === "c-9"));
  });

  it("the voicemail hangs up when Twilio echoes its mark, or after the backstop", () => {
    const r = loadRoutes();
    const ws = { readyState: 1, sent: [], closed: [], send(m) { this.sent.push(JSON.parse(m)); }, close(...a) { this.closed.push(a); this.readyState = 3; } };
    const geminiClosed = [];
    const s = { streamSid: "MZ1", notify: { callId: "c-1" }, geminiSession: { close: () => geminiClosed.push(true) } };
    r.endVoicemailAfterPlayback(s, ws);
    assert.deepEqual(ws.sent, [{ event: "mark", streamSid: "MZ1", mark: { name: r.NOTIFY_VOICEMAIL_MARK } }]);
    assert.equal(s.endedReason, "customer-call-voicemail-left");
    assert.equal(r.timers.length, 1);
    assert.equal(r.timers[0].ms, 25_000);
    r.timers[0].fn();
    assert.deepEqual(geminiClosed, [true]);
    assert.deepEqual(ws.closed, [[1000, "customer call ended"]]);
    // A socket already gone gets no mark.
    const gone = { readyState: 3, send: () => assert.fail("no send on a closed socket") };
    r.endVoicemailAfterPlayback({ streamSid: "MZ2" }, gone);
  });
});

// ─── The mark echo and the never-spoken backstop ────────────────────────────

describe("SCRUM-598: the voicemail's hang-up triggers, run for real", () => {
  it("the mark echo of a voicemail marks it played, then hangs up; other marks don't", () => {
    const played = { notify: { mode: "voicemail", callId: "c" }, fastState: null };
    const runOnce = (session, name) => {
      runSlice({
        from: 'case "mark": {',
        to: 'case "stop": {',
        scope: { session, msg: { event: "mark", mark: { name } }, twilioWs: {}, hangUpNotifyCall: () => {}, NOTIFY_VOICEMAIL_MARK: "notify-voicemail-done", onFastRestMark: () => {}, onFastMark: () => {}, console: recordingConsole([]) },
        wrap: (code) => `switch (msg.event) {\n${code}\n}`,
      });
    };
    runOnce(played, "notify-voicemail-done");
    assert.equal(played.notifyVoicemailPlayed, true);
    const run = (session, name) => {
      const hung = [];
      runSlice({
        from: 'case "mark": {',
        to: 'case "stop": {',
        scope: {
          session, msg: { event: "mark", mark: { name } }, twilioWs: {},
          hangUpNotifyCall: (...a) => hung.push(a),
          NOTIFY_VOICEMAIL_MARK: "notify-voicemail-done",
          onFastRestMark: () => {}, onFastMark: () => {},
          console: recordingConsole([]),
        },
        wrap: (code) => `switch (msg.event) {\n${code}\n}`,
      });
      return hung.length;
    };
    assert.equal(run({ notify: { mode: "voicemail", callId: "c" }, fastState: null }, "notify-voicemail-done"), 1);
    assert.equal(run({ notify: { mode: "conversation", callId: "c" }, fastState: null }, "notify-voicemail-done"), 0);
    assert.equal(run({ notify: null, fastState: null }, "notify-voicemail-done"), 0);
    assert.equal(run({ notify: { mode: "voicemail", callId: "c" }, fastState: null, isSpeaking: true }, "tts-done"), 0);
  });

  it("a voicemail never spoken hangs up after 45 s; a spoken one is left alone", () => {
    const run = (session) => {
      const timers = [];
      const hung = [];
      runSlice({
        from: "// SCRUM-598: a voicemail that is never spoken (Gemini silent) still ends.",
        to: "// No greeting needed — Gemini handles the full conversation including greeting",
        scope: {
          session, twilioWs: { readyState: 1 }, WebSocket: { OPEN: 1 },
          setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref: () => {} }; },
          hangUpNotifyCall: (...a) => hung.push(a),
          NOTIFY_VOICEMAIL_MAX_MS: 45_000,
          console: recordingConsole([]),
        },
        wrap: (code) => code,
      });
      return { timers, hung };
    };
    const silent = { notify: { mode: "voicemail", callId: "c" }, notifyVoicemailDone: false };
    const a = run(silent);
    assert.equal(a.timers.length, 1);
    assert.equal(a.timers[0].ms, 45_000);
    a.timers[0].fn();
    assert.equal(a.hung.length, 1);
    assert.equal(silent.callFailed, true);
    assert.equal(silent.endedReason, "customer-call-voicemail-not-spoken");
    const spoken = { notify: { mode: "voicemail", callId: "c" }, notifyVoicemailDone: true };
    const b = run(spoken);
    b.timers[0].fn();
    assert.equal(b.hung.length, 0);
    assert.equal(run({ notify: { mode: "conversation" } }).timers.length, 0, "a conversation gets the wrap-up notice instead (below)");
    assert.equal(run({ notify: null }).timers.length, 0);
  });

  it("a conversation is told to wrap up a minute before Twilio's 5-minute limit (clients lens S1)", () => {
    const run = (session, open = true) => {
      const timers = [];
      const lines = [];
      runSlice({
        from: "// SCRUM-598 (clients lens S1): Twilio cuts a customer call at 5 minutes",
        to: "// SCRUM-598: a voicemail that is never spoken (Gemini silent) still ends.",
        scope: {
          session, twilioWs: { readyState: open ? 1 : 3 }, WebSocket: { OPEN: 1 },
          setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref: () => {} }; },
          NOTIFY_WRAP_UP_AT_MS: 240_000,
          NOTIFY_WRAP_UP_NOTICE: "WRAP UP",
          console: recordingConsole(lines),
        },
        wrap: (code) => code,
      });
      return { timers, lines };
    };
    const sent = [];
    const s = { notify: { mode: "conversation" }, geminiSession: { sendText: (t) => sent.push(t) } };
    const a = run(s);
    assert.equal(a.timers.length, 1);
    assert.equal(a.timers[0].ms, 240_000);
    a.timers[0].fn();
    assert.deepEqual(sent, ["WRAP UP"]);
    const closed = { notify: { mode: "conversation" }, geminiSession: { sendText: (t) => sent.push(t) } };
    run(closed, false).timers[0].fn();
    assert.equal(sent.length, 1, "nothing once the call has ended");
    const broken = { notify: { mode: "conversation" }, geminiSession: { sendText: () => { throw new Error("socket gone"); } } };
    const b = run(broken);
    assert.doesNotThrow(() => b.timers[0].fn());
    assert.ok(b.lines.some((l) => l.startsWith("warn|") && l.includes("wrap-up notice failed")));
    assert.equal(run({ notify: { mode: "voicemail" } }).timers.length, 0);
    assert.equal(run({ notify: null }).timers.length, 0);
  });
});

describe("SCRUM-598: the shutdown drain waits for customer calls to finish (silent lens N1)", () => {
  it("exits only once no session is left AND no customer call is still finishing", () => {
    const shutdown = sliceOf("async function gracefulShutdown(signal) {", 'process.on("SIGTERM"');
    assert.match(shutdown, /if \(sessions\.size === 0 && liveCustomerCalls\.size === 0 && customerCallWork\.size === 0\) \{/);
  });

  it("silent lens R2-2: status callbacks and sweeps in flight are tracked until they settle, and both are wrapped", async () => {
    const { customerCallWork, trackCustomerCallWork } = runSlice({
      from: "const customerCallWork = new Set();",
      to: "/** How often the sweeper looks for customer calls nobody finished (silent lens N1). */",
      scope: {},
      names: ["customerCallWork", "trackCustomerCallWork"],
    });
    let finish;
    const work = new Promise((r) => { finish = r; });
    assert.equal(trackCustomerCallWork(work), work, "the same promise comes back");
    assert.equal(customerCallWork.size, 1);
    finish("done");
    await work;
    await sleep(0);
    assert.equal(customerCallWork.size, 0);
    let fail;
    const failing = new Promise((_r, rej) => { fail = rej; });
    trackCustomerCallWork(failing).catch(() => {});
    fail(new Error("boom"));
    await sleep(0);
    assert.equal(customerCallWork.size, 0, "a failed finish is released too");
    const status = sliceOf('app.post("/twiml/customer-call-status/:token"', 'app.post("/preview"');
    assert.match(status, /trackCustomerCallWork\(\n\s+customerCall\.handleCustomerCallStatus\(req,/);
    const sweep = sliceOf("const CUSTOMER_CALL_SWEEP_MS", "const NOTIFY_VOICEMAIL_MARK");
    assert.match(sweep, /trackCustomerCallWork\(\n\s+customerCall\.sweepStuckCustomerCalls\(\{/);
  });
});

describe("SCRUM-598 (test lens): the stream start registers the call and checks its line, run for real", () => {
  const NOTIFY = { callId: "55555555-5555-4555-8555-555555555555", organizationId: "org-1", appointmentId: "a-1", purpose: "confirm", requestedByCallId: "o-1", mode: "conversation", answeredBy: "human" };
  async function start({ notify = NOTIFY, context = { organizationId: "org-1", assistantId: "asst-1", phoneNumberId: "pn-1" } } = {}) {
    const live = new Set();
    const said = [];
    const failed = [];
    const sessions = new Map();
    const ws = { closed: 0, close() { this.closed += 1; } };
    const r = await runSlice({
      isAsync: true,
      from: "          session = new CallSession(callSid);\n          session.streamSid = streamSid;",
      to: "          // Store context on session",
      scope: {
        session: null, CallSession, callSid: "CA-1", streamSid: "MZ-1", callerPhone: "+61412345678", calledNumber: "+61257015064", phoneRecord: null,
        tokenData: { ownerMode: false, notify }, liveCustomerCalls: live, sessions, maskPhone, twilioWs: ws,
        loadCallContext: async () => context,
        sendTTS: async (_s, _ws, text) => { said.push(text); },
        getErrorMsg: (_lang, key) => `<${key}>`,
        getSupabase: () => ({}),
        customerCall: { markSetupFailed: async (_sb, n, reason) => { failed.push([n.callId, reason]); return true; } },
        console: recordingConsole([]),
      },
      wrap: (code) => `${code}\nreturn { session };`,
    });
    return { r, live, ws, said, failed, session: sessions.get("MZ-1") };
  }
  it("a customer call is registered as live, so the status callback leaves it to the session", async () => {
    const { r, live, ws, failed } = await start();
    assert.ok(r && r.session.notify, "the session takes the notify context");
    assert.equal(live.has("CA-1"), true);
    assert.equal(ws.closed, 0);
    assert.deepEqual(failed, []);
  });
  it("a line that now belongs to another org: nothing is said, the call ends as our failure and is released", async () => {
    const { r, live, ws, said, failed, session } = await start({ context: { organizationId: "org-2", assistantId: "x", phoneNumberId: "y" } });
    assert.equal(r, undefined, "setup stops here");
    assert.deepEqual(failed, [[NOTIFY.callId, "org-mismatch"]]);
    assert.equal(session.callFailed, true);
    assert.equal(live.has("CA-1"), false);
    assert.equal(ws.closed, 1);
    assert.deepEqual(said, []);
  });
  it("no context: the customer never hears 'not configured'; the call ends as our failure and is released", async () => {
    const { r, live, ws, said, failed } = await start({ context: null });
    assert.equal(r, undefined);
    assert.deepEqual(said, []);
    assert.deepEqual(failed, [[NOTIFY.callId, "no-call-context"]]);
    assert.equal(ws.closed, 1);
    assert.equal(live.has("CA-1"), false);
  });
});

describe("SCRUM-598 (test lens, rounds 1-3): timing constants the slice stubs hide", () => {
  const timing = () => runSlice({ from: "const NOTIFY_VOICEMAIL_MARK = ", to: "const NOTIFY_WRAP_UP_NOTICE", scope: {}, names: ["NOTIFY_VOICEMAIL_MAX_MS", "NOTIFY_WRAP_UP_AT_MS"] });
  it("the wrap-up notice lands at least a minute before Twilio's TimeLimit cuts the call", () => {
    const { NOTIFY_WRAP_UP_AT_MS } = timing();
    assert.ok(NOTIFY_WRAP_UP_AT_MS <= customerCall.CALL_TIME_LIMIT_SECONDS * 1000 - 60_000, `${NOTIFY_WRAP_UP_AT_MS} ms`);
    assert.ok(NOTIFY_WRAP_UP_AT_MS >= 120_000, "not so early it cuts a normal call short");
  });
  it("a voicemail that is never spoken gives the line back within a minute", () => {
    const { NOTIFY_VOICEMAIL_MAX_MS } = timing();
    assert.ok(NOTIFY_VOICEMAIL_MAX_MS <= 60_000, `${NOTIFY_VOICEMAIL_MAX_MS} ms`);
    assert.ok(NOTIFY_VOICEMAIL_MAX_MS >= 20_000, "long enough for a slow first turn");
  });
});

// SCRUM-617: Gemini's booking rules (its freshest instruction) follow THIS business's fields —
// they demanded a first and last name for every business and nothing else, so the address and
// reason an owner had turned on were never asked for.
describe("SCRUM-617: Gemini's booking rules follow the business's Caller Data Collection, run for real", () => {
  const COPPERLINE = [
    { id: "first_name", label: "First Name", required: true, verification: "repeat-confirm" },
    { id: "last_name", label: "Last Name", required: true, verification: "repeat-confirm" },
    { id: "phone_number", label: "Phone Number", required: true, verification: "read-back-digits" },
    { id: "address", label: "Address", required: true, verification: "repeat-confirm" },
    { id: "reason_for_calling", label: "Reason for Calling", required: true, verification: "none" },
  ];

  it("Copperline: both names, then the address and reason in details — in the rules and in the BOOKING PATH", () => {
    const p = assemble(makeSession(), { fields: COPPERLINE }).geminiSystemPrompt;
    assert.ok(p.includes("- NAME COLLECTION IS MANDATORY — ZERO EXCEPTIONS:"));
    assert.ok(p.includes("- THIS BUSINESS ALSO NEEDS, BEFORE BOOKING: Address and Reason for Calling. Have them before calling book_appointment"));
    assert.ok(p.includes("Pass the rest in book_appointment's details"));
    assert.match(p, / {2}3\. You ask for last name \(if not captured\)\n {2}4\. You collect what this business also needs: Address and Reason for Calling/);
  });

  it("a business that doesn't require a last name: the first name only, and no last-name step", () => {
    const p = assemble(makeSession(), { fields: [{ id: "first_name", label: "First Name", required: true }, { id: "last_name", label: "Last Name", required: false }] }).geminiSystemPrompt;
    assert.ok(p.includes("This business does not require a last name — pass one only if the caller gives it."));
    assert.ok(!p.includes("ZERO EXCEPTIONS"));
    assert.ok(!p.includes("You ask for last name"));
    assert.ok(!p.includes("THIS BUSINESS ALSO NEEDS"));
  });

  it("a required email is named with the rest and goes in email", () => {
    const p = assemble(makeSession(), { fields: [{ id: "first_name", required: true }, { id: "email_address", label: "Email Address", required: true }] }).geminiSystemPrompt;
    assert.ok(p.includes("- THIS BUSINESS ALSO NEEDS, BEFORE BOOKING: Email Address. Have it before calling book_appointment"));
    assert.ok(p.includes("Pass the email in email and the rest in book_appointment's details"));
  });
});

