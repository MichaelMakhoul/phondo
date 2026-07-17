"use strict";

/**
 * SCRUM-556 — pins the custom-VAD wiring in gemini-live.js.
 *
 * With CUSTOM_VAD=on and the front-end available, the Gemini setup must
 * disable automatic activity detection and the session must emit manual
 * activityStart/activityEnd markers when the turn gate fires. With the flag
 * off — or the front-end unavailable — the SCRUM-554 tuned automatic config
 * must be sent instead (never a disabled detector without a gate driving
 * markers: that would be a call nobody can talk to).
 *
 * The TurnGate is stubbed via require.cache (same pattern as the FakeWebSocket)
 * so gate events are scripted; the gate's real logic is unit-tested in
 * turn-gate.test.js.
 */

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

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
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket };

// Scripted turn gate: pops events from a static queue on each push().
class FakeTurnGate {
  push() {
    return FakeTurnGate.queue.length ? FakeTurnGate.queue.shift() : null;
  }
}
FakeTurnGate.queue = [];

const realTurnGate = require("../lib/turn-gate");
const gatePath = require.resolve("../lib/turn-gate");
require.cache[gatePath] = {
  id: gatePath,
  filename: gatePath,
  loaded: true,
  exports: { TurnGate: FakeTurnGate, customVadEnabled: realTurnGate.customVadEnabled },
};

process.env.GEMINI_API_KEY = "test-key";
delete process.env.AUDIO_FRONTEND; // default-on

const { createGeminiSession } = require("../services/gemini-live");
const { initAudioFrontend } = require("../lib/audio-frontend");
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

const activityMsgs = (ws, kind) => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput[kind]);

before(async () => {
  const { enabled, reason } = await initAudioFrontend();
  assert.ok(enabled, `RNNoise wasm must load for the wiring test (got: ${reason})`);
});

test("CUSTOM_VAD=on: setup disables automatic detection; gate events emit manual turn markers", () => {
  process.env.CUSTOM_VAD = "on";
  try {
    const { session, ws } = makeReadySession();
    const setup = ws.sent.find((m) => m.setup);
    assert.equal(
      setup.setup.realtimeInputConfig.automaticActivityDetection.disabled,
      true,
      "automatic VAD must be disabled when the gate drives turns"
    );
    assert.equal(
      setup.setup.realtimeInputConfig.activityHandling,
      "START_OF_ACTIVITY_INTERRUPTS",
      "barge-in must survive the switch to manual markers"
    );

    // one 20ms frame = 2 gate pushes; script start on the first, end on the third
    FakeTurnGate.queue = ["start", null, "end", null];
    session.sendAudio(makeSineB64(160));
    assert.equal(activityMsgs(ws, "activityStart").length, 1, "gate 'start' must emit activityStart");
    session.sendAudio(makeSineB64(160));
    assert.equal(activityMsgs(ws, "activityEnd").length, 1, "gate 'end' must emit activityEnd");
    // audio itself must still stream continuously alongside the markers
    assert.ok(
      ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).length >= 2,
      "audio must keep streaming with manual markers"
    );
    ws.emit("close", 1000, Buffer.from(""));
  } finally {
    delete process.env.CUSTOM_VAD;
    FakeTurnGate.queue = [];
  }
});

test("CUSTOM_VAD unset: setup keeps the SCRUM-554 tuned automatic config, no markers ever", () => {
  const { session, ws } = makeReadySession();
  const setup = ws.sent.find((m) => m.setup);
  const aad = setup.setup.realtimeInputConfig.automaticActivityDetection;
  assert.equal(aad.disabled, undefined, "automatic VAD must stay enabled by default");
  assert.equal(aad.startOfSpeechSensitivity, "START_SENSITIVITY_LOW");
  assert.equal(aad.prefixPaddingMs, 250);
  session.sendAudio(makeSineB64(160));
  assert.equal(activityMsgs(ws, "activityStart").length, 0, "no manual markers without the flag");
  ws.emit("close", 1000, Buffer.from(""));
});

test("CUSTOM_VAD=on but front-end unavailable: automatic VAD is KEPT (never a disabled detector without a gate)", () => {
  process.env.CUSTOM_VAD = "on";
  process.env.AUDIO_FRONTEND = "off"; // front-end gone → gate has no inputs
  try {
    const { ws } = makeReadySession();
    const setup = ws.sent.find((m) => m.setup);
    const aad = setup.setup.realtimeInputConfig.automaticActivityDetection;
    assert.equal(aad.disabled, undefined, "automatic VAD must be kept when the gate can't run");
    assert.equal(aad.startOfSpeechSensitivity, "START_SENSITIVITY_LOW");
    ws.emit("close", 1000, Buffer.from(""));
  } finally {
    delete process.env.CUSTOM_VAD;
    delete process.env.AUDIO_FRONTEND;
  }
});

test("source pins: a dead front-end under custom VAD fails LOUD via onError", () => {
  // The onDead→onError closure is two lines inside createGeminiSession; a
  // functional repro needs 5 forced wasm errors through the private session
  // front-end, so pin the wiring at source level instead.
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "gemini-live.js"), "utf8");
  assert.match(src, /onDead: \(\) => \{\s*callbacks\.onError\?\.\(new Error\("audio front-end died while CUSTOM_VAD/);
  assert.match(src, /CUSTOM_VAD requested but the audio front-end is unavailable/);
});
