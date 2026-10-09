"use strict";
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");
process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";

// The real executor is exercised below with fetch stubbed: no test reaches a network.
let fetches = [];
let fetchImpl = async () => { throw new Error("no fetch stub set for this test"); };
global.fetch = async (url, init) => {
  fetches.push({ url, body: JSON.parse(init.body) });
  return fetchImpl(url, init);
};

const { runOwnerToolCall, buildOwnerCallSummary, OWNER_MAX_TOOL_CALLS, describeOwnerToolCall } = require("../lib/owner-tool-runner");
const { executeToolCall } = require("../services/tool-executor");

// SCRUM-587 — the owner tool path replaces the customer guard chain (spec §5).
function makeSession(overrides = {}) {
  return { callSid: "CA1", organizationId: "org-1", assistantId: "asst-1", callRecordId: "call-1", ownerMode: true, organization: { timezone: "Australia/Sydney" }, callerPhone: "+61400000001", orgPhoneNumber: "+61255550000", telephonyProvider: "twilio", toolCallAudit: [], ownerToolCalls: 0, ...overrides };
}
function makeDeps(resultFor) {
  const calls = []; const invalidated = []; let t = 1000;
  const deps = {
    executeToolCall: async (name, args, context) => { calls.push({ name, args, context }); return typeof resultFor === "function" ? resultFor(name, args) : resultFor; },
    scheduleCache: { invalidate: (orgId) => { invalidated.push(orgId); } },
    now: () => (t += 1),
  };
  return { deps, calls, invalidated, get invalidations() { return invalidated.length; } };
}
/** Run fn with console.* captured (and silenced); resolves to the printed lines. */
async function captureConsole(fn) {
  const lines = [];
  const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const level of Object.keys(saved)) console[level] = (...a) => { lines.push({ level, text: util.format(...a) }); };
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}
const alerts = (lines) => lines.filter((l) => l.text.includes("[ALERT:error]"));
const auditFor = (s, name) => s.toolCallAudit.filter((e) => e.name === name);
/** Arm the confirmation gate by hand: a read-back the owner has answered since. */
function armConfirmed(s, key) {
  s.ownerPendingConfirmations = new Map([[key, { at: 1 }]]);
  s.lastOwnerSpeechAt = 2;
}

const RESCHEDULED = { message: "Moved Jane Smith's 2:00 pm Thursday job to Friday 9:00 am. The customer has NOT been notified.", data: { outcome: "rescheduled", customer_notified: false } };
const CANCELLED = { success: true, message: "Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM. The customer has NOT been notified — I can read you their number if you want to let them know.", data: { outcome: "cancelled", appointment_id: "a1", customer_notified: false } };
const NEEDS_CONFIRMATION = { success: false, message: "Read this back and get a clear yes before cancelling: cancel Bob Lee's job on Friday, October 16 at 3:00 PM. If the owner confirms, call owner_cancel_appointment again with confirmed=true.", data: { outcome: "needs_confirmation", appointment_id: "a1", customer_notified: false } };
const RESCHEDULE_NEEDS_CONFIRMATION = { success: false, message: "Read this back and get a clear yes before changing anything: move Bob Lee's job from Friday, October 16 at 3:00 PM to Friday, October 16 at 9:00 AM. If the owner confirms, call owner_reschedule_appointment again with confirmed=true.", data: { outcome: "needs_confirmation", appointment_id: "a1", customer_notified: false } };

// Every receptionist failure line an owner session can be handed by the shared executor / Next.js handlers.
const CALLBACK_OFFER_NON_2XX = "I'm having trouble with that right now. Would you like me to take your information instead?";
const CALLBACK_OFFER_NO_CONFIG = "I'm sorry, I'm unable to access the calendar system right now. Would you like me to take your information instead?";
const CALLBACK_OFFER_CALENDAR = "I'm having trouble checking the calendar right now. Would you like me to take your information instead?";
const TIMEOUT_STALL = "I'm having a little trouble right now. Could you give me a moment?";
// The exact owner-worded lines (controller rulings) — pinned as literals.
const DIARY_LINE = "I couldn't check the diary just now — try another time, or check the dashboard.";
const NO_CALL_RECORD_LINE = "I can't reach your bookings on this call — please ring back in a minute.";
const READ_FAILED_LINE = "I'm having trouble with that right now — please try again in a moment, or check the dashboard.";
const WRITE_UNCONFIRMED_LINE = "I'm having trouble with that right now, so I can't confirm the change went through. Please check the dashboard, or try again in a moment.";

