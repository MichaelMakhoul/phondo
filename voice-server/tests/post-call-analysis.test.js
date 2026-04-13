const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Save and restore original env + global fetch
let origApiKey;
let origFetch;

/**
 * Build a fake fetch that returns:
 *   - structuredObj when the request system prompt looks like the structured-data prompt
 *   - cleanupObj when the request looks like the STT cleanup prompt
 *
 * The new post-call-analysis service makes TWO parallel OpenAI calls; this stub
 * has to be able to respond to either.
 */
function mockOpenAI({ structuredObj = null, cleanupObj = null } = {}) {
  return function fakeFetch(_url, init) {
    let body = {};
    try {
      body = init && init.body ? JSON.parse(init.body) : {};
    } catch {
      body = {};
    }
    const systemMsg =
      (body.messages && body.messages.find((m) => m.role === "system")?.content) || "";
    const isStructured = systemMsg.includes("Extract the following information from the transcript");
    const responseObj = isStructured ? structuredObj : cleanupObj;

    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify(responseObj || {}),
              },
            },
          ],
        }),
    });
  };
}

/**
 * Convenience helper for tests that only care about the structured response.
 * Provides a minimal valid cleanup payload so the cleanup call also "succeeds"
 * without affecting structured assertions.
 */
function mockStructuredOnly(structuredObj) {
  return mockOpenAI({
    structuredObj,
    cleanupObj: { turns: [] },
  });
}

describe("analyzeCallTranscript", () => {
  beforeEach(() => {
    origApiKey = process.env.OPENAI_API_KEY;
    origFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = origApiKey;
    globalThis.fetch = origFetch;
  });

  // Must re-require after env changes since OPENAI_API_KEY is read at module level
  function getAnalyzer() {
    delete require.cache[require.resolve("../services/post-call-analysis")];
    return require("../services/post-call-analysis").analyzeCallTranscript;
  }

  it('returns "positive" sentiment correctly', async () => {
    globalThis.fetch = mockStructuredOnly({
      caller_name: "John",
      caller_phone_reason: "Booking appointment",
      appointment_requested: true,
      summary: "John called to book a dental cleaning.",
      success_evaluation: "successful",
      collected_data: null,
      unanswered_questions: null,
      sentiment: "positive",
    });

    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("This is a long enough transcript to analyze properly.");

    assert.equal(result.sentiment, "positive");
  });

  it('returns "negative" sentiment correctly', async () => {
    globalThis.fetch = mockStructuredOnly({
      caller_name: null,
      caller_phone_reason: "Complaint",
      appointment_requested: false,
      summary: "Caller was upset about billing.",
      success_evaluation: "unsuccessful",
      collected_data: null,
      unanswered_questions: null,
      sentiment: "negative",
    });

    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("This is a long enough transcript to analyze properly.");

    assert.equal(result.sentiment, "negative");
  });

  it('normalizes invalid sentiment value to null', async () => {
    globalThis.fetch = mockStructuredOnly({
      caller_name: "Jane",
      caller_phone_reason: "Inquiry",
      appointment_requested: false,
      summary: "Jane asked about services.",
      success_evaluation: "successful",
      collected_data: null,
      unanswered_questions: null,
      sentiment: "happy",
    });

    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("This is a long enough transcript to analyze properly.");

    assert.equal(result.sentiment, null);
  });

  it("defaults missing sentiment field to null", async () => {
    globalThis.fetch = mockStructuredOnly({
      caller_name: "Bob",
      caller_phone_reason: "Question",
      appointment_requested: false,
      summary: "Bob had a quick question.",
      success_evaluation: "successful",
      collected_data: null,
      unanswered_questions: null,
    });

    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("This is a long enough transcript to analyze properly.");

    assert.equal(result.sentiment, null);
  });

  it("still returns existing fields correctly alongside sentiment", async () => {
    globalThis.fetch = mockStructuredOnly({
      caller_name: "Alice Smith",
      caller_phone_reason: "Schedule cleaning",
      appointment_requested: true,
      summary: "Alice called to schedule a teeth cleaning for next Tuesday.",
      success_evaluation: "successful",
      collected_data: { email: "alice@example.com" },
      unanswered_questions: ["What insurance do you accept?"],
      sentiment: "neutral",
    });

    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("This is a long enough transcript to analyze properly.");

    assert.equal(result.callerName, "Alice Smith");
    assert.equal(result.callerPhoneReason, "Schedule cleaning");
    assert.equal(result.appointmentRequested, true);
    assert.equal(result.summary, "Alice called to schedule a teeth cleaning for next Tuesday.");
    assert.equal(result.successEvaluation, "successful");
    assert.deepEqual(result.collectedData, { email: "alice@example.com" });
    assert.deepEqual(result.unansweredQuestions, ["What insurance do you accept?"]);
    assert.equal(result.sentiment, "neutral");
  });

  it("returns null for short transcript", async () => {
    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("Too short");

    assert.equal(result, null);
  });

  it("returns null when API key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("This is a long enough transcript to analyze properly.");

    assert.equal(result, null);
  });

  it("returns structured fields even when cleanup call truncates", async () => {
    // Cleanup call returns finish_reason: "length" → throws → cleanedTranscript = null
    // Structured call still succeeds with normal fields.
    globalThis.fetch = function fakeFetch(_url, init) {
      const body = JSON.parse(init.body);
      const systemMsg = body.messages.find((m) => m.role === "system").content;
      const isStructured = systemMsg.includes("Extract the following information from the transcript");

      if (isStructured) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      caller_name: "Truncation Test",
                      caller_phone_reason: "Test",
                      appointment_requested: false,
                      summary: "Structured succeeded.",
                      success_evaluation: "successful",
                      sentiment: "neutral",
                    }),
                  },
                },
              ],
            }),
        });
      }
      // Cleanup call: simulate truncation
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                finish_reason: "length",
                message: {
                  content: '{"turns":[{"role":"user","text":"hello',
                },
              },
            ],
          }),
      });
    };

    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("This is a long enough transcript to analyze properly.");

    assert.notEqual(result, null);
    assert.equal(result.callerName, "Truncation Test");
    assert.equal(result.summary, "Structured succeeded.");
    assert.equal(result.cleanedTranscript, null);
  });

  it("returns cleaned transcript even when structured call fails", async () => {
    // Structured call returns a non-OK response; cleanup succeeds.
    globalThis.fetch = function fakeFetch(_url, init) {
      const body = JSON.parse(init.body);
      const systemMsg = body.messages.find((m) => m.role === "system").content;
      const isStructured = systemMsg.includes("Extract the following information from the transcript");

      if (isStructured) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    turns: [
                      { role: "user", text: "Hi there" },
                      { role: "assistant", text: "Hello, how can I help?" },
                    ],
                  }),
                },
              },
            ],
          }),
      });
    };

    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("This is a long enough transcript to analyze properly.");

    assert.notEqual(result, null);
    // Structured failed → fallback null fields
    assert.equal(result.callerName, null);
    assert.equal(result.summary, null);
    assert.equal(result.sentiment, null);
    // Cleanup succeeded
    assert.notEqual(result.cleanedTranscript, null);
    assert.equal(result.cleanedTranscript.turns.length, 2);
  });

  it("returns null when both calls fail", async () => {
    globalThis.fetch = function fakeFetch() {
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });
    };

    const analyzeCallTranscript = getAnalyzer();
    const result = await analyzeCallTranscript("This is a long enough transcript to analyze properly.");

    assert.equal(result, null);
  });
});
