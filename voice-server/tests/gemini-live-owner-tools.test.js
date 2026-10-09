// voice-server/tests/gemini-live-owner-tools.test.js
"use strict";
// SCRUM-587 — what the owner flow needs from the Gemini adapter (services/gemini-live.js),
// driven through a fake `ws` injected via require.cache (as gemini-live-setup-complete.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const created = [];
class FakeWebSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; this.readyState = FakeWebSocket.OPEN; created.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
const wsPath = require.resolve("ws");
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket };

process.env.GEMINI_API_KEY = "test-key";
process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
const { createGeminiSession } = require("../services/gemini-live");

function makeSession(callbacks, tools = []) {
  createGeminiSession(
    { systemPrompt: "prompt", tools, voiceName: "Kore" },
    { onAudio() {}, onToolCall: async () => ({}), onTranscriptIn() {}, onTranscriptOut() {}, onInterrupted() {}, onTurnComplete() {}, onError() {}, onClose() {}, ...callbacks },
  );
  return created[created.length - 1];
}

// Silent-failure lens SF4: toolCallCancellation was only logged, so an owner write the owner
// talked over still ran. The adapter now hands the cancelled ids to the call site.
test("a toolCallCancellation frame hands the cancelled ids to onToolCallCancellation", () => {
  const seen = [];
  const ws = makeSession({ onToolCallCancellation: (ids) => seen.push(ids) });
  ws.emit("open");
  ws.emit("message", JSON.stringify({ setupComplete: {} }));
  ws.emit("message", JSON.stringify({ toolCallCancellation: { ids: ["fc-1", "fc-2"] } }));
  assert.deepEqual(seen, [["fc-1", "fc-2"]]);
});

test("a malformed cancellation is an empty list; a call site without the callback, or one that throws, never breaks the session", () => {
  const seen = [];
  const ws = makeSession({ onToolCallCancellation: (ids) => seen.push(ids) });
  ws.emit("open");
  ws.emit("message", JSON.stringify({ setupComplete: {} }));
  ws.emit("message", JSON.stringify({ toolCallCancellation: {} }));
  assert.deepEqual(seen, [[]]);
  const quiet = makeSession({});
  quiet.emit("open");
  quiet.emit("message", JSON.stringify({ toolCallCancellation: { ids: ["fc-1"] } }));
  const errors = [];
  const thrower = makeSession({ onToolCallCancellation: () => { throw new Error("boom"); }, onError: (e) => errors.push(e) });
  thrower.emit("open");
  const realError = console.error;
  console.error = () => {};
  try {
    thrower.emit("message", JSON.stringify({ toolCallCancellation: { ids: ["fc-1"] } }));
  } finally {
    console.error = realError;
  }
  assert.deepEqual(errors, [], "a throwing call site is logged, not turned into a session error");
});
