const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CallSession } = require("../call-session");
const { BUFFER_CONFIGS } = require("../lib/input-validators");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Buffer one final while `type` is expected; resolve with what was flushed and when.
 * @param {string} type
 * @param {string[]} finals - said one after another, 100 ms apart
 * @param {number} waitMs - how long to watch
 * @param {string} [aiSaid] - the AI's last words before the answer
 */
async function buffer(type, finals, waitMs, aiSaid) {
  const s = new CallSession(`buffer-${type}`);
  if (aiSaid) s.addMessage("assistant", aiSaid);
  s.setExpectedInputType(type);
  const started = Date.now();
  /** @type {Array<{ text: string, type: string, afterMs: number }>} */
  const flushed = [];
  for (const [i, text] of finals.entries()) {
    if (i > 0) await sleep(100);
    s.bufferTranscript(text, (combined, inputType) => flushed.push({ text: combined, type: inputType, afterMs: Date.now() - started }));
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

  it("\"The second one\" for a time is an answer too (\"one\" there is not a digit)", async () => {
    const flushed = await buffer("date_time", ["The second one, please."], BUFFER_CONFIGS.date_time.debounceMs + 400);
    assert.equal(flushed.length, 1);
  });
});
