const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Set required env vars before import
process.env.OPENAI_API_KEY = "test-key";
process.env.TELNYX_API_KEY = "test-key";
process.env.INTERNAL_API_URL = "http://localhost:3000";
process.env.INTERNAL_API_SECRET = "test-secret";

// Track whether fetch is called (API round-trip indicator)
let fetchCalled = false;
global.fetch = async () => {
  fetchCalled = true;
  return {
    ok: true,
    json: async () => ({ success: true, message: "API response" }),
  };
};

const { executeToolCall, _test } = require("../services/tool-executor");
const { resolveCurrentDatetime, resolveAvailabilityFromCache } = _test;

// Shared context for tests
function makeContext(overrides = {}) {
  return {
    organizationId: "org-1",
    assistantId: "asst-1",
    callSid: null,
    callId: "call-1",
    transferRules: [],
    testMode: false,
    organization: { timezone: "Australia/Sydney", businessHours: {} },
    callerPhone: "+61400000000",
    orgPhoneNumber: "+61200000000",
    telephonyProvider: "telnyx",
    ...overrides,
  };
}

// Sample schedule snapshot
function makeSnapshot() {
  return {
    timezone: "Australia/Sydney",
    generatedAt: new Date().toISOString(),
    slots: {
      "2026-04-13": [
        { start: "2026-04-13T09:00:00+10:00", end: "2026-04-13T09:30:00+10:00" },
        { start: "2026-04-13T10:00:00+10:00", end: "2026-04-13T10:30:00+10:00" },
        { start: "2026-04-13T14:00:00+10:00", end: "2026-04-13T14:30:00+10:00" },
      ],
      "2026-04-14": [],
    },
  };
}

describe("get_current_datetime — local resolution", () => {
  beforeEach(() => {
    fetchCalled = false;
  });

  it("resolves locally when timezone is available (no API call)", async () => {
    const result = await executeToolCall(
      "get_current_datetime",
      {},
      makeContext()
    );
    assert.ok(result.message, "Should return a message");
    assert.equal(fetchCalled, false, "fetch should NOT be called");
  });

  it("message includes timezone name", async () => {
    const result = await executeToolCall(
      "get_current_datetime",
      {},
      makeContext()
    );
    assert.ok(
      result.message.includes("Australia/Sydney"),
      `Message should include timezone, got: ${result.message}`
    );
  });

  it("message includes YYYY-MM-DD format date", async () => {
    const result = await executeToolCall(
      "get_current_datetime",
      {},
      makeContext()
    );
    assert.match(
      result.message,
      /\d{4}-\d{2}-\d{2}/,
      "Message should contain a YYYY-MM-DD date"
    );
  });

  it("falls back to API when timezone is missing", async () => {
    const result = await executeToolCall(
      "get_current_datetime",
      {},
      makeContext({ organization: { timezone: null } })
    );
    assert.equal(fetchCalled, true, "fetch SHOULD be called as fallback");
  });
});

