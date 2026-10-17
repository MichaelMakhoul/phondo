"use strict";

// SCRUM-594 PHASE 2: the CallSession side of the fast path's fixes.
//  - B1: the 20-message window dropped a booking mid-call; the simulated
//    baseline then heard "I didn't book anything on this call" in 3 of 3 long
//    calls. The window is per session now; the fast path keeps the whole call.
//  - B4: the CancelGate took a cancel through four confirmations (hold, a
//    handler's "I need your phone number", a re-hold, then yes). It now takes
//    the AI's own explicit "cancel this?" + yes, and a confirmed cancel stays
//    confirmed when the handler sends the model back for a detail.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { CallSession } = require("../call-session");

function fill(s, n) {
  for (let i = 0; i < n; i++) s.addMessage(i % 2 ? "assistant" : "user", `m${i}`);
}

describe("message window (B1)", () => {
  it("keeps the system prompt plus the last 20 messages by default", () => {
    const s = new CallSession("CA1");
    s.setSystemPrompt("SYS");
    fill(s, 30);
    assert.equal(s.messages.length, 21);
    assert.equal(s.messages[0].content, "SYS");
    assert.equal(s.messages[1].content, "m10");
  });

  it("a session's maxMessages widens it (the fast path keeps the whole call)", () => {
    const s = new CallSession("CA1");
    s.setSystemPrompt("SYS");
    s.maxMessages = 201;
    fill(s, 150);
    assert.equal(s.messages.length, 151);
    assert.equal(s.messages[1].content, "m0");
  });

  it("the transcript is never windowed either way", () => {
    const s = new CallSession("CA1");
    s.setSystemPrompt("SYS");
    fill(s, 30);
    assert.equal(s.fullTranscriptMessages.length, 30);
  });
});

describe("guards are off unless the fast path turns them on", () => {
  it("a new session has no booking guards and a fresh guard state", () => {
    const s = new CallSession("CA1");
    assert.equal(s.bookingGuards, false);
    assert.deepEqual(s.bookingGuardState, { spellingHolds: 0, lastSpellingHoldTurn: -1, secondBookingNudged: false, endCallHolds: 0, lastEndCallHoldTurn: -1, usedCancelConfirmation: -1 });
  });
});

describe("CancelGate (B4)", () => {
  const MON = { datetime: "2026-10-19T09:00:00" };
  const MON_PHONE = { datetime: "2026-10-19T09:00:00", phone: "+61412555013" };

  it("unchanged without options: hold, then the confirming retry proceeds, then a new attempt is held again", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON, 1000), false);
    assert.equal(s.confirmCancel(MON, 2000), true);
    assert.equal(s.confirmCancel(MON_PHONE, 3000), false, "the classic/Gemini gate re-holds after a handler failure");
  });

  it("callerConfirmed: the AI's own 'cancel this?' + yes proceeds at once", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON, 1000, { callerConfirmed: true, fastPath: true }), true);
  });

  it("an attempt with no identifier is always held, even when the caller said yes", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel({}, 1000, { callerConfirmed: true, fastPath: true }), false);
    assert.equal(s.confirmCancel({ datetime: "garbled" }, 2000, { callerConfirmed: true, fastPath: true }), false);
  });

  it("fast path: once confirmed, a retry for the same booking after the handler asked for a detail is not held again", () => {
    const s = new CallSession("CA1");
    const opts = { fastPath: true };
    assert.equal(s.confirmCancel(MON, 1000, opts), false); // held
    assert.equal(s.confirmCancel(MON, 2000, opts), true); // confirmed → the handler wants the phone
    assert.equal(s.confirmCancel(MON_PHONE, 3000, opts), true, "same booking (date key): no second hold");
  });

  it("fast path: a confirmation expires after five minutes and never covers another booking", () => {
    const s = new CallSession("CA1");
    const opts = { callerConfirmed: true, fastPath: true };
    assert.equal(s.confirmCancel(MON, 1000, opts), true);
    assert.equal(s.confirmCancel({ datetime: "2026-10-21T14:00:00" }, 2000, { fastPath: true }), false, "a different day is held");
    const later = 1000 + 5 * 60 * 1000 + 1;
    assert.equal(s.confirmCancel(MON, later, { fastPath: true }), false, "expired");
  });

  it("clearCancelConfirmation (after a cancel succeeds) ends the confirmation", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON, 1000, { callerConfirmed: true, fastPath: true }), true);
    s.clearCancelConfirmation();
    assert.equal(s.confirmCancel(MON, 2000, { fastPath: true }), false);
  });

  it("fast path: a held cancel for one day is not confirmed by an attempt for another day with the same (caller-ID) phone", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON_PHONE, 1000, { fastPath: true }), false);
    assert.equal(s.confirmCancel({ datetime: "2026-10-21T14:00:00", phone: "+61412555013" }, 2000, { fastPath: true }), false);
    assert.equal(s.confirmCancel({ datetime: "2026-10-21T14:00:00", phone: "+61412555013" }, 3000, { fastPath: true }), true, "its own retry confirms it");
  });

  it("without fastPath the options are ignored: the Gemini/classic gate is exactly the old one", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON, 1000, { callerConfirmed: true }), false, "held");
    assert.equal(s.confirmCancel(MON, 2000), true);
  });

  it("Gemini/classic keep matching on ANY shared key (a shared phone confirms, as before)", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON_PHONE, 1000), false);
    assert.equal(s.confirmCancel({ datetime: "2026-10-21T14:00:00", phone: "+61412555013" }, 2000), true);
  });

  it("fast path: a confirmation never carries to another day through the shared caller-ID phone", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON_PHONE, 1000, { callerConfirmed: true, fastPath: true }), true);
    assert.equal(s.confirmCancel({ datetime: "2026-10-21T14:00:00", phone: "+61412555013" }, 2000, { fastPath: true }), false);
  });

  it("fast path: a confirmation is for one booking — another time the same day is held (a family's two bookings)", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON, 1000, { callerConfirmed: true, fastPath: true }), true);
    assert.equal(s.confirmCancel({ datetime: "2026-10-19T14:00:00" }, 2000, { fastPath: true }), false, "a different time");
    const t = new CallSession("CA2");
    assert.equal(t.confirmCancel({ date: "2026-10-19" }, 1000, { callerConfirmed: true, fastPath: true }), true);
    assert.equal(t.confirmCancel({ datetime: "2026-10-19T14:00:00" }, 2000, { fastPath: true }), false, "a date-only yes doesn't cover a time the model picked after");
  });

  it("fast path: a held cancel is confirmed only by an attempt after the caller has spoken again", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON, 1000, { fastPath: true, callerTurn: 3 }), false);
    assert.equal(s.confirmCancel(MON, 1001, { fastPath: true, callerTurn: 3 }), false, "the model's instant retry, same caller turn");
    assert.equal(s.confirmCancel(MON, 2000, { fastPath: true, callerTurn: 4 }), true);
  });

  it("fast path: the held cancel and the confirming one must be the same booking (time, then date)", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON, 1000, { fastPath: true, callerTurn: 1 }), false);
    assert.equal(s.confirmCancel({ datetime: "2026-10-19T14:00:00" }, 2000, { fastPath: true, callerTurn: 2 }), false);
    assert.equal(s.confirmCancel({ datetime: "2026-10-19T14:00:00" }, 3000, { fastPath: true, callerTurn: 3 }), true);
  });
});
