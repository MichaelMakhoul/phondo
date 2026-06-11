const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Set required env vars before import
process.env.OPENAI_API_KEY = "test-key";
process.env.TELNYX_API_KEY = "test-key";
process.env.INTERNAL_API_URL = "http://localhost:3000";
process.env.INTERNAL_API_SECRET = "test-secret";

const { executeToolCall, calendarToolDefinitions, _test } = require("../services/tool-executor");
const { isDialableCallerId } = _test;

// SCRUM-438: the session's VERIFIED caller ID (the call's real From) must be
// threaded to the internal API as a TOP-LEVEL trusted field — never inside
// `arguments`, which the model controls. The Next.js handlers use it as the
// possession factor for cancel/reschedule ownership.

const CALLER = "+61414141883";

function baseContext(overrides = {}) {
  return {
    organizationId: "org-1",
    assistantId: "asst-1",
    callId: "call-1",
    ...overrides,
  };
}

describe("trusted caller ID threading (SCRUM-438)", () => {
  let origFetch;
  let capturedBody;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    capturedBody = null;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ message: "ok", success: true }) };
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("sends the session caller ID as a TOP-LEVEL callerPhone field for cancel_appointment", async () => {
    await executeToolCall("cancel_appointment", { phone: "+61400000000" }, baseContext({ callerPhone: CALLER }));
    assert.equal(capturedBody.callerPhone, CALLER);
    // The model-supplied phone stays where it belongs — inside arguments.
    assert.equal(capturedBody.arguments.phone, "+61400000000");
  });

  it("sends it for reschedule_appointment too", async () => {
    await executeToolCall(
      "reschedule_appointment",
      { new_datetime: "2027-07-02T10:00:00" },
      baseContext({ callerPhone: CALLER }),
    );
    assert.equal(capturedBody.callerPhone, CALLER);
  });

  it("a model-injected `callerPhone` ARGUMENT can never become the trusted field", async () => {
    await executeToolCall(
      "cancel_appointment",
      { phone: "+61400000000", callerPhone: "+61499999999" }, // model tries to spoof
      baseContext({ callerPhone: CALLER }),
    );
    // Top-level field comes from the SESSION, not the model.
    assert.equal(capturedBody.callerPhone, CALLER);
    // The injected value stays quarantined inside arguments.
    assert.equal(capturedBody.arguments.callerPhone, "+61499999999");
  });

  it("omits callerPhone entirely when the session has none (browser test calls)", async () => {
    await executeToolCall("cancel_appointment", { phone: "+61400000000" }, baseContext());
    assert.equal("callerPhone" in capturedBody, false);
  });

  it("omits callerPhone for withheld-ID sentinels and SIP URIs", async () => {
    for (const sentinel of ["anonymous", "Restricted", "unavailable", "sip:alice@example.com"]) {
      capturedBody = null;
      await executeToolCall("cancel_appointment", { phone: "+61400000000" }, baseContext({ callerPhone: sentinel }));
      assert.equal("callerPhone" in capturedBody, false, sentinel);
    }
  });
});

describe("isDialableCallerId", () => {
  it("accepts real numbers in the 8-15 digit window", () => {
    assert.equal(isDialableCallerId("+61414141883"), true);
    assert.equal(isDialableCallerId("0414 141 883"), true);
    assert.equal(isDialableCallerId("+14155551234"), true);
  });

  it("rejects sentinels, SIP URIs, and out-of-window digit counts", () => {
    assert.equal(isDialableCallerId("anonymous"), false);
    assert.equal(isDialableCallerId("sip:alice@example.com"), false);
    assert.equal(isDialableCallerId("12345"), false);
    assert.equal(isDialableCallerId("1234567890123456"), false);
    assert.equal(isDialableCallerId(undefined), false);
    assert.equal(isDialableCallerId(""), false);
  });
});

describe("cancel/reschedule tool schemas expose verification fields (SCRUM-438)", () => {
  const byName = (name) => calendarToolDefinitions.find((d) => d.function.name === name);

  it("cancel_appointment exposes name and email", () => {
    const props = byName("cancel_appointment").function.parameters.properties;
    assert.ok(props.name, "cancel_appointment must expose `name`");
    assert.ok(props.email, "cancel_appointment must expose `email`");
  });

  it("reschedule_appointment exposes name and email, and `name` is documented as verification-only", () => {
    const props = byName("reschedule_appointment").function.parameters.properties;
    assert.ok(props.name, "reschedule_appointment must expose `name`");
    assert.ok(props.email, "reschedule_appointment must expose `email`");
    assert.match(props.name.description, /verification/i);
    // Renames must keep flowing through first_name/last_name.
    assert.match(props.name.description, /first_name/);
  });
});
