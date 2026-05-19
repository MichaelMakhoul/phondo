const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { getPollyVoice } = require("../lib/polly-voice");

describe("getPollyVoice", () => {
  describe("Australian English (AU → Polly.Nicole)", () => {
    it("maps AU to Polly.Nicole", () => {
      assert.equal(getPollyVoice("AU"), "Polly.Nicole");
    });

    it("is case-insensitive", () => {
      assert.equal(getPollyVoice("au"), "Polly.Nicole");
      assert.equal(getPollyVoice("Au"), "Polly.Nicole");
      assert.equal(getPollyVoice("aU"), "Polly.Nicole");
    });
  });

  describe("British English (GB → Polly.Amy)", () => {
    it("maps GB to Polly.Amy", () => {
      assert.equal(getPollyVoice("GB"), "Polly.Amy");
    });

    it("does NOT map UK (we use ISO codes only — UK is not ISO-3166-1)", () => {
      assert.equal(getPollyVoice("UK"), "Polly.Joanna"); // falls through to default
    });
  });

  describe("US / CA (Polly.Joanna — North American English)", () => {
    it("maps US to Polly.Joanna", () => {
      assert.equal(getPollyVoice("US"), "Polly.Joanna");
    });

    it("maps CA to Polly.Joanna (shares NANP voice)", () => {
      assert.equal(getPollyVoice("CA"), "Polly.Joanna");
    });
  });

  describe("default / unknown country", () => {
    it("falls back to Polly.Joanna for null", () => {
      assert.equal(getPollyVoice(null), "Polly.Joanna");
    });

    it("falls back to Polly.Joanna for undefined", () => {
      assert.equal(getPollyVoice(undefined), "Polly.Joanna");
    });

    it("falls back to Polly.Joanna for empty string", () => {
      assert.equal(getPollyVoice(""), "Polly.Joanna");
    });

    it("falls back to Polly.Joanna for unknown ISO code (e.g., DE, FR)", () => {
      assert.equal(getPollyVoice("DE"), "Polly.Joanna");
      assert.equal(getPollyVoice("FR"), "Polly.Joanna");
      assert.equal(getPollyVoice("ZZ"), "Polly.Joanna");
    });

    it("does not crash on bizarre input types", () => {
      // The function uses (country || "").toUpperCase() — these all coerce
      // safely to "" or a non-matching string.
      assert.equal(getPollyVoice(0), "Polly.Joanna");
      assert.equal(getPollyVoice(false), "Polly.Joanna");
    });
  });

  describe("output shape", () => {
    // SCRUM-275 silent-failure-hunter P1: TwiML interpolation
    //   `<Say voice="${pollyVoice}">`
    // happens without XML escaping. Today every branch returns one of three
    // literal string constants — all safe XML. This contract test asserts
    // the closed set, so any future helper addition that returns a value
    // derived from user input (or containing XML metacharacters) trips this
    // test before reaching production.
    const ALLOWED_VOICES = /^Polly\.(Joanna|Nicole|Amy)$/;

    it("returns ONLY one of the three approved Polly voices (never user-derived content)", () => {
      const inputs = ["AU", "GB", "US", "CA", "ZZ", "", null, undefined, 0, false, "au", "Gb"];
      for (const inp of inputs) {
        const result = getPollyVoice(inp);
        assert.match(
          result,
          ALLOWED_VOICES,
          `Helper returned '${result}' for input ${JSON.stringify(inp)} — must be one of Polly.Joanna|Nicole|Amy. ` +
            "If you're adding a new country, also update the ALLOWED_VOICES regex AND audit every TwiML " +
            "interpolation site in server.js / fallback-dial-consent.js for XML-escape safety.",
        );
      }
    });
  });
});
