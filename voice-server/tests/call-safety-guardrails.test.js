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

// SCRUM-373/377: language-agnostic, order-aware unfinished-booking detection.
describe("CallSession.hasUnfinishedBooking (SCRUM-373/377)", () => {
  const withAudit = (audit) => {
    const s = new CallSession("x");
    s.toolCallAudit = audit;
    return s;
  };

  it("false when a booking completed (check → book success)", () => {
    const s = withAudit([
      { name: "check_availability", successful: true, at: 100 },
      { name: "book_appointment", successful: true, at: 200 },
    ]);
    assert.equal(s.hasUnfinishedBooking("booking_complete"), false);
  });

  it("true when a book_appointment was attempted but never succeeded", () => {
    assert.equal(withAudit([{ name: "book_appointment", successful: false, at: 100 }]).hasUnfinishedBooking(), true);
  });

  it("false when a duplicate rebook was blocked AFTER a successful booking (booking exists)", () => {
    // SCRUM-257 rebook guard fires only after a success — must not re-flag as unfinished.
    const s = withAudit([
      { name: "book_appointment", successful: true, at: 100 },
      { name: "book_appointment_blocked", successful: false, at: 200 },
    ]);
    assert.equal(s.hasUnfinishedBooking("booking_complete"), false);
  });

  it("true when the end_call reason claims a booking but no funnel/no booking happened", () => {
    assert.equal(withAudit([]).hasUnfinishedBooking("booking_complete"), true);
    assert.equal(withAudit([]).hasUnfinishedBooking("reschedule_done"), true);
  });

  // SCRUM-377: the regression that motivated this — a reschedule where an EARLIER
  // successful cancel must NOT mask the LATER unfinished booking.
  it("true for a reschedule: cancel X succeeds, then check availability for Y, but Y never booked", () => {
    const s = withAudit([
      { name: "cancel_appointment", successful: true, at: 100 },
      { name: "check_availability", successful: true, at: 200 },
    ]);
    assert.equal(s.hasUnfinishedBooking("reschedule_complete"), true);
  });

  it("false for a reschedule that actually completed (cancel X, check Y, book Y)", () => {
    const s = withAudit([
      { name: "cancel_appointment", successful: true, at: 100 },
      { name: "check_availability", successful: true, at: 200 },
      { name: "book_appointment", successful: true, at: 300 },
    ]);
    assert.equal(s.hasUnfinishedBooking("reschedule_complete"), false);
  });

  it("false when a failed booking was resolved by a take-a-message callback", () => {
    const s = withAudit([
      { name: "book_appointment", successful: false, at: 100 },
      { name: "schedule_callback", successful: true, at: 200 },
    ]);
    assert.equal(s.hasUnfinishedBooking("message_taken"), false);
  });

  it("false for a pure cancel call (no booking funnel)", () => {
    assert.equal(withAudit([{ name: "cancel_appointment", successful: true, at: 100 }]).hasUnfinishedBooking("cancelled"), false);
    assert.equal(withAudit([{ name: "cancel_appointment", successful: true, at: 100 }]).hasUnfinishedBooking("appointment_cancelled"), false);
  });

  it("true for an availability-only call that ends without booking (nudged once, then allowed)", () => {
    // Intentional: entering the booking funnel and leaving without booking is
    // treated as unfinished so the AI offers to book / take a message once.
    assert.equal(withAudit([{ name: "check_availability", successful: true, at: 100 }]).hasUnfinishedBooking("caller finished"), true);
  });

  it("false on an empty call", () => {
    assert.equal(new CallSession("y").hasUnfinishedBooking(), false);
  });
});
