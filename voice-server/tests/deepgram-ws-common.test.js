"use strict";

/**
 * SCRUM-594: the plumbing the Flux and Aura clients share
 * (services/deepgram-ws-common.js). The clients' own tests already exercise it
 * end to end over real sockets; these pin its contract directly, so a change to
 * one client cannot quietly change the other.
 *
 * Time: the 30 s ping interval is observed by intercepting that one
 * setInterval (node:test's mock.timers would add an ExperimentalWarning).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_HOST, PING_INTERVAL_MS, resolveScheme, createCallbackGuard, failConnect, deadStream, createPinger } = require("../services/deepgram-ws-common");

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

/** Resolves after pending setImmediate callbacks (what failConnect schedules) have run. */
const nextImmediate = () => new Promise((resolve) => setImmediate(resolve));

// ── Constants ───────────────────────────────────────────────────────────────

test("one shared AU host and one 30 s ping interval", () => {
  assert.equal(DEFAULT_HOST, "api.au.deepgram.com");
  assert.equal(PING_INTERVAL_MS, 30_000);
});

// ── resolveScheme ───────────────────────────────────────────────────────────

test("resolveScheme: wss unless a loopback test server asks for plaintext ws", () => {
  assert.equal(resolveScheme(undefined, "api.au.deepgram.com", "T"), "wss");
  assert.equal(resolveScheme("wss", "api.au.deepgram.com", "T"), "wss");
  assert.equal(resolveScheme("wss", "127.0.0.1:9", "T"), "wss", "wss is always fine");
  for (const host of ["127.0.0.1", "127.0.0.1:1234", "localhost", "localhost:1234", "[::1]", "[::1]:1234"]) {
    assert.equal(resolveScheme("ws", host, "T"), "ws", host);
  }
});

test("resolveScheme: plaintext ws to anything that is not loopback is refused (the API key rides the upgrade headers)", () => {
  for (const host of ["api.au.deepgram.com", "api.deepgram.com:443", "127.0.0.1.evil.example", "localhost.evil.example", "evil.example/127.0.0.1", "10.0.0.5:80", "0.0.0.0", ""]) {
    assert.throws(() => resolveScheme("ws", host, "T"), /plaintext/i, JSON.stringify(host));
  }
});

test("resolveScheme: any other scheme is refused, and the message names the caller", () => {
  for (const scheme of ["http", "https", "ftp", "", "WS", "WSS", " ws"]) {
    assert.throws(() => resolveScheme(scheme, "127.0.0.1:1", "FluxSTT"), /\[FluxSTT\].*scheme/i, JSON.stringify(scheme));
  }
  assert.throws(() => resolveScheme("ws", "api.au.deepgram.com", "AuraStream"), /\[AuraStream\]/);
});

// ── createCallbackGuard ─────────────────────────────────────────────────────

test("guard.invoke: calls the callback with its arguments; a missing or non-function callback is a no-op", () => {
  const guard = createCallbackGuard("T", () => assert.fail("onError must not run"));
  const seen = [];
  guard.invoke((...args) => seen.push(args), 1, "two", { three: 3 });
  assert.deepEqual(seen, [[1, "two", { three: 3 }]]);
  assert.doesNotThrow(() => guard.invoke(undefined, 1));
  assert.doesNotThrow(() => guard.invoke(/** @type {any} */ ("nope"), 1));
});

test("guard.invoke: a throwing callback is contained and routed to onError (the same Error object)", () => {
  const errors = [];
  const guard = createCallbackGuard("T", (e) => errors.push(e));
  const boom = new Error("consumer bug");
  assert.doesNotThrow(() => guard.invoke(() => { throw boom; }));
  assert.deepEqual(errors, [boom]);
  assert.equal(errors[0], boom);
});

test("guard.invoke: a thrown non-Error is wrapped in an Error", () => {
  const errors = [];
  const guard = createCallbackGuard("T", (e) => errors.push(e));
  guard.invoke(() => { throw "just a string"; });
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  assert.match(errors[0].message, /just a string/);
});

test("guard.reportError: a throwing onError is logged with the label, never thrown", (t) => {
  const consoleError = t.mock.method(console, "error", () => {});
  const guard = createCallbackGuard("FluxSTT", () => { throw new Error("bad onError"); });
  assert.doesNotThrow(() => guard.reportError(new Error("original")));
  assert.equal(consoleError.mock.callCount(), 1);
  assert.equal(String(consoleError.mock.calls[0].arguments[0]), "[FluxSTT] onError callback threw: bad onError");
});

test("guard.reportError: with no onError the failure still goes to console.error (never silent)", (t) => {
  const consoleError = t.mock.method(console, "error", () => {});
  createCallbackGuard("AuraStream", undefined).reportError(new Error("boom"));
  assert.equal(consoleError.mock.callCount(), 1);
  assert.equal(String(consoleError.mock.calls[0].arguments[0]), "[AuraStream] boom (no onError handler)");
});

