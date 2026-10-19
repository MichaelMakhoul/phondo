const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { extractSpokenDigits, validateInput, getBufferConfig, BUFFER_CONFIGS, isPlainYes, saysPhoneNumber } = require("../lib/input-validators");

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
    assert.equal(extractSpokenDigits("One."), "1", "a final carries a full stop");
    assert.equal(extractSpokenDigits("um, zero"), "0", "an unambiguous digit word always counts");
    assert.equal(extractSpokenDigits("oh 412 345 678"), "0412345678", "a numeral vouches for its neighbour");
    assert.equal(extractSpokenDigits("one one two"), "112");
    assert.equal(extractSpokenDigits("Oh four nine five, five six one, and one one one."), "0495561111", "silent-failure re-review: a group of ones after \"and\", mid-dictation");
  });
  it("silent-failure re-review 2: a lead-in before the number doesn't count (it would make a partial look whole)", () => {
    assert.equal(extractSpokenDigits("Oh, one sec. Oh four one two, three four five,"), "0412345");
    assert.equal(extractSpokenDigits("That one. Oh, sorry, no, oh four one two,"), "0412");
    assert.equal(validateInput("phone", "Oh, one sec. Oh four one two, three four five,").complete, false, "7 digits said: still waiting");
  });
  it("test review (F6): an ambiguous word away from the digits is chatter, even when the text holds a number", () => {
    assert.equal(extractSpokenDigits("Oh sorry, it's 0412 345 678"), "0412345678");
    assert.equal(extractSpokenDigits("I have one question, my number is 0412 345 678"), "0412345678");
    assert.equal(extractSpokenDigits("I need it for two, that one"), "2", "code review 2");
  });
  it("code review 2 (F6): a number ends at punctuation too (\"… six seven eight?\")", () => {
    assert.equal(extractSpokenDigits("oh four one two, three four five, six seven eight?"), "0412345678");
    assert.equal(extractSpokenDigits("Is the best mobile for you the number you're calling from, 0412 555 013?"), "0412555013");
    assert.equal(extractSpokenDigits("(02) 3820 5672"), "0238205672");
  });
  it("silent-failure re-review 3: before the number starts, punctuation ends a run (\"Not that one. Oh four …\")", () => {
    assert.equal(extractSpokenDigits("Not that one. Oh four one two, three four five,"), "0412345");
    assert.equal(extractSpokenDigits("The other one? Oh four one two,"), "0412");
    assert.equal(extractSpokenDigits("No, not that one, oh four one two"), "0412");
    assert.equal(extractSpokenDigits("Oh, four one two, three four five, six seven eight."), "412345678", "the cost: a leading \"Oh,\" drops, the number stays whole");
  });
  it("silent-failure re-review 3: \"one sec\" mid-number is a pause, not a digit", () => {
    assert.equal(extractSpokenDigits("Oh four one two, three four five, one sec,"), "0412345");
    assert.equal(extractSpokenDigits("Oh, one moment. Oh four one two"), "0412");
    assert.equal(extractSpokenDigits("Oh four one two, three four five, one more sec,"), "0412345");
    assert.equal(extractSpokenDigits("Oh four one two, three four five, oh! One sec."), "0412345");
    assert.equal(extractSpokenDigits("Oh! One sec."), "", "not a lone digit to wait 12 s for");
  });
  it("confirmation review (F6): \"double oh\" keeps its oh before a hold phrase", () => {
    assert.equal(extractSpokenDigits("Oh, four double oh, one sec, six eight one two, six seven."), "400681267", "the leading \"Oh,\" drops (the documented cost); the number still counts as whole");
  });
  it("gate review (F6): two ambiguous words don't vouch for each other", () => {
    for (const said of ["Oh, one more thing", "Oh, one sec", "Oh one moment please", "That one. Oh, sorry", "martes o jueves"]) {
      assert.equal(extractSpokenDigits(said), "", said);
    }
  });
  it("security review (F6): a word that is an Object.prototype key is not a digit, and never throws", () => {
    // "double constructor" used to reach Object's function and throw on .repeat inside the
    // buffer's timer: an uncaught exception, which exits the server with every call on it.
    for (const said of ["double constructor", "triple tostring", "double __proto__", "hasOwnProperty", "valueOf"]) {
      assert.equal(extractSpokenDigits(said), "", said);
      assert.equal(validateInput("phone", said).complete, true, said);
    }
    assert.equal(extractSpokenDigits("constructor one two"), "12");
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
    for (const said of [
      "Four thirty is good.", "four o'clock", "half past four", "quarter to five", "at four", "around 10", "4:30", "eleven fifteen", "two forty-five", "noon works", "a las cuatro y media", "a la una",
      "Four PM.", "four p.m.", "Nine am", "Ten past four", "Twenty to five", "Five past ten", "After four", "Before four", "Four is fine, thanks.", "Two works",
      "Nine oh five", "Three twenty", "Midnight would be fine", "Lunchtime", "About four",
    ]) {
      assert.equal(validateInput("date_time", said).complete, true, said);
    }
  });
  it("…but a bare number word is not yet, nor a word that starts like am/pm", () => {
    assert.equal(validateInput("date_time", "four").complete, false);
    assert.equal(validateInput("date_time", "four amazing").complete, false);
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

describe("isPlainYes — phone test F6 (gate review)", () => {
  it("a plain yes to an offered number", () => {
    for (const said of ["Yeah. That one, please.", "Yep.", "Yes, that's the one", "Correct.", "That's it.", "Sure, the same one", "Yeah, sure.", "Yes please", "Okay, that one.", "Yes, it is.", "Yeah, the same number", "Yep, that's my mobile", "Yeah, go ahead", "Yes, use that one",
      "Yeah, cheers.", "Yep, that's it, cheers.", "Yes, ta.", "Yep, all good.", "Yeah, no worries.", "Yeah, sounds good.", "Yeah, that works.", "Yes, that's good.", "Yeah, that's my mobile number.", "Uh, yes."]) {
      assert.equal(isPlainYes("phone", said, true), true, said);
    }
  });
  it("not a yes that goes on: another number, a no, digits, or a clause still open", () => {
    for (const said of [
      "Yes, but use my work number", "Yeah, it's oh four one two", "Yeah, actually no", "No.", "Nah, a different one", "Yes, 0412 345 678", "Yeah, the home one", "Hello?", "That one, wait",
      "Yeah, my mobile is", "Yes, it's", "Sure, it's", "Yeah, so", "Yes, the number is", "Right, so my number is", "Yep, and", "Yeah, um", "Yes, I'll give you my mobile", "Yeah, you can use my wife's",
      "Yeah, one sec", "Yes, give me a sec", "Yeah, let me find it", "Yeah, and also", "Sure, I'll read it out", "Yeah, no, my work one", "Um, yeah, it's",
    ]) {
      assert.equal(isPlainYes("phone", said, true), false, said);
    }
  });
  it("silent-failure re-review: a yes to a plain \"what's your number?\" (nothing offered) is a lead-in", () => {
    assert.equal(isPlainYes("phone", "Yeah, sure.", false), false);
    assert.equal(isPlainYes("phone", "Yep.", false), false);
  });
  it("test review (F6): a yes-word at the END of a longer sentence is not a plain yes (the start anchor)", () => {
    for (const said of ["Let me check my other phone, okay.", "Hang on, yeah.", "Oh wait, sure.", "I'm not sure, right", "No, that's right."]) {
      assert.equal(isPlainYes("phone", said, true), false, said);
    }
  });
  it("test review (F6): every word of the whitelist is a plain yes to an offered number", () => {
    for (const said of ["Yup.", "Yeh.", "OK.", "Right.", "Absolutely.", "Definitely.", "Perfect.", "This one.", "That's right.", "That's correct.", "That's perfect.", "That's fine.", "That is it.", "That is right.", "That is correct.", "That is the one.", "Yes, thanks.", "Yes, thank you.", "Yep, mate.", "Yes, that's my number.",
      "Yep, that's the one I'm calling from.", "That's the right number.", "Yeah, that number's fine.", "The one I'm calling from is fine."]) {
      assert.equal(isPlainYes("phone", said, true), true, said);
    }
  });
  it("only for a phone number", () => {
    assert.equal(isPlainYes("name", "Yes.", true), false);
    assert.equal(isPlainYes("date_time", "Yes.", true), false);
  });
});

describe("saysPhoneNumber — code review 2 (F6)", () => {
  it("a whole number in the AI's words", () => {
    for (const said of ["I can see you're calling from 0414 141 883, is that the one?", "Is that 0412 555 013?", "Shall I use (02) 3820 5672?", "Is +61 414 141 883 right?", "I have zero four one four, one four one, eight eight three. Is that right?"]) {
      assert.equal(saysPhoneNumber(said), true, said);
    }
  });
  it("not a date, a time list or a short code", () => {
    for (const said of ["You're booked for Tuesday 20 October 2026 at 10. What's the best number to reach you on?", "We have 9, 10 or 11 tomorrow.", "Your code is 4821.", "What's the best number to reach you on?", null]) {
      assert.equal(saysPhoneNumber(said), false, String(said));
    }
  });
});