describe("runOwnerToolCall", () => {
  it("executes an allowed tool with ownerMode:true and the production call context, audits it, and returns message + data", async () => {
    const s = makeSession(); const d = makeDeps(RESCHEDULED);
    armConfirmed(s, "owner_reschedule_appointment|a1|2026-10-16T09:00");
    const ret = await runOwnerToolCall(s, { name: "owner_reschedule_appointment", args: { appointment_id: "a1", new_datetime: "2026-10-16T09:00", confirmed: true } }, d.deps);
    assert.deepEqual(ret, { message: RESCHEDULED.message, data: RESCHEDULED.data });
    assert.equal(d.calls[0].args.confirmed, true);
    const c = d.calls[0].context;
    assert.equal(c.ownerMode, true); assert.equal(c.callId, "call-1"); assert.equal(c.organizationId, "org-1"); assert.equal(c.transferRules, undefined); assert.equal(c.testMode, undefined);
    assert.equal(c.scheduleSnapshot, undefined); assert.equal(c.collectedDetails, undefined);
    assert.equal(s.toolCallAudit.length, 1);
    assert.equal(s.toolCallAudit[0].at, 1001, "audit stamps come from the injected clock");
    assert.equal(s.toolCallAudit[0].name, "owner_reschedule_appointment"); assert.equal(s.toolCallAudit[0].successful, true);
    assert.equal(s.toolCallAudit[0].ownerDetail, "Moved Jane Smith's 2:00 pm Thursday job to Friday 9:00 am.");
    assert.equal(d.invalidations, 1); assert.deepEqual(d.invalidated, ["org-1"]);
  });
  it("a write whose outcome is not rescheduled/cancelled is NOT a success (no cache invalidation, excluded from the summary)", async () => {
    const s = makeSession(); const d = makeDeps({ message: "Needs confirmation.", data: { outcome: "needs_confirmation", customer_notified: false } });
    await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1" } }, d.deps);
    assert.equal(s.toolCallAudit[0].successful, false); assert.equal(d.invalidations, 0);
    const s2 = makeSession(); const d2 = makeDeps({ message: "That isn't available on this call.", success: false, error: true });
    armConfirmed(s2, "owner_cancel_appointment|a1");
    await runOwnerToolCall(s2, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d2.deps);
    assert.equal(auditFor(s2, "owner_cancel_appointment")[0].successful, false); assert.equal(d2.invalidations, 0);
    assert.equal(buildOwnerCallSummary(s.toolCallAudit), "Owner call: no changes made.");
    assert.equal(buildOwnerCallSummary(s2.toolCallAudit), "Owner call: no changes made.");
  });
  it("every non-success outcome — slot_taken, not_found, invalid_time, rate_limited, external_calendar — is a failure the model still hears in full", async () => {
    for (const outcome of ["slot_taken", "not_found", "invalid_time", "rate_limited", "external_calendar"]) {
      const s = makeSession(); const result = { success: false, message: `outcome ${outcome}`, data: { outcome, customer_notified: false } };
      const d = makeDeps(result);
      armConfirmed(s, "owner_reschedule_appointment|a1|2026-10-16T09:00");
      const ret = await runOwnerToolCall(s, { name: "owner_reschedule_appointment", args: { appointment_id: "a1", new_datetime: "2026-10-16T09:00", confirmed: true } }, d.deps);
      assert.deepEqual(ret, { message: result.message, data: result.data }, outcome);
      assert.equal(s.toolCallAudit[0].successful, false, outcome);
      assert.equal(s.toolCallAudit[0].ownerDetail, null, outcome);
      assert.equal(d.invalidations, 0, outcome);
    }
  });
  it("external_calendar (the booking lives in Cliniko/Cal.com/…) is a non-success for cancel too, passed through verbatim", async () => {
    const s = makeSession();
    const external = { success: false, message: "That booking lives in your Cliniko diary, so I haven't touched it — please change it there.", data: { outcome: "external_calendar", appointment_id: "a1", customer_notified: false } };
    const d = makeDeps(external);
    armConfirmed(s, "owner_cancel_appointment|a1");
    const ret = await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps);
    assert.deepEqual(ret, { message: external.message, data: external.data });
    assert.equal(s.toolCallAudit[0].successful, false); assert.equal(d.invalidations, 0);
    assert.equal(buildOwnerCallSummary(s.toolCallAudit), "Owner call: no changes made.");
  });
  it("a cancelled outcome is a success: cache invalidated, change described from PR B's message", async () => {
    const s = makeSession(); const d = makeDeps(CANCELLED);
    armConfirmed(s, "owner_cancel_appointment|a1");
    const ret = await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps);
    assert.deepEqual(ret, { message: CANCELLED.message, data: CANCELLED.data });
    assert.equal(s.toolCallAudit[0].successful, true);
    assert.equal(s.toolCallAudit[0].ownerDetail, "Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM.");
    assert.deepEqual(d.invalidated, ["org-1"]);
  });
  it("a write with an outcome AND an error flag is not a success", async () => {
    const s = makeSession(); const d = makeDeps({ success: false, error: true, message: "I couldn't move that job just now.", data: { outcome: "rescheduled" } });
    armConfirmed(s, "owner_reschedule_appointment|a1|2026-10-16T09:00");
    await runOwnerToolCall(s, { name: "owner_reschedule_appointment", args: { appointment_id: "a1", new_datetime: "2026-10-16T09:00", confirmed: true } }, d.deps);
    assert.equal(s.toolCallAudit[0].successful, false); assert.equal(d.invalidations, 0);
  });
  it("an error flag on its own (no success:false) is a failure for every kind of tool", async () => {
    const s = makeSession(); const d = makeDeps({ error: true, message: "Cancelled.", data: { outcome: "cancelled" } });
    armConfirmed(s, "owner_cancel_appointment|a1");
    await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps);
    assert.equal(s.toolCallAudit[0].successful, false); assert.equal(d.invalidations, 0);
    const s2 = makeSession();
    await runOwnerToolCall(s2, { name: "owner_list_appointments", args: { range: "today" } }, makeDeps({ error: true, message: "3 jobs today", data: { count: 3 } }).deps);
    assert.equal(s2.toolCallAudit[0].successful, false);
    const s3 = makeSession();
    const ret3 = await runOwnerToolCall(s3, { name: "check_availability", args: { date: "2026-10-16" } }, makeDeps({ error: true, message: "2 available slots on Friday." }).deps);
    assert.deepEqual(ret3, { message: DIARY_LINE });
    assert.equal(s3.toolCallAudit[0].successful, false);
  });
  it("reads succeed without an outcome and never invalidate the cache", async () => {
    const s = makeSession(); const d = makeDeps({ message: "3 jobs today: …", data: { count: 3 } });
    const ret = await runOwnerToolCall(s, { name: "owner_list_appointments", args: { range: "today" } }, d.deps);
    assert.equal(ret.data.count, 3); assert.equal(s.toolCallAudit[0].ownerDetail, "Checked today's jobs"); assert.equal(d.invalidations, 0);
  });
  it("blocks customer tools without executing them", async () => {
    const s = makeSession(); const d = makeDeps(RESCHEDULED);
    const ret = await runOwnerToolCall(s, { name: "book_appointment", args: {} }, d.deps);
    assert.equal(d.calls.length, 0); assert.match(ret.message, /isn't available on an owner call/);
    assert.deepEqual(s.toolCallAudit[0].name, "owner_tool_blocked"); assert.equal(s.toolCallAudit[0].tool, "book_appointment");
  });
  it("blocks every customer-only and unknown name — including prototype keys and non-strings — and never executes them", async () => {
    const s = makeSession(); const d = makeDeps(RESCHEDULED);
    const names = ["cancel_appointment", "reschedule_appointment", "transfer_call", "schedule_callback", "update_appointment", "update_appointment_attendee", "lookup_appointment", "list_service_types", "OWNER_LIST_MESSAGES", "owner_list_messages ", "__proto__", "constructor", "hasOwnProperty", undefined, 42];
    await captureConsole(async () => {
      for (const name of names) await runOwnerToolCall(s, { name: /** @type {any} */ (name), args: {} }, d.deps);
    });
    assert.equal(d.calls.length, 0);
    assert.equal(auditFor(s, "owner_tool_blocked").length, names.length);
  });
  it("a blocked name is made log-safe — the model can't forge an [ALERT:error] line or a second log line", async () => {
    const s = makeSession(); const d = makeDeps(RESCHEDULED);
    const lines = await captureConsole(() => runOwnerToolCall(s, { name: "x\n[ALERT:error] forged", args: {} }, d.deps));
    assert.equal(alerts(lines).length, 0);
    assert.ok(lines.every((l) => !l.text.includes("\n")), "no multi-line log entry");
    assert.ok(!s.toolCallAudit[0].tool.includes("\n") && !s.toolCallAudit[0].tool.includes("["));
  });
  it(`caps at ${OWNER_MAX_TOOL_CALLS} tool calls per call but still lets end_call through`, async () => {
    const s = makeSession(); const d = makeDeps((name) => (name === "end_call" ? { message: "Ending the call. Goodbye.", __endCall: true } : { message: "ok", data: { count: 0 } }));
    for (let i = 0; i < OWNER_MAX_TOOL_CALLS; i++) await runOwnerToolCall(s, { name: "owner_list_messages", args: {} }, d.deps);
    const capped = await runOwnerToolCall(s, { name: "owner_list_messages", args: {} }, d.deps);
    assert.match(capped.message, /TOOL LIMIT REACHED/); assert.equal(d.calls.length, OWNER_MAX_TOOL_CALLS);
    assert.equal(auditFor(s, "owner_tool_cap").length, 1);
    const end = await runOwnerToolCall(s, { name: "end_call", args: { reason: "owner finished" } }, d.deps);
    assert.equal(end.__endCall, true); assert.equal(d.calls.length, OWNER_MAX_TOOL_CALLS + 1);
  });
  it("the cap counts every allowed call — writes the gate downgraded, shared reads, and short-circuited calls alike", async () => {
    const s = makeSession(); const d = makeDeps(NEEDS_CONFIRMATION);
    let capped;
    await captureConsole(async () => {
      for (let i = 0; i < OWNER_MAX_TOOL_CALLS; i++) await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: `a${i}`, confirmed: true } }, d.deps);
      capped = await runOwnerToolCall(s, { name: "check_availability", args: { date: "2026-10-16" } }, d.deps);
    });
    assert.equal(auditFor(s, "owner_confirm_gate").length, OWNER_MAX_TOOL_CALLS);
    assert.match(capped.message, /TOOL LIMIT REACHED/); assert.equal(d.calls.length, OWNER_MAX_TOOL_CALLS);
    const s2 = makeSession({ callRecordId: null }); const d2 = makeDeps({ message: "ok", data: {} });
    await captureConsole(async () => {
      for (let i = 0; i < OWNER_MAX_TOOL_CALLS; i++) await runOwnerToolCall(s2, { name: "owner_list_messages", args: {} }, d2.deps);
    });
    const capped2 = await runOwnerToolCall(s2, { name: "owner_list_messages", args: {} }, d2.deps);
    assert.match(capped2.message, /TOOL LIMIT REACHED/);
  });
  it("blocked names never execute and do not use up the cap", async () => {
    const s = makeSession(); const d = makeDeps({ message: "ok", data: { count: 0 } });
    await captureConsole(async () => {
      for (let i = 0; i < OWNER_MAX_TOOL_CALLS + 5; i++) await runOwnerToolCall(s, { name: "book_appointment", args: {} }, d.deps);
    });
    const ret = await runOwnerToolCall(s, { name: "owner_list_messages", args: {} }, d.deps);
    assert.equal(d.calls.length, 1); assert.equal(ret.message, "ok"); assert.equal(s.ownerToolCalls, 1);
  });
  it("only the executor's end_call sentinel ends the call", async () => {
    const s = makeSession(); const d = makeDeps({ message: "ok", data: { count: 0 } });
    const ret = await runOwnerToolCall(s, { name: "owner_list_messages", args: {} }, d.deps);
    assert.equal(ret.__endCall, undefined);
    const s2 = makeSession();
    const end = await runOwnerToolCall(s2, { name: "end_call", args: { reason: "done" } }, { ...makeDeps(null).deps, executeToolCall });
    assert.equal(end.__endCall, true); assert.equal(s2.ownerToolCalls, 0);
  });
});

