"use strict";

// SCRUM-594: lib/end-call-guard.js is the Gemini end_call booking guard
// (SCRUM-373) in shared form, for the classic pipeline's end_call hang-up.
// These pin the verdicts, the one-nudge rule, the audit entry and the alert
// levels (Grafana routes on [ALERT:warning] vs [ALERT:error]), and that the
// port is verbatim: the Gemini inline guard in server.js stays the source text.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { checkEndCallGuard, END_CALL_BLOCKED_MESSAGE } = require("../lib/end-call-guard");
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
    const start = serverSrc.indexOf('if (toolCall.name === "end_call" && session.hasUnfinishedBooking(toolCall.args?.reason)) {');
    const end = serverSrc.indexOf("// SCRUM-372: cancel-confirmation gate", start);
    assert.ok(start > 0 && end > start, "the Gemini inline guard is still in server.js");
    const gemini = serverSrc.slice(start, end);
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
});
