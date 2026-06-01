const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENAI_API_KEY = "test-key";

const { _test } = require("../services/post-call-analysis");
const { containsNonLatinScript } = _test;

// SCRUM-370: the cleanup pass routes transcripts carrying the STT
// mis-detection signature (non-Latin scripts) to a stronger model.
describe("containsNonLatinScript (SCRUM-370 cleanup routing)", () => {
  it("is false for plain English / Latin (stays on the cheap model)", () => {
    assert.equal(containsNonLatinScript("User: Hi, I'd like to book an appointment.\nAI: Sure!"), false);
    assert.equal(containsNonLatinScript(""), false);
    assert.equal(containsNonLatinScript(null), false);
  });

  it("is false for accented Latin (José, ça va, Müller) — still Latin", () => {
    assert.equal(containsNonLatinScript("José, ça va? Müller — Łukasz Søren Núñez"), false);
    assert.equal(containsNonLatinScript("Nguyễn đặt lịch"), false); // Vietnamese (Latin)
  });

  it("is false for emoji / symbols / punctuation (must NOT force the pricier model)", () => {
    assert.equal(containsNonLatinScript("Thanks! 😀👍 — call me €5 £10 ¥20"), false);
  });

  it("matches the additional AU-market scripts (Greek, Bengali, Tamil, half-width Katakana)", () => {
    assert.equal(containsNonLatinScript("Ωμέγα"), true);   // Greek
    assert.equal(containsNonLatinScript("আমি"), true);     // Bengali
    assert.equal(containsNonLatinScript("வணக்கம்"), true); // Tamil
    assert.equal(containsNonLatinScript("ｱｲｳ"), true);     // half-width Katakana
  });

  it("is true for the mis-detected scripts seen in real garbled calls", () => {
    assert.equal(containsNonLatinScript("User: مرحبا، أريد موعدا"), true);       // Arabic
    assert.equal(containsNonLatinScript("User: 안녕하세요"), true);               // Hangul
    assert.equal(containsNonLatinScript("User: こんにちは"), true);              // Hiragana
    assert.equal(containsNonLatinScript("User: 你好，我想预约"), true);          // CJK
    assert.equal(containsNonLatinScript("User: Привет"), true);                 // Cyrillic
    assert.equal(containsNonLatinScript("User: नमस्ते"), true);                  // Devanagari
    assert.equal(containsNonLatinScript("User: สวัสดี"), true);                 // Thai
    assert.equal(containsNonLatinScript("User: שלום"), true);                   // Hebrew
  });

  it("is true when garble is mixed into an otherwise-English transcript", () => {
    assert.equal(containsNonLatinScript("User: My name is 田中, book me in."), true);
  });
});
