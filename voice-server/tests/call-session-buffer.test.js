const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CallSession } = require("../call-session");
const { BUFFER_CONFIGS } = require("../lib/input-validators");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Buffer one final while `type` is expected; resolve with what was flushed and when.
 * @param {string} type
 * @param {Array<string | [string, number]>} finals - said one after another, 100 ms apart unless [text, gapMs]
 * @param {number} waitMs - how long to watch
 * @param {string | string[]} [aiSaid] - the AI's messages before the answer
 * @param {{ wholeTurn?: boolean }} [opts] - bufferTranscript's options (wholeTurn: Flux finals)
 */
async function buffer(type, finals, waitMs, aiSaid, opts) {
  const s = new CallSession(`buffer-${type}`);
  for (const said of [aiSaid ?? []].flat()) s.addMessage("assistant", said);
  s.setExpectedInputType(type);
  const started = Date.now();
  /** @type {Array<{ text: string, type: string, afterMs: number }>} */
  const flushed = [];
  for (const [i, final] of finals.entries()) {
    const [text, gapMs] = Array.isArray(final) ? final : [final, 100];
    if (i > 0) await sleep(gapMs);
    s.bufferTranscript(text, (combined, inputType) => flushed.push({ text: combined, type: inputType, afterMs: Date.now() - started }), opts);
  }
  await sleep(waitMs);
  const byItself = flushed.slice(); // before the cleanup below, which would flush a buffer still waiting
  s._utteranceCallback = null;
  s._flushAndReset(); // stop the max-wait timer
  return byItself;
}

