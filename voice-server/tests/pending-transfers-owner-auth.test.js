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
  analyzeCallTranscript: async (...args) => { calls.push(["analyzeCallTranscript", ...args]); return analysis; },
});
// SCRUM-594 (phone test F10): the appointments lookup for the names this call booked under.
let appointments = { data: [], error: null };
stub("../lib/supabase", {
  getSupabase: () => ({
    from(table) {
      const lookup = { table, eq: {} };
      calls.push(["appointmentsLookup", lookup]);
      const chain = {
        select: () => chain,
        eq: (col, val) => { lookup.eq[col] = val; return chain; },
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (resolve, reject) => Promise.resolve(appointments).then(resolve, reject),
      };
      return chain;
    },
  }),
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

describe("finishTransferredCall — SCRUM-594: the fast path's summary survives a transfer", () => {
  beforeEach(() => { calls.length = 0; writeFailures = 0; analysis = null; });

  it("writes the summary cleanup attached to the entry, and null without one", async () => {
    const fastPath = { turns: 2, eotToAudioP50: 1300, eotToAudioP90: 1700, specAdopted: 1, specDiscarded: 0, stt: "flux", tts: "stream" };
    await finishTransferredCall(savedState({ fastPath }), "answered");
    assert.deepEqual(calls.find((c) => c[0] === "completeCallRecord")[2].fastPath, fastPath);
    calls.length = 0;
    await finishTransferredCall(savedState(), "answered");
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].fastPath, null);
  });

  it("gate C7: writes the pipeline cleanup attached to the entry (a demo-line call), and null without one", async () => {
    await finishTransferredCall(savedState({ pipeline: "classic-fast" }), "answered");
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].pipeline, "classic-fast");
    calls.length = 0;
    await finishTransferredCall(savedState(), "answered");
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].pipeline, null);
  });
});

describe("finishTransferredCall — SCRUM-594 (phone test F10): the names on this call's appointments", () => {
  beforeEach(() => {
    calls.length = 0;
    writeFailures = 0;
    analysis = { summary: "Booked, then asked for Dave.", callerName: "Michael Dunn", successEvaluation: "successful" };
    appointments = { data: [], error: null };
  });

  it("are looked up for this call in its org and given to the analysis", async () => {
    appointments = { data: [{ attendee_name: "Michael Dunn" }], error: null };
    await finishTransferredCall(savedState(), "answered");
    const [, lookup] = calls.find((c) => c[0] === "appointmentsLookup");
    assert.deepEqual(lookup, { table: "appointments", eq: { call_id: "call-9", organization_id: "org-1" } });
    assert.deepEqual(calls.find((c) => c[0] === "analyzeCallTranscript")[2], { language: "en", bookedNames: ["Michael Dunn"] });
    assert.equal(calls.find((c) => c[0] === "completeCallRecord")[2].callerName, "Michael Dunn");
  });

  it("a failed lookup is said in the log, and the call is analysed and written without names", async (t) => {
    const warned = [];
    t.mock.method(console, "warn", (...a) => warned.push(a.join(" ")));
    appointments = { data: null, error: { message: "timeout" } };
    await finishTransferredCall(savedState(), "answered");
    assert.deepEqual(calls.find((c) => c[0] === "analyzeCallTranscript")[2].bookedNames, []);
    assert.ok(calls.some((c) => c[0] === "completeCallRecord:done"));
    assert.equal(warned.length, 1);
    assert.match(warned[0], /\[PendingTransfer\] Booked names unavailable — analysing without them \(callId=call-9\): appointments lookup failed: timeout/);
  });

  it("an owner call is never analysed, so nothing is looked up", async () => {
    await finishTransferredCall(savedState({ callType: "owner" }), "answered");
    assert.ok(!calls.some((c) => c[0] === "appointmentsLookup"));
  });
});
