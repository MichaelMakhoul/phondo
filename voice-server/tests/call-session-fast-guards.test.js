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
    assert.deepEqual(s.bookingGuardState, { spellingHolds: 0, lastSpellingHoldTurn: -1, secondBookingNudged: false, endCallHolds: 0, lastEndCallHoldTurn: -1 });
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

  it("Gemini/classic keep matching on ANY shared key (a shared phone confirms, as before), and ignore fast options", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON_PHONE, 1000, { callerTurn: 9 }), false);
    assert.equal(s.confirmCancel({ datetime: "2026-10-21T14:00:00", phone: "+61412555013" }, 2000), true);
  });

  it("an attempt with no identifier is always held", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel({}, 1000, { fastPath: true }), false);
    assert.equal(s.confirmCancel({ datetime: "garbled" }, 2000, { fastPath: true }), false);
    assert.deepEqual(s.confirmFastCancel({}, 3000), { proceed: false, via: null, reason: "no-identifier" });
  });

  it("fast path: once confirmed, a retry for the same booking after the handler asked for a detail is not held again", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON, 1000, { fastPath: true, callerTurn: 1 }), false);
    assert.equal(s.confirmCancel(MON, 2000, { fastPath: true, callerTurn: 2 }), true);
    assert.deepEqual(s.confirmFastCancel(MON_PHONE, 3000, { callerTurn: 3 }), { proceed: true, via: "confirmed", reason: null });
  });

  it("fast path: a confirmation never carries to another day through the shared caller-ID phone, nor another time that day", () => {
    const s = new CallSession("CA1");
    s.confirmCancel(MON_PHONE, 1000, { fastPath: true, callerTurn: 1 });
    assert.equal(s.confirmCancel(MON_PHONE, 2000, { fastPath: true, callerTurn: 2 }), true);
    assert.equal(s.confirmCancel({ datetime: "2026-10-21T14:00:00", phone: "+61412555013" }, 3000, { fastPath: true, callerTurn: 3 }), false);
    assert.equal(s.confirmCancel({ datetime: "2026-10-19T14:00:00" }, 4000, { fastPath: true, callerTurn: 4 }), false);
  });

  it("fast path: a date-only confirmation doesn't cover a time the model picked after", () => {
    const t = new CallSession("CA2");
    t.confirmCancel({ date: "2026-10-19" }, 1000, { fastPath: true, callerTurn: 1 });
    assert.equal(t.confirmCancel({ date: "2026-10-19" }, 2000, { fastPath: true, callerTurn: 2 }), true);
    assert.equal(t.confirmCancel({ datetime: "2026-10-19T14:00:00" }, 3000, { fastPath: true, callerTurn: 3 }), false);
  });

  it("fast path: a held cancel is confirmed only by an attempt after the caller has spoken again", () => {
    const s = new CallSession("CA1");
    assert.equal(s.confirmCancel(MON, 1000, { fastPath: true, callerTurn: 3 }), false);
    assert.equal(s.confirmCancel(MON, 1001, { fastPath: true, callerTurn: 3 }), false, "the model's instant retry, same caller turn");
    assert.equal(s.confirmCancel(MON, 2000, { fastPath: true, callerTurn: 4 }), true);
  });

  it("fast path: a confirmation expires after five minutes", () => {
    const s = new CallSession("CA1");
    s.confirmCancel(MON, 1000, { fastPath: true, callerTurn: 1 });
    assert.equal(s.confirmCancel(MON, 2000, { fastPath: true, callerTurn: 2 }), true);
    assert.equal(s.confirmCancel(MON, 2000 + 5 * 60 * 1000 + 1, { fastPath: true, callerTurn: 3 }), false);
  });

  it("clearCancelConfirmation(args) forgets only that booking; without args, everything", () => {
    const s = new CallSession("CA1");
    const TUE = { datetime: "2026-10-20T14:00:00" };
    s.confirmCancel(MON, 1000, { fastPath: true, callerTurn: 1 });
    s.confirmCancel(TUE, 1001, { fastPath: true, callerTurn: 1 });
    s.clearCancelConfirmation(MON);
    assert.equal(s.confirmCancel(TUE, 2000, { fastPath: true, callerTurn: 2 }), true, "Tuesday's hold stands");
    assert.equal(s.confirmCancel(MON, 2001, { fastPath: true, callerTurn: 2 }), false, "Monday's is gone");
    s.clearCancelConfirmation();
    assert.equal(s.confirmCancel(TUE, 3000, { fastPath: true, callerTurn: 3 }), false);
  });
});
