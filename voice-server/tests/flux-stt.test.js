"use strict";

/**
 * SCRUM-594 Task 1: Deepgram Flux STT client (services/flux-stt.js).
 *
 * The real client talks to a real local `ws` WebSocketServer on an ephemeral
 * port (the fake Deepgram). The fake emits the exact message shapes captured
 * by the live probes (scratchpad/fast/flux-aura-api.md A.4-A.7, A.11).
 *
 * Time: the 30 s keepalive is observed by intercepting that one setInterval
 * (so a test can fire a "tick" on demand and see the ping arrive at the fake).
 * node:test's mock.timers is deliberately avoided: its ExperimentalWarning
 * would dirty the test output. Expected console output is captured.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const net = require("node:net");
const { performance } = require("node:perf_hooks");
const { WebSocketServer } = require("ws");

const { openFluxStream, fluxConfigFromEnv, buildFluxUrl, FLUX_DEFAULTS, _test } = require("../services/flux-stt");
const { DEFAULT_HOST, PING_INTERVAL_MS } = require("../services/deepgram-ws-common");
const { buildKeytermsParam } = require("../services/deepgram-stt");

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

const REQUEST_ID = "01a14593-73a4-7a83-b6e9-c01144e8a0c4";

// ── Frames the fake Deepgram sends (shapes verbatim from the probes) ────────
const CONNECTED = { type: "Connected", request_id: REQUEST_ID, sequence_id: 0 };

const WORDS = [
  { word: "No.", confidence: 1, start: 0, end: 0.48 },
  { word: "I", confidence: 1, start: 0.48, end: 0.64 },
  { word: "said", confidence: 1, start: 0.64, end: 0.8 },
  { word: "ten", confidence: 1, start: 0.8, end: 0.96 },
  { word: "AM.", confidence: 1, start: 0.96, end: 1.44 },
];

function turnInfo(event, fields = {}) {
  return {
    type: "TurnInfo",
    request_id: REQUEST_ID,
    event,
    turn_index: 0,
    audio_window_start: 0,
    audio_window_end: 1.68,
    transcript: "No. I said ten AM.",
    words: WORDS,
    end_of_turn_confidence: 0.46,
    sequence_id: 7,
    ...fields,
  };
}

// ── Test plumbing ───────────────────────────────────────────────────────────

/** Poll until `predicate()` is truthy; fails loudly instead of hanging. */
async function until(predicate, what, timeoutMs = 3000) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
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
 * Start a fake Deepgram on 127.0.0.1:<ephemeral>. Records, per connection, the
 * upgrade URL + headers, every text frame, every binary frame and ping count.
 * Everything is torn down in t.after so `node --test` exits promptly.
 */
async function startFakeDeepgram(t, serverOptions = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, ...serverOptions });
  await once(wss, "listening");
  const connections = [];
  wss.on("connection", (socket, req) => {
    const conn = { socket, url: req.url, headers: req.headers, text: [], binary: [], pings: 0, close: null };
    socket.on("message", (data, isBinary) => {
      if (isBinary) conn.binary.push(Buffer.from(/** @type {Buffer} */ (data)));
      else conn.text.push(data.toString());
    });
    socket.on("ping", () => {
      conn.pings += 1;
    });
    socket.on("close", (code, reason) => {
      conn.close = { code, reason: reason.toString() };
    });
    connections.push(conn);
  });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  const port = wss.address().port;
  return {
    connections,
    port,
    host: `127.0.0.1:${port}`,
    async connection(n = 0) {
      await until(() => connections[n], `server connection #${n}`);
      return connections[n];
    },
  };
}

/** Open a Flux client against the fake and record every callback. */
function openClient(t, server, callbacks = {}, options = {}) {
  const events = { opens: 0, turns: [], errors: [], closes: [], warnings: [] };
  const handle = openFluxStream(
    "test-key",
    {
      onOpen: () => {
        events.opens += 1;
      },
      onTurnInfo: (evt) => events.turns.push(evt),
      onError: (err) => events.errors.push(err),
      onClose: (code, reason, info) => events.closes.push({ code, reason, ...info }),
      onWarning: (w) => events.warnings.push(w),
      ...callbacks,
    },
    { host: server.host, scheme: "ws", ...options },
  );
  t.after(() => handle.close());
  return { handle, events };
}

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

// ── URL / params ────────────────────────────────────────────────────────────

test("buildFluxUrl: exact params in the exact order, AU host over wss by default", () => {
  assert.equal(DEFAULT_HOST, "api.au.deepgram.com");
  const url = buildFluxUrl({});
  assert.equal(
    url.split("&keyterm=")[0],
    "wss://api.au.deepgram.com/v2/listen?model=flux-general-en&encoding=mulaw&sample_rate=8000" +
      "&eot_threshold=0.7&eager_eot_threshold=0.4&eot_timeout_ms=5000&mip_opt_out=true",
    "everything before the keyterms is exact (the keyterms have their own test)",
  );
  assert.ok(url.includes("&keyterm="), "the common keyterms follow");
});

test("buildFluxUrl: carries mip_opt_out=true on every variant (privacy: no model-improvement retention)", () => {
  for (const opts of [{}, { industry: "dental" }, { eagerEotThreshold: null }, { host: "example.test", eotThreshold: 0.9 }]) {
    const params = new URL(buildFluxUrl(opts)).searchParams;
    assert.equal(params.get("mip_opt_out"), "true", JSON.stringify(opts));
  }
});

