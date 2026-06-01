const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Set required env vars before import
process.env.OPENAI_API_KEY = "test-key";
process.env.TELNYX_API_KEY = "test-key";
process.env.INTERNAL_API_URL = "http://localhost:3000";
process.env.INTERNAL_API_SECRET = "test-secret";

const { _test } = require("../services/tool-executor");
const { applyCallerIdPhoneFallback } = _test;

// SCRUM-366: caller ID is the deterministic default for a booking's phone, so
// the model stops asking the caller for a number we already have.
describe("applyCallerIdPhoneFallback (SCRUM-366)", () => {
  const CALLER = "+61414141883";

  it("fills phone from caller ID when book_appointment omits it", () => {
    const input = { datetime: "x", first_name: "A" };
    const out = applyCallerIdPhoneFallback("book_appointment", input, CALLER);
    assert.equal(out.phone, CALLER);
    assert.equal("phone" in input, false); // original args object is not mutated
  });

  it("fills phone when book_appointment sends an empty/whitespace phone", () => {
    assert.equal(applyCallerIdPhoneFallback("book_appointment", { phone: "" }, CALLER).phone, CALLER);
    assert.equal(applyCallerIdPhoneFallback("book_appointment", { phone: "   " }, CALLER).phone, CALLER);
  });

  it("keeps a caller-provided DIFFERENT number (does not overwrite)", () => {
    const out = applyCallerIdPhoneFallback("book_appointment", { phone: "+61399998888" }, CALLER);
    assert.equal(out.phone, "+61399998888");
  });

  it("does NOT default phone for cancel/lookup (phone is a match key there)", () => {
    assert.equal("phone" in applyCallerIdPhoneFallback("cancel_appointment", { date: "x" }, CALLER), false);
    assert.equal("phone" in applyCallerIdPhoneFallback("lookup_appointment", { name: "x" }, CALLER), false);
  });

  it("is a no-op when caller ID is unknown (blocked/withheld caller ID)", () => {
    const args = { datetime: "x", first_name: "A" };
    assert.equal(applyCallerIdPhoneFallback("book_appointment", args, undefined), args);
    assert.equal(applyCallerIdPhoneFallback("book_appointment", args, ""), args);
  });

  it("does NOT substitute Twilio's non-dialable sentinels / SIP URIs (withheld ID)", () => {
    // Twilio sends a literal string, not empty, for a withheld caller ID.
    for (const sentinel of ["anonymous", "Anonymous", "Restricted", "unavailable", "sip:alice@example.com"]) {
      const args = { datetime: "x", first_name: "A" };
      assert.equal("phone" in applyCallerIdPhoneFallback("book_appointment", args, sentinel), false, sentinel);
    }
  });

  it("does NOT substitute an out-of-range digit count (too short / too long)", () => {
    assert.equal("phone" in applyCallerIdPhoneFallback("book_appointment", {}, "12345"), false);
    assert.equal("phone" in applyCallerIdPhoneFallback("book_appointment", {}, "1234567890123456"), false);
  });

  it("handles null/empty args without throwing", () => {
    assert.equal(applyCallerIdPhoneFallback("book_appointment", null, CALLER).phone, CALLER);
  });
});
