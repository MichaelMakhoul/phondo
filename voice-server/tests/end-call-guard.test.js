"use strict";

// SCRUM-594: lib/end-call-guard.js is the Gemini end_call booking guard
// (SCRUM-373) in shared form, for the classic pipeline's end_call hang-up.
// These pin the verdicts, the one-nudge rule, the audit entry and the alert
// levels (Grafana routes on [ALERT:warning] vs [ALERT:error]), and that the
// port is verbatim: the Gemini inline guard in server.js stays the source text.
// One deliberate difference (phone test F1): after a failed reschedule the nudge
// is PR #442's text, which #442 also brings to the Gemini guard on develop.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { checkEndCallGuard, END_CALL_BLOCKED_MESSAGE, END_CALL_BLOCKED_RESCHEDULE_MESSAGE, END_CALL_BLOCKED_KEPT_MESSAGE, END_CALL_BLOCKED_NOTHING_NEW_MESSAGE } = require("../lib/end-call-guard");
const { CallSession } = require("../call-session");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

/** Every console line written during the test (the Sentry shim logs through console). */
function captureConsole(t) {
  const lines = [];
  for (const m of ["log", "warn", "error"]) t.mock.method(console, m, (...a) => lines.push(`${m}| ${a.join(" ")}`));
  return lines;
}
function session(audit = []) {
  const s = new CallSession("CA-guard");
  s.toolCallAudit.push(...audit);
  return s;
}
const FUNNEL = { name: "check_availability", successful: true, at: 1 };
/** The Gemini inline guard: server.js's end_call branch of onToolCall. */
function geminiGuardSrc() {
  const start = serverSrc.indexOf('if (toolCall.name === "end_call" && session.hasUnfinishedBooking(toolCall.args?.reason)) {');
  const end = serverSrc.indexOf("// SCRUM-372: cancel-confirmation gate", start);
  assert.ok(start > 0 && end > start, "the Gemini inline guard is still in server.js");
  return serverSrc.slice(start, end);
}

