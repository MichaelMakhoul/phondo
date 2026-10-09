"use strict";
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-587 — a call the AI TRANSFERS is completed by lib/pending-transfers.js
// (finishTransferredCall), not by server.js cleanupSession. A customer call
// that tripped the owner PIN lockout and was then transferred must still get
// calls.metadata.owner_auth = "locked" — otherwise PR B never emails the owner.
// And an owner call, should one ever reach this path, is still never analysed.
process.env.INTERNAL_API_URL = "http://next.internal";
process.env.INTERNAL_API_SECRET = "secret";

const calls = [];
let analysis = null;
function stub(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("../lib/call-logger", {
  completeCallRecord: async (id, fields) => { calls.push(["completeCallRecord", id, fields]); await new Promise((r) => setTimeout(r, 5)); calls.push(["completeCallRecord:done"]); },
  notifyCallCompleted: async (url, secret, payload) => { calls.push(["notifyCallCompleted", payload]); },
});
stub("../services/post-call-analysis", {
  analyzeCallTranscript: async () => { calls.push(["analyzeCallTranscript"]); return analysis; },
});
const { finishTransferredCall } = require("../lib/pending-transfers");

function savedState(extra = {}) {
  return {
    messages: [{ role: "user", content: "Put me through to Dave." }, { role: "assistant", content: "Connecting you now." }],
    organizationId: "org-1",
    assistantId: "asst-1",
    callerPhone: "+61400000999",
    callRecordId: "call-9",
    callSid: "CA-9",
    startedAt: Date.now() - 60_000,
    transferAttempt: { targetName: "Dave" },
    language: "en",
    ...extra,
  };
}

describe("finishTransferredCall — the PIN-gate stamp survives a transfer", () => {
  beforeEach(() => { calls.length = 0; analysis = { summary: "Caller asked for Dave.", callerName: "Sam", successEvaluation: "successful" }; });

  it("a locked customer call that was transferred is written owner_auth=locked (and still analysed as a customer call)", async () => {
    await finishTransferredCall(savedState({ ownerAuth: "locked", callType: null }), "answered");
    const fields = calls.find((c) => c[0] === "completeCallRecord")[2];
    assert.equal(fields.ownerAuth, "locked");
    assert.equal(fields.callType, null);
    assert.equal(fields.summary, "Caller asked for Dave.");
    assert.ok(calls.some((c) => c[0] === "analyzeCallTranscript"));
    const names = calls.map((c) => c[0]);
    const written = names.indexOf("completeCallRecord:done");
    assert.ok(written >= 0 && written < names.indexOf("notifyCallCompleted"), "row written (awaited) before the webhook");
    assert.equal(calls.find((c) => c[0] === "notifyCallCompleted")[1].ownerAuth, "locked");
  });

  it("a plain transferred customer call is unchanged: no owner fields in the row or the webhook body", async () => {
    await finishTransferredCall(savedState(), "answered");
    const fields = calls.find((c) => c[0] === "completeCallRecord")[2];
    assert.equal(fields.ownerAuth, null);
    assert.equal(fields.callType, null);
    const body = JSON.stringify(calls.find((c) => c[0] === "notifyCallCompleted")[1]);
    assert.ok(!body.includes("ownerAuth") && !body.includes("callType"));
  });

  it("an owner call (unreachable today: owner sessions have no transfer tool) is stamped owner and never analysed", async () => {
    await finishTransferredCall(savedState({ ownerAuth: "verified", callType: "owner" }), "unknown_timeout");
    assert.ok(!calls.some((c) => c[0] === "analyzeCallTranscript"), "no OpenAI analysis of an owner call");
    const fields = calls.find((c) => c[0] === "completeCallRecord")[2];
    assert.equal(fields.callType, "owner");
    assert.equal(fields.ownerAuth, "verified");
    assert.equal(calls.find((c) => c[0] === "notifyCallCompleted")[1].callType, "owner");
  });

  it("only the literal 'owner' marks an owner call", async () => {
    await finishTransferredCall(savedState({ callType: "OWNER" }), "answered");
    assert.ok(calls.some((c) => c[0] === "analyzeCallTranscript"));
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].callType, null);
  });
});