test("buildFluxUrl: only Flux-legal params (unknown params are an HTTP 400 on /v2/listen)", () => {
  const allowed = new Set(["model", "encoding", "sample_rate", "eot_threshold", "eager_eot_threshold", "eot_timeout_ms", "mip_opt_out", "keyterm"]);
  const names = [...new URL(buildFluxUrl({ industry: "dental" })).searchParams.keys()];
  const unknown = names.filter((n) => !allowed.has(n));
  assert.deepEqual(unknown, []);
  // The Nova-3 params that Flux rejects must never leak in.
  for (const nova of ["channels", "language", "punctuate", "smart_format", "interim_results", "endpointing", "utterance_end_ms", "vad_events"]) {
    assert.ok(!names.includes(nova), `${nova} must not be sent to Flux`);
  }
});

test("buildFluxUrl: keyterms are plain terms (Flux has no weights), none repeated, multi-word terms whole", () => {
  for (const industry of [undefined, "dental", "medical", "legal", "home_services", "real_estate"]) {
    const values = new URL(buildFluxUrl({ industry })).searchParams.getAll("keyterm");
    assert.ok(values.length > 0, String(industry));
    assert.deepEqual(values.filter((v) => v.includes(":")), [], `${industry}: Flux docs say "Do not append a weight" (appointment:2)`);
    assert.equal(new Set(values).size, values.length, `${industry}: a repeated keyterm: ${values.join(", ")}`);
  }
  const dental = new URL(buildFluxUrl({ industry: "dental" })).searchParams.getAll("keyterm");
  assert.ok(dental.includes("root canal"), "a multi-word term stays ONE value");
  assert.equal(dental.filter((v) => v === "appointment").length, 1, "dental repeats appointment once the boosts are stripped");
});

test("buildFluxUrl: keyterms reuse buildKeytermsParam(industry, { weights: false }) and come last", () => {
  const url = buildFluxUrl({ industry: "dental" });
  assert.ok(url.endsWith(buildKeytermsParam("dental", { weights: false })), url);
  const names = [...new URL(url).searchParams.keys()];
  assert.deepEqual(names.slice(0, 7), ["model", "encoding", "sample_rate", "eot_threshold", "eager_eot_threshold", "eot_timeout_ms", "mip_opt_out"]);
  assert.ok(names.slice(7).length > 0 && names.slice(7).every((n) => n === "keyterm"));
});

test("buildFluxUrl: eagerEotThreshold null omits the param (speculation off); numbers pass through", () => {
  const off = new URL(buildFluxUrl({ eagerEotThreshold: null })).searchParams;
  assert.equal(off.has("eager_eot_threshold"), false);
  assert.equal(off.get("eot_threshold"), String(FLUX_DEFAULTS.eotThreshold));

  const custom = new URL(buildFluxUrl({ eotThreshold: 0.85, eagerEotThreshold: 0.55, eotTimeoutMs: 8000 })).searchParams;
  assert.equal(custom.get("eot_threshold"), "0.85");
  assert.equal(custom.get("eager_eot_threshold"), "0.55");
  assert.equal(custom.get("eot_timeout_ms"), "8000");
});

test("buildFluxUrl: a whole-number threshold keeps its decimal point (the probes verified eot_threshold=1.0, never a bare 1)", () => {
  const params = new URL(buildFluxUrl({ eotThreshold: 1, eagerEotThreshold: 0.9, eotTimeoutMs: 1000 })).searchParams;
  assert.equal(params.get("eot_threshold"), "1.0");
  assert.equal(params.get("eager_eot_threshold"), "0.9");
  assert.equal(params.get("eot_timeout_ms"), "1000", "the timeout is an integer parameter and stays one");
});

test("buildFluxUrl: plaintext ws is for loopback test servers only (the API key travels in the upgrade headers)", () => {
  assert.ok(buildFluxUrl({ scheme: "ws", host: "127.0.0.1:1234" }).startsWith("ws://127.0.0.1:1234/v2/listen?"));
  assert.ok(buildFluxUrl({ scheme: "ws", host: "localhost:1234" }).startsWith("ws://localhost:1234/"));
  assert.throws(() => buildFluxUrl({ scheme: "ws", host: "api.au.deepgram.com" }), /plaintext/i);
  assert.throws(() => buildFluxUrl({ scheme: "http", host: "127.0.0.1:1234" }), /scheme/i);
});

test("connect: the upgrade request carries the path, params and Token auth", async (t) => {
  const server = await startFakeDeepgram(t);
  openClient(t, server, {}, { industry: "home_services" });
  const conn = await server.connection();
  assert.equal(conn.url, new URL(buildFluxUrl({ scheme: "ws", host: server.host, industry: "home_services" })).pathname +
    new URL(buildFluxUrl({ scheme: "ws", host: server.host, industry: "home_services" })).search);
  assert.equal(conn.headers.authorization, "Token test-key");
  assert.equal(new URLSearchParams(conn.url.split("?")[1]).get("mip_opt_out"), "true");
});

// ── Handle: readyState / send / open ────────────────────────────────────────

