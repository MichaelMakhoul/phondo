"use strict";

/**
 * SCRUM-594 Task 1: Deepgram Aura-2 streaming TTS client (services/aura-stream.js).
 *
 * The real client talks to a real local `ws` WebSocketServer on an ephemeral
 * port (the fake Deepgram). The fake emits the message shapes captured by the
 * live probes (scratchpad/fast/flux-aura-api.md B.2-B.6): Metadata on open,
 * `Flushed {sequence_id}`, `Cleared`, and `Warning {warn_code, warn_msg}`.
 *
 * The one thing the real server punishes hard is a malformed client message:
 * it closes with 1008 `DATA-0000` and sends no error frame. So the central
 * contract here is that EVERY frame the client ever sends is a well-formed
 * Speak / Flush / Clear / Close.
 *
 * Time: the 30 s keepalive is observed by intercepting that one setInterval,
 * and the flush window by stubbing Date.now. node:test's mock.timers is
 * deliberately avoided (its ExperimentalWarning would dirty the output).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const net = require("node:net");
const { performance } = require("node:perf_hooks");
const { WebSocketServer } = require("ws");

const { openAuraStream, buildAuraUrl, splitForSpeak, DEFAULT_VOICE, MAX_SPEAK_CHARS, FLUSH_BUDGET, FLUSH_WINDOW_MS, CLEARED_BACKSTOP_MS } = require("../services/aura-stream");
const { DEFAULT_HOST, PING_INTERVAL_MS } = require("../services/deepgram-ws-common");

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

// ── What the fake Deepgram says (shapes from the probes) ────────────────────
const METADATA = {
  type: "Metadata",
  request_id: "01a14593-73a4-7a83-b6e9-c01144e8a0c4",
  model_name: "aura-2-hyperion-en",
  model_version: "2025-04-15.4",
  model_uuid: "10c196f5-0000-0000-0000-000000000000",
  additional_model_uuids: ["0ec06c9b-0000-0000-0000-000000000000", "2e5096c7-0000-0000-0000-000000000000"],
};
const flushed = (n) => ({ type: "Flushed", sequence_id: n });
const CLEARED = { type: "Cleared", sequence_id: 0 };
const EXCESSIVE_FLUSH = { type: "Warning", warn_code: "EXCESSIVE_FLUSH", warn_msg: "Rate limit exceeded for flushes. Please try again later." };

/** Deepgram's audio frames are variable-sized raw mulaw (290 / 320 / 30 bytes in the probes). */
const audioFrame = (size, fill) => Buffer.alloc(size, fill);

// ── Test plumbing ───────────────────────────────────────────────────────────

/** Poll until `predicate()` is truthy; fails loudly instead of hanging. */
async function until(predicate, what, timeoutMs = 3000) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Let any in-flight frames settle (used to prove that something did NOT happen). */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A loopback port that refuses connections (bind, read the port, release). */
async function deadPort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Start a fake Deepgram TTS on 127.0.0.1:<ephemeral>. Sends Metadata on open
 * like the real one; records per connection the upgrade URL + headers, every
 * text frame (raw), every binary frame and the ping count. `server.script`, if
 * set, is called with (conn, parsedMessage) for each text frame so a test can
 * play the server's part. Torn down in t.after.
 */
async function startFakeAura(t, serverOptions = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, ...serverOptions });
  await once(wss, "listening");
  const connections = [];
  const server = {
    connections,
    host: `127.0.0.1:${wss.address().port}`,
    /** @type {null | ((conn: any, msg: any) => void)} */
    script: null,
    async connection(n = 0) {
      await until(() => connections[n], `server connection #${n}`);
      return connections[n];
    },
  };
  wss.on("connection", (socket, req) => {
    const conn = { socket, url: req.url, headers: req.headers, text: [], binary: [], pings: 0, close: null };
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        conn.binary.push(Buffer.from(/** @type {Buffer} */ (data)));
        return;
      }
      const raw = data.toString();
      conn.text.push(raw);
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // The real server closes with 1008 DATA-0000; the tests assert it never gets here.
      }
      if (server.script && parsed) server.script(conn, parsed);
    });
    socket.on("ping", () => {
      conn.pings += 1;
    });
    socket.on("close", (code, reason) => {
      conn.close = { code, reason: reason.toString() };
    });
    connections.push(conn);
    socket.send(JSON.stringify(METADATA));
  });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  return server;
}

/** Open an Aura client against the fake and record every callback. */
function openClient(t, server, callbacks = {}, options = {}) {
  const events = { audio: [], flushed: [], cleared: 0, warnings: [], errors: [], closes: [] };
  const handle = openAuraStream("test-key", {
    host: server.host,
    scheme: "ws",
    voice: "aura-2-hyperion-en",
    onAudio: (buf) => events.audio.push(buf),
    onFlushed: (seq) => events.flushed.push(seq),
    onCleared: () => {
      events.cleared += 1;
    },
    onWarning: (w) => events.warnings.push(w),
    onError: (err) => events.errors.push(err),
    onClose: (code, reason, info) => events.closes.push({ code, reason, ...info }),
    ...callbacks,
    ...options,
  });
  t.after(() => handle.close());
  return { handle, events };
}

/** The client's text frames, parsed (and proven to be JSON). */
const sent = (conn) => conn.text.map((raw) => JSON.parse(raw));

