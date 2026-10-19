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
 */
async function buffer(type, finals, waitMs) {
  const s = new CallSession(`buffer-${type}`);
  s.setExpectedInputType(type);
  const started = Date.now();
  /** @type {Array<{ text: string, type: string, afterMs: number }>} */
  const flushed = [];
  for (const [i, text] of finals.entries()) {
    if (i > 0) await sleep(100);
    s.bufferTranscript(text, (combined, inputType) => flushed.push({ text: combined, type: inputType, afterMs: Date.now() - started }));
  }
  await sleep(waitMs);
  s._flushAndReset(); // stop the max-wait timer of a test that failed
  return flushed;
}

// SCRUM-594 (phone test F6): the fast path sends structured answers through this buffer.
describe("CallSession.bufferTranscript — phone test F6", () => {
  it("\"Yeah. That one, please.\" to the caller-ID question flushes at the debounce, not the 12 s maximum", async () => {
    const flushed = await buffer("phone", ["Yeah. That one, please."], BUFFER_CONFIGS.phone.debounceMs + 400);
    assert.equal(flushed.length, 1, "flushed once, within the debounce");
    assert.equal(flushed[0].text, "Yeah. That one, please.");
    assert.equal(flushed[0].type, "phone");
    assert.ok(flushed[0].afterMs < BUFFER_CONFIGS.phone.debounceMs + 400, `${flushed[0].afterMs} ms`);
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

  it("\"The second one\" for a time is an answer too (\"one\" there is not a digit)", async () => {
    const flushed = await buffer("date_time", ["The second one, please."], BUFFER_CONFIGS.date_time.debounceMs + 400);
    assert.equal(flushed.length, 1);
  });
});
