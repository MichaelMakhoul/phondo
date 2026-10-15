"use strict";

// SCRUM-593 — the booking pre-check in the server.js monolith (idiom:
// server-owner-mode-wiring.test.js, which also pairs source pins with a "run
// for real" section). The behaviour is unit-tested in booking-precheck.test.js.
// This file does two things:
//   1. PINS where the check runs: in both Gemini onToolCall handlers, after the
//      owner early-return and the existing guards, before anything is remembered
//      or written, and in the RebookGuard's name-correction branch too.
//   2. RUNS the real checked-in handler text against stubs, because a source pin
//      cannot catch a hold that is ignored, a reset that never fires, or a flag
//      left on. The pre-check glue and CallSession are the real ones; only Claude
//      (fetch), the tool executor and the sockets are stubbed.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const inboundStart = src.indexOf("onToolCall: async (toolCall) => {");
const inbound = src.slice(inboundStart, src.indexOf("onToolCallCancellation", inboundStart));
const testStart = src.indexOf("onToolCall: async (toolCall) => {", inboundStart + 1);
const testPath = src.slice(testStart, src.indexOf("onTranscriptIn", testStart));

const CHECK = "await applyBookingPrecheck(session, toolCall, {";
/** Every pre-check call in the inbound handler, in source order: the name-correction branch's, then the main write path's. */
const inboundChecks = [];
for (let i = inbound.indexOf(CHECK); i >= 0; i = inbound.indexOf(CHECK, i + 1)) inboundChecks.push(i);
const [correctionCheck, mainCheck] = inboundChecks;