/** Intercept ONLY the 30 s ping interval; everything else passes through. */
function interceptPingInterval(t) {
  const created = [];
  const cleared = [];
  t.mock.method(globalThis, "setInterval", (fn, ms, ...rest) => {
    if (ms !== PING_INTERVAL_MS) return realSetInterval(fn, ms, ...rest);
    const timer = { fn, ms, unref() {}, ref() {} };
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

/**
 * Capture the setTimeout timers armed INSIDE `during(fn)` instead of scheduling
 * them, so a test can read their delay and fire them on demand. Every other
 * timer (ws's own, node:test's) passes straight through.
 */
function captureTimers(t) {
  const created = [];
  const cleared = [];
  let capturing = false;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...rest) => {
    if (!capturing) return realSetTimeout(fn, ms, ...rest);
    const timer = {
      fn,
      ms,
      unrefd: false,
      unref() {
        timer.unrefd = true;
        return timer;
      },
      ref() {
        return timer;
      },
    };
    created.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    if (timer && created.includes(timer)) {
      cleared.push(timer);
      return undefined;
    }
    return realClearTimeout(timer);
  });
  return {
    created,
    cleared,
    during(fn) {
      capturing = true;
      try {
        return fn();
      } finally {
        capturing = false;
      }
    },
  };
}

/** A Date.now the test owns. */
function controlClock(t, start = 1_700_000_000_000) {
  const clock = { now: start, advance(ms) { clock.now += ms; } };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

// ── URL / params ────────────────────────────────────────────────────────────

test("buildAuraUrl: exact params, AU host over wss by default", () => {
  assert.equal(DEFAULT_HOST, "api.au.deepgram.com");
  assert.equal(DEFAULT_VOICE, "aura-2-asteria-en");
  assert.equal(buildAuraUrl({}), "wss://api.au.deepgram.com/v1/speak?model=aura-2-asteria-en&encoding=mulaw&sample_rate=8000&mip_opt_out=true");
  assert.equal(
    buildAuraUrl({ voice: "aura-2-hyperion-en", host: "example.test" }),
    "wss://example.test/v1/speak?model=aura-2-hyperion-en&encoding=mulaw&sample_rate=8000&mip_opt_out=true",
  );
});

test("buildAuraUrl: carries mip_opt_out=true on every variant (privacy: no model-improvement retention)", () => {
  for (const opts of [{}, { voice: "aura-2-orion-en" }, { host: "example.test" }, { scheme: "ws", host: "127.0.0.1:9" }]) {
    assert.equal(new URL(buildAuraUrl(opts)).searchParams.get("mip_opt_out"), "true", JSON.stringify(opts));
  }
});

test("buildAuraUrl: mulaw/8000 raw audio, no container param, voice is URL-encoded", () => {
  const params = new URL(buildAuraUrl({ voice: "a b&c=d" })).searchParams;
  assert.deepEqual([...params.keys()], ["model", "encoding", "sample_rate", "mip_opt_out"]);
  assert.equal(params.get("model"), "a b&c=d", "round-trips through encoding, cannot smuggle params");
  assert.equal(params.get("encoding"), "mulaw");
  assert.equal(params.get("sample_rate"), "8000");
});

test("buildAuraUrl: plaintext ws is for loopback test servers only (the API key travels in the upgrade headers)", () => {
  assert.ok(buildAuraUrl({ scheme: "ws", host: "127.0.0.1:1234" }).startsWith("ws://127.0.0.1:1234/v1/speak?"));
  assert.throws(() => buildAuraUrl({ scheme: "ws", host: "api.au.deepgram.com" }), /plaintext/i);
  assert.throws(() => buildAuraUrl({ scheme: "http", host: "127.0.0.1:1234" }), /scheme/i);
});

test("connect: the upgrade request carries path, params and Token auth; ready resolves; Metadata is ignored", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  assert.equal(handle.isOpen(), false, "not open before the handshake");
  await handle.ready;
  assert.equal(handle.isOpen(), true);

  const conn = await server.connection();
  assert.equal(conn.url, "/v1/speak?model=aura-2-hyperion-en&encoding=mulaw&sample_rate=8000&mip_opt_out=true");
  assert.equal(conn.headers.authorization, "Token test-key");

  await settle();
  assert.deepEqual(events.audio, []);
  assert.deepEqual(events.errors, []);
  assert.deepEqual(events.warnings, []);
});

test("ready rejects when the connection fails; a never-awaited ready is NOT an unhandled rejection", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const port = await deadPort();
  const events = { errors: [], closes: [] };
  const awaited = openAuraStream("test-key", {
    host: `127.0.0.1:${port}`,
    scheme: "ws",
    onError: (e) => events.errors.push(e),
    onClose: (code, reason, info) => events.closes.push({ code, ...info }),
  });
  await assert.rejects(awaited.ready, /ECONNREFUSED/);

  // A second client whose ready nobody ever looks at.
  const ignored = openAuraStream("test-key", { host: `127.0.0.1:${port}`, scheme: "ws", onError: () => {}, onClose: () => {} });
  void ignored;
  await until(() => events.closes.length === 1, "onClose");
  await settle();

  assert.equal(events.errors.length, 1);
  assert.deepEqual(events.closes[0], { code: 1006, initiatedByUs: false });
  assert.deepEqual(unhandled, []);
  assert.equal(awaited.isOpen(), false);
});

