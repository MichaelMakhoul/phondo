const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { generateOutboundToken, verifyOutboundToken, buildCallerPrompt } = require("../services/outbound-caller");

describe("outbound-caller", () => {
  describe("token generation", () => {
    it("generates and verifies a valid token", () => {
      const secret = "test-secret-key-12345";
      const data = { scenarioId: "book-happy-path", targetNumber: "+61299999999" };
      const token = generateOutboundToken(data, secret);
      assert.ok(token, "token should be generated");
      assert.ok(token.includes("."), "token should have payload.signature format");

      const verified = verifyOutboundToken(token, secret);
      assert.ok(verified, "token should verify");
      assert.equal(verified.scenarioId, "book-happy-path");
      assert.equal(verified.targetNumber, "+61299999999");
    });

    it("rejects tampered token", () => {
      const secret = "test-secret-key-12345";
      const token = generateOutboundToken({ test: true }, secret);
      const tampered = token.slice(0, -3) + "xxx";
      assert.equal(verifyOutboundToken(tampered, secret), null);
    });

    it("rejects expired token", () => {
      const secret = "test-secret-key-12345";
      // Create a token with exp in the past
      const payload = { test: true, exp: Date.now() - 10000 };
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const crypto = require("crypto");
      const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
      const token = `${payloadB64}.${sig}`;
      assert.equal(verifyOutboundToken(token, secret), null);
    });
  });

  describe("buildCallerPrompt", () => {
    it("wraps scenario in caller persona template", () => {
      const prompt = buildCallerPrompt({
        persona: "Alex, a new patient",
        prompt: "Book a dental cleaning",
      });
      assert.ok(prompt.includes("Alex, a new patient"), "should include persona");
      assert.ok(prompt.includes("Book a dental cleaning"), "should include scenario prompt");
      assert.ok(prompt.includes("CALLER"), "should instruct AI to act as caller");
      assert.ok(prompt.includes("goodbye"), "should instruct natural call ending");
    });
  });
});