test("readyState mirrors the socket, onOpen fires once, send() delivers binary audio", async (t) => {
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);

  assert.equal(handle.readyState, 0, "CONNECTING right after open()");
  assert.equal(handle.send(Buffer.from([1, 2, 3])), false, "send before open is a no-op, not a throw");

  await until(() => events.opens === 1, "onOpen");
  assert.equal(handle.readyState, 1, "OPEN");

  const audio = Buffer.from(Array.from({ length: 160 }, (_, i) => i % 256));
  assert.equal(handle.send(audio), true);
  const conn = await server.connection();
  await until(() => conn.binary.length === 1, "audio frame at the server");
  assert.deepEqual(conn.binary[0], audio);
  assert.deepEqual(conn.text, [], "audio is binary only; nothing else is sent on connect");

  handle.close();
  await until(() => events.closes.length === 1, "onClose");
  assert.equal(handle.readyState, 3, "CLOSED");
  assert.equal(events.opens, 1);
});

test("activity stamps for the server's silence watchdog: lastMessageAt counts EVERY frame (empty Updates too), lastSendAt every audio frame sent", async (t) => {
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  assert.equal(handle.lastSendAt, 0, "nothing sent yet");
  const beforeOpen = Date.now();
  await until(() => events.opens === 1, "onOpen");
  assert.ok(handle.lastMessageAt >= beforeOpen, "the open counts: a fresh connection is not silent");
  const conn = await server.connection();

  await new Promise((resolve) => setTimeout(resolve, 5));
  const sentAt = Date.now();
  assert.equal(handle.send(Buffer.alloc(160)), true);
  assert.ok(handle.lastSendAt >= sentAt);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const heardAt = Date.now();
  conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "", words: [] }))); // never delivered to onTurnInfo
  await until(() => handle.lastMessageAt >= heardAt, "the empty Update's stamp");
  assert.deepEqual(events.turns, [], "still not delivered");

  const closedAt = handle.lastMessageAt;
  handle.close();
  conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "late" })));
  await until(() => events.closes.length === 1, "onClose");
  assert.equal(handle.lastMessageAt, closedAt, "frames after our close() are not activity");
});

test("a dead handle (it could not even be constructed) reports no activity", () => {
  const handle = openFluxStream("test-key", { onError() {}, onClose() {} }, { host: "not a valid host" });
  assert.equal(handle.lastMessageAt, 0);
  assert.equal(handle.lastSendAt, 0);
});

// ── Turn events ─────────────────────────────────────────────────────────────

test("TurnInfo: all five events map to {event, turnIndex, transcript, eotConfidence, trigger}", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.send(JSON.stringify(CONNECTED));
  conn.socket.send(JSON.stringify(turnInfo("StartOfTurn", { transcript: "No.", end_of_turn_confidence: 0.0064, sequence_id: 3 })));
  conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "No. I said ten a", end_of_turn_confidence: 0.0723, sequence_id: 5 })));
  conn.socket.send(JSON.stringify(turnInfo("EagerEndOfTurn")));
  conn.socket.send(JSON.stringify(turnInfo("TurnResumed", { transcript: "No. I said ten AM. Yes", end_of_turn_confidence: 0.0437 })));
  conn.socket.send(JSON.stringify(turnInfo("EndOfTurn", { transcript: "No. I said ten AM. Yes", end_of_turn_confidence: 0.7974, turn_index: 0, trigger: "model" })));
  await until(() => events.turns.length === 5, "5 turn events");

  assert.deepEqual(events.turns, [
    { event: "StartOfTurn", turnIndex: 0, transcript: "No.", eotConfidence: 0.0064, trigger: null },
    { event: "Update", turnIndex: 0, transcript: "No. I said ten a", eotConfidence: 0.0723, trigger: null },
    { event: "EagerEndOfTurn", turnIndex: 0, transcript: "No. I said ten AM.", eotConfidence: 0.46, trigger: null },
    { event: "TurnResumed", turnIndex: 0, transcript: "No. I said ten AM. Yes", eotConfidence: 0.0437, trigger: null },
    { event: "EndOfTurn", turnIndex: 0, transcript: "No. I said ten AM. Yes", eotConfidence: 0.7974, trigger: "model" },
  ]);
  assert.deepEqual(events.errors, []);
});

test("TurnInfo: turnIndex follows the wire; EndOfTurn triggers model/timeout/manual and unknown values pass through", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  for (const trigger of ["model", "timeout", "manual", "some-future-trigger"]) {
    conn.socket.send(JSON.stringify(turnInfo("EndOfTurn", { turn_index: 4, trigger })));
  }
  await until(() => events.turns.length === 4, "4 EndOfTurn events");
  assert.deepEqual(events.turns.map((e) => [e.turnIndex, e.trigger]), [[4, "model"], [4, "timeout"], [4, "manual"], [4, "some-future-trigger"]]);
});

test("TurnInfo: Updates with an empty transcript are dropped inside the client", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  // Steady silence: the server streams empty Updates ~4/s forever.
  for (let i = 0; i < 20; i++) {
    conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "", words: [], end_of_turn_confidence: 0.0046 })));
  }
  conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "   " })));
  conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "hello" })));
  await until(() => events.turns.length >= 1, "the one real Update");

  assert.equal(events.turns.length, 1);
  assert.equal(events.turns[0].transcript, "hello");
});

test("TurnInfo: only Updates are filtered; an EndOfTurn with an empty transcript still reaches the turn engine", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.send(JSON.stringify(turnInfo("EndOfTurn", { transcript: "", words: [], trigger: "timeout" })));
  await until(() => events.turns.length === 1, "empty EndOfTurn");
  assert.equal(events.turns[0].event, "EndOfTurn");
  assert.equal(events.turns[0].transcript, "");
});