test("a malformed host never throws into the caller (call-start path): ready rejects, then onError and onClose", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const events = { errors: [], closes: [] };
  let handle;
  assert.doesNotThrow(() => {
    handle = openAuraStream("test-key", {
      host: "not a valid host",
      onError: (e) => events.errors.push(e),
      onClose: (code, reason, info) => events.closes.push({ code, reason, ...info }),
    });
  });
  assert.equal(handle.isOpen(), false);
  assert.equal(handle.speak("hello"), false);
  assert.equal(handle.flush(), null);
  assert.equal(handle.flushesInLastMinute(), 0);
  assert.equal(handle.clear(), false);
  assert.doesNotThrow(() => handle.close());
  assert.deepEqual(events, { errors: [], closes: [] }, "callbacks are asynchronous: the caller finishes wiring first");
  await assert.rejects(handle.ready);

  await until(() => events.closes.length === 1, "onClose");
  await settle();
  assert.equal(events.errors.length, 1, "onError first, exactly once");
  assert.deepEqual(events.closes[0], { code: 1006, reason: "", initiatedByUs: false });
  assert.deepEqual(unhandled, []);
});

test("plaintext ws to a non-loopback host is refused through the same path: no cleartext connection, no throw", async () => {
  const events = { errors: [], closes: [] };
  let handle;
  assert.doesNotThrow(() => {
    handle = openAuraStream("test-key", { host: "api.au.deepgram.com", scheme: "ws", onError: (e) => events.errors.push(e), onClose: (c) => events.closes.push(c) });
  });
  assert.equal(handle.isOpen(), false);
  await assert.rejects(handle.ready, /plaintext/i);
  await until(() => events.closes.length === 1, "onClose");
  assert.match(events.errors[0].message, /plaintext/i);
});

// ── speak() ─────────────────────────────────────────────────────────────────

test("speak: sends {type:'Speak', text} with a TRAILING SPACE (it releases a finished sentence before Flush)", async (t) => {
  const server = await startFakeAura(t);
  const { handle } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  assert.equal(handle.speak("Sure, Michael."), true);
  await until(() => conn.text.length === 1, "Speak at the server");
  assert.equal(conn.text[0], '{"type":"Speak","text":"Sure, Michael. "}');
});

test("speak: trims the input first, one trailing space regardless of the input's whitespace", async (t) => {
  const server = await startFakeAura(t);
  const { handle } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  handle.speak("  \n Hello there.  \t");
  handle.speak("No trailing whitespace");
  await until(() => conn.text.length === 2, "2 Speaks");
  assert.deepEqual(sent(conn), [
    { type: "Speak", text: "Hello there. " },
    { type: "Speak", text: "No trailing whitespace " },
  ]);
});

test("speak: empty, whitespace-only and non-string input is a no-op (a Speak without text closes the socket with 1008)", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  for (const bad of ["", "   ", "\n\t ", null, undefined, 42, {}, [], true]) {
    assert.equal(handle.speak(/** @type {any} */ (bad)), false, String(bad));
  }
  handle.speak("marker");
  await until(() => conn.text.length === 1, "marker Speak");
  assert.deepEqual(sent(conn), [{ type: "Speak", text: "marker " }]);
  assert.deepEqual(events.errors, []);
});

test("speak: JSON-escapes quotes, newlines and non-ASCII (the message stays well-formed)", async (t) => {
  const server = await startFakeAura(t);
  const { handle } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  const text = 'She said "hi"\nthen left \\ café 😀';
  handle.speak(text);
  await until(() => conn.text.length === 1, "Speak");
  assert.deepEqual(sent(conn), [{ type: "Speak", text: `${text} ` }]);
});

test("speak: false (and nothing sent) when the socket is not open", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  assert.equal(handle.speak("too early"), false, "still connecting");
  await handle.ready;
  handle.close();
  await until(() => events.closes.length === 1, "onClose");
  assert.equal(handle.speak("too late"), false);
  const conn = await server.connection();
  assert.deepEqual(conn.text.filter((raw) => raw.includes("Speak")), []);
});

// ── speak(): the 2000-character limit ───────────────────────────────────────

const SENTENCE = (i) => `This is sentence number ${i} of the long answer.`;

test("splitForSpeak: text that fits goes out whole", () => {
  assert.deepEqual(splitForSpeak("Hello."), ["Hello."]);
  const fits = "a".repeat(MAX_SPEAK_CHARS - 1);
  assert.deepEqual(splitForSpeak(fits), [fits], "1999 chars + the trailing space = exactly 2000");
});

test("splitForSpeak: over-long text splits at the LAST sentence end that fits (= greedy sentence packing)", () => {
  const sentences = Array.from({ length: 90 }, (_, i) => SENTENCE(i));
  const text = sentences.join(" ");
  assert.ok(text.length > 4000);

  // Model: pack whole sentences while "<current> <next>" still fits in one Speak
  // (the trailing space is added on send, so a part may be 1999 chars).
  const expected = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + 1 + sentence.length > MAX_SPEAK_CHARS - 1) {
      expected.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  expected.push(current);

  const parts = splitForSpeak(text);
  assert.ok(parts.length >= 3, `expected 3+ parts, got ${parts.length}`);
  assert.deepEqual(parts, expected);
  for (const part of parts) assert.match(part, /\.$/, "every part ends on a sentence end");
});