test("guard: an onError that throws while reporting a callback failure is logged too (no loop, no crash)", (t) => {
  const consoleError = t.mock.method(console, "error", () => {});
  const guard = createCallbackGuard("T", () => { throw new Error("handler broke"); });
  assert.doesNotThrow(() => guard.invoke(() => { throw new Error("first failure"); }));
  assert.equal(consoleError.mock.callCount(), 1);
  assert.match(String(consoleError.mock.calls[0].arguments[0]), /onError callback threw: handler broke/);
});

// ── failConnect ─────────────────────────────────────────────────────────────

test("failConnect: delivers onError then onClose(1006, '', {initiatedByUs:false}) ASYNCHRONOUSLY and returns the Error", async () => {
  const order = [];
  const guard = createCallbackGuard("T", (e) => order.push(["error", e.message]));
  const err = new Error("bad host");
  const returned = failConnect(guard, err, (code, reason, info) => order.push(["close", code, reason, info]));

  assert.equal(returned, err);
  assert.deepEqual(order, [], "nothing synchronously: the caller finishes wiring first");
  await nextImmediate();
  assert.deepEqual(order, [["error", "bad host"], ["close", 1006, "", { initiatedByUs: false }]]);
});

test("failConnect: a non-Error failure is wrapped; a missing onClose is fine", async () => {
  const errors = [];
  const guard = createCallbackGuard("T", (e) => errors.push(e));
  const returned = failConnect(guard, "plain string", undefined);
  assert.ok(returned instanceof Error);
  await nextImmediate();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /plain string/);
});

// ── deadStream ──────────────────────────────────────────────────────────────

test("deadStream: every named method is an inert function returning its configured value; props are copied; each call is fresh", () => {
  const a = deadStream({ send: false, flush: null, count: 0, close: undefined }, { readyState: 3 });
  assert.equal(a.send(Buffer.alloc(160)), false);
  assert.equal(a.flush(), null);
  assert.equal(a.count(), 0);
  assert.equal(a.close(), undefined);
  assert.equal(a.readyState, 3);
  const b = deadStream({ send: false });
  assert.notEqual(a, b);
  assert.equal(b.readyState, undefined);
});

// ── createPinger ────────────────────────────────────────────────────────────

/** Intercept ONLY the 30 s ping interval; everything else passes through. */
function interceptPingInterval(t) {
  const created = [];
  const cleared = [];
  t.mock.method(globalThis, "setInterval", (fn, ms, ...rest) => {
    if (ms !== PING_INTERVAL_MS) return realSetInterval(fn, ms, ...rest);
    const timer = {
      fn,
      ms,
      unrefd: false,
      unref() {
        timer.unrefd = true;
        return timer;
      },
    };
    created.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => {
    if (timer && timer.ms === PING_INTERVAL_MS) {
      cleared.push(timer);
      return undefined;
    }
    return realClearInterval(timer);
  });
  return { created, cleared };
}

/** The slice of a ws the pinger touches. */
function fakeWs(readyState) {
  return { readyState, pings: 0, ping() { this.pings += 1; } };
}

test("createPinger: nothing is armed until start(); start() arms one unref'd 30 s interval", (t) => {
  const timers = interceptPingInterval(t);
  const pinger = createPinger(fakeWs(1));
  assert.equal(timers.created.length, 0);
  pinger.start();
  assert.equal(timers.created.length, 1);
  assert.equal(timers.created[0].ms, 30_000);
  assert.equal(timers.created[0].unrefd, true, "a keepalive must never hold the process open");
});

test("createPinger: each tick sends a WebSocket ping only while the socket is OPEN", (t) => {
  const timers = interceptPingInterval(t);
  const ws = fakeWs(1);
  createPinger(ws).start();
  timers.created[0].fn();
  timers.created[0].fn();
  assert.equal(ws.pings, 2);
  for (const state of [0, 2, 3]) {
    ws.readyState = state;
    timers.created[0].fn();
  }
  assert.equal(ws.pings, 2, "no ping into a connecting / closing / closed socket");
});

test("createPinger: stop() clears the interval, is idempotent, and start() twice keeps a single timer", (t) => {
  const timers = interceptPingInterval(t);
  const pinger = createPinger(fakeWs(1));
  pinger.stop(); // before start: harmless
  assert.deepEqual(timers.cleared, []);

  pinger.start();
  pinger.start();
  assert.equal(timers.created.length, 1, "a second start() must not leak a second timer");
  pinger.stop();
  pinger.stop();
  assert.deepEqual(timers.cleared, timers.created, "cleared exactly once");
});