test("TurnInfo: a missing end_of_turn_confidence is null, never undefined or NaN", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  const frame = turnInfo("EndOfTurn", { trigger: "model" });
  delete frame.end_of_turn_confidence;
  conn.socket.send(JSON.stringify(frame));
  await until(() => events.turns.length === 1, "EndOfTurn");
  assert.equal(events.turns[0].eotConfidence, null);
});

test("non-TurnInfo frames never reach onTurnInfo", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.send(JSON.stringify(CONNECTED));
  conn.socket.send(JSON.stringify({ type: "ConfigureSuccess", request_id: REQUEST_ID, thresholds: { eot_threshold: 0.8, eager_eot_threshold: 0.4, eot_timeout_ms: 6000 }, keyterms: [], sequence_id: 1 }));
  conn.socket.send(JSON.stringify({ type: "SomethingNew", sequence_id: 9 }));
  conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "marker" })));
  await until(() => events.turns.length === 1, "marker Update");

  assert.equal(events.turns.length, 1);
  assert.deepEqual(events.errors, []);
});

test("an unknown future TurnInfo event is not delivered, and is reported ONCE via onWarning (not as an error)", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  for (let i = 0; i < 3; i++) conn.socket.send(JSON.stringify(turnInfo("SpeechStarted", { transcript: "caller words must not leak" })));
  conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "marker" })));
  await until(() => events.turns.length === 1, "marker Update");

  assert.deepEqual(events.turns.map((e) => e.transcript), ["marker"], "the unknown event never reaches the turn engine");
  assert.equal(events.warnings.length, 1, "once per distinct event name");
  assert.equal(events.warnings[0].code, "UNKNOWN_EVENT");
  assert.match(events.warnings[0].message, /SpeechStarted/);
  assert.ok(!/caller words/.test(events.warnings[0].message), "warnings never carry transcript text");
  assert.deepEqual(events.errors, []);
});

test("malformed TurnInfo is reported (never a silent drop) and never delivered", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.send(JSON.stringify({ type: "TurnInfo", request_id: REQUEST_ID, turn_index: 0, transcript: "no event field" }));
  conn.socket.send(JSON.stringify(turnInfo("EndOfTurn", { turn_index: "zero" })));
  conn.socket.send("this is not json");
  conn.socket.send(Buffer.from([0, 1, 2]), { binary: true }); // Flux never sends binary: ignored
  conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "marker" })));
  await until(() => events.turns.length === 1, "marker Update");

  assert.equal(events.turns.length, 1, "only the well-formed event is delivered");
  assert.equal(events.errors.length, 3);
  for (const err of events.errors) {
    assert.ok(err instanceof Error);
    assert.ok(!/no event field|marker/.test(err.message), "error messages must not echo caller words");
  }
});

// ── Errors / warnings ───────────────────────────────────────────────────────

test("Error frames read `description` (not `message`) and fall back to `code`", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.send(JSON.stringify({ type: "Error", code: "INACTIVE_CLIENT", description: "The client did not receive a websocket Ping message in the last 60 seconds", message: "WRONG-FIELD", sequence_id: 1 }));
  conn.socket.send(JSON.stringify({ type: "Error", code: "SOME_CODE_ONLY", sequence_id: 2 }));
  conn.socket.send(JSON.stringify({ type: "Error", sequence_id: 3 }));
  await until(() => events.errors.length === 3, "3 errors");

  assert.match(events.errors[0].message, /did not receive a websocket Ping message/);
  assert.doesNotMatch(events.errors[0].message, /WRONG-FIELD/);
  assert.equal(events.errors[0].code, "INACTIVE_CLIENT");
  assert.match(events.errors[1].message, /SOME_CODE_ONLY/);
  assert.match(events.errors[2].message, /unknown/i);
  assert.deepEqual(events.turns, []);
});

test("Warning and ConfigureFailure go to onWarning, not onError", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.send(JSON.stringify({ type: "Warning", request_id: REQUEST_ID, code: "FORCE_END_TURN_NO_ACTIVE_TURN", description: "Received ForceEndTurn while no turn was active; the request was ignored.", sequence_id: 15 }));
  conn.socket.send(JSON.stringify({ type: "ConfigureFailure", request_id: REQUEST_ID, code: "UNPARSABLE_CLIENT_MESSAGE", description: "eager_eot_threshold cannot be greater than eot_threshold.", sequence_id: 2 }));
  await until(() => events.warnings.length === 2, "2 warnings");

  assert.deepEqual(events.warnings, [
    { type: "Warning", code: "FORCE_END_TURN_NO_ACTIVE_TURN", message: "Received ForceEndTurn while no turn was active; the request was ignored." },
    { type: "ConfigureFailure", code: "UNPARSABLE_CLIENT_MESSAGE", message: "eager_eot_threshold cannot be greater than eot_threshold." },
  ]);
  assert.deepEqual(events.errors, []);
});

test("a throwing consumer callback is contained and routed to onError (it must not crash the process)", async (t) => {
  const server = await startFakeDeepgram(t);
  const boom = new Error("consumer bug");
  const { events } = openClient(t, server, {
    onTurnInfo: () => {
      throw boom;
    },
  });
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.send(JSON.stringify(turnInfo("EndOfTurn", { trigger: "model" })));
  await until(() => events.errors.length === 1, "the contained error");
  assert.equal(events.errors[0], boom);
});