describe("SCRUM-593: booking pre-check wiring", () => {
  it("imports the module", () => {
    assert.match(src, /const \{ applyBookingPrecheck \} = require\("\.\/lib\/booking-precheck"\);/);
  });

  it("inbound: one check for the main write path and one for the RebookGuard's name-correction branch", () => {
    assert.equal(inboundChecks.length, 2, "name-correction branch + main write path");
  });

  it("inbound: the main check runs after the owner return and the RebookGuard, before rememberDetails and the write", () => {
    const call = mainCheck;
    assert.ok(call > 0, "inbound handler calls applyBookingPrecheck");
    assert.ok(inbound.indexOf("runOwnerToolCall(") < call, "owner calls return first");
    assert.ok(inbound.indexOf("DUPLICATE_REBOOK_MESSAGE") < call, "after the RebookGuard");
    assert.ok(call < inbound.indexOf("session.rememberDetails(toolCall.name, toolCall.args)"), "before details are remembered");
    assert.ok(call < inbound.indexOf("result = await executeToolCall(toolCall.name"), "before the write");
    assert.match(inbound.slice(call), /pendingUser: pendingUserTranscript,\s*pendingAi: pendingAiTranscript,\s*promptConfig: context\?\.assistant\?\.promptConfig,\s*audit: true,/);
    assert.match(inbound, /if \(!session\) return \{ message: "" \};\s*if \(precheckHold\) return precheckHold;/);
  });

  // The name fix is a write too: a re-book with a corrected surname is answered inside the
  // RebookGuard, so it never reaches the main check below it.
  it("inbound: the name-correction branch is checked before its attendee write, and does not reopen the end_call funnel", () => {
    const branch = inbound.indexOf('verdict.kind === "name-correction"');
    const attendeeWrite = inbound.indexOf('executeToolCall("update_appointment_attendee"');
    assert.ok(branch > 0 && attendeeWrite > branch, "found the name-correction branch and its attendee write");
    assert.ok(correctionCheck > branch && correctionCheck < attendeeWrite, "the check sits inside the branch, before the attendee write");
    assert.ok(inbound.indexOf("runOwnerToolCall(") < correctionCheck, "owner calls return first");
    const block = inbound.slice(correctionCheck, attendeeWrite);
    // audit:false — a booking already stands. An audited hold would read to hasUnfinishedBooking as an
    // unresolved funnel step (a successful fix is "book_appointment_corrected", not a resolve), and the
    // caller would be told at end_call that they have NO appointment.
    assert.match(block, /pendingUser: pendingUserTranscript,\s*pendingAi: pendingAiTranscript,\s*promptConfig: context\?\.assistant\?\.promptConfig,\s*audit: false,/);
    assert.match(block, /if \(!session\) return \{ message: "" \};\s*if \(correctionHold\) return correctionHold;/);
  });

  it("inbound: the goodbye auto-end stays off while either check runs", () => {
    for (const [label, call] of [["name-correction", correctionCheck], ["main", mainCheck]]) {
      assert.ok(call > 0, `${label}: inbound handler calls applyBookingPrecheck`);
      const before = inbound.slice(Math.max(0, call - 400), call);
      assert.match(before, /if \(session\) session\._toolCallInFlight = true;/, `${label}: flag on before the check`);
      assert.match(inbound.slice(call, call + 600), /finally \{\s*if \(session\) session\._toolCallInFlight = false;/, `${label}: flag off in a finally`);
    }
  });

  it("inbound: a successful write — or a successful name fix — resets that tool's hold count", () => {
    assert.match(inbound, /if \(successful\) session\.precheckHolds\?\.delete\(toolCall\.name\);/);
    assert.match(inbound, /if \(correctionOk\) \{\s*session\.precheckHolds\?\.delete\(toolCall\.name\);/);
  });

  it("/ws/test: runs before the write, without auditing", () => {
    const call = testPath.indexOf("await applyBookingPrecheck(session, toolCall, {");
    assert.ok(call > 0, "test handler calls applyBookingPrecheck");
    assert.ok(call < testPath.indexOf("session.rememberDetails(toolCall.name, toolCall.args)"), "before details are remembered");
    assert.ok(call < testPath.indexOf("executeToolCall(toolCall.name"), "before the write");
    assert.match(testPath, /pendingUser: pendingUserTranscript,\s*pendingAi: pendingAiTranscript,\s*promptConfig: context\?\.assistant\?\.promptConfig,\s*audit: false,/);
    assert.match(testPath, /if \(!session\) return \{ message: "" \};\s*if \(precheckHold\) return precheckHold;/);
  });

  it("/ws/test: a successful write resets that tool's hold count, after the write (parity with production)", () => {
    const write = testPath.indexOf("executeToolCall(toolCall.name");
    const reset = testPath.indexOf("session?.precheckHolds?.delete(toolCall.name)");
    assert.ok(write > 0 && reset > write, "the reset comes after the write");
    assert.match(testPath, /if \(!\(typeof result === "object" && \(result\?\.error \|\| result\?\.success === false\)\)\) session\?\.precheckHolds\?\.delete\(toolCall\.name\);/);
  });

  it("the Tier-2 call site passes the business timezone", () => {
    assert.match(src, /spokenResponse: aiTurnText,\s*timezone: session\.organization\?\.timezone \|\| "Australia\/Sydney",/);
  });
});

describe("SCRUM-593: CallSession", () => {
  it("starts every call with an empty hold map", () => {
    const { CallSession } = require("../call-session");
    const s = new CallSession("CAtest");
    assert.ok(s.precheckHolds instanceof Map);
    assert.equal(s.precheckHolds.size, 0);
  });
});

// ─── Run for real ────────────────────────────────────────────────────────────
// server.js can't be required (live env + a bound port), so the REAL text of each
// handler is evaluated against stubs — the technique server-owner-mode-wiring.test.js
// uses. The evaluated text is this repo's own checked-in server.js, read from disk
// (never external input). `session` is a mutable binding inside it, so killSession()
// is cleanup running while the check is still awaiting Claude: the handler must
// then write nothing and return { message: "" }.

const { CallSession } = require("../call-session");
const { bookingKey, normalizeDatetime } = require("../lib/booking-key");
const { classifyRebookAttempt, DUPLICATE_REBOOK_MESSAGE, CORRECTION_ERROR_MESSAGE, CANCEL_NUDGE } = require("../lib/rebook-correction");
const { RESCHEDULE_SUCCESS_SIGNAL, applyRescheduleToLedger } = require("../lib/reschedule-ledger");
const { applyBookingPrecheck } = require("../lib/booking-precheck");

const SAVED_ENV = { key: process.env.ANTHROPIC_API_KEY, mode: process.env.PRECHECK_MODE };
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };

/** The glue and the module log through the global console; keep a run quiet. */
function arrange() {
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.PRECHECK_MODE;
  console.log = console.warn = console.error = () => {};
  allow(); // never reach the real network, whatever a test forgets to stub
}
function restore() {
  for (const [name, v] of [["ANTHROPIC_API_KEY", SAVED_ENV.key], ["PRECHECK_MODE", SAVED_ENV.mode]]) {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
}

const verdictReply = (verdict, problem) => ({
  ok: true,
  status: 200,
  json: async () => ({ content: [{ type: "text", text: JSON.stringify({ verdict, problem }) }], stop_reason: "end_turn" }),
});
/** Stubs Claude with one verdict; `seen` records every request. */
function stubClaude(verdict, problem) {
  const seen = { calls: 0, prompts: /** @type {string[]} */ ([]) };
  globalThis.fetch = async (_url, init) => {
    seen.calls++;
    seen.prompts.push(JSON.parse(init.body).messages[0].content);
    return verdictReply(verdict, problem);
  };
  return seen;
}
const allow = () => stubClaude("allow", "none");
const hold = (problem = "name_unconfirmed") => stubClaude("fix", problem);
/**
 * Claude, held open: look at the handler while the check is in flight, then release().
 * asked(pending) waits until the handler has asked Claude — and FAILS, rather than hangs, if the
 * handler finishes without ever asking (a check that was removed or bypassed).
 */
function gatedClaude(verdict = "allow", problem = "none") {
  let release = () => {};
  let arrived = () => {};
  const started = new Promise((resolve) => { arrived = resolve; });
  globalThis.fetch = () => new Promise((resolve) => {
    release = () => resolve(verdictReply(verdict, problem));
    arrived();
  });
  return {
    release: () => release(),
    async asked(pending) {
      const first = await Promise.race([started.then(() => "asked"), pending.then(() => "finished", () => "finished")]);
      assert.equal(first, "asked", "the handler finished without asking Claude");
    },
  };
}

function recordingConsole(lines) {
  const rec = (...a) => lines.push(a.join(" "));
  return { log: rec, info: rec, warn: rec, error: rec, debug: rec };
}
const fakeSentry = {
  withScope: (fn) => fn({ setTag() {}, setExtras() {}, setExtra() {}, setLevel() {} }),
  captureMessage() {},
  captureException() {},
};

/** Evaluates server.js text as an object literal of callbacks. */
function evalCallbacks(code, scope, session) {
  const params = Object.keys(scope);
  const body = `let session = __session;\nconst cbs = {\n${code}\n};\nreturn { cbs, killSession: () => { session = null; } };`;
  return new Function(...params, "__session", body)(...params.map((p) => scope[p]), session);
}

const NAME_METHOD_CONTEXT = { assistant: { promptConfig: { fields: [{ id: "first_name", verification: "spell-out" }] } } };

/** The production inbound handler's callbacks (onAudio … up to onError). */
function inboundHandlers(session, o = {}) {
  const calls = [];
  const lines = [];
  const from = src.indexOf("onAudio: (twilioBase64) => {");
  const to = src.indexOf("onError: (err) => {", from);
  assert.ok(from > 0 && to > from, "the inbound callbacks are in server.js");
  const scope = {
    twilioWs: { readyState: 1, send() {}, close: (...a) => calls.push(["twilio.close", ...a]) },
    WebSocket: { OPEN: 1 },
    logToolCall() {},
    runOwnerToolCall: o.runOwnerToolCall || (async () => { throw new Error("the owner path must not run"); }),
    executeToolCall: o.executeToolCall || (async (name, args) => { calls.push(["executeToolCall", name, args]); return { message: "ok" }; }),
    scheduleCache: { invalidate() {}, applyDelta() {} },
    Sentry: fakeSentry,
    bookingKey, classifyRebookAttempt, CORRECTION_ERROR_MESSAGE, DUPLICATE_REBOOK_MESSAGE, normalizeDatetime,
    RESCHEDULE_SUCCESS_SIGNAL, applyRescheduleToLedger, CANCEL_NUDGE,
    logTranscript() {},
    pendingUserTranscript: "",
    pendingAiTranscript: "",
    detectPhantomAction: () => null,
    validateToolResponse: async () => ({ accurate: true }),
    DEBUG_TRANSCRIPTS: false,
    noteAssistantSpeech() {}, noteAssistantTurnEnd() {}, noteOwnerSpeech() {}, noteCancelledOwnerToolCalls() {},
    applyBookingPrecheck: o.applyBookingPrecheck || applyBookingPrecheck,
    context: NAME_METHOD_CONTEXT,
    console: recordingConsole(lines),
  };
  const h = evalCallbacks(src.slice(from, to), scope, session);
  const written = () => calls.filter((c) => c[0] === "executeToolCall").map((c) => c[1]);
  return { ...h, calls, lines, written };
}

/** The /ws/test handler's onToolCall (up to onTranscriptIn). */
function testPathHandlers(session, o = {}) {
  const calls = [];
  const first = src.indexOf("onToolCall: async (toolCall) => {");
  const from = src.indexOf("onToolCall: async (toolCall) => {", first + 1);
  const to = src.indexOf("onTranscriptIn", from);
  assert.ok(from > first && to > from, "the /ws/test onToolCall is in server.js");
  const scope = {
    logToolCall() {},
    executeToolCall: o.executeToolCall || (async (name) => { calls.push(["executeToolCall", name]); return { message: "simulated ok" }; }),
    applyBookingPrecheck: o.applyBookingPrecheck || applyBookingPrecheck,
    context: NAME_METHOD_CONTEXT,
    pendingUserTranscript: "yes, that is right",
    pendingAiTranscript: "one moment",
    console: recordingConsole([]),
  };
  const h = evalCallbacks(src.slice(from, to), scope, session);
  const written = () => calls.filter((c) => c[0] === "executeToolCall").map((c) => c[1]);
  return { ...h, calls, written };
}

function makeSession() {
  const s = new CallSession("CAhandler");
  s.organizationId = "org-1";
  s.assistantId = "asst-1";
  s.callRecordId = "call-1";
  s.callerPhone = "+61400000001";
  s.organization = { timezone: "Australia/Sydney" };
  s.messages.push({ role: "user", content: "Can I book a plumber for Tuesday at 3pm?" });
  return s;
}

const WHEN = "2026-10-20T15:00:00";
const BOOK = { name: "book_appointment", args: { first_name: "John", last_name: "Makhoul", datetime: WHEN, phone: "+61400000001" } };
const END = { name: "end_call", args: { reason: "caller_finished" } }; // a reason that does not mention a booking, so only the tool funnel can block it
const BOOKED = { message: "Booked. Your confirmation code is 123456. You're all set.", success: true };

/** A session whose call already booked "John Makhlul" (the misheard surname) a minute ago. */
function withConfirmedBooking(s) {
  const first = { first_name: "John", last_name: "Makhlul", datetime: WHEN };
  s.confirmedBookings = new Map([[bookingKey(first), { code: "123456", datetime: WHEN, name: "John Makhlul", at: Date.now() - 60000 }]]);
  s.toolCallAudit.push({ name: "book_appointment", successful: true, at: Date.now() - 60000, dt: normalizeDatetime(WHEN), code: "123456" });
  return s;
}

describe("SCRUM-593: the real inbound handler, run against stubs", () => {
  beforeEach(arrange);
  afterEach(restore);

  it("a hold writes nothing, hands Gemini the hold text, and is audited under the tool's own name", async () => {
    hold("name_unconfirmed");
    const s = makeSession();
    const h = inboundHandlers(s);
    const ret = await h.cbs.onToolCall({ id: "t1", ...BOOK });
    assert.match(ret.message, /^NOT DONE YET — nothing was saved\. Read back the name/);
    assert.match(ret.message, /Then call book_appointment again with the confirmed details\.$/);
    assert.deepEqual(h.written(), [], "no write on a hold");
    assert.deepEqual(s.toolCallAudit.map((t) => [t.name, t.successful, t.precheckHold]), [["book_appointment", false, true]]);
    assert.equal(s.precheckHolds.get("book_appointment"), 1);
    assert.equal(s._toolCallInFlight, false);
  });

  // CallSession#rememberDetails ignores book_appointment (its attendee may be a third party) but keeps the
  // name/phone/email of a reschedule, so a reschedule is what shows whether a hold remembered anything.
  it("a hold remembers nothing from the held call; an allowed call is remembered (control)", async () => {
    const call = { name: "reschedule_appointment", args: { name: "John Makhoul", phone: "+61400000001", new_datetime: "2026-10-21T10:00:00", current_datetime: WHEN } };
    hold("date_mismatch");
    const held = makeSession();
    await inboundHandlers(held).cbs.onToolCall({ id: "t1", ...call });
    assert.deepEqual(held.getCollectedDetails(), {}, "held details are not carried forward as the caller's own");

    allow();
    const allowed = makeSession();
    await inboundHandlers(allowed).cbs.onToolCall({ id: "t2", ...call });
    assert.deepEqual(allowed.getCollectedDetails(), { name: "John Makhoul", phone: "+61400000001" });
  });

  it("a hold is not a booking failure: no loop-cap count, no armed Tier-2 validator, nothing in the ledger", async () => {
    hold("date_mismatch");
    const s = makeSession();
    const h = inboundHandlers(s);
    await h.cbs.onToolCall({ id: "t1", ...BOOK });
    await h.cbs.onToolCall({ id: "t2", name: "reschedule_appointment", args: { new_datetime: "2026-10-21T10:00:00", current_datetime: WHEN } });
    assert.equal(s.bookRejectionCount, 0);
    assert.equal(s.rescheduleRetryCount, 0);
    assert.ok(!s._lastToolResult, "the validator is not armed with the hold text");
    assert.equal(s.confirmedBookings?.size ?? 0, 0);
    assert.deepEqual(h.written(), []);
  });

  it("end_call after a held booking still gets the CANNOT END CALL YET nudge (and does not without one)", async () => {
    allow();
    const clean = inboundHandlers(makeSession());
    await clean.cbs.onToolCall({ id: "e0", ...END });
    assert.deepEqual(clean.written(), ["end_call"], "control: with no booking in play the call may end");

    hold("name_unconfirmed");
    const s = makeSession();
    const h = inboundHandlers(s);
    await h.cbs.onToolCall({ id: "b1", ...BOOK });
    const end = await h.cbs.onToolCall({ id: "e1", ...END });
    assert.match(end.message, /^CANNOT END CALL YET/, "the hold's audit entry keeps the booking funnel open");
    assert.deepEqual(h.written(), [], "end_call was not executed");
  });

  it("a successful write clears that tool's hold count; a failed or unconfirmed write keeps it", async () => {
    const holdsAfter = async (call, result, prior = { book_appointment: 1 }) => {
      allow();
      const s = makeSession();
      s.confirmedBookings = new Map();
      for (const [tool, n] of Object.entries(prior)) s.precheckHolds.set(tool, n);
      const h = inboundHandlers(s, { executeToolCall: async (name) => { h.calls.push(["executeToolCall", name]); return result; } });
      await h.cbs.onToolCall({ id: "t", ...call });
      assert.deepEqual(h.written(), [call.name], "the write happened");
      return Object.fromEntries(s.precheckHolds);
    };
    assert.deepEqual(await holdsAfter(BOOK, BOOKED), {}, "a confirmed booking resets its count");
    assert.deepEqual(await holdsAfter(BOOK, { message: "Sorry, that time is no longer available.", success: false }), { book_appointment: 1 }, "a failed write keeps it");
    assert.deepEqual(await holdsAfter(BOOK, { message: "boom", error: "internal" }), { book_appointment: 1 }, "an errored write keeps it");
    assert.deepEqual(await holdsAfter(BOOK, { message: "OK" }), { book_appointment: 1 }, "a booking with no confirmation in its result is not a success");
    const reschedule = { name: "reschedule_appointment", args: { new_datetime: "2026-10-21T10:00:00", current_datetime: WHEN } };
    assert.deepEqual(
      await holdsAfter(reschedule, { message: "All done, moved it.", success: true }, { book_appointment: 1, reschedule_appointment: 2 }),
      { book_appointment: 1 },
      "a success clears ITS tool's count and no other"
    );
  });

  describe("the RebookGuard's name-correction branch", () => {
    const CORRECTED = { message: "NAME CORRECTED: John Makhoul", success: true };

    it("is held when the pre-check holds: no attendee update, the old name stays, and the standing booking is not reopened", async () => {
      hold("name_unconfirmed");
      const s = withConfirmedBooking(makeSession());
      const h = inboundHandlers(s);
      const ret = await h.cbs.onToolCall({ id: "t1", ...BOOK });
      assert.match(ret.message, /^NOT DONE YET — nothing was saved\./);
      assert.deepEqual(h.written(), [], "no attendee update");
      assert.equal([...s.confirmedBookings.values()][0].name, "John Makhlul", "the ledger keeps the old name");
      assert.equal(s.precheckHolds.get("book_appointment"), 1);
      assert.equal(s._toolCallInFlight, false);
      assert.deepEqual(s.toolCallAudit.map((t) => t.name), ["book_appointment"], "only the original booking: a held fix adds no funnel step");
      assert.equal(s.hasUnfinishedBooking(END.args.reason), false, "the booking that stands is still a finished one");
      assert.ok(!h.lines.some((l) => l.includes("updating attendee in place")), "no 'updating' log for a fix that was held");
    });

    it("goes through once the pre-check allows it: the attendee is updated, the hold count clears, and the call may end", async () => {
      hold("name_unconfirmed");
      const s = withConfirmedBooking(makeSession());
      const h = inboundHandlers(s, { executeToolCall: async (name, args) => { h.calls.push(["executeToolCall", name, args]); return CORRECTED; } });
      await h.cbs.onToolCall({ id: "t1", ...BOOK });
      assert.equal(s.precheckHolds.get("book_appointment"), 1);

      s.precheckHolds.set("reschedule_appointment", 1); // another tool's count must survive the reset
      allow(); // the caller confirmed the spelling
      const ret = await h.cbs.onToolCall({ id: "t2", ...BOOK });
      assert.equal(ret.message, CORRECTED.message);
      const writes = h.calls.filter((c) => c[0] === "executeToolCall");
      assert.deepEqual(writes.map((c) => c[1]), ["update_appointment_attendee"]);
      assert.deepEqual(writes[0][2], { datetime: WHEN, first_name: "John", last_name: "Makhoul" });
      assert.equal([...s.confirmedBookings.values()][0].name, "John Makhoul");
      assert.deepEqual(Object.fromEntries(s.precheckHolds), { reschedule_appointment: 1 }, "a confirmed fix resets ITS tool's count, as a confirmed booking does, and no other");
      assert.equal(s.toolCallAudit.at(-1).name, "book_appointment_corrected");

      await h.cbs.onToolCall({ id: "t3", ...END });
      assert.deepEqual(h.written(), ["update_appointment_attendee", "end_call"], "the call may end: nothing is left unfinished");
    });

    it("is handed the live pending turn and the assistant's name method, like the main check", async () => {
      const claude = hold("name_unconfirmed");
      const s = withConfirmedBooking(makeSession());
      const h = inboundHandlers(s);
      h.cbs.onTranscriptIn("Yes, Makhoul, with an O.");
      h.cbs.onTranscriptOut("Let me fix that for you.");
      await h.cbs.onToolCall({ id: "t1", ...BOOK });
      assert.equal(claude.calls, 1);
      assert.match(claude.prompts[0], /CALLER: Yes, Makhoul, with an O\.\nAI: Let me fix that for you\.$/m, "the turn still in progress");
      assert.match(claude.prompts[0], /spelled it back letter by letter/, "the assistant's name-confirmation method");
    });

    it("a failed fix keeps the hold count", async () => {
      allow();
      const s = withConfirmedBooking(makeSession());
      s.precheckHolds.set("book_appointment", 1);
      const h = inboundHandlers(s, { executeToolCall: async () => ({ message: "CORRECTION FAILED (internal error)." }) });
      await h.cbs.onToolCall({ id: "t1", ...BOOK });
      assert.equal(s.precheckHolds.get("book_appointment"), 1);
      assert.equal([...s.confirmedBookings.values()][0].name, "John Makhlul");
    });

    it("keeps the flag on while the check runs, then clears it", async () => {
      const claude = gatedClaude();
      const s = withConfirmedBooking(makeSession());
      const h = inboundHandlers(s);
      const pending = h.cbs.onToolCall({ id: "t1", ...BOOK });
      await claude.asked(pending);
      assert.equal(s._toolCallInFlight, true, "in flight while Claude is being asked");
      for (let i = 0; i < 3; i++) { h.cbs.onAudio("AAAA"); h.cbs.onTranscriptOut("Goodbye, have a great day!"); h.cbs.onTurnComplete(); }
      assert.ok(h.lines.some((l) => l.includes("[GoodbyeLoop] Skipping auto-end — tool call in flight")), h.lines.join("\n"));
      assert.deepEqual(h.calls.filter((c) => c[0] === "twilio.close"), [], "the call was not closed mid-check");
      claude.release();
      await pending;
      assert.equal(s._toolCallInFlight, false);
    });

    it("writes nothing if the session is torn down during the check", async () => {
      allow();
      const s = withConfirmedBooking(makeSession());
      const h = inboundHandlers(s, { applyBookingPrecheck: async (...a) => { const r = await applyBookingPrecheck(...a); h.killSession(); return r; } });
      const ret = await h.cbs.onToolCall({ id: "t1", ...BOOK });
      assert.deepEqual(ret, { message: "" });
      assert.deepEqual(h.written(), []);
    });

    it("clears the flag even if the glue throws", async () => {
      const s = withConfirmedBooking(makeSession());
      const h = inboundHandlers(s, { applyBookingPrecheck: async () => { throw new Error("boom"); } });
      await assert.rejects(h.cbs.onToolCall({ id: "t1", ...BOOK }), /boom/);
      assert.equal(s._toolCallInFlight, false);
    });

    it("a true duplicate (same surname) is still refused without asking Claude", async () => {
      const claude = hold();
      const s = withConfirmedBooking(makeSession());
      const h = inboundHandlers(s);
      const ret = await h.cbs.onToolCall({ id: "t1", name: "book_appointment", args: { ...BOOK.args, last_name: "Makhlul" } });
      assert.equal(ret.message, DUPLICATE_REBOOK_MESSAGE);
      assert.equal(claude.calls, 0);
      assert.deepEqual(h.written(), []);
    });
  });

  it("the main check keeps the flag on while it runs (the goodbye-loop auto-end is held off), then clears it", async () => {
    const claude = gatedClaude();
    const s = makeSession();
    const h = inboundHandlers(s);
    const pending = h.cbs.onToolCall({ id: "t1", ...BOOK });
    await claude.asked(pending);
    assert.equal(s._toolCallInFlight, true, "in flight while Claude is being asked");
    for (let i = 0; i < 3; i++) { h.cbs.onAudio("AAAA"); h.cbs.onTranscriptOut("Goodbye, have a great day!"); h.cbs.onTurnComplete(); }
    assert.ok(h.lines.some((l) => l.includes("[GoodbyeLoop] Skipping auto-end — tool call in flight")), h.lines.join("\n"));
    assert.deepEqual(h.calls.filter((c) => c[0] === "twilio.close"), [], "the call was not closed mid-check");
    claude.release();
    await pending;
    assert.equal(s._toolCallInFlight, false);
  });

  it("writes nothing if the session is torn down during the main check", async () => {
    allow();
    const s = makeSession();
    const h = inboundHandlers(s, { applyBookingPrecheck: async (...a) => { const r = await applyBookingPrecheck(...a); h.killSession(); return r; } });
    const ret = await h.cbs.onToolCall({ id: "t1", ...BOOK });
    assert.deepEqual(ret, { message: "" });
    assert.deepEqual(h.written(), [], "no write after teardown");
  });

  it("clears the flag even if the glue throws", async () => {
    const s = makeSession();
    const h = inboundHandlers(s, { applyBookingPrecheck: async () => { throw new Error("boom"); } });
    await assert.rejects(h.cbs.onToolCall({ id: "t1", ...BOOK }), /boom/);
    assert.equal(s._toolCallInFlight, false);
  });

  it("hands the check the call so far, the live pending turn and the assistant's name method", async () => {
    const claude = allow();
    const s = makeSession();
    const h = inboundHandlers(s);
    h.cbs.onTranscriptIn("Yes, that is right.");
    h.cbs.onTranscriptOut("One moment, booking that now.");
    await h.cbs.onToolCall({ id: "t1", ...BOOK });
    assert.equal(claude.calls, 1);
    const prompt = claude.prompts[0];
    assert.match(prompt, /TOOL: book_appointment/);
    assert.match(prompt, /CALLER: Can I book a plumber for Tuesday at 3pm\?/, "the call so far");
    assert.match(prompt, /CALLER: Yes, that is right\.\nAI: One moment, booking that now\.$/m, "the turn still in progress");
    assert.match(prompt, /spelled it back letter by letter/, "the assistant's name-confirmation method");
    assert.deepEqual(h.written(), ["book_appointment"], "and an allow writes");
  });

  it("checks reschedule_appointment and update_appointment the same way", async () => {
    hold("date_mismatch");
    for (const call of [
      { name: "reschedule_appointment", args: { new_datetime: "2026-10-21T10:00:00", current_datetime: WHEN } },
      { name: "update_appointment", args: { first_name: "John", last_name: "Makhoul" } },
    ]) {
      const h = inboundHandlers(makeSession());
      const ret = await h.cbs.onToolCall({ id: "t", ...call });
      assert.match(ret.message, new RegExp(`Then call ${call.name} again`));
      assert.deepEqual(h.written(), []);
    }
  });

  it("never asks Claude about any other tool", async () => {
    const claude = hold();
    const s = makeSession();
    const h = inboundHandlers(s);
    await h.cbs.onToolCall({ id: "t1", name: "check_availability", args: { date: "2026-10-20" } });
    assert.equal(claude.calls, 0);
    assert.deepEqual(h.written(), ["check_availability"]);
    assert.equal(s._toolCallInFlight, false);
  });

  it("an owner call never reaches the pre-check", async () => {
    const claude = hold();
    const s = makeSession();
    s.ownerMode = true;
    let checked = 0;
    const h = inboundHandlers(s, {
      runOwnerToolCall: async () => ({ message: "owner result" }),
      applyBookingPrecheck: async () => { checked++; return { message: "held" }; },
    });
    const ret = await h.cbs.onToolCall({ id: "t1", ...BOOK });
    assert.deepEqual(ret, { message: "owner result" });
    assert.equal(checked, 0);
    assert.equal(claude.calls, 0);
  });
});

describe("SCRUM-593: the real /ws/test handler, run against stubs", () => {
  beforeEach(arrange);
  afterEach(restore);

  it("a hold writes nothing, comes back whole and is not audited", async () => {
    hold("name_unconfirmed");
    const s = makeSession();
    const h = testPathHandlers(s);
    const ret = await h.cbs.onToolCall({ id: "t1", ...BOOK });
    assert.match(ret.message, /^NOT DONE YET — nothing was saved\./);
    assert.deepEqual(h.written(), []);
    assert.deepEqual(s.toolCallAudit, []);
    assert.equal(s.precheckHolds.get("book_appointment"), 1);
  });

  it("a hold remembers nothing from the held call; an allowed call is remembered (control)", async () => {
    const call = { name: "reschedule_appointment", args: { name: "John Makhoul", phone: "+61400000001", new_datetime: "2026-10-21T10:00:00", current_datetime: WHEN } };
    hold("date_mismatch");
    const held = makeSession();
    await testPathHandlers(held).cbs.onToolCall({ id: "t1", ...call });
    assert.deepEqual(held.getCollectedDetails(), {});

    allow();
    const allowed = makeSession();
    await testPathHandlers(allowed).cbs.onToolCall({ id: "t2", ...call });
    assert.deepEqual(allowed.getCollectedDetails(), { name: "John Makhoul", phone: "+61400000001" });
  });

  it("an allow writes once, and the check saw the pending turn and the name method", async () => {
    const claude = allow();
    const s = makeSession();
    const h = testPathHandlers(s);
    const ret = await h.cbs.onToolCall({ id: "t1", ...BOOK });
    assert.deepEqual(ret, { message: "simulated ok" });
    assert.deepEqual(h.written(), ["book_appointment"]);
    assert.match(claude.prompts[0], /CALLER: yes, that is right\nAI: one moment$/m);
    assert.match(claude.prompts[0], /spelled it back letter by letter/);
  });

  it("a successful write clears that tool's hold count; a failed or errored one keeps it (parity with production)", async () => {
    const holdsAfter = async (result) => {
      allow();
      const s = makeSession();
      s.precheckHolds.set("book_appointment", 1);
      s.precheckHolds.set("reschedule_appointment", 1);
      const h = testPathHandlers(s, { executeToolCall: async () => result });
      await h.cbs.onToolCall({ id: "t", ...BOOK });
      return Object.fromEntries(s.precheckHolds);
    };
    assert.deepEqual(await holdsAfter({ message: "simulated ok" }), { reschedule_appointment: 1 }, "success clears ITS tool's count only");
    assert.deepEqual(await holdsAfter("a plain string result"), { reschedule_appointment: 1 }, "a string result is a success");
    assert.deepEqual(await holdsAfter({ message: "no longer available", success: false }), { book_appointment: 1, reschedule_appointment: 1 });
    assert.deepEqual(await holdsAfter({ message: "boom", error: "internal" }), { book_appointment: 1, reschedule_appointment: 1 });
  });

  it("writes nothing if the session is torn down during the check", async () => {
    allow();
    const s = makeSession();
    const h = testPathHandlers(s, { applyBookingPrecheck: async (...a) => { const r = await applyBookingPrecheck(...a); h.killSession(); return r; } });
    const ret = await h.cbs.onToolCall({ id: "t1", ...BOOK });
    assert.deepEqual(ret, { message: "" });
    assert.deepEqual(h.written(), []);
  });
});