// SCRUM-594 (phone test F6): the fast path sends structured answers through this buffer.
const OFFER = "Thanks, Michael. What's the best mobile number to reach you on? I can see you're calling from 0414 141 883, is that the one?";
describe("CallSession.bufferTranscript — phone test F6", () => {
  it("\"Yeah. That one, please.\" to the caller-ID question flushes at once, not after the 12 s maximum", async () => {
    const flushed = await buffer("phone", ["Yeah. That one, please."], 100, OFFER);
    assert.equal(flushed.length, 1, "flushed at once");
    assert.equal(flushed[0].text, "Yeah. That one, please.");
    assert.equal(flushed[0].type, "phone");
    assert.ok(flushed[0].afterMs < 50, `${flushed[0].afterMs} ms`);
  });

  it("a yes that goes on to another number still waits for it (\"Yes, but use my work number\" … \"oh four one two …\")", async () => {
    const flushed = await buffer("phone", ["Yes, but use my work number,", "oh four one two, three four five, six seven eight."], BUFFER_CONFIGS.phone.debounceMs + 400, OFFER);
    assert.deepEqual(flushed.map((f) => f.text), ["Yes, but use my work number, oh four one two, three four five, six seven eight."]);
  });

  it("security re-review (F6): \"Yeah, my mobile is\" … \"0412 345 678\" is still one answer", async () => {
    const flushed = await buffer("phone", ["Yeah, my mobile is", "0412 345 678"], BUFFER_CONFIGS.phone.debounceMs + 400, OFFER);
    assert.deepEqual(flushed.map((f) => f.text), ["Yeah, my mobile is 0412 345 678"]);
  });

  it("silent-failure re-review: a lead-in to a plain ask, then the number in pieces, is one answer", async () => {
    const flushed = await buffer("phone", ["Sure, my number is", "oh four one two,", "three four five,", "six seven eight."], BUFFER_CONFIGS.phone.debounceMs + 400, "What's the best number to reach you on?");
    assert.deepEqual(flushed.map((f) => f.text), ["Sure, my number is oh four one two, three four five, six seven eight."]);
  });

  it("silent-failure re-review: \"Yeah, sure.\" to a plain ask still waits for the number", async () => {
    const flushed = await buffer("phone", ["Yeah, sure.", "oh four one two, three four five, six seven eight."], BUFFER_CONFIGS.phone.debounceMs + 400, "What's the best number to reach you on?");
    assert.deepEqual(flushed.map((f) => f.text), ["Yeah, sure. oh four one two, three four five, six seven eight."]);
  });

  it("silent-failure re-review 2: \"Oh, one sec. Oh four one two,\" … a pause … the rest is still one answer", async () => {
    const flushed = await buffer("phone", ["Oh, one sec. Oh four one two,", ["three four five,", 1500], ["six seven eight.", 2400]], BUFFER_CONFIGS.phone.debounceMs + 400, "What's the best number to reach you on?");
    assert.deepEqual(flushed.map((f) => f.text), ["Oh, one sec. Oh four one two, three four five, six seven eight."]);
  });

  it("silent-failure re-review 3: declining the offer, \"Not that one. Oh four one two,\" … a pause … the rest is one answer", async () => {
    for (const lead of ["Not that one. Oh four one two,", "The other one? Oh four one two,"]) {
      const flushed = await buffer("phone", [lead, ["three four five,", 1500], ["six seven eight.", 2400]], BUFFER_CONFIGS.phone.debounceMs + 400, OFFER);
      assert.deepEqual(flushed.map((f) => f.text), [`${lead} three four five, six seven eight.`], lead);
    }
  });

  it("silent-failure re-review 3: \"… three four five, one sec,\" … a pause … the rest is one answer", async () => {
    const flushed = await buffer("phone", ["Oh four one two,", ["three four five, one sec,", 1500], ["six seven eight.", 2400]], BUFFER_CONFIGS.phone.debounceMs + 400, "What's the best number to reach you on?");
    assert.deepEqual(flushed.map((f) => f.text), ["Oh four one two, three four five, one sec, six seven eight."]);
  });

  it("silent-failure re-review 2: the offer counts when a re-prompt repeated only the question", async () => {
    const flushed = await buffer("phone", ["Yes."], 100, ["I can see you're calling from 0414 141 883. Is that the best number to reach you on?", "Is that the best number to reach you on?"]);
    assert.equal(flushed.length, 1, "flushed at once");
  });

  it("silent-failure re-review: \"… five six one,\" \"and one one one.\" completes the number at the debounce (not 16 s)", async () => {
    const flushed = await buffer("phone", ["Oh four nine five,", "five six one,", "and one one one."], BUFFER_CONFIGS.phone.debounceMs + 400);
    assert.deepEqual(flushed.map((f) => f.text), ["Oh four nine five, five six one, and one one one."]);
  });

  it("a conversational answer with \"one\" in it flushes at the debounce, not the 12 s maximum", async () => {
    const flushed = await buffer("phone", ["Hmm, which one did I give you?"], BUFFER_CONFIGS.phone.debounceMs + 400);
    assert.equal(flushed.length, 1, "flushed within the debounce");
  });

  it("a number dictated in pieces still waits for the rest (\"oh four one four\" … \"one four one, eight eight three\")", async () => {
    const flushed = await buffer("phone", ["Oh four one four", "one four one, eight eight three"], BUFFER_CONFIGS.phone.debounceMs + 400);
    assert.deepEqual(flushed.map((f) => f.text), ["Oh four one four one four one, eight eight three"]);
  });

  it("\"Four thirty is good.\" to a time question flushes at the debounce, not the 4 s maximum", async () => {
    const flushed = await buffer("date_time", ["Four thirty is good."], BUFFER_CONFIGS.date_time.debounceMs + 400);
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].text, "Four thirty is good.");
  });

  it("a bare \"four\" to a time question still waits (the control: the helper sees a buffer that holds)", async () => {
    const flushed = await buffer("date_time", ["Four."], BUFFER_CONFIGS.date_time.debounceMs + 400);
    assert.equal(flushed.length, 0);
  });

  it("test review (F6): a yes-word in the middle of a dictation does not cut it", async () => {
    // Only the FIRST piece can be a plain yes (bufferTranscript's `length === 1`): "right" here is a filler.
    const flushed = await buffer("phone", ["No, it's oh four one four", "right", "one four one, eight eight three"], BUFFER_CONFIGS.phone.debounceMs + 400, OFFER);
    assert.deepEqual(flushed.map((f) => f.text), ["No, it's oh four one four right one four one, eight eight three"]);
  });

  it("test review (F6): a booking time in the AI's question is not an offered number", async () => {
    const ask = "Great, Tuesday the 21st at 10 AM it is. What's the best number to reach you on?";
    const flushed = await buffer("phone", ["Yeah, sure.", "oh four one two, three four five, six seven eight."], BUFFER_CONFIGS.phone.debounceMs + 400, ask);
    assert.deepEqual(flushed.map((f) => f.text), ["Yeah, sure. oh four one two, three four five, six seven eight."]);
  });

  it("code review 2 (F6): a date read back with its year is not an offered number", async () => {
    const ask = "You're booked for Tuesday 20 October 2026 at 10. What's the best number to reach you on?";
    const flushed = await buffer("phone", ["Yeah, sure.", "oh four one two, three four five, six seven eight."], BUFFER_CONFIGS.phone.debounceMs + 400, ask);
    assert.deepEqual(flushed.map((f) => f.text), ["Yeah, sure. oh four one two, three four five, six seven eight."]);
  });

  it("code review 2 (F6): an offer ending at \"?\" counts (\"… calling from, 0412 555 013?\")", async () => {
    const flushed = await buffer("phone", ["Yep, that's the one."], 100, ["Thanks for calling.", "Is the best mobile for you the number you're calling from, 0412 555 013?"]);
    assert.equal(flushed.length, 1, "flushed at once");
  });

  it("test review (F6): only the AI's LAST words can be the offer", () => {
    const s = new CallSession("stale-offer");
    s.addMessage("assistant", OFFER);
    s.addMessage("user", "No, use a different one.");
    s.addMessage("assistant", "Sure, what's the number?");
    assert.equal(s._lastAiOfferedNumber(), false, "the offer was two turns ago");
    s.addMessage("user", "It's 0412 345 678");
    s.addMessage("assistant", "I have 0412 345 678 down, is that right?");
    assert.equal(s._lastAiOfferedNumber(), true);
  });

  it("\"The second one\" for a time is an answer too (\"one\" there is not a digit)", async () => {
    const flushed = await buffer("date_time", ["The second one, please."], BUFFER_CONFIGS.date_time.debounceMs + 400);
    assert.equal(flushed.length, 1);
  });
});