describe("runOwnerToolCall — authority stays with the session", () => {
  it("refuses, alerts and never executes when the session is not a PIN-verified owner session", async () => {
    for (const ownerMode of [undefined, false, "true", 1]) {
      const s = makeSession({ ownerMode }); const d = makeDeps(RESCHEDULED);
      let ret;
      const lines = await captureConsole(async () => { ret = await runOwnerToolCall(s, { name: "owner_list_appointments", args: { range: "today" } }, d.deps); });
      assert.equal(d.calls.length, 0, String(ownerMode));
      assert.equal(ret.message, "That isn't available on this call.");
      assert.equal(alerts(lines).length, 1, String(ownerMode));
    }
  });
});

describe("runOwnerToolCall — no call record (the calls insert failed)", () => {
  it("short-circuits every owner_* call without the executor, with one [ALERT:error] for the call", async () => {
    for (const callRecordId of [null, undefined, ""]) {
      const s = makeSession({ callRecordId }); const d = makeDeps(RESCHEDULED);
      const rets = [];
      const lines = await captureConsole(async () => {
        rets.push(await runOwnerToolCall(s, { name: "owner_list_appointments", args: { range: "today" } }, d.deps));
        rets.push(await runOwnerToolCall(s, { name: "owner_list_messages", args: {} }, d.deps));
        rets.push(await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps));
        rets.push(await runOwnerToolCall(s, { name: "owner_reschedule_appointment", args: { appointment_id: "a1", new_datetime: "2026-10-16T09:00" } }, d.deps));
      });
      assert.equal(d.calls.length, 0, String(callRecordId));
      for (const ret of rets) assert.deepEqual(ret, { message: NO_CALL_RECORD_LINE });
      assert.equal(alerts(lines).length, 1, "one alert per call, not one per tool");
      assert.ok(s.toolCallAudit.every((e) => e.successful === false));
      assert.equal(buildOwnerCallSummary(s.toolCallAudit), "Owner call: no changes made.");
    }
  });
  it("each call without a record gets its own alert", async () => {
    const d = makeDeps(RESCHEDULED);
    const lines = await captureConsole(async () => {
      await runOwnerToolCall(makeSession({ callRecordId: null, callSid: "CA1" }), { name: "owner_list_messages", args: {} }, d.deps);
      await runOwnerToolCall(makeSession({ callRecordId: null, callSid: "CA2" }), { name: "owner_list_messages", args: {} }, d.deps);
    });
    assert.equal(alerts(lines).length, 2);
  });
  it("the shared tools still run, and PR B is never asked for an owner_* tool", async () => {
    const s = makeSession({ callRecordId: null }); fetches = [];
    fetchImpl = async () => ({ ok: true, json: async () => ({ success: true, message: "2 available slots on Friday, October 16: 9:00 AM, 10:00 AM." }) });
    const deps = { executeToolCall, scheduleCache: { invalidate: () => {} } };
    await captureConsole(async () => {
      await runOwnerToolCall(s, { name: "owner_list_appointments", args: { range: "today" } }, deps);
      const avail = await runOwnerToolCall(s, { name: "check_availability", args: { date: "2026-10-16" } }, deps);
      assert.match(avail.message, /2 available slots/);
      const now = await runOwnerToolCall(s, { name: "get_current_datetime", args: {} }, deps);
      assert.match(now.message, /Current date and time/);
      const end = await runOwnerToolCall(s, { name: "end_call", args: {} }, deps);
      assert.equal(end.__endCall, true);
    });
    assert.deepEqual(fetches.map((f) => f.body.functionName), ["check_availability"]);
  });
});