describe("check_availability — cache resolution", () => {
  beforeEach(() => {
    fetchCalled = false;
  });

  it("resolves from cache for a cached date (no API call)", async () => {
    const result = await executeToolCall(
      "check_availability",
      { date: "2026-04-13" },
      makeContext({ scheduleSnapshot: makeSnapshot() })
    );
    assert.ok(result.message, "Should return a message");
    assert.equal(fetchCalled, false, "fetch should NOT be called");
  });

  it("falls back to API for uncached dates (API call made)", async () => {
    const result = await executeToolCall(
      "check_availability",
      { date: "2026-04-20" }, // not in snapshot
      makeContext({ scheduleSnapshot: makeSnapshot() })
    );
    assert.equal(fetchCalled, true, "fetch SHOULD be called for cache miss");
  });

  it("falls back to API when no scheduleSnapshot on context", async () => {
    const result = await executeToolCall(
      "check_availability",
      { date: "2026-04-13" },
      makeContext() // no scheduleSnapshot
    );
    assert.equal(fetchCalled, true, "fetch SHOULD be called without snapshot");
  });

  it("returns formatted slot times with count", async () => {
    const result = await executeToolCall(
      "check_availability",
      { date: "2026-04-13" },
      makeContext({ scheduleSnapshot: makeSnapshot() })
    );
    assert.ok(
      result.message.includes("3 available slots"),
      `Should mention slot count, got: ${result.message}`
    );
    // Should contain AM/PM formatted times
    assert.match(
      result.message,
      /\d{1,2}:\d{2}\s*(AM|PM)/i,
      "Should contain formatted times"
    );
  });

  it("handles fully booked day correctly", async () => {
    const result = await executeToolCall(
      "check_availability",
      { date: "2026-04-14" }, // empty slots array in snapshot
      makeContext({ scheduleSnapshot: makeSnapshot() })
    );
    assert.equal(fetchCalled, false, "fetch should NOT be called");
    assert.ok(
      result.message.includes("No available slots"),
      `Should say no slots, got: ${result.message}`
    );
    assert.ok(
      result.message.includes("Fully booked"),
      `Should say fully booked, got: ${result.message}`
    );
  });

  it("includes slot duration in message", async () => {
    const result = await executeToolCall(
      "check_availability",
      { date: "2026-04-13" },
      makeContext({ scheduleSnapshot: makeSnapshot() })
    );
    assert.ok(
      result.message.includes("30-minute slots"),
      `Should include duration, got: ${result.message}`
    );
  });
});

describe("write operations always use API", () => {
  beforeEach(() => {
    fetchCalled = false;
  });

  it("book_appointment always calls API even with cache present", async () => {
    await executeToolCall(
      "book_appointment",
      {
        datetime: "2026-04-13T09:00:00",
        first_name: "Jane",
        last_name: "Doe",
        phone: "+61400000001",
      },
      makeContext({ scheduleSnapshot: makeSnapshot() })
    );
    assert.equal(fetchCalled, true, "fetch MUST be called for book_appointment");
  });

  it("cancel_appointment always calls API even with cache present", async () => {
    await executeToolCall(
      "cancel_appointment",
      { phone: "+61400000001", date: "2026-04-13" },
      makeContext({ scheduleSnapshot: makeSnapshot() })
    );
    assert.equal(
      fetchCalled,
      true,
      "fetch MUST be called for cancel_appointment"
    );
  });
});

describe("resolveCurrentDatetime unit", () => {
  it("returns message with correct timezone", () => {
    const result = resolveCurrentDatetime("America/New_York");
    assert.ok(result.message.includes("America/New_York"));
    assert.match(result.message, /\d{4}-\d{2}-\d{2}/);
  });
});

describe("resolveAvailabilityFromCache unit", () => {
  it("returns null on missing date arg", () => {
    const result = resolveAvailabilityFromCache({}, makeSnapshot());
    assert.equal(result, null);
  });

  it("returns null when date not in snapshot", () => {
    const result = resolveAvailabilityFromCache(
      { date: "2099-01-01" },
      makeSnapshot()
    );
    assert.equal(result, null);
  });

  it("handles single slot correctly", () => {
    const snapshot = {
      timezone: "Australia/Sydney",
      generatedAt: new Date().toISOString(),
      slots: {
        "2026-04-15": [
          { start: "2026-04-15T11:00:00+10:00", end: "2026-04-15T11:30:00+10:00" },
        ],
      },
    };
    const result = resolveAvailabilityFromCache({ date: "2026-04-15" }, snapshot);
    assert.ok(result);
    assert.ok(
      result.message.includes("1 available slot"),
      `Should say "1 available slot" (singular), got: ${result.message}`
    );
    // No trailing "s" on "slot"
    assert.ok(
      !result.message.includes("1 available slots"),
      "Should not pluralize for single slot"
    );
  });
});
