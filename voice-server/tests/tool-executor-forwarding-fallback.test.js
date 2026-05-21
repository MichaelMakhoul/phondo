const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Set required env vars before import (mirrors tool-executor-routing.test.js).
process.env.OPENAI_API_KEY = "test-key";
process.env.TELNYX_API_KEY = "test-key";
process.env.INTERNAL_API_URL = "http://localhost:3000";
process.env.INTERNAL_API_SECRET = "test-secret";

const { executeToolCall } = require("../services/tool-executor");

// SCRUM-328: the forwarded-number fallback opt-in must be enforced INSIDE the
// tool-executor too, not only at the registration gate. These tests call
// executeToolCall directly — i.e. they simulate transfer_call being invoked in
// the no-rules case by SOME path other than the gate (a future regression, a
// hallucinated tool). The executor must still refuse to dial the forwarded
// number unless the org explicitly opted in.
//
// We omit callSid so executeTransferCall returns its synchronous
// action:"transfer" decision (tool-executor.js:747) without any network dial,
// and pass urgency:"high" to bypass the business-hours gate.
function forwardedContext(overrides = {}) {
  return {
    organizationId: "org-1",
    assistantId: "asst-1",
    transferRules: [],
    userPhoneNumber: "+61411111111",
    orgPhoneNumber: "+61200000000",
    forwardingStatus: "active",
    sourceType: "forwarded",
    transferToForwardedNumber: true,
    organization: {},
    ...overrides,
  };
}

describe("forwarded-number fallback opt-in enforced in tool-executor (SCRUM-328)", () => {
  it("synthesizes the forwarded fallback and transfers when the org opted in", async () => {
    const result = await executeToolCall(
      "transfer_call",
      { reason: "I want to speak to a human", urgency: "high" },
      forwardedContext()
    );
    assert.equal(result.action, "transfer");
    assert.equal(result.transferTo, "+61411111111");
  });

  it("does NOT synthesize the fallback when opt-in is false (takes a message instead)", async () => {
    const result = await executeToolCall(
      "transfer_call",
      { reason: "I want to speak to a human", urgency: "high" },
      forwardedContext({ transferToForwardedNumber: false })
    );
    assert.notEqual(result.action, "transfer");
    assert.equal(result.transferAttempt.outcome, "no_rules_configured");
  });

  it("does NOT synthesize the fallback when opt-in is absent (default off)", async () => {
    const result = await executeToolCall(
      "transfer_call",
      { reason: "I want to speak to a human", urgency: "high" },
      forwardedContext({ transferToForwardedNumber: undefined })
    );
    assert.notEqual(result.action, "transfer");
    assert.equal(result.transferAttempt.outcome, "no_rules_configured");
  });

  it("LOOP GUARD still applies even when opted in: refuses when forwarded == Phondo number", async () => {
    const result = await executeToolCall(
      "transfer_call",
      { reason: "I want to speak to a human", urgency: "high" },
      forwardedContext({ userPhoneNumber: "+61200000000", orgPhoneNumber: "+61200000000" })
    );
    assert.notEqual(result.action, "transfer");
    assert.equal(result.transferAttempt.outcome, "no_rules_configured");
  });
});
