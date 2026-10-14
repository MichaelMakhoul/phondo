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
let writeFailures = 0;
function stub(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub("../lib/call-logger", {
  completeCallRecord: async (id, fields) => {
    calls.push(["completeCallRecord", id, fields]);
    await new Promise((r) => setTimeout(r, 5));
    if (writeFailures > 0) { writeFailures -= 1; throw new Error("db write failed"); }
    calls.push(["completeCallRecord:done"]);
  },
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
  beforeEach(() => { calls.length = 0; writeFailures = 0; analysis = { summary: "Caller asked for Dave.", callerName: "Sam", successEvaluation: "successful" }; });

  /** Run finishTransferredCall on mocked timers (its 1 s / 2 s retry back-offs), console captured. */
  async function finishOnMockedTimers(t, state) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const lines = [];
    for (const m of ["log", "warn", "error"]) t.mock.method(console, m, (...a) => lines.push(`${m}| ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`));
    let done = false;
    const p = finishTransferredCall(state, "unknown_timeout").finally(() => { done = true; });
    for (let i = 0; i < 60 && !done; i++) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(100); }
    await p;
    return lines;
  }

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

  it("an owner call whose record can't be written skips the webhook and pages once, ids only (unreachable today)", async (t) => {
    writeFailures = Infinity;
    const lines = await finishOnMockedTimers(t, savedState({ ownerAuth: "verified", callType: "owner" }));
    assert.equal(calls.filter((c) => c[0] === "completeCallRecord").length, 3, "the transfer path's own retries");
    assert.deepEqual(calls.filter((c) => c[0] === "notifyCallCompleted"), []);
    const alerts = lines.filter((l) => l.includes("[ALERT:error]"));
    assert.equal(alerts.length, 1, lines.join("\n"));
    for (const id of ["CA-9", "call-9", "org-1"]) assert.ok(alerts[0].includes(id), alerts[0]);
    assert.ok(!alerts[0].includes("Put me through") && !alerts[0].includes("+61400000999"), alerts[0]);
  });

  it("a customer call whose record can't be written still sends the webhook (unchanged)", async (t) => {
    writeFailures = Infinity;
    const lines = await finishOnMockedTimers(t, savedState({ ownerAuth: "locked" }));
    assert.equal(calls.filter((c) => c[0] === "notifyCallCompleted").length, 1);
    assert.deepEqual(lines.filter((l) => l.includes("[ALERT:error]")), []);
  });

  it("only the literal 'owner' marks an owner call", async () => {
    await finishTransferredCall(savedState({ callType: "OWNER" }), "answered");
    assert.ok(calls.some((c) => c[0] === "analyzeCallTranscript"));
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].callType, null);
  });
});
