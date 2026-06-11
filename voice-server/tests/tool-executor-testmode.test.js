// SCRUM-452: test-mode simulation coverage for MUTATING tools.
//
// Browser test calls (/ws/test) run against the user's REAL organization, so
// every tool that mutates appointment rows MUST be simulated in test mode.
// reschedule_appointment used to fall through to the real internal API — a
// user testing their assistant who said "move my appointment" created a real
// reschedule leg and freed the real slot. These tests pin that NO internal-API
// fetch happens for ANY mutating calendar tool (and schedule_callback) when
// context.testMode is true, and that production mode still routes to the API.

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Set required env vars before import — executeCalendarCall only attempts the
// fetch when these are configured, so without them a fall-through would be
// invisible to the fetch counter.
process.env.OPENAI_API_KEY = "test-key";
process.env.TELNYX_API_KEY = "test-key";
process.env.INTERNAL_API_URL = "http://localhost:3000";
process.env.INTERNAL_API_SECRET = "test-secret";

// Count fetch calls (internal-API round-trip indicator)
let fetchCalls = 0;
global.fetch = async () => {
  fetchCalls += 1;
  return {
    ok: true,
    json: async () => ({ success: true, message: "API response" }),
  };
};

const { executeToolCall } = require("../services/tool-executor");

// Mirrors the context built for /ws/test sessions in server.js
function makeTestContext(overrides = {}) {
  return {
    organizationId: "org-1",
    assistantId: "asst-1",
    callSid: "test_abc123",
    transferRules: [],
    testMode: true,
    organization: { timezone: "Australia/Sydney", businessHours: {} },
    ...overrides,
  };
}

describe("test mode — mutating tools never hit the internal API (SCRUM-452)", () => {
  beforeEach(() => {
    fetchCalls = 0;
  });

  it("book_appointment is simulated (zero fetches)", async () => {
    const result = await executeToolCall(
      "book_appointment",
      { datetime: "2026-06-18T10:00:00", first_name: "Jane", last_name: "Doe", phone: "+61400000001" },
      makeTestContext()
    );
    assert.equal(fetchCalls, 0, "fetch must NOT be called in test mode");
    assert.match(result.message, /confirmed/i);
    assert.match(result.message, /Jane Doe/);
  });

  it("cancel_appointment is simulated (zero fetches)", async () => {
    const result = await executeToolCall(
      "cancel_appointment",
      { phone: "+61400000001", date: "2026-06-18" },
      makeTestContext()
    );
    assert.equal(fetchCalls, 0, "fetch must NOT be called in test mode");
    assert.match(result.message, /cancelled/i);
  });

  it("reschedule_appointment is simulated (zero fetches) — the SCRUM-452 regression", async () => {
    const result = await executeToolCall(
      "reschedule_appointment",
      { phone: "+61400000001", current_datetime: "2026-06-18T10:00:00", new_datetime: "2026-06-19T14:00:00" },
      makeTestContext()
    );
    assert.equal(fetchCalls, 0, "fetch must NOT be called in test mode — a real reschedule leg would be created");
    // Conversationally plausible: confirms the move and the NEW time, mirroring
    // the real handler's "Done — I've moved your appointment from X" wording.
    assert.match(result.message, /moved your appointment/i);
    assert.match(result.message, /2026-06-19T14:00:00/);
    assert.match(result.message, /2026-06-18T10:00:00/);
  });

  it("reschedule_appointment simulation works without a current_datetime", async () => {
    const result = await executeToolCall(
      "reschedule_appointment",
      { phone: "+61400000001", new_datetime: "2026-06-19T14:00:00" },
      makeTestContext()
    );
    assert.equal(fetchCalls, 0, "fetch must NOT be called in test mode");
    assert.match(result.message, /moved your appointment/i);
    assert.match(result.message, /2026-06-19T14:00:00/);
    assert.ok(!/undefined/.test(result.message), `no "undefined" leaking into speech, got: ${result.message}`);
  });

  it("schedule_callback is simulated (zero fetches)", async () => {
    const result = await executeToolCall(
      "schedule_callback",
      { caller_name: "Jane Doe", caller_phone: "+61400000001", reason: "billing question" },
      makeTestContext()
    );
    assert.equal(fetchCalls, 0, "fetch must NOT be called in test mode");
    assert.match(result.message, /callback/i);
  });

  it("no simulated message reads as a failure to the prose success-detector", async () => {
    // conversationrelay.js derives success from prose when the result has no
    // structured `success` boolean — a simulated message that matched its
    // fail-signal regex would make the model retry/apologize in test calls.
    const failSignal = /\b(error|not found|couldn'?t|could not|unable|failed|no longer available|already booked|fully booked|no available slot|not configured)\b/i;
    const calls = [
      ["book_appointment", { datetime: "2026-06-18T10:00:00", first_name: "Jane", phone: "+61400000001" }],
      ["cancel_appointment", { phone: "+61400000001" }],
      ["reschedule_appointment", { phone: "+61400000001", new_datetime: "2026-06-19T14:00:00" }],
      ["schedule_callback", { caller_name: "Jane", caller_phone: "+61400000001", reason: "billing" }],
    ];
    for (const [name, args] of calls) {
      const result = await executeToolCall(name, args, makeTestContext());
      assert.ok(!failSignal.test(result.message), `${name} simulation reads as failure: ${result.message}`);
    }
    assert.equal(fetchCalls, 0, "no mutating tool may reach the internal API in test mode");
  });
});

describe("production mode — mutating tools still route to the internal API", () => {
  beforeEach(() => {
    fetchCalls = 0;
  });

  it("reschedule_appointment calls the API when testMode is false", async () => {
    await executeToolCall(
      "reschedule_appointment",
      { phone: "+61400000001", current_datetime: "2026-06-18T10:00:00", new_datetime: "2026-06-19T14:00:00" },
      makeTestContext({ testMode: false, callerPhone: "+61400000001" })
    );
    assert.equal(fetchCalls, 1, "fetch MUST be called in production mode");
  });

  it("book_appointment calls the API when testMode is false", async () => {
    await executeToolCall(
      "book_appointment",
      { datetime: "2026-06-18T10:00:00", first_name: "Jane", phone: "+61400000001" },
      makeTestContext({ testMode: false, callerPhone: "+61400000001" })
    );
    assert.equal(fetchCalls, 1, "fetch MUST be called in production mode");
  });
});

describe("test mode — reads intentionally stay real", () => {
  beforeEach(() => {
    fetchCalls = 0;
  });

  it("lookup_appointment still hits the API in test mode (read-only)", async () => {
    await executeToolCall(
      "lookup_appointment",
      { phone: "+61400000001" },
      makeTestContext()
    );
    assert.equal(fetchCalls, 1, "reads hit the real API so the LLM gets realistic data");
  });
});
