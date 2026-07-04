const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CallSession } = require("../call-session");

// SCRUM-503: deterministic reschedule_appointment re-fire cap — the reschedule
// twin of the SCRUM-367 booking cap. Born from the first completed Grok eval
// call (2026-07-04): the model re-called the tool ~10x in 40s instead of
// relaying the tool's "confirm the name" question to the caller.
describe("CallSession.registerRescheduleOutcome (SCRUM-503)", () => {
  const ok = () => ({ successful: true, isAvailabilityReject: false });
  const needsInfo = () => ({ successful: false, isAvailabilityReject: false });
  const unavailable = () => ({ successful: false, isAvailabilityReject: true });

  it("no directive on the 1st non-success result", () => {
    const s = new CallSession("c1");
    assert.equal(s.registerRescheduleOutcome(needsInfo()), "");
    assert.equal(s.rescheduleRetryCount, 1);
  });

  it("escalates from the 2nd consecutive non-success result onward", () => {
    const s = new CallSession("c2");
    s.registerRescheduleOutcome(needsInfo());
    const d2 = s.registerRescheduleOutcome(needsInfo());
    assert.match(d2, /SYSTEM — reschedule attempt 2/);
    assert.match(d2, /ASK THE CALLER/);
    assert.match(d2, /STOP calling reschedule_appointment/);
    const d3 = s.registerRescheduleOutcome(needsInfo());
    assert.match(d3, /reschedule attempt 3/);
  });

  it("success resets the counter (a later single failure doesn't escalate)", () => {
    const s = new CallSession("c3");
    s.registerRescheduleOutcome(needsInfo());
    s.registerRescheduleOutcome(needsInfo());
    assert.equal(s.registerRescheduleOutcome(ok()), "");
    assert.equal(s.rescheduleRetryCount, 0);
    assert.equal(s.registerRescheduleOutcome(needsInfo()), ""); // back to attempt 1
  });

  it("availability rejections reset instead of escalating (legit offer-another-time turns)", () => {
    const s = new CallSession("c4");
    s.registerRescheduleOutcome(needsInfo());
    assert.equal(s.registerRescheduleOutcome(unavailable()), "");
    assert.equal(s.rescheduleRetryCount, 0);
  });

  it("independent from the booking cap's counter", () => {
    const s = new CallSession("c5");
    s.registerBookOutcome({ successful: false, isAvailabilityReject: false });
    s.registerBookOutcome({ successful: false, isAvailabilityReject: false });
    assert.equal(s.registerRescheduleOutcome(needsInfo()), ""); // reschedule still at attempt 1
    assert.equal(s.rescheduleRetryCount, 1);
  });
});
