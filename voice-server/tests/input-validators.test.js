const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { extractSpokenDigits, validateInput, getBufferConfig, BUFFER_CONFIGS } = require("../lib/input-validators");

describe("extractSpokenDigits", () => {
  it("extracts numeric digits", () => {
    assert.equal(extractSpokenDigits("0412 345 678"), "0412345678");
  });
  it("extracts spoken digit words", () => {
    assert.equal(extractSpokenDigits("oh four one two three four five six seven eight"), "0412345678");
  });
  it("handles zero and oh", () => {
    assert.equal(extractSpokenDigits("zero four oh two"), "0402");
  });
  it("handles double prefix", () => {
    assert.equal(extractSpokenDigits("double five"), "55");
  });
  it("handles triple prefix", () => {
    assert.equal(extractSpokenDigits("triple zero"), "000");
  });
  it("handles mixed spoken and numeric", () => {
    assert.equal(extractSpokenDigits("04 double one 3 five six"), "0411356");
  });
  it("returns empty for no digits", () => {
    assert.equal(extractSpokenDigits("my number is"), "");
  });
  it("handles single digit", () => {
    assert.equal(extractSpokenDigits("four"), "4");
  });
});

describe("validateInput - phone", () => {
  it("complete with 10 digits", () => {
    const result = validateInput("phone", "0412 345 678");
    assert.equal(result.complete, true);
  });
  it("complete with 8 digits", () => {
    const result = validateInput("phone", "1234 5678");
    assert.equal(result.complete, true);
  });
  it("incomplete with 5 digits", () => {
    const result = validateInput("phone", "oh four one two three");
    assert.equal(result.complete, false);
  });
  it("complete with spoken digits", () => {
    const result = validateInput("phone", "oh four one two triple five six seven eight");
    assert.equal(result.complete, true);
  });
});

describe("validateInput - email", () => {
  it("complete with .com", () => {
    const result = validateInput("email", "john at example.com");
    assert.equal(result.complete, true);
  });
  it("complete with dot com spoken", () => {
    const result = validateInput("email", "john at example dot com");
    assert.equal(result.complete, true);
  });
  it("complete with .com.au", () => {
    const result = validateInput("email", "john@example.com.au");
    assert.equal(result.complete, true);
  });
  it("incomplete without TLD", () => {
    const result = validateInput("email", "john at example");
    assert.equal(result.complete, false);
  });
});

describe("validateInput - name", () => {
  it("complete with first and last", () => {
    const result = validateInput("name", "John Smith");
    assert.equal(result.complete, true);
  });
  it("incomplete with single word", () => {
    const result = validateInput("name", "John");
    assert.equal(result.complete, false);
  });
  it("complete with three words", () => {
    const result = validateInput("name", "John William Smith");
    assert.equal(result.complete, true);
  });
});

describe("validateInput - address", () => {
  it("complete with street address", () => {
    const result = validateInput("address", "42 Main Street");
    assert.equal(result.complete, true);
  });
  it("complete with postcode", () => {
    const result = validateInput("address", "Sydney 2000");
    assert.equal(result.complete, true);
  });
  it("complete with road abbreviation", () => {
    const result = validateInput("address", "15 Oak Rd");
    assert.equal(result.complete, true);
  });
  it("incomplete without structure", () => {
    const result = validateInput("address", "somewhere in Sydney");
    assert.equal(result.complete, false);
  });
});

describe("validateInput - date_time", () => {
  it("complete with day name", () => {
    const result = validateInput("date_time", "next Monday");
    assert.equal(result.complete, true);
  });
  it("complete with tomorrow", () => {
    const result = validateInput("date_time", "tomorrow");
    assert.equal(result.complete, true);
  });
  it("complete with time", () => {
    const result = validateInput("date_time", "2:30 pm");
    assert.equal(result.complete, true);
  });
  it("complete with morning", () => {
    const result = validateInput("date_time", "Tuesday morning");
    assert.equal(result.complete, true);
  });
  it("incomplete without reference", () => {
    const result = validateInput("date_time", "whenever you have");
    assert.equal(result.complete, false);
  });
});

describe("validateInput - general", () => {
  it("always complete", () => {
    const result = validateInput("general", "anything at all");
    assert.equal(result.complete, true);
  });
  it("complete for unknown type", () => {
    const result = validateInput("unknown_type", "test");
    assert.equal(result.complete, true);
  });
});

describe("getBufferConfig", () => {
  it("returns phone config", () => {
    const config = getBufferConfig("phone");
    assert.equal(config.debounceMs, 2000);
    assert.equal(config.maxWaitMs, 12000);
    assert.equal(config.ignoreUtteranceEnd, true);
  });
  it("returns general config for unknown type", () => {
    const config = getBufferConfig("nonexistent");
    assert.deepEqual(config, BUFFER_CONFIGS.general);
  });
  it("phone ignores utterance end", () => {
    assert.equal(getBufferConfig("phone").ignoreUtteranceEnd, true);
  });
  it("name respects utterance end", () => {
    assert.equal(getBufferConfig("name").ignoreUtteranceEnd, false);
  });
});