describe("runOwnerToolCall — an owner READ without data is a failure", () => {
  const CASES = [
    { label: "timeout / fetch error (the executor's stall)", result: { message: TIMEOUT_STALL } },
    { label: "missing config (the callback offer)", result: { message: CALLBACK_OFFER_NO_CONFIG } },
    { label: "200 that claims success but carries no data", result: { success: true, message: "3 jobs today: Bob at 9." } },
    { label: "200 with an empty body", result: { message: "The operation completed but returned no message." } },
    { label: "a bare string", result: "3 jobs today" },
    { label: "nothing at all", result: undefined },
  ];
  for (const name of ["owner_list_appointments", "owner_list_messages"]) {
    for (const { label, result } of CASES) {
      it(`${name}: ${label} → audited failed, and the model hears the owner-worded failure`, async () => {
        const s = makeSession(); const d = makeDeps(result);
        const ret = await runOwnerToolCall(s, { name, args: { range: "today" } }, d.deps);
        assert.deepEqual(ret, { message: READ_FAILED_LINE });
        assert.equal(s.toolCallAudit[0].successful, false);
        assert.equal(s.toolCallAudit[0].ownerDetail, null);
        assert.equal(buildOwnerCallSummary(s.toolCallAudit), "Owner call: no changes made.");
      });
    }
  }
  it("PR B's own non-success keeps its words (the model can fix the request), still audited failed", async () => {
    const s = makeSession(); const d = makeDeps({ success: false, message: "Which date? Give it as year-month-day, like 2026-10-20." });
    const ret = await runOwnerToolCall(s, { name: "owner_list_appointments", args: { range: "date" } }, d.deps);
    assert.deepEqual(ret, { message: "Which date? Give it as year-month-day, like 2026-10-20." });
    assert.equal(s.toolCallAudit[0].successful, false);
    const s2 = makeSession(); const d2 = makeDeps({ success: false, error: true, message: "I'm having trouble reaching the calendar right now. Try again in a moment." });
    const ret2 = await runOwnerToolCall(s2, { name: "owner_list_messages", args: {} }, d2.deps);
    assert.equal(ret2.message, "I'm having trouble reaching the calendar right now. Try again in a moment.");
    assert.equal(s2.toolCallAudit[0].successful, false);
  });
  it("with the real executor: a timeout is audited failed and never heard as 'give me a moment'", async () => {
    const s = makeSession(); fetches = [];
    fetchImpl = async () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; };
    let ret;
    await captureConsole(async () => { ret = await runOwnerToolCall(s, { name: "owner_list_appointments", args: { range: "today" } }, { executeToolCall, scheduleCache: { invalidate: () => {} } }); });
    assert.equal(fetches.length, 1);
    assert.deepEqual(ret, { message: READ_FAILED_LINE });
    assert.equal(s.toolCallAudit[0].successful, false);
  });
  it("with the real executor: a non-2xx keeps the executor's owner-worded line, audited failed", async () => {
    const s = makeSession();
    fetchImpl = async () => ({ ok: false, status: 503, text: async () => "<html>Service Unavailable</html>" });
    let ret;
    await captureConsole(async () => { ret = await runOwnerToolCall(s, { name: "owner_list_messages", args: {} }, { executeToolCall, scheduleCache: { invalidate: () => {} } }); });
    assert.deepEqual(ret, { message: READ_FAILED_LINE });
    assert.equal(s.toolCallAudit[0].successful, false);
  });
  it("with the real executor: a read with data is a success and the ownerVerified envelope rides on the wire", async () => {
    const s = makeSession(); fetches = [];
    fetchImpl = async () => ({ ok: true, json: async () => ({ success: true, message: "Nothing booked today.", data: { range: "today", count: 0, appointments: [] } }) });
    const ret = await runOwnerToolCall(s, { name: "owner_list_appointments", args: { range: "today" } }, { executeToolCall, scheduleCache: { invalidate: () => {} } });
    assert.deepEqual(ret, { message: "Nothing booked today.", data: { range: "today", count: 0, appointments: [] } });
    assert.equal(s.toolCallAudit[0].successful, true);
    assert.equal(fetches[0].body.ownerVerified, true); assert.equal(fetches[0].body.callId, "call-1");
  });
});

