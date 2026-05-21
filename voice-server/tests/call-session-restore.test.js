const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CallSession } = require("../call-session");

// SCRUM-325: after a failed/no-answer transfer reconnects the caller to the
// AI, the session is rebuilt via restoreFrom(savedState). It MUST restore the
// forwarding fields (userPhoneNumber/forwardingStatus/sourceType) — without
// them a SECOND transfer on the reconnected call can't use the
// forwarded-number fallback (executeToolCall gates on those three).
describe("CallSession.restoreFrom (SCRUM-325)", () => {
  function savedState(overrides = {}) {
    return {
      messages: [{ role: "system", content: "x" }],
      organizationId: "org-1",
      assistantId: "asst-1",
      phoneNumberId: "pn-1",
      callerPhone: "+61400000000",
      callRecordId: "rec-1",
      calendarEnabled: true,
      serviceTypes: [{ id: "st1" }],
      transferRules: [{ id: "tr1" }],
      userPhoneNumber: "+61411111111",
      forwardingStatus: "active",
      sourceType: "forwarded",
      deepgramVoice: "aura-2-thalia-en",
      holdPreset: "calm",
      organization: { name: "Acme" },
      orgPhoneNumber: "+61200000000",
      transferAttempt: { outcome: "no-answer" },
      startedAt: 1700000000000,
      language: "es",
      ...overrides,
    };
  }

  it("restores the forwarding fallback fields (the SCRUM-325 fix)", () => {
    const s = new CallSession("call-1");
    s.restoreFrom(savedState());
    assert.equal(s.userPhoneNumber, "+61411111111");
    assert.equal(s.forwardingStatus, "active");
    assert.equal(s.sourceType, "forwarded");
  });

  it("restores the rest of the saveForTransfer payload", () => {
    const s = new CallSession("call-1");
    s.restoreFrom(savedState());
    assert.equal(s.organizationId, "org-1");
    assert.equal(s.assistantId, "asst-1");
    assert.equal(s.phoneNumberId, "pn-1");
    assert.equal(s.callerPhone, "+61400000000");
    assert.equal(s.callRecordId, "rec-1");
    assert.equal(s.calendarEnabled, true);
    assert.deepEqual(s.serviceTypes, [{ id: "st1" }]);
    assert.deepEqual(s.transferRules, [{ id: "tr1" }]);
    assert.equal(s.deepgramVoice, "aura-2-thalia-en");
    assert.equal(s.holdPreset, "calm");
    assert.deepEqual(s.organization, { name: "Acme" });
    assert.equal(s.orgPhoneNumber, "+61200000000");
    assert.equal(s.transferAttempt.outcome, "no-answer");
    assert.equal(s.startedAt, 1700000000000);
    assert.equal(s.language, "es");
  });

  it("defaults serviceTypes to [] and language to 'en' when absent", () => {
    const s = new CallSession("call-2");
    s.restoreFrom({ messages: [] });
    assert.deepEqual(s.serviceTypes, []);
    assert.equal(s.language, "en");
  });
});
