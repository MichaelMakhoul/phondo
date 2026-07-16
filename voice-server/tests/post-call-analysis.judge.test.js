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
    // 500, not 200: positive verdicts carry a note — a tight cap concentrates
    // truncation on exactly the verdicts the guard exists to deliver.
    assert.equal(capture.body.max_tokens, 500);
  });

  it("maps a clean verdict and normalizes an empty note to null", async () => {
    globalThis.fetch = mockJudge({ content_loss: false, note: "" });
    const verdict = await getJudge()("User: a", "User: a");
    assert.deepEqual(verdict, { contentLoss: false, note: null });
  });

  it("THROWS on a non-boolean content_loss — schema drift must never coerce to a confident verdict", async () => {
    // JSON mode enforces syntax, not schema: a model swap emitting
    // {"contentLoss": ...} or {"content_loss": "yes"} would otherwise become a
    // permanent, fleet-wide silent "no loss" with no error existing anywhere.
    globalThis.fetch = mockJudge({
      content_loss: "yes",
      note: "Caller gave her Medicare number and asked about billing",
    });
    await assert.rejects(
      () => getJudge()("User: a", "User: b"),
      (err) => {
        assert.match(err.message, /malformed verdict/);
        // SHAPE-ONLY: the payload's note paraphrases caller speech and this
        // message flows into a Sentry page that bypasses the extras scrubber.
        // Key NAMES may appear; values must not.
        assert.doesNotMatch(err.message, /Medicare/);
        assert.doesNotMatch(err.message, /"yes"/);
        return true;
      },
    );
  });

  it("THROWS when content_loss is missing entirely (e.g. key drift after a prompt edit)", async () => {
    globalThis.fetch = mockJudge({ verdict: true });
    await assert.rejects(() => getJudge()("User: a", "User: b"), /malformed verdict/);
  });

  it("clamps an oversize note to 300 chars", async () => {
    globalThis.fetch = mockJudge({ content_loss: true, note: "x".repeat(500) });
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

  it("truncates giant transcripts at 24k/side — a comparison needs BOTH sides to cover the same span", async () => {
    const capture = {};
    globalThis.fetch = mockJudge({ content_loss: false, note: "" }, capture);
    await getJudge()("A".repeat(30_000), "B".repeat(30_000));
    const user = capture.body.messages.find((m) => m.role === "user").content;
    // 2×24k + labels: bounded, but NOT the analysis prompts' 6k window — a
    // short window structurally hides late-call loss (B is tighter than A).
    assert.ok(user.length < 49_000, `user message unexpectedly large: ${user.length}`);
    assert.ok(user.length > 40_000, `slice window regressed below 24k/side: ${user.length}`);
  });
});
