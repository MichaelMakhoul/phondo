const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Set required env vars before import
process.env.OPENAI_API_KEY = "test-key";
process.env.TELNYX_API_KEY = "test-key";
process.env.INTERNAL_API_URL = "http://localhost:3000";
process.env.INTERNAL_API_SECRET = "test-secret";

const { executeToolCall, _test } = require("../services/tool-executor");
const { resolveCollectedDetailsField } = _test;

// SCRUM-506: the per-call collected caller details ride to the internal API as a
// TOP-LEVEL trusted field (`collectedDetails`), exactly like the caller-ID
// fields — NEVER inside `arguments` (which the model controls). Handlers backfill
// a MISSING verification factor from it so the AI doesn't re-ask.

function baseContext(overrides = {}) {
  return { organizationId: "org-1", assistantId: "asst-1", callId: "call-1", ...overrides };
}

const DETAILS = { name: "Michael Makhoul", email: "m@example.com" };

describe("collected-details threading (SCRUM-506)", () => {
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

  for (const fn of ["cancel_appointment", "reschedule_appointment", "lookup_appointment"]) {
    it(`sends collectedDetails as a TOP-LEVEL field for ${fn}`, async () => {
      await executeToolCall(fn, { phone: "+61400000000" }, baseContext({ collectedDetails: DETAILS }));
      assert.deepEqual(capturedBody.collectedDetails, DETAILS);
      // NEVER inside arguments (the model-controlled bag).
      assert.equal("collectedDetails" in capturedBody.arguments, false);
    });
  }

  it("omits the field entirely when the store is empty", async () => {
    await executeToolCall("cancel_appointment", { phone: "+61400000000" }, baseContext({ collectedDetails: {} }));
    assert.equal("collectedDetails" in capturedBody, false);
  });

  it("omits the field when the context has no collectedDetails at all", async () => {
    await executeToolCall("cancel_appointment", { phone: "+61400000000" }, baseContext());
    assert.equal("collectedDetails" in capturedBody, false);
  });

  it("a model-injected `collectedDetails` ARGUMENT stays quarantined in arguments (can't become the trusted field)", async () => {
    await executeToolCall(
      "cancel_appointment",
      { phone: "+61400000000", collectedDetails: { name: "Spoofed" } }, // model tries to inject
      baseContext({ collectedDetails: DETAILS }),
    );
    // Top-level trusted field comes from the SESSION store, not the model.
    assert.deepEqual(capturedBody.collectedDetails, DETAILS);
    // The injected value stays quarantined inside arguments.
    assert.deepEqual(capturedBody.arguments.collectedDetails, { name: "Spoofed" });
  });
});

describe("resolveCollectedDetailsField (SCRUM-506)", () => {
  it("returns the field only when it is a non-empty plain object", () => {
    assert.deepEqual(resolveCollectedDetailsField({ collectedDetails: { name: "A" } }), { collectedDetails: { name: "A" } });
    assert.deepEqual(resolveCollectedDetailsField({ collectedDetails: {} }), {});
    assert.deepEqual(resolveCollectedDetailsField({}), {});
    assert.deepEqual(resolveCollectedDetailsField({ collectedDetails: null }), {});
    assert.deepEqual(resolveCollectedDetailsField({ collectedDetails: ["x"] }), {}); // arrays rejected
  });
});