test("splitForSpeak: with no sentence end it splits at the last space (never inside a word)", () => {
  const text = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
  assert.ok(text.length > 4000);
  const parts = splitForSpeak(text);
  assert.ok(parts.length >= 3);
  for (const part of parts) assert.ok(part.length + 1 <= MAX_SPEAK_CHARS);
  assert.equal(parts.join(" "), text);
});

test("splitForSpeak: a single unbroken token is hard-split at the limit (still never over it)", () => {
  const text = "x".repeat(4500);
  const parts = splitForSpeak(text);
  assert.deepEqual(parts.map((p) => p.length), [MAX_SPEAK_CHARS - 1, MAX_SPEAK_CHARS - 1, 4500 - 2 * (MAX_SPEAK_CHARS - 1)]);
  assert.equal(parts.join(""), text);
});

test("splitForSpeak: a hard split never cuts an emoji in half (a lone surrogate is invalid JSON text)", () => {
  const text = "😀".repeat(2200); // 4400 UTF-16 units, no spaces
  const parts = splitForSpeak(text);
  assert.ok(parts.length >= 3);
  for (const part of parts) {
    assert.equal(part, part.toWellFormed(), "no lone surrogate");
    assert.ok(part.length + 1 <= MAX_SPEAK_CHARS);
  }
  assert.equal(parts.join(""), text);
});

test("splitForSpeak: no message ever exceeds 2000 chars including the trailing space (boundary sweep)", () => {
  for (let n = MAX_SPEAK_CHARS - 12; n <= MAX_SPEAK_CHARS + 12; n++) {
    const text = "abcd ".repeat(600).slice(0, n).trim();
    const parts = splitForSpeak(text);
    for (const part of parts) assert.ok(part.length + 1 <= MAX_SPEAK_CHARS, `n=${n}: ${part.length + 1}`);
    assert.equal(parts.join(" "), text, `n=${n}`);
  }
});

test("speak: long text goes out as several Speak messages, each <= 2000 chars with its trailing space", async (t) => {
  const server = await startFakeAura(t);
  const { handle } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  const text = Array.from({ length: 90 }, (_, i) => SENTENCE(i)).join(" ");
  assert.equal(handle.speak(text), true);
  await until(() => conn.text.length >= 3, "3+ Speaks");
  await settle();

  const messages = sent(conn);
  assert.ok(messages.every((m) => m.type === "Speak"));
  assert.ok(messages.every((m) => m.text.length <= MAX_SPEAK_CHARS && m.text.endsWith(" ")));
  assert.equal(messages.map((m) => m.text.trimEnd()).join(" "), text);
});

// ── flush() ─────────────────────────────────────────────────────────────────

test("flush: sends {type:'Flush'} and returns the expected Flushed sequence id, from 0 per connection", async (t) => {
  const server = await startFakeAura(t);
  const { handle } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  assert.equal(handle.flush(), 0);
  assert.equal(handle.flush(), 1);
  assert.equal(handle.flush(), 2);
  await until(() => conn.text.length === 3, "3 Flushes");
  assert.deepEqual(conn.text, ['{"type":"Flush"}', '{"type":"Flush"}', '{"type":"Flush"}']);
});

test("flush budget: 18 per 60 s, the 19th returns null and sends NOTHING (the 21st would earn EXCESSIVE_FLUSH and no Flushed)", async (t) => {
  assert.equal(FLUSH_BUDGET, 18);
  assert.equal(FLUSH_WINDOW_MS, 60_000);
  controlClock(t);
  const server = await startFakeAura(t);
  const { handle } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  for (let i = 0; i < 18; i++) assert.equal(handle.flush(), i, `flush #${i + 1} is inside the budget`);
  assert.equal(handle.flush(), null, "the 19th is refused");
  assert.equal(handle.flush(), null, "and so is every later one in the window");
  assert.equal(handle.flushesInLastMinute(), 18);

  await until(() => conn.text.length === 18, "18 Flushes");
  await settle();
  assert.equal(conn.text.length, 18, "refused flushes are never put on the wire");
});

test("flush budget: a sliding window, not a fixed one; refused flushes consume no sequence id", async (t) => {
  const clock = controlClock(t);
  const server = await startFakeAura(t);
  const { handle } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  for (let i = 0; i < 10; i++) assert.equal(handle.flush(), i); // t0
  clock.advance(30_000);
  for (let i = 10; i < 18; i++) assert.equal(handle.flush(), i); // t0+30s: 18 in the window
  assert.equal(handle.flush(), null);

  clock.advance(29_999); // t0+59.999s: nothing has aged out yet
  assert.equal(handle.flush(), null);
  assert.equal(handle.flushesInLastMinute(), 18);

  clock.advance(1); // t0+60s: the first ten age out, eight remain
  assert.equal(handle.flushesInLastMinute(), 8);
  for (let i = 18; i < 28; i++) assert.equal(handle.flush(), i, "ids continue where they left off");
  assert.equal(handle.flush(), null, "back at 18 in the window");

  await until(() => conn.text.length === 28, "28 Flushes");
});