test("with no onError at all, a failure is still loud (console.error), never silently dropped", async (t) => {
  const consoleError = t.mock.method(console, "error", () => {});
  const server = await startFakeDeepgram(t);
  const opens = [];
  const handle = openFluxStream("test-key", { onOpen: () => opens.push(1) }, { host: server.host, scheme: "ws" });
  t.after(() => handle.close());
  const conn = await server.connection();
  await until(() => opens.length === 1, "onOpen");

  conn.socket.send(JSON.stringify({ type: "Error", code: "X", description: "boom", sequence_id: 1 }));
  await until(() => consoleError.mock.callCount() === 1, "the log line");
  const line = String(consoleError.mock.calls[0].arguments[0]);
  assert.match(line, /Flux error: boom/);
  assert.match(line, /no onError handler/);
});

test("a throwing onError is logged, never thrown into the socket handler", async (t) => {
  const consoleError = t.mock.method(console, "error", () => {});
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server, {
    onError: () => {
      throw new Error("bad onError");
    },
  });
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.send(JSON.stringify({ type: "Error", code: "X", description: "boom", sequence_id: 1 }));
  await until(() => consoleError.mock.callCount() === 1, "the log line");
  assert.match(String(consoleError.mock.calls[0].arguments[0]), /onError callback threw/);
});

// ── Close ───────────────────────────────────────────────────────────────────

test("close(): sends {\"type\":\"CloseStream\"} then closes; onClose reports initiatedByUs=true; idempotent", async (t) => {
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  handle.close();
  handle.close();
  await until(() => events.closes.length === 1 && conn.close, "close on both ends");

  assert.deepEqual(conn.text, ['{"type":"CloseStream"}']);
  assert.equal(events.closes.length, 1);
  assert.equal(events.closes[0].initiatedByUs, true);
  assert.deepEqual(events.errors, []);
});

test("close() before the socket opens: no CloseStream, no spurious onError, onClose still fires", async (t) => {
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  handle.close(); // still CONNECTING
  await until(() => events.closes.length === 1, "onClose");

  assert.equal(events.closes[0].initiatedByUs, true);
  assert.deepEqual(events.errors, [], "'closed before the connection was established' is our own doing, not an error");
  assert.equal(events.opens, 0);
  assert.deepEqual(server.connections.flatMap((c) => c.text), []);
});

test("a server-initiated close is NOT ours: initiatedByUs=false (Flux 1005 is ambiguous)", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.close(1011, "boom");
  await until(() => events.closes.length === 1, "onClose");
  assert.deepEqual(events.closes[0], { code: 1011, reason: "boom", initiatedByUs: false });
});

test("a code-less server close (Flux fatal Error / CloseStream both end in 1005) is reported as not initiated by us", async (t) => {
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.send(JSON.stringify({ type: "Error", code: "INACTIVE_CLIENT", description: "no ping", sequence_id: 1 }));
  conn.socket.close();
  await until(() => events.closes.length === 1, "onClose");
  assert.equal(events.closes[0].code, 1005);
  assert.equal(events.closes[0].initiatedByUs, false);
  assert.equal(events.errors.length, 1);
});

test("after our own close(), late frames are ignored (no callbacks into a torn-down call)", async (t) => {
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");
  conn.socket.on("message", (data) => {
    // Flux answers CloseStream with the remaining Updates before it closes.
    if (data.toString() === '{"type":"CloseStream"}') {
      conn.socket.send(JSON.stringify(turnInfo("Update", { transcript: "trailing words" })));
      conn.socket.send(JSON.stringify({ type: "Error", code: "LATE", description: "late", sequence_id: 9 }));
    }
  });

  handle.close();
  await until(() => events.closes.length === 1, "onClose");
  assert.deepEqual(events.turns, []);
  assert.deepEqual(events.errors, []);
});


test("connection refused: one onError, then onClose(1006) not initiated by us", async (t) => {
  const port = await deadPort();
  const events = { errors: [], closes: [] };
  const handle = openFluxStream(
    "test-key",
    { onError: (e) => events.errors.push(e), onClose: (code, reason, info) => events.closes.push({ code, ...info }) },
    { host: `127.0.0.1:${port}`, scheme: "ws" },
  );
  t.after(() => handle.close());
  await until(() => events.closes.length === 1, "onClose");

  assert.equal(events.errors.length, 1);
  assert.match(events.errors[0].message, /ECONNREFUSED/);
  assert.deepEqual(events.closes[0], { code: 1006, initiatedByUs: false });
  assert.equal(handle.readyState, 3);
});

test("a rejected upgrade (HTTP 401) surfaces the status and never the API key", async (t) => {
  const server = await startFakeDeepgram(t, { verifyClient: (info, done) => done(false, 401, "Unauthorized") });
  const { events } = openClient(t, server);
  await until(() => events.closes.length === 1, "onClose");

  assert.equal(events.opens, 0);
  assert.equal(events.errors.length, 1);
  assert.match(events.errors[0].message, /401/);
  assert.ok(!events.errors[0].message.includes("test-key"));
  assert.equal(events.closes[0].initiatedByUs, false);
});

