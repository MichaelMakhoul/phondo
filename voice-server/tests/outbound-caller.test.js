const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const {
  generateOutboundToken,
  verifyOutboundToken,
  cleanupConsumedJtis,
  consumedJtis,
  buildCallerPrompt,
} = require("../services/outbound-caller");

/** Sign an arbitrary payload the same way generateOutboundToken does. */
function signPayload(payload, secret) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  return `${payloadB64}.${sig}`;
}

/** Decode a token's payload without verifying (test helper). */
function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
}

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
      // Create a token with exp in the past (valid jti — expiry is the only defect)
      const payload = { test: true, jti: crypto.randomUUID(), exp: Date.now() - 10000 };
      const token = signPayload(payload, secret);
      assert.equal(verifyOutboundToken(token, secret), null);
    });
  });

  // SCRUM-449: tokens are single-use per jti — a captured token must not be
  // replayable within its TTL.
  describe("single-use jti", () => {
    const secret = "test-secret-key-12345";

    it("mints a unique jti per token", () => {
      const a = decodePayload(generateOutboundToken({ test: true }, secret));
      const b = decodePayload(generateOutboundToken({ test: true }, secret));
      assert.ok(a.jti && b.jti, "both tokens should carry a jti");
      assert.notEqual(a.jti, b.jti, "jtis should be unique");
    });

    it("accepts first use, rejects replay of the same token", () => {
      const token = generateOutboundToken({ scenarioId: "book-happy-path" }, secret);
      assert.ok(verifyOutboundToken(token, secret), "first use should succeed");
      assert.equal(verifyOutboundToken(token, secret), null, "replay should be rejected");
    });

    it("pre-flight verify ({ consume: false }) does not burn the token", () => {
      const token = generateOutboundToken({ scenarioId: "book-happy-path" }, secret);
      // /outbound/twiml stage: verify-only, may legitimately repeat (Twilio retry)
      assert.ok(verifyOutboundToken(token, secret, { consume: false }), "pre-flight should succeed");
      assert.ok(verifyOutboundToken(token, secret, { consume: false }), "repeated pre-flight should succeed");
      // /ws/outbound stage: consuming verify
      assert.ok(verifyOutboundToken(token, secret), "consuming verify should succeed");
      // Once consumed, even pre-flight mode rejects the jti
      assert.equal(verifyOutboundToken(token, secret, { consume: false }), null, "pre-flight after consumption should be rejected");
      assert.equal(verifyOutboundToken(token, secret), null, "replay after consumption should be rejected");
    });

    it("rejects old-format tokens without a jti", () => {
      const token = signPayload({ scenarioId: "x", exp: Date.now() + 60_000 }, secret);
      assert.equal(verifyOutboundToken(token, secret), null);
      assert.equal(verifyOutboundToken(token, secret, { consume: false }), null);
    });

    it("rejects tokens with a malformed (non-string) jti", () => {
      const token = signPayload({ jti: 12345, exp: Date.now() + 60_000 }, secret);
      assert.equal(verifyOutboundToken(token, secret), null);
    });

    it("rejects tokens with an empty-string jti", () => {
      const token = signPayload({ jti: "", exp: Date.now() + 60_000 }, secret);
      assert.equal(verifyOutboundToken(token, secret), null);
    });

    it("sweeps consumed jtis once their token exp passes", () => {
      const token = generateOutboundToken({ test: true }, secret);
      const { jti, exp } = decodePayload(token);
      assert.ok(verifyOutboundToken(token, secret), "consume the token");
      assert.ok(consumedJtis.has(jti), "jti should be in the consumed set");

      cleanupConsumedJtis(exp - 1); // before exp → entry retained
      assert.ok(consumedJtis.has(jti), "unexpired entry should survive the sweep");

      cleanupConsumedJtis(exp + 1); // past exp → entry swept
      assert.equal(consumedJtis.has(jti), false, "expired entry should be swept");
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