test("flush: null when the socket is not open, and a failed flush does not eat budget", async (t) => {
  controlClock(t);
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  assert.equal(handle.flush(), null, "still connecting");
  assert.equal(handle.flushesInLastMinute(), 0);
  await handle.ready;
  handle.close();
  await until(() => events.closes.length === 1, "onClose");
  assert.equal(handle.flush(), null);
  assert.equal(handle.flushesInLastMinute(), 0);
});

// ── Server messages ─────────────────────────────────────────────────────────

test("audio frames arrive as Buffers of whatever size Deepgram chose (no re-framing here)", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  const frames = [audioFrame(290, 0x62), audioFrame(320, 0x5b), audioFrame(320, 0x66), audioFrame(30, 0x01)];
  for (const frame of frames) conn.socket.send(frame);
  await until(() => events.audio.length === 4, "4 audio frames");

  assert.ok(events.audio.every((b) => Buffer.isBuffer(b)));
  assert.deepEqual(events.audio, frames);
});

test("Flushed -> onFlushed(sequence_id); Warning -> onWarning({code, message}) from warn_code/warn_msg", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  conn.socket.send(JSON.stringify(flushed(0)));
  conn.socket.send(JSON.stringify(flushed(1)));
  conn.socket.send(JSON.stringify(EXCESSIVE_FLUSH));
  await until(() => events.flushed.length === 2 && events.warnings.length === 1, "Flushed x2 + Warning");

  assert.deepEqual(events.flushed, [0, 1]);
  conn.socket.send(JSON.stringify({ type: "Flushed" })); // no sequence_id: the owner still hears about it
  await until(() => events.flushed.length === 3, "Flushed without an id");
  assert.deepEqual(events.flushed, [0, 1, null]);
  assert.deepEqual(events.warnings, [{ code: "EXCESSIVE_FLUSH", message: "Rate limit exceeded for flushes. Please try again later." }]);
  assert.deepEqual(events.errors, []);
});

test("an Error frame (never observed, but handled) and unparseable text go to onError without echoing content", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  conn.socket.send(JSON.stringify({ type: "Error", description: "Input text exceeds character limits", code: "413" }));
  conn.socket.send("this is not json, and says hello caller");
  conn.socket.send(JSON.stringify({ type: "SomethingNew" }));
  await until(() => events.errors.length === 2, "2 errors");
  await settle();

  assert.equal(events.errors.length, 2, "an unknown future message type is ignored, not an error");
  assert.match(events.errors[0].message, /Input text exceeds character limits/);
  assert.ok(!/hello caller/.test(events.errors[1].message));
});

test("a throwing consumer callback is contained and routed to onError (it must not crash the process)", async (t) => {
  const server = await startFakeAura(t);
  const boom = new Error("consumer bug");
  const { handle, events } = openClient(t, server, {
    onAudio: () => {
      throw boom;
    },
  });
  await handle.ready;
  const conn = await server.connection();

  conn.socket.send(audioFrame(320, 1));
  await until(() => events.errors.length === 1, "the contained error");
  assert.equal(events.errors[0], boom);
});

test("with no onError at all, a failure is still loud (console.error), never silently dropped", async (t) => {
  const consoleError = t.mock.method(console, "error", () => {});
  const server = await startFakeAura(t);
  const handle = openAuraStream("test-key", { host: server.host, scheme: "ws" });
  t.after(() => handle.close());
  await handle.ready;
  const conn = await server.connection();

  conn.socket.send(JSON.stringify({ type: "Error", description: "boom" }));
  await until(() => consoleError.mock.callCount() === 1, "the log line");
  const line = String(consoleError.mock.calls[0].arguments[0]);
  assert.match(line, /Aura error: boom/);
  assert.match(line, /no onError handler/);
});

test("a throwing onError is logged, never thrown into the socket handler", async (t) => {
  const consoleError = t.mock.method(console, "error", () => {});
  const server = await startFakeAura(t);
  const { handle } = openClient(t, server, {
    onError: () => {
      throw new Error("bad onError");
    },
  });
  await handle.ready;
  const conn = await server.connection();

  conn.socket.send(JSON.stringify({ type: "Error", description: "boom" }));
  await until(() => consoleError.mock.callCount() === 1, "the log line");
  assert.match(String(consoleError.mock.calls[0].arguments[0]), /onError callback threw/);
});

// ── clear() ─────────────────────────────────────────────────────────────────

test("clear: sends {type:'Clear'} and drops every audio frame until Cleared, then audio flows again", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  const BEFORE = audioFrame(320, 0xa1);
  const IN_FLIGHT = audioFrame(320, 0xa2); // generated before the Clear landed: must NOT reach Twilio
  const AFTER = audioFrame(320, 0xa3);
  server.script = (c, msg) => {
    if (msg.type !== "Clear") return;
    c.socket.send(IN_FLIGHT);
    c.socket.send(JSON.stringify(CLEARED));
    c.socket.send(AFTER);
  };

  conn.socket.send(BEFORE);
  await until(() => events.audio.length === 1, "audio before the clear");
  assert.equal(handle.clear(), true);
  await until(() => events.audio.length === 2 && events.cleared === 1, "Cleared + the frame after it");

  assert.deepEqual(conn.text, ['{"type":"Clear"}']);
  assert.deepEqual(events.audio, [BEFORE, AFTER], "the in-flight frame was dropped, the post-Cleared one delivered");
});