test("a malformed host never throws into the caller (call-start path): it degrades like any connect failure", async () => {
  const events = { errors: [], closes: [] };
  let handle;
  assert.doesNotThrow(() => {
    handle = openFluxStream(
      "test-key",
      { onError: (e) => events.errors.push(e), onClose: (code, reason, info) => events.closes.push({ code, reason, ...info }) },
      { host: "not a valid host" },
    );
  });
  assert.equal(handle.readyState, 3, "a dead handle reports CLOSED");
  assert.equal(handle.send(Buffer.alloc(160)), false);
  assert.equal(handle.configure({ numerals: true }), false);
  assert.equal(handle.forceEndTurn(), false);
  assert.doesNotThrow(() => handle.close());
  assert.deepEqual(events, { errors: [], closes: [] }, "callbacks are asynchronous: the caller finishes wiring first");

  await until(() => events.closes.length === 1, "onClose");
  assert.equal(events.errors.length, 1, "onError first, exactly once");
  assert.deepEqual(events.closes[0], { code: 1006, reason: "", initiatedByUs: false });
});

test("plaintext ws to a non-loopback host is refused through the same path: no cleartext connection, no throw", async () => {
  const events = { errors: [], closes: [] };
  let handle;
  assert.doesNotThrow(() => {
    handle = openFluxStream("test-key", { onError: (e) => events.errors.push(e), onClose: (c) => events.closes.push(c) }, { host: "api.au.deepgram.com", scheme: "ws" });
  });
  assert.equal(handle.readyState, 3);
  await until(() => events.closes.length === 1, "onClose");
  assert.match(events.errors[0].message, /plaintext/i);
});

// ── Keepalive: WebSocket ping every 30 s, NEVER a JSON KeepAlive ────────────

test("keepalive: a WebSocket ping every 30 s, started on open", async (t) => {
  assert.equal(PING_INTERVAL_MS, 30_000);
  const timers = interceptPingInterval(t);
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  assert.equal(timers.created.length, 0, "no ping timer before the socket is open");
  await until(() => events.opens === 1, "onOpen");

  assert.equal(timers.created.length, 1, "exactly one ping timer");
  assert.equal(timers.created[0].ms, 30_000);

  timers.created[0].fn();
  await until(() => conn.pings === 1, "first ping");
  timers.created[0].fn();
  await until(() => conn.pings === 2, "second ping");
});

test("keepalive: Flux never receives a JSON KeepAlive (it is a fatal UNPARSABLE_CLIENT_MESSAGE there)", async (t) => {
  const timers = interceptPingInterval(t);
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  // Stream audio and let the keepalive fire repeatedly.
  for (let i = 0; i < 5; i++) {
    handle.send(Buffer.alloc(160, 0xff));
    timers.created[0].fn();
  }
  await until(() => conn.pings === 5 && conn.binary.length === 5, "5 pings + 5 audio frames");
  assert.deepEqual(conn.text, [], "no text frame at all while streaming");

  handle.close();
  await until(() => events.closes.length === 1 && conn.close, "closed");

  // Whatever the client ever sent as JSON: only protocol-legal Flux messages.
  const legal = new Set(["CloseStream", "ForceEndTurn", "Configure"]);
  for (const frame of conn.text) {
    const parsed = JSON.parse(frame);
    assert.notEqual(parsed.type, "KeepAlive");
    assert.ok(legal.has(parsed.type), `unexpected client message type ${parsed.type}`);
  }
});

test("keepalive: the ping timer is cleared on our close()", async (t) => {
  const timers = interceptPingInterval(t);
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  await until(() => events.opens === 1, "onOpen");
  assert.equal(timers.created.length, 1);
  assert.equal(timers.cleared.length, 0);

  handle.close();
  await until(() => events.closes.length === 1, "onClose");
  assert.deepEqual(timers.cleared, timers.created);
});

test("keepalive: the ping timer is cleared when the SERVER closes too", async (t) => {
  const timers = interceptPingInterval(t);
  const server = await startFakeDeepgram(t);
  const { events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  conn.socket.close(1011, "server went away");
  await until(() => events.closes.length === 1, "onClose");
  assert.deepEqual(timers.cleared, timers.created);
});

test("keepalive: a failed connection never leaves a ping timer behind", async (t) => {
  const timers = interceptPingInterval(t);
  const port = await deadPort();
  const closes = [];
  openFluxStream("test-key", { onError: () => {}, onClose: (code) => closes.push(code) }, { host: `127.0.0.1:${port}`, scheme: "ws" });
  await until(() => closes.length === 1, "onClose");
  assert.equal(timers.created.length - timers.cleared.length, 0);
});

test("keepalive: closing from INSIDE onOpen still clears the ping timer (it exists before onOpen runs)", async (t) => {
  const timers = interceptPingInterval(t);
  const server = await startFakeDeepgram(t);
  const closes = [];
  /** What the timers looked like the instant close() returned inside onOpen. */
  let atReturn = null;
  const handle = openFluxStream(
    "test-key",
    {
      onOpen: () => {
        handle.close();
        atReturn = { created: timers.created.length, cleared: timers.cleared.length };
      },
      onError: () => {},
      onClose: (code, reason, info) => closes.push(info),
    },
    { host: server.host, scheme: "ws" },
  );
  t.after(() => handle.close());
  await until(() => closes.length === 1, "onClose");

  assert.deepEqual(atReturn, { created: 1, cleared: 1 }, "cleared synchronously by that close(), not left to the close event");
  assert.deepEqual(timers.cleared, timers.created);
  assert.equal(closes[0].initiatedByUs, true);
});

test("keepalive: closing while still CONNECTING never creates a ping timer", async (t) => {
  const timers = interceptPingInterval(t);
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  assert.equal(handle.readyState, 0);
  handle.close();
  await until(() => events.closes.length === 1, "onClose");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timers.created.length, 0, "the timer starts on open, not at construction");
  assert.equal(events.opens, 0);
});

