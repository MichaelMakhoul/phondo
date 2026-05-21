const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { forwardingFallbackEligible } = require("../lib/transfer-eligibility");

// A session for which the forwarded-number fallback SHOULD be eligible.
function eligibleSession(overrides = {}) {
  return {
    transferToForwardedNumber: true,
    behaviors: { transferToHuman: true },
    sourceType: "forwarded",
    forwardingStatus: "active",
    userPhoneNumber: "+61411111111",
    orgPhoneNumber: "+61200000000",
    ...overrides,
  };
}

describe("forwardingFallbackEligible (SCRUM-327)", () => {
  it("is true when opted-in, forwarded, active, and the number differs from Phondo's", () => {
    assert.equal(forwardingFallbackEligible(eligibleSession()), true);
  });

  it("DEFAULT OFF: false when transferToForwardedNumber is not set (competitor parity)", () => {
    assert.equal(forwardingFallbackEligible(eligibleSession({ transferToForwardedNumber: undefined })), false);
    assert.equal(forwardingFallbackEligible(eligibleSession({ transferToForwardedNumber: false })), false);
  });

  it("DECOUPLED from transferToHuman: eligible even when transferToHuman is false/absent (the explicit opt-in is the authorization — so dental/home_services, where it defaults off, can use it)", () => {
    assert.equal(forwardingFallbackEligible(eligibleSession({ behaviors: { transferToHuman: false } })), true);
    assert.equal(forwardingFallbackEligible(eligibleSession({ behaviors: undefined })), true);
  });

  it("false when the call wasn't forwarded (Phondo-pool number)", () => {
    assert.equal(forwardingFallbackEligible(eligibleSession({ sourceType: "purchased" })), false);
    assert.equal(forwardingFallbackEligible(eligibleSession({ sourceType: null })), false);
  });

  it("false when forwarding is not active (e.g. pending_setup / paused)", () => {
    assert.equal(forwardingFallbackEligible(eligibleSession({ forwardingStatus: "pending_setup" })), false);
  });

  it("false when there is no userPhoneNumber to dial", () => {
    assert.equal(forwardingFallbackEligible(eligibleSession({ userPhoneNumber: null })), false);
  });

  it("LOOP GUARD: false when the forwarded number equals the Phondo number (incl. formatting differences)", () => {
    assert.equal(forwardingFallbackEligible(eligibleSession({ userPhoneNumber: "+61200000000", orgPhoneNumber: "+61200000000" })), false);
    assert.equal(forwardingFallbackEligible(eligibleSession({ userPhoneNumber: "+61 2 0000 0000", orgPhoneNumber: "+61200000000" })), false);
  });
});