// SCRUM-594 (phone test F8): a "Sorry?" and a one-word surname each waited the name buffer's 4 s maximum.
describe("CallSession.bufferTranscript — phone test F8", () => {
  const NAME_ASK = "Got it, a new shower install. Is this a booked job rather than an urgent one? Can I grab your first and last name?";

  it("a whole turn of \"Sorry?\" to the name question flushes at once", async () => {
    const flushed = await buffer("name", ["Sorry?"], 100, NAME_ASK, { wholeTurn: true });
    assert.equal(flushed.length, 1, "flushed at once");
    assert.deepEqual([flushed[0].text, flushed[0].type], ["Sorry?", "name"]);
    assert.ok(flushed[0].afterMs < 50, `${flushed[0].afterMs} ms`);
  });

  it("asked to repeat while a number is expected: at once too", async () => {
    const flushed = await buffer("phone", ["Can you repeat that?"], 100, "What's the best number to reach you on?", { wholeTurn: true });
    assert.equal(flushed.length, 1, "flushed at once");
  });

  it("a Nova piece (not a whole turn) is not flushed at once: \"Sorry,\" may lead into the answer", async () => {
    const flushed = await buffer("name", ["Sorry,", "it's Michael Makhoul."], BUFFER_CONFIGS.name.debounceMs + 400, NAME_ASK);
    assert.deepEqual(flushed.map((f) => f.text), ["Sorry, it's Michael Makhoul."]);
  });

  it("a repair word after the first piece does not cut a dictation", async () => {
    const flushed = await buffer("phone", ["Oh four one two,", "sorry,", "three four five, six seven eight."], BUFFER_CONFIGS.phone.debounceMs + 400, "What's the best number to reach you on?", { wholeTurn: true });
    assert.deepEqual(flushed.map((f) => f.text), ["Oh four one two, sorry, three four five, six seven eight."]);
  });

  it("\"McCook.\" to \"And your last name?\" flushes at the debounce, not the 4 s maximum", async () => {
    const flushed = await buffer("name", ["McCook."], BUFFER_CONFIGS.name.debounceMs + 400, "Thanks, Michael. And your last name?", { wholeTurn: true });
    assert.equal(flushed.length, 1);
    assert.ok(flushed[0].afterMs >= BUFFER_CONFIGS.name.debounceMs - 20 && flushed[0].afterMs < BUFFER_CONFIGS.name.debounceMs + 300, `${flushed[0].afterMs} ms`);
  });

  it("a lone letter still waits past the debounce (a spelling just begun)", async () => {
    const flushed = await buffer("name", ["M."], BUFFER_CONFIGS.name.debounceMs + 400, "Thanks, Michael. And your last name?", { wholeTurn: true });
    assert.equal(flushed.length, 0);
  });

  it("spelled letters in pieces are still one answer", async () => {
    const flushed = await buffer("name", ["M.", "A K H", "O U L."], BUFFER_CONFIGS.name.debounceMs + 400, "Could you spell your last name for me?", { wholeTurn: true });
    assert.deepEqual(flushed.map((f) => f.text), ["M. A K H O U L."]);
  });
});
