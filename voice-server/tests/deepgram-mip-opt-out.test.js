// SCRUM-595: every Deepgram request must opt out of Deepgram's Model Improvement
// Program. Our privacy policy and data-sovereignty page promise that providers
// may not train on customer data; without mip_opt_out=true Deepgram may retain
// samples for training.
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("live STT stream URL opts out of Deepgram's model improvement program", () => {
  const wsPath = require.resolve("ws");
  const sttPath = require.resolve("../services/deepgram-stt");
  const savedWs = require.cache[wsPath];
  const urls = [];
  class FakeWs {
    constructor(url) { urls.push(url); }
    on() {}
  }
  require.cache[wsPath] = /** @type {any} */ ({ id: wsPath, filename: wsPath, loaded: true, exports: FakeWs });
  delete require.cache[sttPath];
  try {
    const { openDeepgramStream } = require("../services/deepgram-stt");
    openDeepgramStream("KEY", { onTranscript() {}, onUtteranceEnd() {}, onError() {}, onClose() {} });
  } finally {
    if (savedWs) require.cache[wsPath] = savedWs; else delete require.cache[wsPath];
    delete require.cache[sttPath];
  }
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.match(urls[0], /[?&]mip_opt_out=true(&|$)/);
});

test("TTS REST URL opts out of Deepgram's model improvement program", async () => {
  const savedFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = /** @type {any} */ (async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  try {
    const { synthesizeSpeech } = require("../services/deepgram-tts");
    await synthesizeSpeech("KEY", "Hello there.");
  } finally {
    globalThis.fetch = savedFetch;
  }
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/api\.deepgram\.com\/v1\/speak\?/);
  assert.match(urls[0], /[?&]mip_opt_out=true(&|$)/);
});
