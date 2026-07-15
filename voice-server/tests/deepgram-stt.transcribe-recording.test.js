const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { transcribeRecording } = require("../services/deepgram-stt");

// SCRUM-550: Deepgram pre-recorded multichannel transcription of the stored
// call recording. Independent of Gemini; runs post-call.

describe("transcribeRecording (SCRUM-550)", () => {
  let origFetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function mockFetch(response) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return response;
    };
    return calls;
  }

  const okResponse = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  it("POSTs the audio to Deepgram with the right params, auth, and content type", async () => {
    const calls = mockFetch(
      okResponse({ results: { channels: [{}, {}], utterances: [] } }),
    );
    const audio = Buffer.from("mp3-bytes");
    await transcribeRecording("KEY123", audio, { language: "en", industry: "dental" });

    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.ok(url.startsWith("https://api.deepgram.com/v1/listen?"), url);
    for (const p of ["model=nova-3", "multichannel=true", "utterances=true", "punctuate=true", "smart_format=true", "language=en"]) {
      assert.ok(url.includes(p), `missing ${p} in ${url}`);
    }
    assert.ok(url.includes("keyterm="), "expected industry keyterms");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Token KEY123");
    assert.equal(init.headers["Content-Type"], "audio/mpeg");
    assert.equal(init.body, audio);
  });

  it("maps results.utterances and channelCount", async () => {
    mockFetch(
      okResponse({
        results: {
          channels: [{}, {}],
          utterances: [
            { start: 1.0, end: 2.0, channel: 0, transcript: "hi there" },
            { start: 0.0, end: 0.9, channel: 1, transcript: "hello" },
          ],
        },
      }),
    );
    const out = await transcribeRecording("K", Buffer.from("x"), {});
    assert.equal(out.channelCount, 2);
    assert.deepEqual(out.utterances, [
      { start: 1.0, end: 2.0, channel: 0, transcript: "hi there" },
      { start: 0.0, end: 0.9, channel: 1, transcript: "hello" },
    ]);
  });

  it("falls back to English for an unsupported language", async () => {
    const calls = mockFetch(okResponse({ results: { channels: [{}], utterances: [] } }));
    await transcribeRecording("K", Buffer.from("x"), { language: "zh" });
    assert.ok(calls[0].url.includes("language=en"), calls[0].url);
  });

  it("throws on a non-2xx Deepgram response", async () => {
    mockFetch({ ok: false, status: 429, text: async () => "rate limited" });
    await assert.rejects(
      () => transcribeRecording("K", Buffer.from("x"), {}),
      /Deepgram pre-recorded returned 429/,
    );
  });

  it("throws when results.utterances is missing/malformed", async () => {
    mockFetch(okResponse({ results: { channels: [{}] } }));
    await assert.rejects(
      () => transcribeRecording("K", Buffer.from("x"), {}),
      /missing results\.utterances/,
    );
  });
});