test("clear: suppression ends exactly at Cleared, not at the next Speak (audio for new text flows once Cleared lands)", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  const STALE = audioFrame(40, 0xb1);
  const FRESH = audioFrame(40, 0xb2);
  server.script = (c, msg) => {
    if (msg.type === "Clear") {
      c.socket.send(STALE);
      c.socket.send(JSON.stringify(CLEARED));
    }
    if (msg.type === "Flush") c.socket.send(FRESH);
  };

  handle.clear();
  handle.speak("A new answer.");
  handle.flush();
  await until(() => events.cleared === 1 && events.audio.length === 1, "Cleared + fresh audio");
  assert.deepEqual(events.audio, [FRESH]);
});

test("clear: two Clears in flight keep suppressing until BOTH are acknowledged", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  const X1 = audioFrame(40, 0xc1);
  const X2 = audioFrame(40, 0xc2);
  const Y = audioFrame(40, 0xc3);
  let clears = 0;
  server.script = (c, msg) => {
    if (msg.type !== "Clear") return;
    clears += 1;
    if (clears === 1) {
      c.socket.send(X1);
      c.socket.send(JSON.stringify(CLEARED));
    } else {
      c.socket.send(X2); // after the first Cleared, but the second Clear is still unacknowledged
      c.socket.send(JSON.stringify(CLEARED));
      c.socket.send(Y);
    }
  };

  handle.clear();
  handle.clear();
  await until(() => events.cleared === 2 && events.audio.length === 1, "both Cleared + Y");
  assert.deepEqual(events.audio, [Y]);
});

test("Cleared backstop: a Clear arms ONE unref'd ~750 ms timer, and the ack disarms it", async (t) => {
  assert.equal(CLEARED_BACKSTOP_MS, 750, "observed acks took 16-67 ms; 750 ms is the give-up point");
  const timers = captureTimers(t);
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  server.script = (c, msg) => {
    if (msg.type === "Clear") c.socket.send(JSON.stringify(CLEARED));
  };

  assert.equal(timers.during(() => handle.clear()), true);
  assert.equal(timers.created.length, 1);
  assert.equal(timers.created[0].ms, 750);
  assert.equal(timers.created[0].unrefd, true, "a backstop must never keep the process alive");

  await until(() => events.cleared === 1, "Cleared");
  assert.deepEqual(timers.cleared, timers.created, "the ack disarms the backstop");
  assert.deepEqual(events.warnings, []);
});

test("Cleared backstop: with NO ack, audio stays dropped until the timer fires, then flows again, with a CLEARED_TIMEOUT warning", async (t) => {
  const timers = captureTimers(t);
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();
  // The server never answers this Clear (a Clear on an idle Aura was never probed).

  timers.during(() => handle.clear());
  const STALE = audioFrame(40, 0xe1);
  const FRESH = audioFrame(40, 0xe2);
  conn.socket.send(STALE);
  conn.socket.send(JSON.stringify(EXCESSIVE_FLUSH)); // a marker the client never suppresses: once it lands, STALE was handled
  await until(() => events.warnings.length === 1, "the marker warning");
  assert.deepEqual(events.audio, [], "dropped while the ack is outstanding");

  timers.created[0].fn(); // ~750 ms pass with no Cleared
  assert.deepEqual(events.warnings.map((w) => w.code), ["EXCESSIVE_FLUSH", "CLEARED_TIMEOUT"]);
  assert.match(events.warnings[1].message, /Cleared/);
  assert.equal(events.cleared, 0, "the backstop is not an ack");

  conn.socket.send(FRESH);
  await until(() => events.audio.length === 1, "audio after the backstop");
  assert.deepEqual(events.audio, [FRESH]);
  assert.deepEqual(events.errors, []);
});

test("Cleared backstop: two Clears but ONE ack: the ack disarms the OLDEST timer, the other still ends the suppression", async (t) => {
  const timers = captureTimers(t);
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();
  const X = audioFrame(40, 0xf1);
  const Y = audioFrame(40, 0xf2);
  let clears = 0;
  server.script = (c, msg) => {
    if (msg.type !== "Clear") return;
    clears += 1;
    if (clears === 1) {
      c.socket.send(JSON.stringify(CLEARED));
      c.socket.send(X); // after the one ack, but the second Clear is unanswered: still the interrupted reply
      c.socket.send(JSON.stringify(EXCESSIVE_FLUSH)); // marker
    }
  };

  timers.during(() => {
    handle.clear();
    handle.clear();
  });
  assert.equal(timers.created.length, 2);
  await until(() => events.cleared === 1 && events.warnings.length === 1, "one ack + the marker");

  assert.deepEqual(timers.cleared, [timers.created[0]], "the ack disarmed the OLDEST backstop only");
  assert.deepEqual(events.audio, [], "X is still dropped: one Clear is unanswered");

  timers.created[1].fn(); // the unanswered Clear's backstop
  assert.deepEqual(events.warnings.map((w) => w.code), ["EXCESSIVE_FLUSH", "CLEARED_TIMEOUT"]);
  conn.socket.send(Y);
  await until(() => events.audio.length === 1, "audio after the backstop");
  assert.deepEqual(events.audio, [Y]);
});