describe("runOwnerToolCall — a failed check_availability is owner-worded, never the callback offer", () => {
  const FAILURES = [
    { label: "an error result", result: { success: false, error: true, message: "Something broke." } },
    { label: "the non-2xx fallback", result: { message: CALLBACK_OFFER_NON_2XX } },
    { label: "the missing-config fallback", result: { message: CALLBACK_OFFER_NO_CONFIG } },
    { label: "the calendar handler's callback offer", result: { success: false, message: CALLBACK_OFFER_CALENDAR } },
    { label: "Cliniko's no-one-available callback offer", result: { success: false, message: "I'm sorry, there's no one available for that appointment type at the moment. Would you like me to take your information instead?" } },
    { label: "a timeout (the executor's stall)", result: { message: TIMEOUT_STALL } },
    { label: "an empty result", result: undefined },
  ];
  for (const { label, result } of FAILURES) {
    it(`${label} → "${DIARY_LINE}"`, async () => {
      const s = makeSession(); const d = makeDeps(result);
      const ret = await runOwnerToolCall(s, { name: "check_availability", args: { date: "2026-10-16" } }, d.deps);
      assert.deepEqual(ret, { message: DIARY_LINE });
      assert.equal(s.toolCallAudit[0].successful, false);
    });
  }
  it("with the real executor: a non-2xx and a timeout both become the diary line", async () => {
    const deps = { executeToolCall, scheduleCache: { invalidate: () => {} } };
    for (const impl of [async () => ({ ok: false, status: 500, text: async () => "Internal Server Error" }), async () => { throw new Error("fetch failed"); }]) {
      fetchImpl = impl;
      const s = makeSession(); let ret;
      await captureConsole(async () => { ret = await runOwnerToolCall(s, { name: "check_availability", args: { date: "2026-10-16" } }, deps); });
      assert.deepEqual(ret, { message: DIARY_LINE });
      assert.equal(s.toolCallAudit[0].successful, false);
    }
  });
  it("free times pass through untouched, audited successful", async () => {
    const s = makeSession(); const d = makeDeps({ success: true, message: "2 available slots on Friday, October 16: 9:00 AM, 10:00 AM." });
    const ret = await runOwnerToolCall(s, { name: "check_availability", args: { date: "2026-10-16" } }, d.deps);
    assert.deepEqual(ret, { message: "2 available slots on Friday, October 16: 9:00 AM, 10:00 AM." });
    assert.equal(s.toolCallAudit[0].successful, true); assert.equal(s.toolCallAudit[0].ownerDetail, null);
    const s2 = makeSession();
    const ret2 = await runOwnerToolCall(s2, { name: "check_availability", args: { date: "2026-10-16" } }, makeDeps("No available slots on Friday, October 16. Fully booked.").deps);
    assert.deepEqual(ret2, { message: "No available slots on Friday, October 16. Fully booked." }, "a bare string result is its message");
    assert.equal(s2.toolCallAudit[0].successful, true);
  });
  it("a request the tool can't answer as asked keeps its prompt (no fault, nothing to map)", async () => {
    const s = makeSession(); const d = makeDeps({ success: false, message: "I need the date in a standard format. Could you say the date again?" });
    const ret = await runOwnerToolCall(s, { name: "check_availability", args: { date: "Friday" } }, d.deps);
    assert.equal(ret.message, "I need the date in a standard format. Could you say the date again?");
    assert.equal(s.toolCallAudit[0].successful, false);
  });
});

describe("runOwnerToolCall — a failed write never sounds like a stall or a callback offer", () => {
  for (const { label, result } of [{ label: "timeout", result: { message: TIMEOUT_STALL } }, { label: "missing config", result: { message: CALLBACK_OFFER_NO_CONFIG } }, { label: "empty", result: undefined }]) {
    it(`${label} → it may have gone through, so the owner is told to check`, async () => {
      const s = makeSession(); const d = makeDeps(result);
      armConfirmed(s, "owner_cancel_appointment|a1");
      const ret = await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps);
      assert.deepEqual(ret, { message: WRITE_UNCONFIRMED_LINE });
      assert.equal(s.toolCallAudit[0].successful, false); assert.equal(d.invalidations, 0);
    });
  }
  it("with the real executor: a timed-out confirmed cancel is unconfirmed, not 'give me a moment', and its read-back is spent", async () => {
    const s = makeSession(); fetches = [];
    armConfirmed(s, "owner_cancel_appointment|a1");
    fetchImpl = async () => { throw new Error("The operation was aborted due to timeout"); };
    let invalidations = 0;
    const deps = { executeToolCall, scheduleCache: { invalidate: () => { invalidations += 1; } } };
    let ret;
    await captureConsole(async () => { ret = await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, deps); });
    assert.equal(fetches[0].body.arguments.confirmed, true);
    assert.deepEqual(ret, { message: WRITE_UNCONFIRMED_LINE });
    assert.equal(s.toolCallAudit[0].successful, false);
    assert.equal(invalidations, 0);
    assert.equal(s.ownerPendingConfirmations.has("owner_cancel_appointment|a1"), false);
  });
  it("PR B's own fault wording (owner-worded) reaches the model unchanged", async () => {
    const s = makeSession(); const d = makeDeps({ success: false, error: true, message: "I couldn't cancel that booking — something went wrong on our side. Please check it in the dashboard." });
    armConfirmed(s, "owner_cancel_appointment|a1");
    const ret = await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps);
    assert.equal(ret.message, "I couldn't cancel that booking — something went wrong on our side. Please check it in the dashboard.");
  });
});

