"use strict";

/**
 * SCRUM-535 (review, HIGH) — the adapter's setup watchdog must be armed from
 * CONSTRUCTION, not from ws.on("open").
 *
 * A socket that connects TCP but stalls in the TLS/upgrade handshake never
 * emits open/error/close. With the watchdog armed inside on("open"), that
 * call had NO terminal state: no event, no timer, sendAudio dropping every
 * frame — a caller stranded in unbounded silence. Survivable while this
 * adapter only served A/B test calls; as the Gemini failover target it would
 * strand a real caller during exactly the correlated-outage window failover
 * exists for.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const created = [];

class FakeWebSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.sent = [];
    this.closed = [];
    this.readyState = FakeWebSocket.CONNECTING;
    created.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code, reason) {
    this.closed.push({ code, reason });
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

process.env.OPENAI_API_KEY = "test-key";
const { createOpenAIRealtimeSession } = require("../services/openai-realtime");

function makeSession(callbacks) {
  createOpenAIRealtimeSession(
    { systemPrompt: "prompt", tools: [], voiceName: "marin", language: "en" },
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
  return created[created.length - 1];
}

test("a socket that NEVER opens still hits the setup watchdog — no unbounded silence", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timeouts = [];
  const ws = makeSession({ onSetupTimeout: (err) => timeouts.push(err) });

  // No open, no error, no close — the stalled-handshake shape.
  t.mock.timers.tick(10_000);

  assert.equal(timeouts.length, 1, "the watchdog must fire without any socket event");
  assert.match(timeouts[0].message, /setup timeout/);
  assert.equal(ws.closed.length, 1, "the dead socket must be closed, not leaked");
});

test("without an onSetupTimeout callback the watchdog degrades to onError", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = [];
  makeSession({ onError: (err) => errors.push(err) });
  t.mock.timers.tick(10_000);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /setup timeout/);
});

test("the watchdog does NOT fire once session.updated arrived in time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timeouts = [];
  const ws = makeSession({ onSetupTimeout: (err) => timeouts.push(err) });

  ws.readyState = FakeWebSocket.OPEN;
  ws.emit("open");
  ws.emit("message", JSON.stringify({ type: "session.updated" }));
  t.mock.timers.tick(10_000);

  assert.equal(timeouts.length, 0, "a ready session must never be timed out");
});

test("post-watchdog socket noise is swallowed — the timeout is surfaced exactly once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = [];
  const closes = [];
  const timeouts = [];
  const ws = makeSession({
    onError: (err) => errors.push(err),
    onClose: (code) => closes.push(code),
    onSetupTimeout: (err) => timeouts.push(err),
  });

  t.mock.timers.tick(10_000);
  // Closing a CONNECTING socket emits a synthetic error, then close.
  ws.emit("error", new Error("WebSocket was closed before the connection was established"));
  ws.emit("close", 1006, Buffer.from(""));

  assert.equal(timeouts.length, 1);
  assert.deepEqual(errors, [], "the self-inflicted error must not double-report into teardown");
  assert.deepEqual(closes, [], "the self-inflicted close must not double-report into teardown");
});
