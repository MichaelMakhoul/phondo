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

  it("DOES default phone for reschedule_appointment (SCRUM-377 — prompts identify by 'the same number')", () => {
    const out = applyCallerIdPhoneFallback("reschedule_appointment", { new_datetime: "2026-06-17T10:15:00" }, CALLER);
    assert.equal(out.phone, CALLER);
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

// SCRUM-518: a non-empty phone is not a usable one. A real call captured
// `phone: "0.5"`; because it was non-empty the fallback stood down, the handler
// rejected it, and the AI asked the caller for a number it was already holding.
describe("applyCallerIdPhoneFallback — junk values (SCRUM-518)", () => {
  const CALLER = "+61414141883";

  it("replaces a phone that could not possibly dial", () => {
    // Every one of these came out of, or is one keystroke from, a real
    // speech-to-text failure.
    for (const junk of ["0.5", "0", "5", ".", "-", "12345", "oh four one two", "N/A", "unknown"]) {
      const out = applyCallerIdPhoneFallback("book_appointment", { datetime: "x", phone: junk }, CALLER);
      assert.equal(out.phone, CALLER, `junk: ${JSON.stringify(junk)}`);
    }
  });

  it("replaces the withheld-caller sentinel if the model ever echoes it back", () => {
    const out = applyCallerIdPhoneFallback("book_appointment", { phone: "+266696687" }, CALLER);
    assert.equal(out.phone, CALLER);
  });

  it("replaces an all-same-digit number, which isValidPhoneNumber rejects downstream", () => {
    // Long enough to clear a bare digit-count window, but the booking handler
    // refuses it. Without this the AI still dead-ends asking for a number it is
    // already holding — the same bug as "0.5", wearing a different mask.
    for (const junk of ["00000000", "11111111", "0000000000", "0 0 0 0 0 0 0 0"]) {
      const out = applyCallerIdPhoneFallback("book_appointment", { phone: junk }, CALLER);
      assert.equal(out.phone, CALLER, `junk: ${junk}`);
    }
  });

  it("replaces a non-string phone rather than passing it downstream", () => {
    for (const junk of [0.5, null, {}, []]) {
      const out = applyCallerIdPhoneFallback("book_appointment", { phone: junk }, CALLER);
      assert.equal(out.phone, CALLER, `junk: ${JSON.stringify(junk)}`);
    }
  });

  it("still keeps a real number the caller gave for someone else", () => {
    // The whole point of the guard is that it fires ONLY on unusable values.
    for (const real of ["+61399998888", "02 9999 8888", "0299998888", "(02) 9999-8888"]) {
      const out = applyCallerIdPhoneFallback("book_appointment", { phone: real }, CALLER);
      assert.equal(out.phone, real, `real: ${real}`);
    }
  });

  it("leaves junk alone when there is no caller ID to put in its place", () => {
    // Overwriting with nothing would book an appointment with no contact number
    // and never tell anyone. Leaving it lets the handler reject and the AI ask.
    const args = { datetime: "x", phone: "0.5" };
    assert.equal(applyCallerIdPhoneFallback("book_appointment", args, undefined).phone, "0.5");
    assert.equal(applyCallerIdPhoneFallback("book_appointment", args, "anonymous").phone, "0.5");
  });

  it("does not touch cancel/lookup, where phone is a match key", () => {
    const out = applyCallerIdPhoneFallback("cancel_appointment", { phone: "0.5" }, CALLER);
    assert.equal(out.phone, "0.5");
  });
});

describe("isDialablePhoneArg (SCRUM-518)", () => {
  const { isDialablePhoneArg } = _test;

  it("accepts what a phone can dial, in the formats callers say it", () => {
    for (const ok of ["+61414141883", "0414141883", "02 9999 8888", "(02) 9999-8888", "12345678"]) {
      assert.equal(isDialablePhoneArg(ok), true, ok);
    }
  });

  it("rejects too few digits, too many, and the anonymous sentinel", () => {
    assert.equal(isDialablePhoneArg("0.5"), false);
    assert.equal(isDialablePhoneArg("1234567"), false); // 7 digits
    assert.equal(isDialablePhoneArg("12345678"), true); // 8 digits: the boundary
    assert.equal(isDialablePhoneArg("123456789012345"), true); // 15 digits
    assert.equal(isDialablePhoneArg("1234567890123456"), false); // 16 digits
    assert.equal(isDialablePhoneArg("+266696687"), false);
  });

  it("rejects an all-same-digit number, matching isValidPhoneNumber", () => {
    assert.equal(isDialablePhoneArg("00000000"), false);
    assert.equal(isDialablePhoneArg("999999999999"), false);
    // Not all the same, so it stands.
    assert.equal(isDialablePhoneArg("00000001"), true);
  });

  it("rejects anything that is not a string", () => {
    for (const bad of [undefined, null, 0.5, 61414141883, {}, []]) {
      assert.equal(isDialablePhoneArg(bad), false, JSON.stringify(bad));
    }
  });
});