describe("runOwnerToolCall — faults inside the runner", () => {
  it("an executor that throws is audited failed, alerts once, and the model never sees the raw error", async () => {
    for (const [name, args, expected] of [
      ["owner_list_appointments", { range: "today" }, READ_FAILED_LINE],
      ["owner_reschedule_appointment", { appointment_id: "a1", new_datetime: "2026-10-16T09:00" }, WRITE_UNCONFIRMED_LINE],
      ["check_availability", { date: "2026-10-16" }, DIARY_LINE],
    ]) {
      const s = makeSession();
      const deps = { executeToolCall: async () => { throw new TypeError("boom-internal-detail"); }, scheduleCache: { invalidate: () => {} } };
      let ret;
      const lines = await captureConsole(async () => { ret = await runOwnerToolCall(s, { name, args }, deps); });
      assert.deepEqual(ret, { message: expected }, name);
      assert.equal(s.toolCallAudit.at(-1).successful, false, name);
      assert.equal(alerts(lines).length, 1, name);
    }
  });
  it("a schedule-cache failure after a real change still hands the model the success (and alerts)", async () => {
    const s = makeSession(); const d = makeDeps(CANCELLED);
    d.deps.scheduleCache = { invalidate: () => { throw new Error("listener blew up"); } };
    armConfirmed(s, "owner_cancel_appointment|a1");
    let ret;
    const lines = await captureConsole(async () => { ret = await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps); });
    assert.deepEqual(ret, { message: CANCELLED.message, data: CANCELLED.data });
    assert.equal(s.toolCallAudit[0].successful, true);
    assert.equal(alerts(lines).length, 1);
  });
  it("logs carry no tool arguments, customer text or results", async () => {
    const SECRET_ID = "appt-ZQ-9137"; const SECRET_DT = "2031-02-03T04:05";
    const reveal = { success: true, message: `Moved Zelda Quixote from Monday to Tuesday. The customer has NOT been notified.`, data: { outcome: "rescheduled", customer_name: "Zelda Quixote", customer_phone: "+61499999999" } };
    const s = makeSession(); const d = makeDeps((name, args) => (args.confirmed === true ? reveal : { ...RESCHEDULE_NEEDS_CONFIRMATION, message: "Read back Zelda Quixote" }));
    const lines = await captureConsole(async () => {
      await runOwnerToolCall(s, { name: "owner_reschedule_appointment", args: { appointment_id: SECRET_ID, new_datetime: SECRET_DT, confirmed: true } }, d.deps);
      s.lastOwnerSpeechAt = Date.now() + 1000;
      await runOwnerToolCall(s, { name: "owner_reschedule_appointment", args: { appointment_id: SECRET_ID, new_datetime: SECRET_DT, confirmed: true } }, d.deps);
      await runOwnerToolCall(s, { name: "owner_list_messages", args: { note: "Zelda Quixote" } }, makeDeps({ message: "Zelda Quixote called", data: { callbacks: [] } }).deps);
      await runOwnerToolCall(s, { name: "book_appointment", args: { first_name: "Zelda" } }, d.deps);
      await runOwnerToolCall(makeSession({ callRecordId: null }), { name: "owner_cancel_appointment", args: { appointment_id: SECRET_ID } }, d.deps);
      const thrower = { executeToolCall: async () => { throw new Error("boom"); }, scheduleCache: { invalidate: () => {} } };
      await runOwnerToolCall(s, { name: "owner_list_appointments", args: { range: "date", date: SECRET_DT } }, thrower);
      const s4 = makeSession(); armConfirmed(s4, `owner_reschedule_appointment|${SECRET_ID}|${SECRET_DT}`);
      const brokenCache = { ...d.deps, scheduleCache: { invalidate: () => { throw new Error("cache down"); } } };
      await runOwnerToolCall(s4, { name: "owner_reschedule_appointment", args: { appointment_id: SECRET_ID, new_datetime: SECRET_DT, confirmed: true } }, brokenCache);
    });
    assert.ok(alerts(lines).length >= 3, "the no-record, throw and cache-fault alerts all printed");
    assert.ok(lines.length > 0, "the gate and the block do log");
    for (const { text } of lines) {
      for (const secret of [SECRET_ID, SECRET_DT, "Zelda", "Quixote", "+61499999999"]) assert.ok(!text.includes(secret), `log leaked ${secret}: ${text}`);
    }
    assert.equal(auditFor(s, "owner_reschedule_appointment").at(-1).successful, true);
  });
});

