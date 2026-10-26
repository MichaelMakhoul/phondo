"use strict";

/**
 * SCRUM-594: the plumbing the Deepgram Flux STT client (services/flux-stt.js)
 * and the Aura TTS client (services/aura-stream.js) share, so the two cannot
 * drift apart on the rules that matter for a live call:
 *
 *  - the AU host and the keepalive ping interval;
 *  - plaintext ws:// only for loopback test servers (the API key rides the
 *    upgrade headers);
 *  - consumer callbacks can never throw into the socket's message handler, and
 *    a failure is never silent;
 *  - a connection that cannot even be constructed degrades through the normal
 *    onError / onClose path instead of throwing on the call-start path.
 *
 * No Sentry import and no caller text in any log: the owner of the call decides
 * what to capture.
 */

const WebSocket = require("ws");

/** Sydney endpoint, same API key. From Sydney the RTT is ~25 ms vs ~335 ms to api.deepgram.com (Virginia). */
const DEFAULT_HOST = "api.au.deepgram.com";

/**
 * Flux drops a client that sends neither audio nor a WS ping for 60 s, and an
 * idle Aura socket times out at ~300 s: a ping every 30 s is cheap insurance
 * for both. (A JSON KeepAlive is NOT: it is fatal on Flux and a 1008 on Aura.)
 */
const PING_INTERVAL_MS = 30_000;

/** Plaintext ws:// exists for the loopback fake used in tests. */
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;

/**
 * @param {string|undefined} scheme - "wss" (default) or "ws"
 * @param {string} host
 * @param {string} label - the client's name, for the error message
 * @returns {"ws"|"wss"}
 * @throws when the scheme is not wss and not ws-to-loopback
 */
function resolveScheme(scheme, host, label) {
  if (scheme === undefined || scheme === "wss") return "wss";
  if (scheme === "ws" && LOOPBACK_HOST_RE.test(host)) return "ws";
  throw new Error(`[${label}] refusing scheme ${JSON.stringify(scheme)} for host ${JSON.stringify(host)}: plaintext ws is for loopback test servers only`);
}

/**
 * @param {unknown} err
 * @returns {Error}
 */
function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The two safe ways to reach a consumer's callbacks.
 *
 * `reportError` hands a failure to `onError`; if `onError` is missing the
 * failure goes to console.error (never silent), and if `onError` itself throws
 * that is logged too (never thrown into the socket's message handler).
 * `invoke` calls any other callback and routes whatever it throws to
 * `reportError`.
 *
 * @param {string} label - the client's name, used as the log prefix
 * @param {((err: Error) => void)|undefined} onError
 * @returns {{ reportError: (err: Error) => void, invoke: (callback: ((...args: any[]) => void)|undefined, ...args: any[]) => void }}
 */
function createCallbackGuard(label, onError) {
  /** @param {Error} err */
  function reportError(err) {
    if (typeof onError !== "function") {
      console.error(`[${label}] ${err.message} (no onError handler)`);
      return;
    }
    try {
      onError(err);
    } catch (handlerErr) {
      console.error(`[${label}] onError callback threw: ${toError(handlerErr).message}`);
    }
  }

  /**
   * @param {((...args: any[]) => void)|undefined} callback
   * @param {...any} args
   */
  function invoke(callback, ...args) {
    if (typeof callback !== "function") return;
    try {
      callback(...args);
    } catch (err) {
      reportError(toError(err));
    }
  }

  return { reportError, invoke };
}

/**
 * A connection that could not even be constructed (a malformed host, a refused
 * scheme) fails the way any connect failure does: `onError`, then
 * `onClose(1006, "", { initiatedByUs: false })`. Asynchronously, so the caller
 * can finish wiring up before it hears about it.
 *
 * @param {{ reportError: (err: Error) => void, invoke: (callback: ((...args: any[]) => void)|undefined, ...args: any[]) => void }} guard
 * @param {unknown} err
 * @param {((code: number, reason: string, info: { initiatedByUs: boolean }) => void)|undefined} onClose
 * @returns {Error} the failure, for a caller that also needs to reject a promise with it
 */
function failConnect(guard, err, onClose) {
  const failure = toError(err);
  setImmediate(() => {
    guard.reportError(failure);
    guard.invoke(onClose, 1006, "", { initiatedByUs: false });
  });
  return failure;
}

/**
 * The handle returned for a stream that could not be constructed: every method
 * is an inert function returning a fixed value, so the caller's code path is
 * the same as for a live handle that is simply not open.
 *
 * @param {Record<string, any>} inertMethods - method name -> the value that method returns
 * @param {Record<string, any>} [props] - plain properties to copy onto the handle (e.g. readyState)
 * @returns {any}
 */
function deadStream(inertMethods, props = {}) {
  const stream = { ...props };
  for (const [name, value] of Object.entries(inertMethods)) stream[name] = () => value;
  return stream;
}

/**
 * WebSocket-ping keepalive: `start()` arms one unref'd interval that pings
 * while the socket is OPEN; `stop()` clears it. Both are idempotent.
 *
 * @param {{ readyState: number, ping: () => void }} ws
 * @returns {{ start: () => void, stop: () => void }}
 */
function createPinger(ws) {
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;
  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, PING_INTERVAL_MS);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { DEFAULT_HOST, PING_INTERVAL_MS, resolveScheme, createCallbackGuard, failConnect, deadStream, createPinger };