test("Cleared backstop: when it fires it gives up on EVERY outstanding Clear (other timers disarmed, one warning)", async (t) => {
  const timers = captureTimers(t);
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  timers.during(() => {
    handle.clear();
    handle.clear();
    handle.clear();
  });
  assert.equal(timers.created.length, 3);
  timers.created[0].fn();

  assert.ok(timers.cleared.includes(timers.created[1]) && timers.cleared.includes(timers.created[2]), "the later backstops are disarmed");
  assert.deepEqual(events.warnings.map((w) => w.code), ["CLEARED_TIMEOUT"], "exactly one warning, not one per Clear");

  const AFTER = audioFrame(40, 0xe3);
  conn.socket.send(AFTER);
  await until(() => events.audio.length === 1, "audio after the backstop");
  assert.deepEqual(events.audio, [AFTER], "all three Clears are written off, not just one");
});

test("Cleared backstop: a late ack after the backstop is harmless (onCleared still fires, nothing else changes)", async (t) => {
  const timers = captureTimers(t);
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  timers.during(() => handle.clear());
  timers.created[0].fn();
  conn.socket.send(JSON.stringify(CLEARED)); // arrives 900 ms late
  const AFTER = audioFrame(40, 0xe4);
  conn.socket.send(AFTER);
  await until(() => events.cleared === 1 && events.audio.length === 1, "late ack + audio");

  assert.deepEqual(events.audio, [AFTER]);
  assert.deepEqual(events.warnings.map((w) => w.code), ["CLEARED_TIMEOUT"]);
});

test("Cleared backstop: the timer is disarmed on our close() and on a server close, so nothing fires into a torn-down call", async (t) => {
  const timers = captureTimers(t);
  const server = await startFakeAura(t);

  const ours = openClient(t, server);
  await ours.handle.ready;
  timers.during(() => ours.handle.clear());
  assert.equal(timers.created.length, 1);
  ours.handle.close();
  assert.deepEqual(timers.cleared, timers.created, "disarmed synchronously by close()");
  await until(() => ours.events.closes.length === 1, "our close");

  const theirs = openClient(t, server);
  await theirs.handle.ready;
  const conn = await server.connection(1);
  timers.during(() => theirs.handle.clear());
  assert.equal(timers.created.length, 2);
  conn.socket.close(1011, "server went away");
  await until(() => theirs.events.closes.length === 1, "server close");
  assert.deepEqual(timers.cleared, timers.created, "disarmed by the close event");
  assert.deepEqual([...ours.events.warnings, ...theirs.events.warnings], []);
});

test("Cleared backstop: a Clear that was never sent (socket not open) arms no timer", async (t) => {
  const timers = captureTimers(t);
  const server = await startFakeAura(t);
  const { handle } = openClient(t, server);
  assert.equal(timers.during(() => handle.clear()), false, "still connecting");
  assert.equal(timers.created.length, 0);
  await handle.ready;
});

test("a Flushed between our Clear and its Cleared belongs to the interrupted reply and is dropped; a later one is delivered", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  server.script = (c, msg) => {
    if (msg.type !== "Clear") return;
    c.socket.send(JSON.stringify(flushed(7))); // finished generating just before the Clear landed: stale
    c.socket.send(JSON.stringify(CLEARED));
    c.socket.send(JSON.stringify(flushed(9))); // the next reply
  };

  handle.clear();
  await until(() => events.cleared === 1 && events.flushed.length >= 1, "Cleared + a Flushed");
  await settle();
  assert.deepEqual(events.flushed, [9], "Flushed(7) never reached onFlushed");
});

test("clear on a socket that is not open sends nothing and does NOT arm suppression", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  assert.equal(handle.clear(), false, "still connecting");
  await handle.ready;
  const conn = await server.connection();

  conn.socket.send(audioFrame(40, 0xd1));
  await until(() => events.audio.length === 1, "audio flows: nothing was cleared");
  assert.deepEqual(conn.text, []);
});

// ── Protocol discipline ─────────────────────────────────────────────────────

test("INVALID MESSAGES ARE NEVER SENT: every client frame is a well-formed Speak/Flush/Clear/Close", async (t) => {
  controlClock(t);
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  // Everything a careless caller might do.
  for (const input of ["  hi  ", "", "   ", null, undefined, 42, {}, "a".repeat(5000), "x".repeat(4500), "😀".repeat(2200), 'q"uote\nline', "end."]) {
    handle.speak(/** @type {any} */ (input));
  }
  for (let i = 0; i < 25; i++) handle.flush();
  handle.clear();
  handle.close();
  await until(() => events.closes.length === 1 && conn.close, "closed");

  assert.deepEqual(conn.binary, [], "the client never sends binary frames to Aura");
  assert.ok(conn.text.length > 20);
  const allowed = new Set(["Speak", "Flush", "Clear", "Close"]);
  for (const raw of conn.text) {
    const msg = JSON.parse(raw); // throws if the client ever sent invalid JSON
    assert.ok(allowed.has(msg.type), `illegal message type in ${raw.slice(0, 80)}`);
    if (msg.type === "Speak") {
      assert.deepEqual(Object.keys(msg).sort(), ["text", "type"]);
      assert.equal(typeof msg.text, "string");
      assert.ok(msg.text.trim().length > 0, "a Speak without text closes the socket with 1008");
      assert.ok(msg.text.length <= MAX_SPEAK_CHARS, `Speak of ${msg.text.length} chars`);
      assert.ok(msg.text.endsWith(" "), "trailing space");
      assert.equal(msg.text, msg.text.toWellFormed());
    } else {
      assert.deepEqual(Object.keys(msg), ["type"], `${msg.type} carries no other fields`);
    }
  }
  // The real server would have closed us with 1008; ours closed because we asked.
  assert.equal(events.closes[0].initiatedByUs, true);
  assert.notEqual(conn.close.code, 1008);
});