describe("runOwnerToolCall — structural confirmation gate", () => {
  const CANCEL_KEY = "owner_cancel_appointment|a1";
  const RESCHEDULE_KEY = "owner_reschedule_appointment|a1|2026-10-16T09:00";
  /** PR B's real gate: confirmed === true acts, anything else gets the read-back. */
  const prB = (name, args) => {
    if (name === "owner_cancel_appointment") return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION;
    if (name === "owner_reschedule_appointment") return args.confirmed === true ? RESCHEDULED : RESCHEDULE_NEEDS_CONFIRMATION;
    return { message: "ok", data: {} };
  };
  let lines;
  beforeEach(() => { lines = []; });
  const run = (s, d, name, args) => captureConsole(() => runOwnerToolCall(s, { name, args }, d.deps)).then((l) => { lines.push(...l); });

  it("a confirmed write with no pending read-back is forwarded with confirmed:false and audited as gated", async () => {
    const s = makeSession(); const d = makeDeps(prB);
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1", confirmed: true, reason: "owner asked" });
    assert.deepEqual(d.calls[0].args, { appointment_id: "a1", confirmed: false, reason: "owner asked" });
    const gate = auditFor(s, "owner_confirm_gate");
    assert.equal(gate.length, 1); assert.equal(gate[0].tool, "owner_cancel_appointment"); assert.equal(gate[0].successful, false);
    assert.equal(d.invalidations, 0);
    assert.equal(lines.filter((l) => l.level === "warn").length, 1);
  });
  it("PR B's needs_confirmation arms a pending entry (Map created lazily), keyed tool|appointment_id[|new_datetime]", async () => {
    for (const initial of [undefined, null]) {
      const s = makeSession({ ownerPendingConfirmations: initial }); const d = makeDeps(prB);
      const before = Date.now();
      await run(s, d, "owner_cancel_appointment", { appointment_id: "a1" });
      await run(s, d, "owner_reschedule_appointment", { appointment_id: "a1", new_datetime: "2026-10-16T09:00" });
      assert.ok(s.ownerPendingConfirmations instanceof Map);
      assert.deepEqual([...s.ownerPendingConfirmations.keys()].sort(), [CANCEL_KEY, RESCHEDULE_KEY].sort());
      for (const entry of s.ownerPendingConfirmations.values()) assert.ok(entry.at >= before && entry.at <= Date.now(), "stamped with Date.now()");
      assert.deepEqual(d.calls.map((c) => c.args.confirmed), [undefined, undefined], "an unconfirmed write is forwarded unchanged");
      assert.equal(auditFor(s, "owner_confirm_gate").length, 0);
    }
  });
  it("a pending read-back the owner hasn't spoken after is not a yes", async () => {
    const s = makeSession(); const d = makeDeps(prB);
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1" });
    const at = s.ownerPendingConfirmations.get(CANCEL_KEY).at;
    for (const spokeAt of [undefined, 0, at - 1, at]) {
      s.lastOwnerSpeechAt = spokeAt;
      await run(s, d, "owner_cancel_appointment", { appointment_id: "a1", confirmed: true });
      assert.equal(d.calls.at(-1).args.confirmed, false, `spoke at ${spokeAt}, read-back at ${at}`);
    }
    assert.equal(auditFor(s, "owner_confirm_gate").length, 4);
    assert.equal(d.invalidations, 0);
  });
  it("a non-number speech stamp never opens the gate", async () => {
    const s = makeSession(); const d = makeDeps(prB);
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1" });
    const at = s.ownerPendingConfirmations.get(CANCEL_KEY).at;
    for (const spokeAt of [String(at + 1000), NaN, { valueOf: () => at + 1000 }, [at + 1000], true]) {
      s.lastOwnerSpeechAt = spokeAt;
      await run(s, d, "owner_cancel_appointment", { appointment_id: "a1", confirmed: true });
      assert.equal(d.calls.at(-1).args.confirmed, false, String(spokeAt));
    }
  });
  it("pending read-back + owner speech after it → the confirmed write goes through as-is, once", async () => {
    const s = makeSession(); const d = makeDeps(prB);
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1" });
    s.lastOwnerSpeechAt = s.ownerPendingConfirmations.get(CANCEL_KEY).at + 1;
    const args = { appointment_id: "a1", confirmed: true, reason: "owner asked" };
    await run(s, d, "owner_cancel_appointment", args);
    assert.deepEqual(d.calls[1].args, { appointment_id: "a1", confirmed: true, reason: "owner asked" });
    assert.equal(auditFor(s, "owner_confirm_gate").length, 0);
    assert.equal(auditFor(s, "owner_cancel_appointment").at(-1).successful, true);
    assert.equal(s.ownerPendingConfirmations.has(CANCEL_KEY), false, "the entry is spent");
    assert.equal(d.invalidations, 1);
  });
  it("a reschedule read-back authorises exactly that job AND that new time", async () => {
    const s = makeSession(); const d = makeDeps(prB);
    await run(s, d, "owner_reschedule_appointment", { appointment_id: "a1", new_datetime: "2026-10-16T09:00" });
    s.lastOwnerSpeechAt = Date.now() + 1000;
    await run(s, d, "owner_reschedule_appointment", { appointment_id: "a1", new_datetime: "2026-10-16T10:00", confirmed: true });
    assert.equal(d.calls.at(-1).args.confirmed, false, "different new_datetime");
    await run(s, d, "owner_reschedule_appointment", { appointment_id: "a2", new_datetime: "2026-10-16T09:00", confirmed: true });
    assert.equal(d.calls.at(-1).args.confirmed, false, "different appointment_id");
    assert.ok(s.ownerPendingConfirmations.has(RESCHEDULE_KEY), "the real read-back is still pending");
    await run(s, d, "owner_reschedule_appointment", { appointment_id: "a1", new_datetime: "2026-10-16T09:00", confirmed: true });
    assert.equal(d.calls.at(-1).args.confirmed, true);
    assert.equal(auditFor(s, "owner_confirm_gate").length, 2);
  });
  it("a cancel read-back for a job doesn't authorise a different job, or a reschedule of the same job (and vice versa)", async () => {
    const s = makeSession(); const d = makeDeps(prB);
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1" });
    s.lastOwnerSpeechAt = Date.now() + 1000;
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a2", confirmed: true });
    assert.equal(d.calls.at(-1).args.confirmed, false, "different appointment_id");
    await run(s, d, "owner_reschedule_appointment", { appointment_id: "a1", new_datetime: "2026-10-16T09:00", confirmed: true });
    assert.equal(d.calls.at(-1).args.confirmed, false, "cancel read-back used for a reschedule");
    const s2 = makeSession(); const d2 = makeDeps(prB);
    await run(s2, d2, "owner_reschedule_appointment", { appointment_id: "a1", new_datetime: "2026-10-16T09:00" });
    s2.lastOwnerSpeechAt = Date.now() + 1000;
    await run(s2, d2, "owner_cancel_appointment", { appointment_id: "a1", confirmed: true });
    assert.equal(d2.calls.at(-1).args.confirmed, false, "reschedule read-back used for a cancel");
  });
  it("the entry is cleared after a confirmed forward — a second confirmed call needs a fresh read-back", async () => {
    const s = makeSession(); const d = makeDeps(prB);
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1" });
    s.lastOwnerSpeechAt = Date.now() + 1000;
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1", confirmed: true });
    assert.equal(d.calls.at(-1).args.confirmed, true);
    assert.equal(s.ownerPendingConfirmations.size, 0);
    s.lastOwnerSpeechAt = Date.now() + 2000;
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1", confirmed: true });
    assert.equal(d.calls.at(-1).args.confirmed, false);
    assert.equal(auditFor(s, "owner_confirm_gate").length, 1);
  });
  it("two confirmed calls for one read-back in the same model turn (run in parallel) → only one goes through", async () => {
    const s = makeSession();
    const d = makeDeps(async (name, args) => { await new Promise((r) => setTimeout(r, 5)); return prB(name, args); });
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1" });
    s.lastOwnerSpeechAt = Date.now() + 1000;
    await captureConsole(() => Promise.all([
      runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps),
      runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps),
    ]));
    assert.deepEqual(d.calls.slice(1).map((c) => c.args.confirmed).sort(), [false, true]);
  });
  it("a confirmed write and its own read-back requested in the same turn → the confirm is gated", async () => {
    const s = makeSession(); s.lastOwnerSpeechAt = Date.now() + 60_000; // the owner spoke, but before nothing was pending
    const d = makeDeps(prB);
    await captureConsole(() => Promise.all([
      runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1" } }, d.deps),
      runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps),
    ]));
    assert.deepEqual(d.calls.map((c) => c.args.confirmed), [undefined, false]);
  });
  it("a pending entry can't be reached through a key collision ('|' inside an id or time)", async () => {
    const s = makeSession();
    const d = makeDeps((name, args) => (args.confirmed === true ? RESCHEDULED : RESCHEDULE_NEEDS_CONFIRMATION));
    await run(s, d, "owner_reschedule_appointment", { appointment_id: "a1", new_datetime: "2026-10-16T09:00|x" });
    s.lastOwnerSpeechAt = Date.now() + 1000;
    await run(s, d, "owner_reschedule_appointment", { appointment_id: "a1|2026-10-16T09:00", new_datetime: "x", confirmed: true });
    assert.equal(d.calls.at(-1).args.confirmed, false);
  });
  it("a non-string id or time is never confirmable", async () => {
    for (const args of [{ appointment_id: 7 }, { appointment_id: { id: "a1" } }, { appointment_id: ["a1"] }, { appointment_id: "" }, {}]) {
      const s = makeSession(); const d = makeDeps(prB);
      await run(s, d, "owner_cancel_appointment", { ...args });
      s.lastOwnerSpeechAt = Date.now() + 1000;
      await run(s, d, "owner_cancel_appointment", { ...args, confirmed: true });
      assert.equal(d.calls.at(-1).args.confirmed, false, JSON.stringify(args));
    }
    const s = makeSession(); const d = makeDeps(prB);
    await run(s, d, "owner_reschedule_appointment", { appointment_id: "a1", new_datetime: 202610160900 });
    s.lastOwnerSpeechAt = Date.now() + 1000;
    await run(s, d, "owner_reschedule_appointment", { appointment_id: "a1", new_datetime: 202610160900, confirmed: true });
    assert.equal(d.calls.at(-1).args.confirmed, false);
  });
  it("read tools are unaffected — no gate, and a read result never arms a write", async () => {
    const s = makeSession();
    const d = makeDeps({ message: "ok", data: { outcome: "needs_confirmation", count: 1 } });
    const args = { range: "today", confirmed: true, appointment_id: "a1" };
    await run(s, d, "owner_list_appointments", args);
    assert.deepEqual(d.calls[0].args, args);
    assert.equal(auditFor(s, "owner_confirm_gate").length, 0);
    assert.ok(!(s.ownerPendingConfirmations instanceof Map) || s.ownerPendingConfirmations.size === 0);
  });
  it("end to end: gated confirm → read-back → owner speaks → confirm goes through → summary names the change", async () => {
    const s = makeSession(); const d = makeDeps(prB);
    await run(s, d, "owner_cancel_appointment", { appointment_id: "a1", confirmed: true }); // eager model, no read-back yet
    assert.equal(d.calls[0].args.confirmed, false);
    s.lastOwnerSpeechAt = Date.now() + 1000; // "yes, cancel it"
    const ret = await runOwnerToolCall(s, { name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } }, d.deps);
    assert.equal(d.calls[1].args.confirmed, true);
    assert.equal(ret.data.outcome, "cancelled");
    assert.equal(buildOwnerCallSummary(s.toolCallAudit), "Owner call: Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM.");
  });
});

