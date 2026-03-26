const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// Mock fetch globally before requiring the module
const originalFetch = global.fetch;

describe("telnyx-transfer", () => {
  let transferCall, sendTransferSMS;

  beforeEach(() => {
    // Fresh require for each test to reset module-level state
    delete require.cache[require.resolve("../services/telnyx-transfer")];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TELNYX_API_KEY;
  });

  describe("transferCall", () => {
    it("should return not_configured when TELNYX_API_KEY is missing", async () => {
      delete process.env.TELNYX_API_KEY;
      ({ transferCall } = require("../services/telnyx-transfer"));
      const result = await transferCall("call123", "+61400000000", "Connecting you");
      assert.equal(result.success, false);
      assert.equal(result.outcome, "not_configured");
    });

    it("should return initiated on successful transfer", async () => {
      process.env.TELNYX_API_KEY = "test-key";
      global.fetch = async () => ({ ok: true, json: async () => ({ data: {} }) });
      ({ transferCall } = require("../services/telnyx-transfer"));
      const result = await transferCall("call123", "+61400000000", "Connecting you");
      assert.equal(result.success, true);
      assert.equal(result.outcome, "initiated");
    });

    it("should return failed on API error", async () => {
      process.env.TELNYX_API_KEY = "test-key";
      global.fetch = async () => ({ ok: false, status: 404, text: async () => "Not found" });
      ({ transferCall } = require("../services/telnyx-transfer"));
      const result = await transferCall("call123", "+61400000000", "Connecting you");
      assert.equal(result.success, false);
      assert.equal(result.outcome, "failed");
    });

    it("should return error on network failure", async () => {
      process.env.TELNYX_API_KEY = "test-key";
      global.fetch = async () => { throw new Error("Network timeout"); };
      ({ transferCall } = require("../services/telnyx-transfer"));
      const result = await transferCall("call123", "+61400000000", "Connecting you");
      assert.equal(result.success, false);
      assert.equal(result.outcome, "error");
    });

    it("should pass fromPhone in options", async () => {
      process.env.TELNYX_API_KEY = "test-key";
      let capturedBody;
      global.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ data: {} }) };
      };
      ({ transferCall } = require("../services/telnyx-transfer"));
      await transferCall("call123", "+61400000000", "Connecting", { fromPhone: "+61200000000" });
      assert.equal(capturedBody.from, "+61200000000");
    });
  });

  describe("sendTransferSMS", () => {
    it("should return null when API key is missing", async () => {
      delete process.env.TELNYX_API_KEY;
      ({ sendTransferSMS } = require("../services/telnyx-transfer"));
      const result = await sendTransferSMS("+61400000000", "+61200000000", "Test");
      assert.equal(result, null);
    });

    it("should return message ID on success", async () => {
      process.env.TELNYX_API_KEY = "test-key";
      global.fetch = async () => ({ ok: true, json: async () => ({ data: { id: "msg_123" } }) });
      ({ sendTransferSMS } = require("../services/telnyx-transfer"));
      const result = await sendTransferSMS("+61400000000", "+61200000000", "Transfer context");
      assert.equal(result, "msg_123");
    });

    it("should return null on API error", async () => {
      process.env.TELNYX_API_KEY = "test-key";
      global.fetch = async () => ({ ok: false, status: 400, text: async () => "Bad request" });
      ({ sendTransferSMS } = require("../services/telnyx-transfer"));
      const result = await sendTransferSMS("+61400000000", "+61200000000", "Test");
      assert.equal(result, null);
    });
  });
});
