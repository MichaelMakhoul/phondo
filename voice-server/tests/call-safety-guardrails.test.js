const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CallSession } = require("../call-session");

const T0 = 1_000_000_000_000; // fixed base epoch ms for deterministic TTL tests

// SCRUM-372: cancel-confirmation gate.
describe("CallSession.confirmCancel (SCRUM-372)", () => {
  it("holds the FIRST cancel attempt (returns false)", () => {
    const s = new CallSession("c1");
    assert.equal(s.confirmCancel({ phone: "+61414141883" }, T0), false);
  });

  it("proceeds on a SECOND matching attempt within the 5-min window", () => {
    const s = new CallSession("c2");
    assert.equal(s.confirmCancel({ phone: "+61414141883" }, T0), false);
    assert.equal(s.confirmCancel({ phone: "+61414141883" }, T0 + 30_000), true);
    // consumed — a third call starts a fresh hold
    assert.equal(s.confirmCancel({ phone: "+61414141883" }, T0 + 31_000), false);
  });

  it("matches on date even when datetime varies (STT churn), collapsing to the date", () => {
    const s = new CallSession("c3");
    assert.equal(s.confirmCancel({ datetime: "2026-06-08T08:00:00" }, T0), false);
    assert.equal(s.confirmCancel({ datetime: "2026-06-08T08:15:00" }, T0 + 5_000), true);
  });

  it("confirms when the 2nd attempt ADDS a key (date-only -> phone+date share the date)", () => {
    const s = new CallSession("c3b");
    assert.equal(s.confirmCancel({ datetime: "2026-06-08T08:00:00" }, T0), false);
    assert.equal(s.confirmCancel({ phone: "+61414141883", datetime: "2026-06-08T08:00:00" }, T0 + 5_000), true);
  });

  it("does NOT proceed when the second attempt is a different appointment", () => {
    const s = new CallSession("c4");
    assert.equal(s.confirmCancel({ phone: "+61400000001" }, T0), false);
    assert.equal(s.confirmCancel({ phone: "+61400000002" }, T0 + 5_000), false); // no shared key -> new hold
  });

  it("NEVER auto-confirms an arg-less / garbled cancel (the most dangerous case)", () => {
    const s = new CallSession("c4b");
    assert.equal(s.confirmCancel({}, T0), false);
    assert.equal(s.confirmCancel({}, T0 + 1_000), false); // two arg-less calls must not match each other
    assert.equal(s.confirmCancel({ reason: "they said cancel" }, T0 + 2_000), false); // reason is not an identifier
  });

  it("does NOT proceed when the confirmation comes after the 5-min TTL", () => {
    const s = new CallSession("c5");
    assert.equal(s.confirmCancel({ phone: "+61414141883" }, T0), false);
    assert.equal(s.confirmCancel({ phone: "+61414141883" }, T0 + 5 * 60 * 1000 + 1), false); // expired -> new hold
  });
});

// SCRUM-373: language-agnostic unfinished-booking detection.
describe("CallSession.hasUnfinishedBooking (SCRUM-373)", () => {
  const withAudit = (audit, bookRejectionCount = 0) => {
    const s = new CallSession("x");
    s.toolCallAudit = audit;
    s.bookRejectionCount = bookRejectionCount;
    return s;
  };

  it("false when a book_appointment succeeded", () => {
    const s = withAudit([{ name: "book_appointment", successful: true }]);
    assert.equal(s.hasUnfinishedBooking("booking_complete"), false);
  });

  it("true when a book_appointment was attempted but never succeeded", () => {
    assert.equal(withAudit([{ name: "book_appointment", successful: false }]).hasUnfinishedBooking(), true);
    assert.equal(withAudit([{ name: "book_appointment_blocked", successful: false }]).hasUnfinishedBooking(), true);
  });

  it("true when there were rejections but no success", () => {
    assert.equal(withAudit([], 2).hasUnfinishedBooking(), true);
  });

  it("true (language-agnostic) when the end_call reason claims a booking but none succeeded", () => {
    assert.equal(withAudit([{ name: "check_availability", successful: true }]).hasUnfinishedBooking("booking_complete"), true);
  });

  it("false for an info-only call ending normally (no booking signals)", () => {
    assert.equal(withAudit([{ name: "check_availability", successful: true }]).hasUnfinishedBooking("caller finished"), false);
  });

  it("false when a callback or cancellation legitimately completed", () => {
    assert.equal(withAudit([{ name: "schedule_callback", successful: true }], 1).hasUnfinishedBooking("booking_complete"), false);
    assert.equal(withAudit([{ name: "cancel_appointment", successful: true }]).hasUnfinishedBooking("cancelled"), false);
  });

  it("false on an empty call", () => {
    assert.equal(new CallSession("y").hasUnfinishedBooking(), false);
  });
});
