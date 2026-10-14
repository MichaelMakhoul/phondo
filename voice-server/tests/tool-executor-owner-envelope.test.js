"use strict";
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-587 — authority leaves the voice server ONLY as the top-level
// `ownerVerified: true` envelope field (never inside `arguments`, never in
// test mode), PR B's `data` rides back to the model, and PR B's 403 refusal
// message is surfaced verbatim as a non-success.
process.env.OPENAI_API_KEY = "test-key";
process.env.INTERNAL_API_URL = "http://localhost:3000";
process.env.INTERNAL_API_SECRET = "test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";

let fetches = [];
let nextResponse = null;
global.fetch = async (url, init) => {
  fetches.push({ url, init, raw: init.body, body: JSON.parse(init.body) });
  return nextResponse || { ok: true, json: async () => ({ message: "Moved it.", data: { outcome: "rescheduled", customer_notified: false } }) };
};
const { executeToolCall } = require("../services/tool-executor");

/** The customer fallback for a non-2xx — an owner must never be offered this. */
const CUSTOMER_TROUBLE = "I'm having trouble with that right now. Would you like me to take your information instead?";

function ctx(overrides = {}) {
  return { organizationId: "org-1", assistantId: "asst-1", callSid: "CA1", callId: "call-1", callerPhone: "+61400000001", organization: { timezone: "Australia/Sydney" }, ...overrides };
}
const ARGS = { appointment_id: "a1", new_datetime: "2026-10-15T09:00", confirmed: true };

describe("ownerVerified envelope", () => {
  beforeEach(() => { fetches = []; nextResponse = null; });
  it("is sent top-level, beside functionName, only when context.ownerMode === true", async () => {
    await executeToolCall("owner_reschedule_appointment", ARGS, ctx({ ownerMode: true }));
    const body = fetches[0].body;
    assert.equal(body.ownerVerified, true);
    assert.equal(body.functionName, "owner_reschedule_appointment");
    assert.equal(body.callId, "call-1");
    assert.equal(body.arguments.ownerVerified, undefined);
  });
  it("is absent for customer sessions, even if the model smuggles it into arguments", async () => {
    await executeToolCall("owner_reschedule_appointment", { ...ARGS, ownerVerified: true }, ctx());
    assert.equal(fetches[0].body.ownerVerified, undefined);
    await executeToolCall("owner_reschedule_appointment", ARGS, ctx({ ownerMode: "true" }));
    assert.equal(fetches[1].body.ownerVerified, undefined);
    await executeToolCall("owner_reschedule_appointment", ARGS, ctx({ ownerMode: 1 }));
    assert.equal(fetches[2].body.ownerVerified, undefined);
    assert.ok(fetches.every((f) => !("ownerVerified" in f.body)), "no ownerVerified key at all");
  });
  it("is never sent in test mode (reads stay real, without authority)", async () => {
    await executeToolCall("owner_list_appointments", { range: "today" }, ctx({ ownerMode: true, testMode: true, callId: undefined }));
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].body.ownerVerified, undefined);
  });
  it("is never sent in test mode even when a callId is present — testMode alone withholds it", async () => {
    await executeToolCall("owner_list_appointments", { range: "today" }, ctx({ ownerMode: true, testMode: true }));
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].body.callId, "call-1");
    assert.ok(!("ownerVerified" in fetches[0].body));
    // Fail safe: any truthy testMode withholds authority, not only the boolean.
    await executeToolCall("owner_list_appointments", { range: "today" }, ctx({ ownerMode: true, testMode: 1 }));
    assert.ok(!("ownerVerified" in fetches[1].body));
  });
});

