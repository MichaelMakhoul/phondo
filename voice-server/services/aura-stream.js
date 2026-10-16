"use strict";

/**
 * SCRUM-594: Deepgram Aura-2 streaming TTS client (`/v1/speak`).
 *
 * One WebSocket carries a whole call (wire reference: scratchpad/fast/
 * flux-aura-api.md, Part B, verified with live probes). First audio arrives
 * 44-97 ms after a Flush on the AU host, vs 300-900 ms for REST per sentence.
 *
 * The server is unforgiving, and says nothing when it is unhappy:
 *
 *  - Anything that is not valid JSON of a known type (and a Speak without
 *    text) closes the socket with 1008 `DATA-0000` and NO error frame. So this
 *    client sends only well-formed Speak / Flush / Clear / Close. There is no
 *    JSON KeepAlive for TTS either: an unknown type is the same 1008.
 *  - 20 Flush requests per 60 s. The 21st earns `Warning EXCESSIVE_FLUSH` and
 *    no `Flushed` at all. `flush()` keeps its own sliding window and refuses
 *    (returns null) at 18, leaving a margin of 2.
 *  - A Speak is at most 2000 characters (413 above that).
 *  - `Clear` is not instant: one or two in-flight audio frames can still
 *    arrive between our Clear and the server's `Cleared`. They belong to the
 *    interrupted reply, so they are dropped.
 *  - Audio is raw mulaw with no header, in variable frame sizes (290 / 320 /
 *    30 bytes seen). Re-framing for Twilio is the player's job.
 *  - Warnings use `warn_code` / `warn_msg` on the wire (the schema says
 *    `code` / `description`).
 *
 * Privacy: every connection sends `mip_opt_out=true`.
 *
 * Like the Flux client this never imports Sentry and never logs caller text:
 * failures go through callbacks, and the owner of the call decides what to
 * capture.
 */

const WebSocket = require("ws");

/** Sydney endpoint, same API key. Keep in sync with services/flux-stt.js. */
const DEFAULT_HOST = "api.au.deepgram.com";
const DEFAULT_VOICE = "aura-2-asteria-en";
/** Idle timeout is ~300 s and a WS ping resets it; ping at 30 s as cheap insurance. */
const PING_INTERVAL_MS = 30_000;
/** Deepgram's cap on the characters of ONE Speak message (the trailing space counts). */
const MAX_SPEAK_CHARS = 2000;
/** Room in a Speak for the trailing space we append. */
const SPEAK_BODY_LIMIT = MAX_SPEAK_CHARS - 1;
/** The server allows 20 flushes per 60 s; we stop at 18 so timing skew cannot reach 21. */
const FLUSH_BUDGET = 18;
const FLUSH_WINDOW_MS = 60_000;