describe("SCRUM-594: checkEndCallGuard", () => {
  it("lets a call with no booking flow end — no audit entry, no alert", (t) => {
    const lines = captureConsole(t);
    const s = session([{ name: "schedule_callback", successful: true, at: 1 }]);
    assert.deepEqual(checkEndCallGuard(s, "message captured"), { allow: true });
    assert.deepEqual(checkEndCallGuard(session(), undefined), { allow: true });
    assert.equal(s.toolCallAudit.length, 1);
    assert.deepEqual(lines, []);
  });

  it("lets a call whose booking went through end", (t) => {
    const lines = captureConsole(t);
    const s = session([FUNNEL, { name: "book_appointment", successful: true, at: 2 }]);
    assert.deepEqual(checkEndCallGuard(s, "booking_complete"), { allow: true });
    assert.deepEqual(lines, []);
  });

  it("blocks the FIRST end_call on an unfinished booking: the nudge text, an audit entry and a warning alert", (t) => {
    const lines = captureConsole(t);
    const s = session([FUNNEL]);
    const before = Date.now();
    const verdict = checkEndCallGuard(s, "booking_complete");
    assert.deepEqual(verdict, { allow: false, message: END_CALL_BLOCKED_MESSAGE });
    assert.match(verdict.message, /^CANNOT END CALL YET: a booking was started but book_appointment never returned success/);
    const entry = s.toolCallAudit.at(-1);
    assert.deepEqual({ ...entry, at: 0 }, { name: "end_call_blocked", successful: false, at: 0 });
    assert.ok(entry.at >= before && entry.at <= Date.now(), "stamped with the wall clock, like every audit entry");
    assert.deepEqual(lines, [
      'error| [HallucinationGuard] Blocking end_call — booking started but no successful book_appointment. callSid=CA-guard reason="booking_complete"',
      "warn| [ALERT:warning] [hallucination_guard] end_call blocked — unfinished booking (language-agnostic) | service=hallucination_guard callSid=CA-guard endCallReason=booking_complete",
    ]);
  });

  it("nudges ONCE: the next end_call is allowed, but pages at error level", (t) => {
    const lines = captureConsole(t);
    const s = session([FUNNEL]);
    assert.equal(checkEndCallGuard(s, "caller_left").allow, false);
    lines.length = 0;
    assert.deepEqual(checkEndCallGuard(s, "caller_left"), { allow: true });
    assert.deepEqual(checkEndCallGuard(s, ""), { allow: true }, "and every one after it");
    assert.equal(s.toolCallAudit.filter((e) => e.name === "end_call_blocked").length, 1, "one nudge, one audit entry");
    assert.deepEqual(lines.slice(0, 2), [
      "error| [HallucinationGuard] Allowing end_call on unfinished booking AFTER a prior nudge. callSid=CA-guard",
      "error| [ALERT:error] [hallucination_guard] end_call allowed on unfinished booking after nudge | service=hallucination_guard callSid=CA-guard endCallReason=caller_left",
    ]);
  });

  it("a reason that claims a booking when nothing was ever booked is blocked even without a booking flow", (t) => {
    captureConsole(t);
    assert.equal(checkEndCallGuard(session(), "booked the appointment").allow, false);
    assert.equal(checkEndCallGuard(session(), "reschedule_done").allow, false);
    assert.equal(checkEndCallGuard(session(), "cancelled").allow, true);
  });

  it("a nudge from an earlier turn still counts (it is read from the call's audit)", (t) => {
    captureConsole(t);
    const s = session([FUNNEL, { name: "end_call_blocked", successful: false, at: 2 }]);
    assert.deepEqual(checkEndCallGuard(s, "x"), { allow: true });
  });

  it("is the Gemini guard verbatim: same nudge text, log lines and alert texts and levels", () => {
    const gemini = geminiGuardSrc();
    const guardSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "end-call-guard.js"), "utf8");
    assert.ok(gemini.includes(JSON.stringify(END_CALL_BLOCKED_MESSAGE)), "the nudge text drifted from the Gemini guard's");
    for (const text of [
      'Sentry.captureMessage("end_call blocked — unfinished booking (language-agnostic)", "warning");',
      'Sentry.captureMessage("end_call allowed on unfinished booking after nudge", "error");',
      'scope.setTag("service", "hallucination_guard");',
      '{ name: "end_call_blocked", successful: false, at: Date.now() }',
      "[HallucinationGuard] Blocking end_call — booking started but no successful book_appointment.",
      "[HallucinationGuard] Allowing end_call on unfinished booking AFTER a prior nudge.",
    ]) {
      assert.ok(gemini.includes(text), `the Gemini guard no longer says: ${text}`);
      assert.ok(guardSrc.includes(text), `lib/end-call-guard.js does not say: ${text}`);
    }
    assert.doesNotMatch(guardSrc, /setReasonTag|setTag\("reason"/, "no reason tag: the server.js census pins 3 reason-tagged sites, and the Gemini guard has none");
  });

  it("after a failed reschedule: PR #442's text (a deliberate divergence from this branch's Gemini guard until #442 lands)", () => {
    // Phone test F1: the owner's first fast-path call. The AI booked 9:30, a reschedule
    // to 10:30 failed, and the nudge's "the caller has NO appointment" had it tell the
    // caller there was no appointment on the system. Word for word #442's text.
    assert.equal(
      END_CALL_BLOCKED_RESCHEDULE_MESSAGE,
      "CANNOT END CALL YET: the appointment change was NOT completed — the caller's existing appointment is unchanged. Either call reschedule_appointment again with the confirmed details, or tell the caller — in their language — that you couldn't change it and call schedule_callback to take a message. Only call end_call AFTER one of those succeeds.",
    );
    const gemini = geminiGuardSrc();
    if (gemini.includes("session.lastFunnelStep()")) {
      // #442 has landed (it words the Gemini guard by lastFunnelStep): the two agree again.
      assert.ok(gemini.includes(JSON.stringify(END_CALL_BLOCKED_RESCHEDULE_MESSAGE)), "the reschedule nudge drifted from the Gemini guard's");
    } else {
      // Until then, the Gemini guard here still says NO appointment after a failed reschedule.
      assert.ok(!gemini.includes("the appointment change was NOT completed"), "a reschedule wording without lastFunnelStep: update this test");
    }
  });
});

