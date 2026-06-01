const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CallSession } = require("../call-session");

// SCRUM-367 (B): deterministic book_appointment re-confirm-loop cap.
describe("CallSession.registerBookOutcome (SCRUM-367)", () => {
  const ok = () => ({ successful: true, isAvailabilityReject: false });
  const reject = () => ({ successful: false, isAvailabilityReject: false });
  const unavailable = () => ({ successful: false, isAvailabilityReject: true });

  it("no directive on the 1st rejection", () => {
    const s = new CallSession("c1");
    assert.equal(s.registerBookOutcome(reject()), "");
    assert.equal(s.bookRejectionCount, 1);
    assert.equal(s.bookNameEscalated, false);
  });

  it("escalates from the 2nd rejection onward", () => {
    const s = new CallSession("c2");
    s.registerBookOutcome(reject());
    const d2 = s.registerBookOutcome(reject());
    assert.match(d2, /SYSTEM — booking attempt 2/);
    assert.match(d2, /transliterate/i);
    assert.equal(s.bookNameEscalated, true);
    const d3 = s.registerBookOutcome(reject());
    assert.match(d3, /attempt 3/);
  });

  it("resets the counter on a successful booking", () => {
    const s = new CallSession("c3");
    s.registerBookOutcome(reject());
    s.registerBookOutcome(reject()); // escalated, count=2
    assert.equal(s.registerBookOutcome(ok()), "");
    assert.equal(s.bookRejectionCount, 0);
    // a fresh rejection after success starts over — no immediate escalation
    assert.equal(s.registerBookOutcome(reject()), "");
  });

  it("availability/conflict rejections reset the counter (not a same-detail loop)", () => {
    const s = new CallSession("c4");
    s.registerBookOutcome(reject()); // count=1
    assert.equal(s.registerBookOutcome(unavailable()), ""); // reset
    assert.equal(s.bookRejectionCount, 0);
    // two distinct unavailable slots never escalate
    assert.equal(s.registerBookOutcome(unavailable()), "");
    assert.equal(s.registerBookOutcome(unavailable()), "");
  });

  it("starts fresh per call (constructor init)", () => {
    const s = new CallSession("c5");
    assert.equal(s.bookRejectionCount, 0);
    assert.equal(s.bookNameEscalated, false);
  });
});