// The customer request must not change by one byte: these are the exact bodies
// the pre-SCRUM-587 executeCalendarCall produced (verified against the parent
// commit), for each caller-ID state, with and without a stray ownerMode.
describe("customer envelope is byte-identical on the wire", () => {
  beforeEach(() => { fetches = []; nextResponse = { ok: true, json: async () => ({ success: true, message: "ok" }) }; });
  const CASES = [
    {
      label: "production call, verified caller ID, collected details",
      fn: "book_appointment",
      args: { datetime: "2026-10-15T09:00:00", first_name: "Jane", last_name: "Doe" },
      context: { organizationId: "org-1", assistantId: "asst-1", callSid: "CA1", callId: "call-1", callerPhone: "+61400000001", collectedDetails: { first_name: "Jane" } },
      raw: '{"organizationId":"org-1","assistantId":"asst-1","functionName":"book_appointment","arguments":{"datetime":"2026-10-15T09:00:00","first_name":"Jane","last_name":"Doe","phone":"+61400000001"},"callId":"call-1","callerIdState":"verified","callerPhone":"+61400000001","collectedDetails":{"first_name":"Jane"}}',
    },
    {
      label: "production call, withheld caller ID",
      fn: "cancel_appointment",
      args: { date: "2026-10-15" },
      context: { organizationId: "org-1", assistantId: "asst-1", callSid: "CA2", callId: "call-2", callerPhone: "anonymous" },
      raw: '{"organizationId":"org-1","assistantId":"asst-1","functionName":"cancel_appointment","arguments":{"date":"2026-10-15"},"callId":"call-2","callerIdState":"withheld"}',
    },
    {
      label: "browser test session (read)",
      fn: "lookup_appointment",
      args: { name: "Jane Doe" },
      context: { organizationId: "org-1", assistantId: "asst-1", callSid: "test_1", testMode: true },
      raw: '{"organizationId":"org-1","assistantId":"asst-1","functionName":"lookup_appointment","arguments":{"name":"Jane Doe"}}',
    },
  ];
  for (const c of CASES) {
    it(`${c.label}: same URL, method, headers and body bytes — ownerMode absent, false, "true" or 1`, async () => {
      for (const ownerMode of [undefined, false, "true", 1]) {
        fetches = [];
        const context = ownerMode === undefined ? { ...c.context } : { ...c.context, ownerMode };
        await executeToolCall(c.fn, { ...c.args }, context);
        assert.equal(fetches.length, 1, `ownerMode=${String(ownerMode)}`);
        const f = fetches[0];
        assert.equal(f.url, "http://localhost:3000/api/internal/tool-call");
        assert.equal(f.init.method, "POST");
        assert.deepEqual(f.init.headers, { "Content-Type": "application/json", "X-Internal-Secret": "test-secret" });
        assert.equal(f.raw, c.raw, `ownerMode=${String(ownerMode)}`);
      }
    });
  }
  it("an owner session's body is the customer body plus one trailing top-level ownerVerified:true", async () => {
    const context = { organizationId: "org-1", assistantId: "asst-1", callSid: "CA3", callId: "call-3", callerPhone: "+61400000009" };
    const args = { appointment_id: "a1", confirmed: true };
    await executeToolCall("owner_cancel_appointment", args, context);
    await executeToolCall("owner_cancel_appointment", args, { ...context, ownerMode: true });
    const expectedCustomer = '{"organizationId":"org-1","assistantId":"asst-1","functionName":"owner_cancel_appointment","arguments":{"appointment_id":"a1","confirmed":true},"callId":"call-3","callerIdState":"verified","callerPhone":"+61400000009"}';
    assert.equal(fetches[0].raw, expectedCustomer);
    assert.equal(fetches[1].raw, expectedCustomer.slice(0, -1) + ',"ownerVerified":true}');
  });
});