describe("phone test F1: the nudge says what is still open", () => {
  const book = (at, successful = false) => ({ name: "book_appointment", successful, at });
  const move = (at, successful = false) => ({ name: "reschedule_appointment", successful, at });
  const look = (at) => ({ name: "check_availability", successful: true, at });

  it("book, then a failed reschedule: the existing appointment is unchanged, never 'NO appointment'", (t) => {
    const lines = captureConsole(t);
    const s = session([look(1), book(2, true), move(3)]);
    const verdict = checkEndCallGuard(s, "caller_done");
    assert.deepEqual(verdict, { allow: false, message: END_CALL_BLOCKED_RESCHEDULE_MESSAGE });
    assert.doesNotMatch(verdict.message, /NO appointment/);
    assert.equal(s.toolCallAudit.at(-1).name, "end_call_blocked", "the same audit entry");
    assert.equal(lines.length, 2, "the same log line and warning alert");
    assert.match(lines[1], /^warn\| \[ALERT:warning\] \[hallucination_guard\] end_call blocked/);
  });

  it("a failed book: the book text", (t) => {
    captureConsole(t);
    assert.deepEqual(checkEndCallGuard(session([look(1), book(2)]), "booking_complete"), { allow: false, message: END_CALL_BLOCKED_MESSAGE });
  });

  it("the latest unresolved write decides, by time: an availability check after a failed reschedule does not hide it", (t) => {
    captureConsole(t);
    assert.equal(checkEndCallGuard(session([book(1, true), move(2), look(3)]), "x").message, END_CALL_BLOCKED_RESCHEDULE_MESSAGE);
    assert.equal(checkEndCallGuard(session([move(1), book(2)]), "x").message, END_CALL_BLOCKED_MESSAGE);
    assert.equal(checkEndCallGuard(session([book(2), move(3)]), "x").message, END_CALL_BLOCKED_RESCHEDULE_MESSAGE);
  });

  // Ported from #442 (tests/server-booking-precheck-wiring.test.js), which adds the same method.
  describe("CallSession.lastFunnelStep: the write an unfinished booking funnel is waiting on", () => {
    const step = (audit) => {
      const s = new CallSession("CAtest");
      s.toolCallAudit = audit;
      return s.lastFunnelStep();
    };

    it("null with no booking write at all, or only availability checks", () => {
      assert.equal(step([]), null);
      assert.equal(step([look(1), look(2)]), null);
    });

    it("the most recent unresolved write, by time", () => {
      assert.equal(step([look(1), book(2)]), "book_appointment");
      assert.equal(step([book(1), move(2)]), "reschedule_appointment");
      assert.equal(step([move(1), book(2)]), "book_appointment");
      assert.equal(step([move(2), book(1)]), "reschedule_appointment", "by `at`, not by array order");
    });

    it("an availability check after a held reschedule does not hide it", () => {
      assert.equal(step([move(1), look(2)]), "reschedule_appointment");
    });

    it("a held reschedule after a confirmed booking: the booking stands, the change is what is open", () => {
      assert.equal(step([book(1, true), move(2)]), "reschedule_appointment");
    });

    it("writes resolved by a later success (or a callback) are not open", () => {
      assert.equal(step([move(1), move(2, true)]), null);
      assert.equal(step([book(1), book(2, true)]), null);
      assert.equal(step([move(1), { name: "schedule_callback", successful: true, at: 2 }]), null);
    });
  });
});

describe("SCRUM-594 PHASE 2 re-review: the fast path's nudge when this call's booking still stands", () => {
  it("a held new booking while this call holds one: the nudge says the earlier booking stands, never 'NO appointment'", (t) => {
    captureConsole(t);
    const s = session([
      { name: "book_appointment", successful: true, at: 1 },
      { name: "book_appointment_held", successful: false, at: 2 }, // a spelling hold on a second booking
    ]);
    s.bookingGuards = true;
    s.confirmedBookings = new Map([["k", { datetime: "2026-10-19T09:00:00", name: "Sami Khoury", at: 1 }]]);
    const verdict = checkEndCallGuard(s, "caller finished");
    assert.equal(verdict.allow, false);
    assert.equal(verdict.message, END_CALL_BLOCKED_KEPT_MESSAGE);
    assert.match(END_CALL_BLOCKED_KEPT_MESSAGE, /earlier booking from this call still stands/);
    assert.doesNotMatch(END_CALL_BLOCKED_KEPT_MESSAGE, /NO appointment/);
  });

  it("gate review: a new booking the AI claimed on a call about the caller's own booking — the nudge says only the NEW one isn't booked", (t) => {
    captureConsole(t);
    const claimed = (guards, audit) => {
      const s = session(audit);
      s.bookingGuards = guards;
      s.addMessage("assistant", "I've booked you in for Tuesday at 2 PM.");
      return checkEndCallGuard(s, "booked Tuesday 2pm");
    };
    const FOUND = [{ name: "lookup_appointment", successful: true, found: true, at: 1 }];
    assert.deepEqual(claimed(true, FOUND), { allow: false, message: END_CALL_BLOCKED_NOTHING_NEW_MESSAGE });
    assert.doesNotMatch(END_CALL_BLOCKED_NOTHING_NEW_MESSAGE, /NO appointment/);
    assert.equal(claimed(true, []).message, END_CALL_BLOCKED_MESSAGE, "nothing about their booking: the plain wording");
    assert.equal(claimed(false, FOUND).message, END_CALL_BLOCKED_MESSAGE, "Gemini/classic: unchanged");
  });

  it("Gemini/classic (no guards) keep the old wording", (t) => {
    captureConsole(t);
    const s = session([{ name: "book_appointment", successful: true, at: 1 }, { name: "book_appointment", successful: false, at: 2 }]);
    s.confirmedBookings = new Map([["k", { datetime: "2026-10-19T09:00:00", name: "Sami Khoury", at: 1 }]]);
    assert.equal(checkEndCallGuard(s, "caller finished").message, END_CALL_BLOCKED_MESSAGE);
  });
});
