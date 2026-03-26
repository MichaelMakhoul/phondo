const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Set required env vars before import
process.env.OPENAI_API_KEY = "test-key";
process.env.TELNYX_API_KEY = "test-key";
process.env.INTERNAL_API_URL = "http://localhost:3000";
process.env.INTERNAL_API_SECRET = "test-secret";

const { _test } = require("../services/tool-executor");
const { getTransferService } = _test;

describe("getTransferService routing", () => {
  it("should return telnyx transfer for telnyx provider", () => {
    const service = getTransferService({ telephonyProvider: "telnyx" });
    // telnyx-transfer module has transferCall and sendTransferSMS
    assert.ok(typeof service.transferCall === "function");
    assert.ok(typeof service.sendTransferSMS === "function");
  });

  it("should return twilio transfer for twilio provider", () => {
    const service = getTransferService({ telephonyProvider: "twilio" });
    assert.ok(typeof service.transferCall === "function");
    assert.ok(typeof service.sendTransferSMS === "function");
  });

  it("should default to twilio when telephonyProvider is undefined", () => {
    const service = getTransferService({});
    // Should not throw, should return twilio transfer
    assert.ok(typeof service.transferCall === "function");
  });

  it("should default to twilio for unknown provider", () => {
    const service = getTransferService({ telephonyProvider: "unknown" });
    assert.ok(typeof service.transferCall === "function");
  });

  it("should return different services for different providers", () => {
    const telnyxService = getTransferService({ telephonyProvider: "telnyx" });
    const twilioService = getTransferService({ telephonyProvider: "twilio" });
    // They should be different modules
    assert.notEqual(telnyxService, twilioService);
  });
});