// ── Control messages ────────────────────────────────────────────────────────

test("forceEndTurn() and configure() send the documented Flux messages", async (t) => {
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  assert.equal(handle.forceEndTurn(), true);
  assert.equal(handle.configure({ thresholds: { eot_threshold: 0.8, eot_timeout_ms: 6000 }, keyterms: ["Phondo"], numerals: true }), true);
  await until(() => conn.text.length === 2, "2 control messages");

  assert.deepEqual(conn.text.map((f) => JSON.parse(f)), [
    { type: "ForceEndTurn" },
    { type: "Configure", thresholds: { eot_threshold: 0.8, eot_timeout_ms: 6000 }, keyterms: ["Phondo"], numerals: true },
  ]);
});

test("configure() can never be turned into another message type (KeepAlive included)", async (t) => {
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  const conn = await server.connection();
  await until(() => events.opens === 1, "onOpen");

  handle.configure({ type: "KeepAlive", keyterms: [] });
  await until(() => conn.text.length === 1, "1 control message");
  assert.deepEqual(JSON.parse(conn.text[0]), { type: "Configure", keyterms: [] });

  handle.configure(); // no settings = "report the current config"
  await until(() => conn.text.length === 2, "bare Configure");
  assert.deepEqual(JSON.parse(conn.text[1]), { type: "Configure" });
});

test("control messages before open / after close are no-ops, not throws", async (t) => {
  const server = await startFakeDeepgram(t);
  const { handle, events } = openClient(t, server);
  assert.equal(handle.forceEndTurn(), false);
  assert.equal(handle.configure({ numerals: true }), false);
  await until(() => events.opens === 1, "onOpen");
  handle.close();
  await until(() => events.closes.length === 1, "onClose");
  assert.equal(handle.forceEndTurn(), false);
  assert.equal(handle.configure({ numerals: true }), false);
  assert.equal(handle.send(Buffer.alloc(160)), false);
});

// ── fluxConfigFromEnv ───────────────────────────────────────────────────────

function captureWarnings(t) {
  _test.resetConfigWarnings();
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((c) => String(c.arguments[0]));
}

test("fluxConfigFromEnv: unset or blank env gives the defaults, silently", (t) => {
  const warnings = captureWarnings(t);
  assert.deepEqual(FLUX_DEFAULTS, { eotThreshold: 0.7, eagerEotThreshold: 0.4, eotTimeoutMs: 5000 });
  assert.deepEqual(fluxConfigFromEnv({}), { eotThreshold: 0.7, eagerEotThreshold: 0.4, eotTimeoutMs: 5000 });
  assert.deepEqual(fluxConfigFromEnv({ FLUX_EOT_THRESHOLD: "", FLUX_EAGER_EOT_THRESHOLD: "  ", FLUX_EOT_TIMEOUT_MS: "" }), FLUX_DEFAULTS);
  assert.deepEqual(warnings(), []);
});

test("fluxConfigFromEnv: reads process.env by default", (t) => {
  const warnings = captureWarnings(t);
  const saved = process.env.FLUX_EOT_THRESHOLD;
  process.env.FLUX_EOT_THRESHOLD = "0.9";
  t.after(() => {
    if (saved === undefined) delete process.env.FLUX_EOT_THRESHOLD;
    else process.env.FLUX_EOT_THRESHOLD = saved;
  });
  assert.equal(fluxConfigFromEnv().eotThreshold, 0.9);
  assert.deepEqual(warnings(), []);
});

test("fluxConfigFromEnv: valid values are used (inclusive range edges)", (t) => {
  const warnings = captureWarnings(t);
  assert.deepEqual(fluxConfigFromEnv({ FLUX_EOT_THRESHOLD: "0.8", FLUX_EAGER_EOT_THRESHOLD: "0.5", FLUX_EOT_TIMEOUT_MS: "8000" }), { eotThreshold: 0.8, eagerEotThreshold: 0.5, eotTimeoutMs: 8000 });
  assert.equal(fluxConfigFromEnv({ FLUX_EOT_THRESHOLD: "0.5" }).eotThreshold, 0.5);
  assert.equal(fluxConfigFromEnv({ FLUX_EOT_THRESHOLD: "1" }).eotThreshold, 1);
  assert.equal(fluxConfigFromEnv({ FLUX_EOT_THRESHOLD: " 0.6 " }).eotThreshold, 0.6, "whitespace is trimmed");
  assert.equal(fluxConfigFromEnv({ FLUX_EAGER_EOT_THRESHOLD: "0.3" }).eagerEotThreshold, 0.3);
  assert.equal(fluxConfigFromEnv({ FLUX_EOT_THRESHOLD: "0.9", FLUX_EAGER_EOT_THRESHOLD: "0.9" }).eagerEotThreshold, 0.9, "eager may equal eot");
  assert.equal(fluxConfigFromEnv({ FLUX_EOT_TIMEOUT_MS: "500" }).eotTimeoutMs, 500);
  assert.equal(fluxConfigFromEnv({ FLUX_EOT_TIMEOUT_MS: "60000" }).eotTimeoutMs, 60000);
  assert.deepEqual(warnings(), []);
});