test("close(): sends {type:'Close'} then closes; initiatedByUs=true; idempotent; isOpen() false", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  handle.close();
  handle.close();
  assert.equal(handle.isOpen(), false);
  await until(() => events.closes.length === 1 && conn.close, "close on both ends");

  assert.deepEqual(conn.text, ['{"type":"Close"}']);
  assert.equal(events.closes.length, 1);
  assert.equal(events.closes[0].initiatedByUs, true);
  assert.deepEqual(events.errors, []);
});

test("close() before the socket opens: no Close frame, no spurious onError, onClose fires, ready rejects quietly", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  handle.close(); // still CONNECTING
  await until(() => events.closes.length === 1, "onClose");

  assert.equal(events.closes[0].initiatedByUs, true);
  assert.deepEqual(events.errors, [], "'closed before the connection was established' is our own doing");
  await assert.rejects(handle.ready, /closed/i);
  assert.deepEqual(server.connections.flatMap((c) => c.text), []);
});

test("a server-initiated close is reported as not ours: the 1008 DATA-0000 a malformed message would earn", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();

  conn.socket.close(1008, "DATA-0000");
  await until(() => events.closes.length === 1, "onClose");
  assert.deepEqual(events.closes[0], { code: 1008, reason: "DATA-0000", initiatedByUs: false });
  assert.equal(handle.isOpen(), false);
  assert.deepEqual(events.errors, []);
});

test("after our own close(), late frames are ignored (no audio into a torn-down call)", async (t) => {
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  await handle.ready;
  const conn = await server.connection();
  conn.socket.on("message", (data) => {
    if (data.toString() === '{"type":"Close"}') {
      conn.socket.send(audioFrame(320, 9));
      conn.socket.send(JSON.stringify(flushed(0)));
    }
  });

  handle.close();
  await until(() => events.closes.length === 1, "onClose");
  assert.deepEqual(events.audio, []);
  assert.deepEqual(events.flushed, []);
});

// ── Keepalive ───────────────────────────────────────────────────────────────

test("keepalive: closing while still CONNECTING never creates a ping timer", async (t) => {
  const timers = interceptPingInterval(t);
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  handle.close();
  await until(() => events.closes.length === 1, "onClose");
  await settle();

  assert.equal(timers.created.length, 0, "the timer starts on open, not at construction");
  await assert.rejects(handle.ready, /closed/i);
});

test("keepalive: a WebSocket ping every 30 s, started on open, and never a JSON KeepAlive (an unknown type closes the socket with 1008)", async (t) => {
  assert.equal(PING_INTERVAL_MS, 30_000);
  const timers = interceptPingInterval(t);
  const server = await startFakeAura(t);
  const { handle, events } = openClient(t, server);
  assert.equal(timers.created.length, 0, "no ping timer before the socket is open");
  await handle.ready;
  const conn = await server.connection();

  assert.equal(timers.created.length, 1, "exactly one ping timer");
  assert.equal(timers.created[0].ms, 30_000);
  for (let i = 1; i <= 4; i++) {
    timers.created[0].fn();
    await until(() => conn.pings === i, `ping #${i}`);
  }
  assert.deepEqual(conn.text, [], "an idle connection sends pings only");

  handle.close();
  await until(() => events.closes.length === 1 && conn.close, "closed");
  assert.deepEqual(conn.text, ['{"type":"Close"}']);
  assert.ok(conn.text.every((raw) => !raw.includes("KeepAlive")));
});

test("keepalive: the ping timer is cleared on our close(), on a server close, and never created for a failed connection", async (t) => {
  const timers = interceptPingInterval(t);
  const server = await startFakeAura(t);

  const ours = openClient(t, server);
  await ours.handle.ready;
  assert.equal(timers.created.length, 1);
  ours.handle.close();
  await until(() => ours.events.closes.length === 1, "our close");
  assert.deepEqual(timers.cleared, timers.created);

  const theirs = openClient(t, server);
  await theirs.handle.ready;
  assert.equal(timers.created.length, 2);
  const conn = await server.connection(1);
  conn.socket.close(1011, "server went away");
  await until(() => theirs.events.closes.length === 1, "server close");
  assert.deepEqual(timers.cleared, timers.created);

  const port = await deadPort();
  const closes = [];
  openAuraStream("test-key", { host: `127.0.0.1:${port}`, scheme: "ws", onError: () => {}, onClose: (code) => closes.push(code) }).ready.catch(() => {});
  await until(() => closes.length === 1, "failed connection closed");
  assert.equal(timers.created.length, 2, "no timer for a connection that never opened");
});
