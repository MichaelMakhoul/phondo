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
  it("phone test F6: \"one\", \"oh\" and \"una\" used as ordinary words are not digits", () => {
    for (const said of ["Yeah. That one, please.", "Yeah. That one, please. Hello?", "Oh yes, that's the one", "the second one", "una cita"]) {
      assert.equal(extractSpokenDigits(said), "", said);
    }
  });
  it("…but beside another digit, or as the whole answer, they still are", () => {
    assert.equal(extractSpokenDigits("oh four one two"), "0412");
    assert.equal(extractSpokenDigits("It's oh four"), "04");
    assert.equal(extractSpokenDigits("one four one"), "141");
    assert.equal(extractSpokenDigits("zero four one four, one four one, eight eight three"), "0414141883");
    assert.equal(extractSpokenDigits("one"), "1");
    assert.equal(extractSpokenDigits("um, zero"), "0", "an unambiguous digit word always counts");
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
  it("phone test F6: a clock time said in words is a time", () => {
    for (const said of ["Four thirty is good.", "four o'clock", "half past four", "quarter to five", "at four", "around 10", "4:30", "eleven fifteen", "two forty-five", "noon works", "a las cuatro y media", "a la una"]) {
      assert.equal(validateInput("date_time", said).complete, true, said);
    }
  });
  it("…but a bare number word is not yet", () => {
    assert.equal(validateInput("date_time", "four").complete, false);
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
