const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-553: judgeTranscriptContentLoss — the semantic guard that keeps a lossy
// re-transcription (SCRUM-550) from replacing a fuller original. Mocks global
// fetch (same idiom as post-call-analysis.test.js) and pins the request shape,
// the verdict mapping, and that failures THROW (the retranscribe handler owns
// the fail-open posture — this function must not hide errors).

let origApiKey;
let origFetch;

/** Fake fetch returning a JSON-mode chat completion with the given object. */
function mockJudge(responseObj, capture) {
  return function fakeFetch(url, init) {
    if (capture) {
      capture.url = url;
      capture.body = JSON.parse(init.body);
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { finish_reason: "stop", message: { content: JSON.stringify(responseObj) } },
          ],
        }),
    });
  };
}

describe("judgeTranscriptContentLoss (SCRUM-553)", () => {
  beforeEach(() => {
    origApiKey = process.env.OPENAI_API_KEY;
    origFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    if (origApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origApiKey;
    globalThis.fetch = origFetch;
  });

  // Must re-require after env changes since OPENAI_API_KEY is read at module level
  function getJudge() {
    delete require.cache[require.resolve("../services/post-call-analysis")];
    return require("../services/post-call-analysis").judgeTranscriptContentLoss;
  }

  it("sends both transcripts in one JSON-mode request and maps a loss verdict", async () => {
    const capture = {};
    globalThis.fetch = mockJudge({ content_loss: true, note: "Arabic exchange missing" }, capture);
    const verdict = await getJudge()("User: a\nAI: b", "User: a2\nAI: b2");
    assert.deepEqual(verdict, { contentLoss: true, note: "Arabic exchange missing" });
    assert.equal(capture.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(capture.body.response_format.type, "json_object");
    const user = capture.body.messages.find((m) => m.role === "user").content;
    assert.match(user, /TRANSCRIPT A \(original\):\nUser: a\nAI: b/);
    assert.match(user, /TRANSCRIPT B \(re-transcription\):\nUser: a2\nAI: b2/);
    const system = capture.body.messages.find((m) => m.role === "system").content;
    // The one instruction the whole guard hinges on: garbled text in A still
    // counts as the caller having said something there.
    assert.match(system, /garbled text still proves the caller SAID something/);
  });

  it("maps a clean verdict and normalizes an empty note to null", async () => {
    globalThis.fetch = mockJudge({ content_loss: false, note: "" });
    const verdict = await getJudge()("User: a", "User: a");
    assert.deepEqual(verdict, { contentLoss: false, note: null });
  });

  it("coerces a non-boolean content_loss and clamps an oversize note", async () => {
    globalThis.fetch = mockJudge({ content_loss: "yes", note: "x".repeat(500) });
    const verdict = await getJudge()("User: a", "User: b");
    assert.equal(verdict.contentLoss, true);
    assert.equal(verdict.note.length, 300);
  });

  it("THROWS on a non-2xx response — the caller owns the fail-open posture", async () => {
    globalThis.fetch = () =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("overloaded") });
    await assert.rejects(() => getJudge()("User: a", "User: b"), /OpenAI 503/);
  });

  it("THROWS on empty model content — never a silent no-verdict", async () => {
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "" } }] }),
      });
    await assert.rejects(() => getJudge()("User: a", "User: b"), /empty content/);
  });

  it("THROWS when OPENAI_API_KEY is unset — never a silent no-verdict", async () => {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(() => getJudge()("User: a", "User: b"), /OPENAI_API_KEY not set/);
  });

  it("truncates giant transcripts to keep the request bounded", async () => {
    const capture = {};
    globalThis.fetch = mockJudge({ content_loss: false, note: "" }, capture);
    await getJudge()("A".repeat(10_000), "B".repeat(10_000));
    const user = capture.body.messages.find((m) => m.role === "user").content;
    assert.ok(user.length < 13_000, `user message unexpectedly large: ${user.length}`);
  });
});
