const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Save and restore original env + global fetch
let origApiKey;
let origFetch;

function mockOpenAIResponse(analysisObj) {
  return function fakeFetch() {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: JSON.stringify(analysisObj),
              },
            },
          ],
        }),
    });
  };
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
    globalThis.fetch = mockOpenAIResponse({
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
    globalThis.fetch = mockOpenAIResponse({
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
    globalThis.fetch = mockOpenAIResponse({
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
    globalThis.fetch = mockOpenAIResponse({
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
    globalThis.fetch = mockOpenAIResponse({
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
});
