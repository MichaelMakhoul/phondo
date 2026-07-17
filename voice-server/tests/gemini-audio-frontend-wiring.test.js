"use strict";

/**
 * SCRUM-555 — pins that gemini-live.js actually USES the audio front-end.
 *
 * The unit suite (audio-frontend.test.js) proves the DSP works; nothing else
 * proves sendAudio routes through it, honors its null return (sub-block
 * buffered — nothing to send yet), or destroys it on ws close. All three are
 * mutation-verified survivable without this file. Discriminator: the legacy
 * path converts every frame immediately, so "5ms frame in, NO ws.send" is
 * only possible via the front-end's fifo.
 *
 * Uses a fake `ws` module injected via require.cache BEFORE requiring the
 * service (the repo's established pattern — see gemini-live-setup-complete).
 */

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const created = [];

class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.readyState = FakeWebSocket.OPEN;
    created.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

const wsPath = require.resolve("ws");
require.cache[wsPath] = {
  id: wsPath,
  filename: wsPath,
  loaded: true,
  exports: FakeWebSocket,
};

process.env.GEMINI_API_KEY = "test-key";
delete process.env.AUDIO_FRONTEND; // default-on

const { createGeminiSession } = require("../services/gemini-live");
const { initAudioFrontend, AudioFrontend } = require("../lib/audio-frontend");
const { pcm16ToMulaw } = require("../lib/audio-converter");

function makeSineB64(samples) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 400 * i) / 8000)), i * 2);
  }
  return pcm16ToMulaw(pcm).toString("base64");
}

function makeReadySession() {
  const session = createGeminiSession(
    { systemPrompt: "prompt", tools: [], voiceName: "Kore" },
    { onAudio: () => {}, onToolCall: async () => ({}), onError: () => {}, onClose: () => {} }
  );
  const ws = created[created.length - 1];
  ws.emit("open");
  ws.emit("message", JSON.stringify({ setupComplete: {} }));
  return { session, ws };
}

const audioMsgs = (ws) => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio);

before(async () => {
  const { enabled, reason } = await initAudioFrontend();
  assert.ok(enabled, `RNNoise wasm must load for the wiring test (got: ${reason})`);
});

test("sendAudio routes through the front-end: a 5ms sub-block frame is buffered (NO ws.send), the next flushes one 10ms 16k block", () => {
  const { session, ws } = makeReadySession();
  const half = makeSineB64(40); // 5ms at 8k — half a 10ms front-end block
  ws.sent.length = 0;

  session.sendAudio(half);
  assert.equal(
    audioMsgs(ws).length,
    0,
    "sub-block input must be buffered, not sent — the legacy path would send immediately, and a dropped null-guard would send data:null"
  );

  session.sendAudio(half);
  const msgs = audioMsgs(ws);
  assert.equal(msgs.length, 1, "the second half-block must flush exactly one block");
  const buf = Buffer.from(msgs[0].realtimeInput.audio.data, "base64");
  assert.equal(buf.length, 160 * 2, "80 samples at 8k in must emit 160 samples at 16k");
  assert.equal(msgs[0].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");

  ws.emit("close", 1000, Buffer.from("")); // clears the setup watchdog timer
});

test("ws close destroys the session front-end (frees the wasm denoise state) — on the normal close branch", () => {
  let destroyCalls = 0;
  const orig = AudioFrontend.prototype.destroy;
  AudioFrontend.prototype.destroy = function (...args) {
    destroyCalls++;
    return orig.apply(this, args);
  };
  try {
    const { ws } = makeReadySession();
    assert.equal(destroyCalls, 0);
    ws.emit("close", 1000, Buffer.from("bye"));
    assert.equal(destroyCalls, 1, "close must free the wasm denoise state — one heap leak per call otherwise");
  } finally {
    AudioFrontend.prototype.destroy = orig;
  }
});
