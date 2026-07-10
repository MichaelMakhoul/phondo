"use strict";

/**
 * SCRUM-535 — pins the onSetupComplete EMIT in gemini-live.js.
 *
 * The emit is the only thing that ever closes the failover window, and its
 * only consumer is the failover wrapper — from inside gemini-live.js it looks
 * like dead code. Deleting it keeps every wrapper test green (they use fake
 * factories) while reopening the window forever: every end_call hangup
 * phantom-fails-over, and a mid-call Gemini error re-greets a live caller
 * through OpenAI with no memory of the conversation.
 *
 * Uses a fake `ws` module injected via require.cache BEFORE requiring the
 * service (the repo's established pattern — see answer-mode-grace.test.js).
 */

const test = require("node:test");
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
const { createGeminiSession } = require("../services/gemini-live");

function makeSession(callbacks) {
  const session = createGeminiSession(
    { systemPrompt: "prompt", tools: [], voiceName: "Kore" },
    {
      onAudio: () => {},
      onToolCall: async () => ({}),
      onTranscriptIn: () => {},
      onTranscriptOut: () => {},
      onInterrupted: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onClose: () => {},
      ...callbacks,
    }
  );
  const ws = created[created.length - 1];
  return { session, ws };
}

test("emits onSetupComplete exactly once when Gemini acks setup, BEFORE the greeting trigger", () => {
  const order = [];
  const { ws } = makeSession({ onSetupComplete: () => order.push("setup-complete") });

  ws.emit("open");
  ws.emit("message", JSON.stringify({ setupComplete: {} }));

  assert.deepEqual(order, ["setup-complete"], "the failover window must close exactly once");
  // The greeting trigger must still have been sent — and after the emit, so
  // the window is already closed before anything else can fail.
  const greeting = ws.sent.find((m) => m.realtimeInput && m.realtimeInput.text === "Call connected.");
  assert.ok(greeting, "greeting trigger must still be sent");

  // A duplicate ack must not re-emit.
  ws.emit("message", JSON.stringify({ setupComplete: {} }));
  assert.equal(order.length, 2 - 1, "duplicate setupComplete must not re-close the window");
});

test("a throwing onSetupComplete callback must not kill the greeting", () => {
  const { ws } = makeSession({
    onSetupComplete: () => {
      throw new Error("wrapper exploded");
    },
  });

  ws.emit("open");
  assert.doesNotThrow(() => ws.emit("message", JSON.stringify({ setupComplete: {} })));

  const greeting = ws.sent.find((m) => m.realtimeInput && m.realtimeInput.text === "Call connected.");
  assert.ok(greeting, "the caller still gets greeted when the telemetry callback throws");
});

test("no emit before the ack: connecting and buffering audio does not close the window", () => {
  let emitted = 0;
  const { session, ws } = makeSession({ onSetupComplete: () => emitted++ });
  ws.emit("open");
  session.sendAudio(Buffer.from([0x7f]).toString("base64"));
  assert.equal(emitted, 0, "only Gemini's setupComplete message closes the window");
});