describe("buildOwnerCallSummary", () => {
  it("joins successful, described calls in order and dedupes consecutive repeats", () => {
    const audit = [
      { name: "owner_list_appointments", successful: true, at: 1, ownerDetail: "Checked today's jobs" },
      { name: "owner_list_appointments", successful: true, at: 2, ownerDetail: "Checked today's jobs" },
      { name: "owner_reschedule_appointment", successful: false, at: 3, ownerDetail: null },
      { name: "owner_reschedule_appointment", successful: true, at: 4, ownerDetail: "Moved Jane Smith's 2:00 pm Thursday job to Friday 9:00 am." },
      { name: "end_call", successful: true, at: 5, ownerDetail: null },
    ];
    assert.equal(buildOwnerCallSummary(audit), "Owner call: Checked today's jobs; Moved Jane Smith's 2:00 pm Thursday job to Friday 9:00 am.");
  });
  it("says so when nothing happened", () => {
    assert.equal(buildOwnerCallSummary([]), "Owner call: no changes made.");
    assert.equal(buildOwnerCallSummary(undefined), "Owner call: no changes made.");
    assert.equal(buildOwnerCallSummary([{ name: "owner_cancel_appointment", successful: false, ownerDetail: "Cancelled Bob's job." }]), "Owner call: no changes made.", "a described but failed call never counts");
  });
  it("describes list ranges and dates in the owner's words", () => {
    assert.equal(describeOwnerToolCall("owner_list_appointments", { range: "this_week" }, "", true), "Checked this week's jobs");
    assert.equal(describeOwnerToolCall("owner_list_appointments", { range: "date", date: "2026-10-14" }, "", true), "Checked jobs on 2026-10-14");
    assert.equal(describeOwnerToolCall("owner_list_messages", {}, "", true), "Checked messages");
    assert.equal(describeOwnerToolCall("owner_cancel_appointment", {}, "Cancelled Bob's 3 pm job. The customer has NOT been notified.", true), "Cancelled Bob's 3 pm job.");
    assert.equal(describeOwnerToolCall("end_call", {}, "", true), null);
    assert.equal(describeOwnerToolCall("owner_cancel_appointment", {}, "x", false), null);
  });
  it("an odd range never reads a prototype property into the summary", () => {
    for (const range of ["constructor", "__proto__", "toString", undefined]) {
      assert.equal(describeOwnerToolCall("owner_list_appointments", { range }, "", true), "Checked the jobs");
    }
  });
  it("PR B's real success line: a name with full stops is kept whole, the not-notified sentence is dropped", () => {
    const msg = "Moved Dr. J. Smith Pty. Ltd. from Thursday, October 15 at 2:00 PM to Friday, October 16 at 9:00 AM. The customer has NOT been notified — I can read you their number if you want to let them know.";
    assert.equal(describeOwnerToolCall("owner_reschedule_appointment", {}, msg, true), "Moved Dr. J. Smith Pty. Ltd. from Thursday, October 15 at 2:00 PM to Friday, October 16 at 9:00 AM.");
    const longest = `Moved ${"A".repeat(80)} from Wednesday, September 30 at 12:30 PM to Wednesday, September 30 at 12:45 PM. The customer has NOT been notified.`;
    assert.equal(describeOwnerToolCall("owner_reschedule_appointment", {}, longest, true), longest.slice(0, longest.indexOf(" The customer")), "PR B's longest line fits uncut");
    assert.equal(describeOwnerToolCall("owner_cancel_appointment", {}, "", true), "Cancelled a job");
    assert.equal(describeOwnerToolCall("owner_reschedule_appointment", {}, "", true), "Moved a job");
  });
  it("through the runner: reads + a move, with gate trips, blocks and failures left out", async () => {
    const s = makeSession();
    const real = { success: true, message: "Moved Dr. Jane Smith from Thursday, October 15 at 2:00 PM to Friday, October 16 at 9:00 AM. The customer has NOT been notified — I can read you their number if you want to let them know.", data: { outcome: "rescheduled", customer_notified: false } };
    const d = makeDeps((name, args) => {
      if (name === "owner_list_appointments") return { success: true, message: "1 job tomorrow", data: { count: 1 } };
      if (name === "owner_reschedule_appointment") return args.confirmed === true ? real : RESCHEDULE_NEEDS_CONFIRMATION;
      return { message: "ok" };
    });
    await captureConsole(async () => {
      await runOwnerToolCall(s, { name: "owner_list_appointments", args: { range: "tomorrow" } }, d.deps);
      await runOwnerToolCall(s, { name: "transfer_call", args: {} }, d.deps);
      await runOwnerToolCall(s, { name: "owner_reschedule_appointment", args: { appointment_id: "a1", new_datetime: "2026-10-16T09:00", confirmed: true } }, d.deps);
      s.lastOwnerSpeechAt = Date.now() + 1000;
      await runOwnerToolCall(s, { name: "owner_reschedule_appointment", args: { appointment_id: "a1", new_datetime: "2026-10-16T09:00", confirmed: true } }, d.deps);
      await runOwnerToolCall(s, { name: "end_call", args: {} }, d.deps);
    });
    assert.equal(buildOwnerCallSummary(s.toolCallAudit), "Owner call: Checked tomorrow's jobs; Moved Dr. Jane Smith from Thursday, October 15 at 2:00 PM to Friday, October 16 at 9:00 AM.");
  });
});
