"use strict";

/**
 * SCRUM-594 test helpers: Anthropic Messages SSE built from the real event
 * shapes (message_start, content_block_start text/tool_use, content_block_delta
 * text_delta/input_json_delta, content_block_stop, message_delta, message_stop,
 * plus the periodic ping), and fake `fetch` implementations that serve them.
 *
 * Shared by claude-chat-clause.test.js and speculative-reply.test.js. Not a
 * *.test.js file, so `npm test` does not execute it on its own. Every fake
 * fetch is installed through a test context and restored in t.after().
 */

const encoder = new TextEncoder();
/** The genuine fetch, captured at load: every fake restores THIS, however many are installed in one test. */
const ORIGINAL_FETCH = globalThis.fetch;

/** One constructor per Anthropic stream event the voice server can see. */
const ev = {
  ping: () => ({ type: "ping" }),
  messageStart: () => ({
    type: "message_start",
    message: {
      id: "msg_01TEST",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 1 },
    },
  }),
  textStart: (index = 0) => ({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  textDelta: (text, index = 0) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
  toolStart: (index, id, name) => ({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }),
  toolDelta: (index, partialJson) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } }),
  blockStop: (index = 0) => ({ type: "content_block_stop", index }),
  messageDelta: (stopReason) => ({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 20 },
  }),
  messageStop: () => ({ type: "message_stop" }),
};

/** Serialise events the way the Anthropic API does: `event: <type>\ndata: <json>\n\n`. */
function sseFrames(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A complete text-only turn; `deltas` are the text_delta payloads, in order. */
function textTurnEvents(deltas) {
  return [
    ev.messageStart(),
    ev.ping(),
    ev.textStart(0),
    ...deltas.map((d) => ev.textDelta(d, 0)),
    ev.blockStop(0),
    ev.messageDelta("end_turn"),
    ev.messageStop(),
  ];
}

/**
 * A complete tool turn: an optional spoken preamble (text block 0) followed by
 * one tool_use block whose JSON arrives in `json` pieces.
 */
function toolTurnEvents({ preamble = [], id = "toolu_01TEST", name = "check_availability", json = ['{"date":"2026-10-20"}'] } = {}) {
  const events = [ev.messageStart()];
  let index = 0;
  if (preamble.length > 0) {
    events.push(ev.textStart(index), ...preamble.map((d) => ev.textDelta(d, index)), ev.blockStop(index));
    index++;
  }
  events.push(
    ev.toolStart(index, id, name),
    ...json.map((j) => ev.toolDelta(index, j)),
    ev.blockStop(index),
    ev.messageDelta("tool_use"),
    ev.messageStop(),
  );
  return events;
}

/**
 * A 200 text/event-stream Response over a real ReadableStream. `byteChunk`
 * re-slices the encoded bytes, so SSE lines and multi-byte characters can
 * straddle network chunks the way they do on a real connection.
 */
function sseResponse(events, { byteChunk } = {}) {
  const bytes = encoder.encode(sseFrames(events));
  const size = byteChunk && byteChunk > 0 ? byteChunk : Math.max(bytes.length, 1);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Replace globalThis.fetch for one test. `handler({ url, init, body, signal }, index)`
 * returns the Response (or a promise of it). Returns the recorded calls.
 * Restored in t.after().
 */
function withFakeFetch(t, handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body), signal: init.signal };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  t.after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });
  return calls;
}

/**
 * A hand-driven Anthropic response for ONE request: the test pushes events when
 * it wants and ends the stream when it wants. Like real fetch, the request's
 * signal cancels the request: before headers the fetch promise rejects with the
 * signal's reason, after headers the body stream errors with it.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ holdHeaders?: boolean }} [options] - holdHeaders: do not answer until release()
 */
function installGatedFetch(t, { holdHeaders = false } = {}) {
  const calls = [];
  let bodyController;
  let bodyOpen = true;
  let answer = () => {};
  let markCalled = () => {};
  const called = new Promise((resolve) => {
    markCalled = resolve;
  });

  const body = new ReadableStream({
    start(controller) {
      bodyController = controller;
    },
  });
  const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

  globalThis.fetch = (url, init) => {
    const signal = init?.signal;
    calls.push({ url, init, body: JSON.parse(init.body), signal });
    markCalled();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          if (bodyOpen) {
            bodyOpen = false;
            bodyController.error(signal.reason);
          }
          reject(signal.reason);
        },
        { once: true },
      );
      answer = () => resolve(response);
      if (!holdHeaders) answer();
    });
  };
  t.after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  return {
    calls,
    /** Resolves once the code under test has called fetch. */
    called,
    /** Answer a request held with holdHeaders. */
    release: () => answer(),
    /** Enqueue events; false (and nothing sent) once the stream was aborted or ended. */
    push(events) {
      if (!bodyOpen) return false;
      bodyController.enqueue(encoder.encode(sseFrames(events)));
      return true;
    },
    /** End the stream normally. */
    end() {
      if (!bodyOpen) return;
      bodyOpen = false;
      bodyController.close();
    },
    /** The signal the code under test handed to fetch. */
    get signal() {
      return calls[0]?.signal;
    },
  };
}

/**
 * Let the event loop turn until `condition()` holds. Streams hop through
 * several microtasks and a macrotask per chunk, so tests wait on an observable
 * effect rather than sleeping.
 */
async function waitUntil(condition, label = "condition") {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Like waitUntil, but bounded by wall-clock time instead of turns of the event
 * loop: for the one test that needs a REAL timer (AbortSignal.timeout) to fire.
 * It only waits for something to happen; nothing races it.
 */
async function waitUntilTimed(condition, label = "condition", limitMs = 3000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > limitMs) throw new Error(`timed out after ${limitMs} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

module.exports = { ev, sseFrames, textTurnEvents, toolTurnEvents, sseResponse, withFakeFetch, installGatedFetch, waitUntil, waitUntilTimed };