describe("PR B result shape", () => {
  beforeEach(() => { fetches = []; nextResponse = null; });
  it("forwards data (outcome, customer_notified) to the caller", async () => {
    const r = await executeToolCall("owner_reschedule_appointment", ARGS, ctx({ ownerMode: true }));
    assert.equal(r.message, "Moved it.");
    assert.deepEqual(r.data, { outcome: "rescheduled", customer_notified: false });
  });
  it("forwards success/error alongside data exactly as PR B sent them", async () => {
    nextResponse = { ok: true, json: async () => ({ success: false, message: "That booking lives in your Cliniko diary.", data: { outcome: "external_calendar", appointment_id: "a1", customer_notified: false } }) };
    const r = await executeToolCall("owner_cancel_appointment", { appointment_id: "a1", confirmed: true }, ctx({ ownerMode: true }));
    assert.deepEqual(r, { message: "That booking lives in your Cliniko diary.", success: false, data: { outcome: "external_calendar", appointment_id: "a1", customer_notified: false } });
  });
  it("adds no data key when the API returned none (customer results unchanged)", async () => {
    nextResponse = { ok: true, json: async () => ({ success: true, message: "Booked." }) };
    const r = await executeToolCall("book_appointment", { datetime: "2026-10-15T09:00:00", first_name: "Jane", last_name: "Doe" }, ctx());
    assert.deepEqual(r, { message: "Booked.", success: true });
  });
  it("surfaces a 403 refusal message verbatim as a non-success, never the generic trouble line", async () => {
    nextResponse = { ok: false, status: 403, text: async () => JSON.stringify({ success: false, error: true, message: "That isn't available on this call." }) };
    const r = await executeToolCall("owner_cancel_appointment", { appointment_id: "a1", confirmed: true }, ctx());
    assert.deepEqual(r, { message: "That isn't available on this call.", success: false, error: true });
  });
  it("keeps the generic message for non-JSON / message-less failures", async () => {
    nextResponse = { ok: false, status: 500, text: async () => "Internal Server Error" };
    const r = await executeToolCall("owner_cancel_appointment", { appointment_id: "a1", confirmed: true }, ctx({ ownerMode: true }));
    assert.ok(r.message.startsWith("I'm having trouble with that right now"));
    assert.equal(r.error, undefined);
  });
  it("never hands an owner_* tool the customer fallback, whatever the non-2xx body", async () => {
    const bodies = [
      [500, "Internal Server Error"],
      [504, "<html>gateway timeout</html>"],
      [429, JSON.stringify({ error: "Too many requests" })],
      [401, JSON.stringify({ error: "Unauthorized" })],
      [500, JSON.stringify({ message: "   " })],
      [500, JSON.stringify({ message: 42 })],
      [500, "null"],
      [500, JSON.stringify(["message"])],
    ];
    for (const fn of ["owner_list_appointments", "owner_list_messages", "owner_reschedule_appointment", "owner_cancel_appointment"]) {
      for (const [status, text] of bodies) {
        nextResponse = { ok: false, status, text: async () => text };
        const r = await executeToolCall(fn, { range: "today", appointment_id: "a1" }, ctx({ ownerMode: true }));
        assert.ok(!r.message.includes("take your information"), `${fn} ${status} ${text}: ${r.message}`);
        assert.ok(r.message.startsWith("I'm having trouble with that right now"), `${fn} ${status} ${text}`);
        assert.equal(r.success, false, `${fn} ${status}: a non-2xx is never a success`);
        assert.equal(r.error, undefined);
        assert.equal(r.data, undefined);
        // A failed WRITE may still have landed — never let it read as "nothing changed".
        if (["owner_reschedule_appointment", "owner_cancel_appointment"].includes(fn)) assert.match(r.message, /can't confirm the change went through/, fn);
        else assert.doesNotMatch(r.message, /change/, `${fn} is a read: ${r.message}`);
      }
    }
  });
  it("still raises the [ALERT:error] line on an owner refusal", async () => {
    const origError = console.error;
    const lines = [];
    console.error = (...a) => { lines.push(a.join(" ")); };
    try {
      nextResponse = { ok: false, status: 403, text: async () => JSON.stringify({ success: false, error: true, message: "That isn't available on this call." }) };
      await executeToolCall("owner_cancel_appointment", { appointment_id: "a1", confirmed: true }, ctx());
    } finally {
      console.error = origError;
    }
    const alert = lines.find((l) => l.includes("[ALERT:error]"));
    assert.ok(alert, "a refused owner tool must still page");
    assert.match(alert, /owner_cancel_appointment/);
  });
});

describe("customer non-2xx handling is unchanged", () => {
  beforeEach(() => { fetches = []; nextResponse = null; });
  it("a customer tool never surfaces a non-2xx body's message — it keeps the exact generic fallback", async () => {
    const bodies = [
      [500, JSON.stringify({ success: false, error: true, message: "Some internal detail" })],
      [403, JSON.stringify({ success: false, error: true, message: "That isn't available on this call." })],
      [500, "Internal Server Error"],
      [429, JSON.stringify({ error: "Too many requests" })],
    ];
    for (const fn of ["reschedule_appointment", "book_appointment", "check_availability", "schedule_callback"]) {
      for (const [status, text] of bodies) {
        nextResponse = { ok: false, status, text: async () => text };
        const r = await executeToolCall(fn, { date: "2026-10-15", new_datetime: "2026-10-15T09:00:00" }, ctx());
        assert.deepEqual(r, { message: CUSTOMER_TROUBLE }, `${fn} ${status} ${text}`);
      }
    }
  });
});
