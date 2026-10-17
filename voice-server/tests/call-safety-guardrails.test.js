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

  // SCRUM-594 phone test F1 (fast path only, gate review): a failed move of a
  // booking, then the caller cancels THAT booking — nothing is left unfinished.
  const MOVE_THEN_CANCEL = () => [
    { name: "check_availability", successful: true, at: 100 },
    { name: "book_appointment", successful: true, at: 200, dt: "2026-10-19T09:30" },
    { name: "reschedule_appointment", successful: false, at: 300, oldDt: "2026-10-19T09:30", dt: "2026-10-19T10:30" },
    { name: "cancel_appointment", successful: true, at: 400, dt: "2026-10-19T09:30" },
  ];
  const fast = (audit) => {
    const s = withAudit(audit);
    s.bookingGuards = true;
    return s;
  };

  it("fast path: book → failed reschedule → successful cancel of THAT booking is finished (phone test F1)", () => {
    const s = fast(MOVE_THEN_CANCEL());
    assert.equal(s.hasUnfinishedBooking("caller_done"), false);
    assert.equal(s.lastFunnelStep(), null);
  });

  it("Gemini/classic (no guards): the same calls stay unfinished — the guard they run is unchanged", () => {
    const s = withAudit(MOVE_THEN_CANCEL());
    assert.equal(s.hasUnfinishedBooking("caller_done"), true);
    assert.equal(s.lastFunnelStep(), "reschedule_appointment");
  });

  it("fast path: a failed BOOK then a successful cancel of an earlier booking is still unfinished (the caller would be left with nothing)", () => {
    for (const s of [fast, withAudit].map((make) => make([
      { name: "book_appointment", successful: true, at: 100, dt: "2026-10-19T09:00" },
      { name: "book_appointment", successful: false, at: 200, dt: "2026-10-20T09:00" },
      { name: "cancel_appointment", successful: true, at: 300, dt: "2026-10-19T09:00" },
    ]))) {
      assert.equal(s.hasUnfinishedBooking("caller_done"), true);
      assert.equal(s.lastFunnelStep(), "book_appointment");
    }
  });

  it("phone test F4 (fast path): a lookup-and-cancel call the model ends as 'booking complete' is not an unfinished booking", () => {
    const audit = () => [
      { name: "lookup_appointment", successful: true, at: 100 },
      { name: "cancel_appointment", successful: true, at: 200, dt: "2026-10-19T10:00" },
    ];
    assert.equal(fast(audit()).hasUnfinishedBooking("booking complete"), false);
    assert.equal(withAudit(audit()).hasUnfinishedBooking("booking complete"), true, "Gemini/classic: unchanged");
    assert.equal(fast([]).hasUnfinishedBooking("booking complete"), true, "a bare 'booking complete' with nothing done still blocks");
    assert.equal(fast([{ name: "lookup_appointment", successful: false, at: 100 }]).hasUnfinishedBooking("booking complete"), true, "a failed lookup proves nothing");
    // final review: only a real cancel, and never a claimed reschedule
    assert.equal(fast([{ name: "lookup_appointment", successful: true, at: 100 }]).hasUnfinishedBooking("booking complete"), true, "a lookup alone (it may have found nothing)");
    assert.equal(fast(audit()).hasUnfinishedBooking("rescheduled the booking"), true, "a cancel is not a reschedule");
    // confirmation review: a lookup that FOUND the booking, or a cancel the caller then declined, is the caller's own booking
    assert.equal(fast([{ name: "lookup_appointment", successful: true, found: true, at: 100 }]).hasUnfinishedBooking("caller kept their booking"), false, "a lookup that found it");
    assert.equal(fast([{ name: "cancel_appointment_held", successful: false, at: 100 }]).hasUnfinishedBooking("caller decided to keep the booking"), false, "a declined cancel");
    assert.equal(fast([{ name: "lookup_appointment", successful: true, found: true, at: 100 }]).hasUnfinishedBooking("rescheduled the booking"), true, "a lookup is not a reschedule");
    assert.equal(withAudit([{ name: "lookup_appointment", successful: true, found: true, at: 100 }]).hasUnfinishedBooking("caller kept their booking"), true, "Gemini/classic: unchanged");
  });

  it("gate review: a booking the AI claimed without book_appointment still blocks once — even on a call about the caller's own booking", () => {
    const said = (audit, role, line) => {
      const s = fast(audit);
      s.addMessage(role, line);
      return s;
    };
    const FOUND = [{ name: "lookup_appointment", successful: true, found: true, at: 100 }];
    const HELD = [{ name: "cancel_appointment_held", successful: false, at: 100 }];
    const CANCELLED = [{ name: "cancel_appointment", successful: true, at: 100 }];
    for (const audit of [FOUND, HELD, CANCELLED]) {
      assert.equal(said(audit, "assistant", "I've booked you in for Tuesday at 2 PM.").hasUnfinishedBooking("booked new appointment for Tuesday 2pm"), true);
      assert.equal(said(audit, "assistant", "I have made a booking for you on Tuesday.").hasUnfinishedBooking("booking complete"), true);
      assert.equal(said(audit, "assistant", "Done — booked you in for Tuesday.").hasUnfinishedBooking("booking complete"), true);
    }
    // describing the booking they already have is no claim; the caller's words never count
    assert.equal(said(FOUND, "assistant", "You've got a booking on Monday the 19th at 10 am.").hasUnfinishedBooking("caller kept their booking"), false);
    assert.equal(said(FOUND, "assistant", "You're booked in for Monday at 10.").hasUnfinishedBooking("caller kept their booking"), false);
    assert.equal(said(CANCELLED, "assistant", "Your Monday booking has been cancelled.").hasUnfinishedBooking("booking cancelled"), false);
    assert.equal(said(FOUND, "user", "I've booked a plumber already.").hasUnfinishedBooking("caller kept their booking"), false);
    // more ways a model claims it booked — and ways it describes what they have
    for (const claim of ["I've also booked a new appointment for you on Tuesday.", "I've gone ahead and booked Tuesday at 2 for you.", "We've now booked Tuesday at 2 for you.", "I've scheduled you in for Tuesday at 2.", "I've booked a call-out for Tuesday at 2 PM.", "I've booked a callout for Tuesday."]) {
      assert.equal(said(FOUND, "assistant", claim).hasUnfinishedBooking("booking complete"), true, claim);
    }
    for (const line of ["I've got you booked in for Monday at 10.", "I have you booked in for Monday.", "I've scheduled a callback for you.", "Let me see what we have booked for you.", "We have your appointment booked for Monday at 10.", "I've booked a call with Dave for you."]) {
      assert.equal(said(FOUND, "assistant", line).hasUnfinishedBooking("caller kept their booking"), false, line);
    }
    // the words of a reply that also called a tool are in the model's messages before they reach the transcript
    const s = fast(FOUND);
    s.messages.push({ role: "assistant", content: "Done — I've booked you in for Tuesday at 2 PM.", tool_calls: [{ id: "1", type: "function", function: { name: "end_call", arguments: "{}" } }] });
    s.messages.push({ role: "assistant", content: null, tool_calls: [] });
    assert.equal(s.hasUnfinishedBooking("booked new appointment for Tuesday 2pm"), true);
    // …and a claim the model's message window has dropped is still in the transcript
    const long = fast(FOUND);
    long.fullTranscriptMessages.push({ role: "assistant", content: "I've booked you in for Tuesday at 2 PM.", at: 1 });
    assert.equal(long.hasUnfinishedBooking("booked new appointment for Tuesday 2pm"), true);
  });

  it("re-review: a failed move, an availability check, then the cancel of that booking is still finished", () => {
    const audit = MOVE_THEN_CANCEL();
    audit.splice(3, 0, { name: "check_availability", successful: true, at: 350 });
    const s = fast(audit);
    assert.equal(s.hasUnfinishedBooking("caller_done"), false);
    assert.equal(s.lastFunnelStep(), null);
  });

  it("re-review: a second booking redirected to a move (B3) is not an unfinished booking — this call's booking stands", () => {
    const s = fast([
      { name: "book_appointment", successful: true, at: 100 },
      { name: "book_appointment_redirected", successful: false, at: 200 },
    ]);
    assert.equal(s.hasUnfinishedBooking("caller_done"), false);
    // the usual order: availability for the new time, then the redirect
    const t = fast([
      { name: "check_availability", successful: true, at: 50 },
      { name: "book_appointment", successful: true, at: 100 },
      { name: "check_availability", successful: true, at: 150 },
      { name: "book_appointment_redirected", successful: false, at: 200 },
    ]);
    assert.equal(t.hasUnfinishedBooking("caller_done"), false);
  });

  it("fast path: cancelling a DIFFERENT booking than the one the failed move was for leaves the move unfinished", () => {
    const audit = MOVE_THEN_CANCEL();
    audit[3].dt = "2026-10-22T14:00";
    assert.equal(fast(audit).hasUnfinishedBooking("caller_done"), true);
  });

  it("fast path: a held booking (book_appointment_held) is a booking step until a booking succeeds", () => {
    const held = [
      { name: "check_availability", successful: true, at: 100 },
      { name: "book_appointment_held", successful: false, at: 200 },
    ];
    assert.equal(fast(held).hasUnfinishedBooking("caller_done"), true);
    assert.equal(fast([...held, { name: "book_appointment", successful: true, at: 300 }]).hasUnfinishedBooking("caller_done"), false);
    // gate review: a cancel, then a booking the guards held — nothing new was booked.
    const s = fast([{ name: "cancel_appointment", successful: true, at: 100, dt: "2026-10-19T09:00" }, { name: "book_appointment_held", successful: false, at: 200 }]);
    assert.equal(s.hasUnfinishedBooking("caller_done"), true);
    assert.equal(s.lastFunnelStep(), "book_appointment", "worded as nothing booked");
  });

  it("a cancel BEFORE a later failed reschedule still leaves it unfinished", () => {
    const s = withAudit([
      { name: "book_appointment", successful: true, at: 100 },
      { name: "cancel_appointment", successful: true, at: 200 },
      { name: "reschedule_appointment", successful: false, at: 300 },
    ]);
    assert.equal(s.hasUnfinishedBooking("caller_done"), true);
    assert.equal(s.lastFunnelStep(), "reschedule_appointment");
  });

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

  // SCRUM-377: the atomic reschedule_appointment tool resolves the funnel itself.
  it("false for a reschedule via the atomic reschedule_appointment tool (check Y, then reschedule success)", () => {
    const s = withAudit([
      { name: "check_availability", successful: true, at: 100 },
      { name: "reschedule_appointment", successful: true, at: 200 },
    ]);
    assert.equal(s.hasUnfinishedBooking("reschedule_complete"), false);
  });

  it("false for a standalone successful reschedule_appointment (no prior funnel)", () => {
    assert.equal(withAudit([{ name: "reschedule_appointment", successful: true, at: 100 }]).hasUnfinishedBooking("reschedule_complete"), false);
  });

  it("true for a FAILED reschedule_appointment with no resolution (don't let end_call pretend it moved)", () => {
    assert.equal(withAudit([{ name: "reschedule_appointment", successful: false, at: 100 }]).hasUnfinishedBooking("reschedule_complete"), true);
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
