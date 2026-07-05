const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-509: a calendar tool that fails GRACEFULLY (the Next.js handler caught
// its own fault and returned HTTP 200 + success:false) was invisible to the
// Grafana "error logged" alert — only HTTP errors / timeouts emit [ALERT:error]
// via the Sentry shim. This is the exact blind spot the reschedule failure fell
// through. The handler now flags genuine errors with `error:true`; the voice
// server must turn that into an [ALERT:error] line, while a normal business
// non-success (slot taken, "which appointment?") stays quiet.

process.env.OPENAI_API_KEY = "test-key";
process.env.TELNYX_API_KEY = "test-key";
process.env.INTERNAL_API_URL = "http://localhost:3000";
process.env.INTERNAL_API_SECRET = "test-secret";

const { executeToolCall } = require("../services/tool-executor");

const CTX = {
  organizationId: "org-1",
  assistantId: "asst-1",
  callId: "call-1",
  callSid: "CA-test-509",
  callerPhone: "+61414141883",
};
const ARGS = { new_datetime: "2027-07-02T10:00:00" };

describe("SCRUM-509: genuine tool errors alert; business non-success stays quiet", () => {
  let origFetch;
  let origError;
  let errorLogs;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    origError = console.error;
    errorLogs = [];
    console.error = (...a) => {
      errorLogs.push(a.join(" "));
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.error = origError;
  });

  const mockApi = (body) => {
    globalThis.fetch = async () => ({ ok: true, json: async () => body });
  };
  const alertLine = () => errorLogs.find((l) => l.includes("[ALERT:error]"));

  it("emits [ALERT:error] and forwards error:true on a genuine error result (HTTP 200 + success:false + error:true)", async () => {
    mockApi({ message: "I'm having trouble rescheduling that right now.", success: false, error: true });
    const result = await executeToolCall("reschedule_appointment", ARGS, CTX);

    assert.equal(result.success, false);
    assert.equal(result.error, true, "the error flag must survive back to the caller");
    const alert = alertLine();
    assert.ok(alert, "a genuine tool error must emit an [ALERT:error] line the Grafana alert can see");
    assert.match(alert, /reschedule_appointment/);
    assert.match(alert, /tool-executor/);
  });

  it("does NOT alert on a business non-success (success:false, no error flag)", async () => {
    mockApi({ message: "That time is no longer available. Would you like another slot?", success: false });
    const result = await executeToolCall("reschedule_appointment", ARGS, CTX);

    assert.equal(result.success, false);
    assert.equal("error" in result, false, "a business non-success must not carry an error flag");
    assert.equal(Boolean(alertLine()), false, "a normal 'slot taken' outcome must never alert");
  });

  it("does NOT alert on success", async () => {
    mockApi({ message: "Done — I've moved your appointment.", success: true });
    const result = await executeToolCall("reschedule_appointment", ARGS, CTX);

    assert.equal(result.success, true);
    assert.equal(Boolean(alertLine()), false);
  });
});