test("fluxConfigFromEnv: eager 'off' (any case) disables speculation with null", (t) => {
  const warnings = captureWarnings(t);
  for (const raw of ["off", "OFF", " Off "]) {
    assert.equal(fluxConfigFromEnv({ FLUX_EAGER_EOT_THRESHOLD: raw }).eagerEotThreshold, null, raw);
  }
  assert.deepEqual(warnings(), []);
});

test("fluxConfigFromEnv: every out-of-range / malformed value falls back to its default and warns", (t) => {
  const cases = [
    [{ FLUX_EOT_THRESHOLD: "0.49" }, "eotThreshold", 0.7, /FLUX_EOT_THRESHOLD/],
    [{ FLUX_EOT_THRESHOLD: "1.01" }, "eotThreshold", 0.7, /FLUX_EOT_THRESHOLD/],
    [{ FLUX_EOT_THRESHOLD: "abc" }, "eotThreshold", 0.7, /FLUX_EOT_THRESHOLD/],
    [{ FLUX_EOT_THRESHOLD: "NaN" }, "eotThreshold", 0.7, /FLUX_EOT_THRESHOLD/],
    [{ FLUX_EOT_THRESHOLD: "Infinity" }, "eotThreshold", 0.7, /FLUX_EOT_THRESHOLD/],
    [{ FLUX_EOT_THRESHOLD: "0x1" }, "eotThreshold", 0.7, /FLUX_EOT_THRESHOLD/],
    [{ FLUX_EAGER_EOT_THRESHOLD: "0.29" }, "eagerEotThreshold", 0.4, /FLUX_EAGER_EOT_THRESHOLD/],
    [{ FLUX_EAGER_EOT_THRESHOLD: "0.91", FLUX_EOT_THRESHOLD: "1" }, "eagerEotThreshold", 0.4, /FLUX_EAGER_EOT_THRESHOLD/],
    [{ FLUX_EAGER_EOT_THRESHOLD: "yes" }, "eagerEotThreshold", 0.4, /FLUX_EAGER_EOT_THRESHOLD/],
    [{ FLUX_EAGER_EOT_THRESHOLD: "false" }, "eagerEotThreshold", 0.4, /off/],
    [{ FLUX_EOT_TIMEOUT_MS: "499" }, "eotTimeoutMs", 5000, /FLUX_EOT_TIMEOUT_MS/],
    [{ FLUX_EOT_TIMEOUT_MS: "60001" }, "eotTimeoutMs", 5000, /FLUX_EOT_TIMEOUT_MS/],
    [{ FLUX_EOT_TIMEOUT_MS: "5000.5" }, "eotTimeoutMs", 5000, /FLUX_EOT_TIMEOUT_MS/],
    [{ FLUX_EOT_TIMEOUT_MS: "5s" }, "eotTimeoutMs", 5000, /FLUX_EOT_TIMEOUT_MS/],
  ];
  for (const [env, field, expected, pattern] of cases) {
    const warnings = captureWarnings(t);
    const cfg = fluxConfigFromEnv(env);
    assert.equal(cfg[field], expected, JSON.stringify(env));
    const lines = warnings();
    assert.equal(lines.length, 1, `${JSON.stringify(env)} must warn exactly once: ${lines.join(" | ")}`);
    assert.match(lines[0], pattern);
    t.mock.restoreAll();
  }
});

test("fluxConfigFromEnv: eager above eot is invalid relative to the EFFECTIVE eot (default 0.7 when eot itself is invalid)", (t) => {
  const warnings = captureWarnings(t);
  // eot=0.6 valid, eager=0.65 > 0.6 -> eager falls back to 0.4.
  assert.deepEqual(fluxConfigFromEnv({ FLUX_EOT_THRESHOLD: "0.6", FLUX_EAGER_EOT_THRESHOLD: "0.65" }), { eotThreshold: 0.6, eagerEotThreshold: 0.4, eotTimeoutMs: 5000 });
  // eot invalid -> 0.7; eager 0.65 <= 0.7 is fine.
  _test.resetConfigWarnings();
  assert.deepEqual(fluxConfigFromEnv({ FLUX_EOT_THRESHOLD: "bogus", FLUX_EAGER_EOT_THRESHOLD: "0.65" }), { eotThreshold: 0.7, eagerEotThreshold: 0.65, eotTimeoutMs: 5000 });
  assert.equal(warnings().length, 2, "one warning per bad variable");
});

test("fluxConfigFromEnv: a bad value warns ONCE per process, not on every call", (t) => {
  const warnings = captureWarnings(t);
  const env = { FLUX_EOT_THRESHOLD: "9", FLUX_EOT_TIMEOUT_MS: "1" };
  for (let i = 0; i < 5; i++) fluxConfigFromEnv(env);
  const lines = warnings();
  assert.equal(lines.length, 2, `expected one line per bad variable: ${lines.join(" | ")}`);
  assert.ok(lines.some((l) => /FLUX_EOT_THRESHOLD/.test(l)));
  assert.ok(lines.some((l) => /FLUX_EOT_TIMEOUT_MS/.test(l)));
});