/** `.`/`!`/`?` (+ closing quotes/brackets) followed by whitespace. */
const SENTENCE_END_RE = /[.!?]["')\]]*(?=\s)/g;

/** Plaintext ws:// exists for the loopback fake used in tests; the API key rides the upgrade headers. */
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;

/**
 * @typedef {Object} AuraWarning
 * @property {string|null} code - e.g. "EXCESSIVE_FLUSH"
 * @property {string} message
 *
 * @typedef {Object} AuraOptions
 * @property {string} [voice] - Aura-2 model name, default aura-2-asteria-en
 * @property {string} [host] - default api.au.deepgram.com
 * @property {string} [scheme] - "wss" (default) or "ws" for a loopback test server
 * @property {(audio: Buffer) => void} [onAudio] - raw mulaw 8 kHz, variable frame sizes
 * @property {(seq: number|null) => void} [onFlushed] - the audio of one flush is complete
 * @property {() => void} [onCleared]
 * @property {(warning: AuraWarning) => void} [onWarning]
 * @property {(err: Error) => void} [onError]
 * @property {(code: number, reason: string, info: { initiatedByUs: boolean }) => void} [onClose]
 */

/** @param {unknown} err */
function describeError(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {string|undefined} scheme
 * @param {string} host
 * @returns {"ws"|"wss"}
 */
function resolveScheme(scheme, host) {
  if (scheme === undefined || scheme === "wss") return "wss";
  if (scheme === "ws" && LOOPBACK_HOST_RE.test(host)) return "ws";
  throw new Error(`[AuraStream] refusing scheme ${JSON.stringify(scheme)} for host ${JSON.stringify(host)}: plaintext ws is for loopback test servers only`);
}

/**
 * The Aura connection URL. Unlike Flux, Aura ignores unknown params, but we
 * send only what we mean: model, mulaw 8 kHz (raw, no container) and the
 * model-improvement opt-out.
 *
 * @param {{ voice?: string, host?: string, scheme?: string }} [options]
 * @returns {string}
 */
function buildAuraUrl(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const scheme = resolveScheme(options.scheme, host);
  const voice = options.voice || DEFAULT_VOICE;
  return `${scheme}://${host}/v1/speak?model=${encodeURIComponent(voice)}&encoding=mulaw&sample_rate=8000&mip_opt_out=true`;
}

// ── Text splitting ──────────────────────────────────────────────────────────

/**
 * Where to cut `rest` (longer than the limit) so the first piece fits one
 * Speak: the last sentence end that fits, else the last whitespace that fits,
 * else a hard cut (never between the halves of a surrogate pair).
 * @param {string} rest
 * @returns {number} a cut index in [1, SPEAK_BODY_LIMIT]
 */
function findCut(rest) {
  // One char past the limit, so a boundary exactly at the limit is visible.
  const window = rest.slice(0, SPEAK_BODY_LIMIT + 1);

  let sentenceEnd = 0;
  for (const match of window.matchAll(SENTENCE_END_RE)) {
    const end = /** @type {number} */ (match.index) + match[0].length;
    if (end <= SPEAK_BODY_LIMIT) sentenceEnd = end;
  }
  if (sentenceEnd > 0) return sentenceEnd;

  for (let i = SPEAK_BODY_LIMIT; i > 0; i--) {
    if (/\s/.test(window[i])) return i;
  }

  let hard = SPEAK_BODY_LIMIT;
  const before = rest.charCodeAt(hard - 1);
  const after = rest.charCodeAt(hard);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) hard -= 1;
  return hard;
}

/**
 * Split text into pieces that each fit one Speak (with its trailing space):
 * at sentence ends where possible, else at the last space, else hard.
 * Pieces are trimmed and non-empty; joined with a space they reproduce the
 * (trimmed) input.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitForSpeak(text) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > SPEAK_BODY_LIMIT) {
    const cut = findCut(rest);
    const part = rest.slice(0, cut).trim();
    if (part) parts.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// ── Client ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AuraStream
 * @property {Promise<void>} ready - resolves when the socket opens; rejects if it never does
 * @property {() => boolean} isOpen
 * @property {(text: string) => boolean} speak - false when nothing was sent
 * @property {() => number|null} flush - the expected Flushed sequence id, or null when refused
 * @property {() => number} flushesInLastMinute
 * @property {() => boolean} clear
 * @property {() => void} close
 */

/**
 * ws hands binary payloads over as a Buffer; tolerate the other shapes it can produce.
 * @param {any} data
 * @returns {Buffer}
 */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Handle for a stream that could not even be constructed: always closed, inert.
 * @param {Promise<void>} ready
 * @returns {AuraStream}
 */
function deadStream(ready) {
  return {
    ready,
    isOpen: () => false,
    speak: () => false,
    flush: () => null,
    flushesInLastMinute: () => 0,
    clear: () => false,
    close() {},
  };
}

/**
 * Open an Aura-2 TTS stream for Twilio audio (raw mulaw, 8 kHz).
 *
 * Never throws: it sits on the call-start path, where a fast-path failure must
 * degrade (the caller falls back to REST TTS), not break the call. A bad host
 * or scheme is delivered like any other connect failure: `ready` rejects,
 * then `onError`, then `onClose(1006, "", { initiatedByUs: false })`,
 * asynchronously.
 *
 * Callback failures are contained too: a throwing `onAudio` is routed to
 * `onError`, a throwing `onError` is logged. Nothing a consumer does can throw
 * into the socket's message handler and take the process down.
 *
 * After `close()` the stream is dead on purpose: late frames and the
 * "closed before the connection was established" error are not delivered; only
 * `onClose` (with `initiatedByUs: true`) is.
 *
 * `ready` resolves when the socket opens and rejects if it never does. The
 * same failure is also delivered through `onError` / `onClose`, so a caller
 * that never awaits `ready` neither misses it nor triggers an unhandled
 * rejection.
 *
 * @param {string} apiKey
 * @param {AuraOptions} [options]
 * @returns {AuraStream}
 */
function openAuraStream(apiKey, options = {}) {
  const { onAudio, onFlushed, onCleared, onWarning, onError, onClose } = options;

  let closedByUs = false;
  /** @type {ReturnType<typeof setInterval>|null} */
  let pingTimer = null;
  /** Clears sent and not yet acknowledged; audio is dropped while any is outstanding. */
  let pendingClears = 0;
  let nextFlushSeq = 0;
  /** Timestamps (ms) of flushes still inside the sliding window. */
  const flushTimes = [];

  /** @type {() => void} */
  let resolveReady = () => {};
  /** @type {(err: Error) => void} */
  let rejectReady = () => {};
  /** @type {Promise<void>} */
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The same failure reaches onError/onClose; this only keeps an un-awaited
  // `ready` from becoming an unhandled rejection (fatal in Node 22).
  ready.catch(() => {});

  /** @param {Error} err */
  function reportError(err) {
    if (typeof onError !== "function") {
      console.error(`[AuraStream] ${err.message} (no onError handler)`);
      return;
    }
    try {
      onError(err);
    } catch (handlerErr) {
      console.error(`[AuraStream] onError callback threw: ${describeError(handlerErr)}`);
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
      reportError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** @type {WebSocket} */
  let ws;
  try {
    ws = new WebSocket(buildAuraUrl(options), { headers: { Authorization: `Token ${apiKey}` } });
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    rejectReady(failure);
    // Asynchronous, so the caller can finish wiring up before it hears about it.
    setImmediate(() => {
      reportError(failure);
      invoke(onClose, 1006, "", { initiatedByUs: false });
    });
    return deadStream(ready);
  }

  function stopPing() {
    if (pingTimer === null) return;
    clearInterval(pingTimer);
    pingTimer = null;
  }

  /** @param {{ type: "Speak", text: string } | { type: "Flush" } | { type: "Clear" } | { type: "Close" }} message */
  function send(message) {
    ws.send(JSON.stringify(message));
  }

  /**
   * Drop flush timestamps older than the window.
   * @param {number} now
   */
  function pruneFlushes(now) {
    while (flushTimes.length > 0 && now - flushTimes[0] >= FLUSH_WINDOW_MS) flushTimes.shift();
  }

  ws.on("open", () => {
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL_MS);
    if (typeof pingTimer.unref === "function") pingTimer.unref();
    resolveReady();
  });

  ws.on("message", (data, isBinary) => {
    if (closedByUs) return;

    if (isBinary) {
      // Generated before the server processed our Clear: part of the interrupted reply.
      if (pendingClears > 0) return;
      invoke(onAudio, toBuffer(data));
      return;
    }

    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      reportError(new Error("Aura sent a frame that is not valid JSON"));
      return;
    }
    if (!frame || typeof frame !== "object") {
      reportError(new Error("Aura sent a frame that is not a JSON object"));
      return;
    }
    switch (frame.type) {
      case "Flushed":
        invoke(onFlushed, Number.isInteger(frame.sequence_id) ? frame.sequence_id : null);
        break;
      case "Cleared":
        if (pendingClears > 0) pendingClears -= 1;
        invoke(onCleared);
        break;
      case "Warning":
        invoke(onWarning, { code: frame.warn_code ?? frame.code ?? null, message: frame.warn_msg ?? frame.description ?? "" });
        break;
      case "Error":
        // Never observed on the wire (failures are an HTTP status or a 1008 close), but handle it.
        reportError(Object.assign(new Error(`Aura error: ${frame.description || frame.message || frame.err_msg || frame.code || "unknown error"}`), frame.code ? { code: frame.code } : {}));
        break;
      default:
        break; // Metadata, and any future type: nothing to do
    }
  });

  ws.on("error", (err) => {
    rejectReady(err); // no-op once ready has resolved
    if (closedByUs) return; // our own close() while still connecting is not a failure
    reportError(err);
  });

  ws.on("close", (code, reason) => {
    stopPing();
    rejectReady(new Error("Aura stream closed before it opened")); // no-op once ready has resolved
    invoke(onClose, code, reason ? reason.toString() : "", { initiatedByUs: closedByUs });
  });

  return {
    ready,

    isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },

    /**
     * Queue text for synthesis. Trimmed; sent with ONE trailing space (Aura
     * releases a finished sentence as soon as the following whitespace arrives,
     * well before any Flush); split into several Speaks if over 2000 chars.
     * Call `flush()` to force out the unfinished tail.
     *
     * @param {string} text
     * @returns {boolean} false when nothing was sent (empty / non-string text, or socket not open)
     */
    speak(text) {
      if (typeof text !== "string") return false;
      const parts = splitForSpeak(text);
      if (parts.length === 0 || ws.readyState !== WebSocket.OPEN) return false;
      for (const part of parts) send({ type: "Speak", text: `${part} ` });
      return true;
    },

    /**
     * Synthesize everything buffered. At most FLUSH_BUDGET flushes per sliding
     * FLUSH_WINDOW_MS; beyond that nothing is sent and null comes back.
     *
     * @returns {number|null} the sequence id the matching `Flushed` will carry
     *   (counted from 0 per connection), or null when refused / socket not open
     */
    flush() {
      if (ws.readyState !== WebSocket.OPEN) return null;
      const now = Date.now();
      pruneFlushes(now);
      if (flushTimes.length >= FLUSH_BUDGET) return null;
      flushTimes.push(now);
      send({ type: "Flush" });
      return nextFlushSeq++;
    },

    /** Flushes sent in the last FLUSH_WINDOW_MS. */
    flushesInLastMinute() {
      pruneFlushes(Date.now());
      return flushTimes.length;
    },

    /**
     * Barge-in: drop buffered text and stop audio. Until the server's
     * `Cleared` arrives, audio frames are dropped (they are the tail of the
     * interrupted reply).
     * @returns {boolean} false when the socket is not open (nothing sent, nothing suppressed)
     */
    clear() {
      if (ws.readyState !== WebSocket.OPEN) return false;
      pendingClears += 1;
      send({ type: "Clear" });
      return true;
    },

    /** Send Close, then close the socket. Idempotent. */
    close() {
      stopPing();
      if (closedByUs) return;
      const state = ws.readyState;
      if (state === WebSocket.OPEN) {
        closedByUs = true;
        send({ type: "Close" });
        ws.close(1000);
      } else if (state === WebSocket.CONNECTING) {
        closedByUs = true;
        ws.close();
      }
    },
  };
}

module.exports = {
  openAuraStream,
  buildAuraUrl,
  splitForSpeak,
  DEFAULT_HOST,
  DEFAULT_VOICE,
  PING_INTERVAL_MS,
  MAX_SPEAK_CHARS,
  FLUSH_BUDGET,
  FLUSH_WINDOW_MS,
};
