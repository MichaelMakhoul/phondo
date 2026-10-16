"use strict";

/**
 * SCRUM-594: Deepgram Flux streaming STT client (`/v2/listen`).
 *
 * Flux is NOT Nova-3 behind a new URL (wire reference: scratchpad/fast/
 * flux-aura-api.md, Part A, verified with live probes):
 *
 *  - `/v2/listen` rejects unknown query params with HTTP 400, so the Nova-3
 *    URL cannot be reused. The param list below is exactly what Flux accepts.
 *  - `{"type":"KeepAlive"}` is not a Flux message. It is FATAL: the server
 *    answers `Error UNPARSABLE_CLIENT_MESSAGE` and closes. Keepalive on Flux is
 *    a WebSocket ping (the server drops a silent client after 60 s). Never add
 *    a JSON keepalive here.
 *  - `Error` frames carry `description` (+ `code`), not `message`.
 *  - Keyterms are PLAIN terms: the docs say "Do not append a weight" (the
 *    Nova-style `appointment:2`), so the URL asks buildKeytermsParam for
 *    `{ weights: false }`, which also collapses the duplicates the strip makes.
 *  - A Flux socket closes with code 1005 both after a clean CloseStream and
 *    after a fatal Error, so a bare close code says nothing. `onClose` reports
 *    whether WE initiated the close; treat any close we did not initiate as
 *    abnormal.
 *
 * Privacy: every connection sends `mip_opt_out=true` (opts the call audio out
 * of Deepgram's Model Improvement Program).
 *
 * This module never imports Sentry and never logs caller words: failures are
 * reported through the callbacks, and the owner of the call decides what to
 * capture. The handle is interface-compatible with the Nova client's
 * `session.deepgramWs` consumers (`readyState`, `send`, `close`).
 */

const WebSocket = require("ws");
const { buildKeytermsParam } = require("./deepgram-stt");
const { DEFAULT_HOST, resolveScheme, createCallbackGuard, failConnect, deadStream, createPinger } = require("./deepgram-ws-common");

const FLUX_MODEL = "flux-general-en";

/**
 * Defaults for the turn-detection knobs (spec 4.1). The eager default is 0.4;
 * "off" (null) is a per-call choice, never a default.
 * @type {Readonly<{ eotThreshold: number, eagerEotThreshold: number, eotTimeoutMs: number }>}
 */
const FLUX_DEFAULTS = Object.freeze({ eotThreshold: 0.7, eagerEotThreshold: 0.4, eotTimeoutMs: 5000 });

const TURN_EVENTS = new Set(["StartOfTurn", "Update", "EagerEndOfTurn", "TurnResumed", "EndOfTurn"]);

/**
 * @typedef {Object} FluxTurnEvent
 * @property {string} event - StartOfTurn | Update | EagerEndOfTurn | TurnResumed | EndOfTurn
 * @property {number} turnIndex
 * @property {string} transcript - cumulative for the turn so far (not a delta)
 * @property {number|null} eotConfidence - end_of_turn_confidence
 * @property {string|null} trigger - EndOfTurn only: "model" | "manual" | "timeout" (open enum)
 *
 * @typedef {Object} FluxWarning
 * @property {string} type - "Warning" | "ConfigureFailure" | "TurnInfo"
 * @property {string|null} code
 * @property {string} message
 *
 * @typedef {Object} FluxCallbacks
 * @property {() => void} [onOpen]
 * @property {(evt: FluxTurnEvent) => void} [onTurnInfo]
 * @property {(err: Error) => void} [onError]
 * @property {(code: number, reason: string, info: { initiatedByUs: boolean }) => void} [onClose]
 * @property {(warning: FluxWarning) => void} [onWarning]
 *
 * @typedef {Object} FluxOptions
 * @property {string} [host] - default api.au.deepgram.com
 * @property {string} [industry] - keyterm set, see buildKeytermsParam
 * @property {number} [eotThreshold] - 0.5-1.0, default 0.7
 * @property {number|null} [eagerEotThreshold] - 0.3-0.9 and <= eot, default 0.4; null omits the param (no eager events)
 * @property {number} [eotTimeoutMs] - 500-60000, default 5000
 * @property {string} [scheme] - "wss" (default) or "ws" for a loopback test server
 */

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A float query value. Whole numbers keep a decimal point ("1.0"): that is the
 * form the live probes verified, a bare "1" was never tried.
 * @param {number} n
 * @returns {string}
 */
function floatParam(n) {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * The Flux connection URL. Param order and set are exactly: model, encoding,
 * sample_rate, eot_threshold, eager_eot_threshold (omitted when null),
 * eot_timeout_ms, mip_opt_out=true, then the keyterms (plain, de-duplicated).
 * Anything else is a 400.
 *
 * @param {FluxOptions} [options]
 * @returns {string}
 */
function buildFluxUrl(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const scheme = resolveScheme(options.scheme, host, "FluxSTT");
  const eot = finiteOr(options.eotThreshold, FLUX_DEFAULTS.eotThreshold);
  const eager = options.eagerEotThreshold === null ? null : finiteOr(options.eagerEotThreshold, FLUX_DEFAULTS.eagerEotThreshold);
  const timeoutMs = finiteOr(options.eotTimeoutMs, FLUX_DEFAULTS.eotTimeoutMs);

  const params = [
    `model=${FLUX_MODEL}`,
    "encoding=mulaw",
    "sample_rate=8000",
    `eot_threshold=${floatParam(eot)}`,
    ...(eager === null ? [] : [`eager_eot_threshold=${floatParam(eager)}`]),
    `eot_timeout_ms=${timeoutMs}`,
    "mip_opt_out=true",
  ];
  return `${scheme}://${host}/v2/listen?${params.join("&")}${buildKeytermsParam(options.industry, { weights: false })}`;
}

// ── Env config ──────────────────────────────────────────────────────────────

/** `NAME=raw` pairs already warned about: the env is read per call, the warning should not be. */
const warnedConfig = new Set();

/**
 * @param {string} name
 * @param {string} raw
 * @param {string} expected
 * @param {string} fallback
 */
function warnInvalidOnce(name, raw, expected, fallback) {
  const key = `${name}=${raw}`;
  if (warnedConfig.has(key)) return;
  warnedConfig.add(key);
  console.warn(`[FluxSTT] ${name}=${JSON.stringify(raw.slice(0, 40))} is invalid (expected ${expected}) - using ${fallback}`);
}

/**
 * Strict decimal parse: digits with an optional fraction. Rejects exponents,
 * hex, signs, NaN and Infinity, which Number() would otherwise let through.
 * @param {string} text
 * @param {{ min: number, max: number, integer?: boolean }} range
 * @returns {number|null} null when malformed or out of range
 */
function parseInRange(text, { min, max, integer = false }) {
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  if (integer && !Number.isInteger(n)) return null;
  return n;
}

/**
 * Flux turn-detection settings from the environment (spec 4.1):
 *  - FLUX_EOT_THRESHOLD       0.5-1.0            default 0.7
 *  - FLUX_EAGER_EOT_THRESHOLD 0.3-0.9, <= eot    default 0.4; "off" disables speculation (null)
 *  - FLUX_EOT_TIMEOUT_MS      500-60000 integer  default 5000
 * An invalid value warns (once per bad value per process) and falls back to
 * its default. A blank or unset variable is the default, silently.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ eotThreshold: number, eagerEotThreshold: number|null, eotTimeoutMs: number }}
 */
function fluxConfigFromEnv(env = process.env) {
  const read = (/** @type {string} */ name) => String(env[name] ?? "").trim();

  let eotThreshold = FLUX_DEFAULTS.eotThreshold;
  const rawEot = read("FLUX_EOT_THRESHOLD");
  if (rawEot !== "") {
    const n = parseInRange(rawEot, { min: 0.5, max: 1 });
    if (n === null) warnInvalidOnce("FLUX_EOT_THRESHOLD", rawEot, "a number from 0.5 to 1", String(FLUX_DEFAULTS.eotThreshold));
    else eotThreshold = n;
  }

  /** @type {number|null} */
  let eagerEotThreshold = FLUX_DEFAULTS.eagerEotThreshold;
  const rawEager = read("FLUX_EAGER_EOT_THRESHOLD");
  if (rawEager !== "") {
    if (rawEager.toLowerCase() === "off") {
      eagerEotThreshold = null;
    } else {
      const n = parseInRange(rawEager, { min: 0.3, max: 0.9 });
      if (n === null || n > eotThreshold) {
        warnInvalidOnce(
          "FLUX_EAGER_EOT_THRESHOLD",
          rawEager,
          `a number from 0.3 to 0.9 that is not above the eot threshold (${eotThreshold}), or "off"`,
          String(FLUX_DEFAULTS.eagerEotThreshold),
        );
      } else {
        eagerEotThreshold = n;
      }
    }
  }

  let eotTimeoutMs = FLUX_DEFAULTS.eotTimeoutMs;
  const rawTimeout = read("FLUX_EOT_TIMEOUT_MS");
  if (rawTimeout !== "") {
    const n = parseInRange(rawTimeout, { min: 500, max: 60000, integer: true });
    if (n === null) warnInvalidOnce("FLUX_EOT_TIMEOUT_MS", rawTimeout, "an integer from 500 to 60000", String(FLUX_DEFAULTS.eotTimeoutMs));
    else eotTimeoutMs = n;
  }

  return { eotThreshold, eagerEotThreshold, eotTimeoutMs };
}

// ── Client ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FluxStream
 * @property {number} readyState - mirrors the socket: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
 * @property {(audio: Buffer) => boolean} send - false when the socket is not open (the frame is dropped)
 * @property {() => void} close
 * @property {(settings?: object) => boolean} configure
 * @property {() => boolean} forceEndTurn
 */

/**
 * An `Error` frame. Flux uses `description` (+ `code`); the Nova-3 client's
 * `message` field does not exist here.
 * @param {any} frame
 * @returns {Error}
 */
function errorFromFrame(frame) {
  const detail = frame.description || frame.code || "unknown error";
  return Object.assign(new Error(`Flux error: ${detail}`), frame.code ? { code: frame.code } : {});
}

/**
 * Open a Flux STT stream for Twilio audio (raw mulaw, 8 kHz, mono).
 *
 * Never throws: it sits on the call-start path, where a fast-path failure must
 * degrade (the caller falls back to Nova), not break the call. A bad host or
 * scheme is delivered like any other connect failure: `onError`, then
 * `onClose(1006, "", { initiatedByUs: false })`, asynchronously.
 *
 * Callback failures are contained too: a throwing `onTurnInfo` is routed to
 * `onError`, a throwing `onError` is logged. Nothing a consumer does can throw
 * into the socket's message handler and take the process down.
 *
 * After `close()` the stream is dead on purpose: late frames and the
 * "closed before the connection was established" error are not delivered; only
 * `onClose` (with `initiatedByUs: true`) is.
 *
 * @param {string} apiKey
 * @param {FluxCallbacks} callbacks
 * @param {FluxOptions} [options]
 * @returns {FluxStream}
 */
function openFluxStream(apiKey, callbacks = {}, options = {}) {
  const { onOpen, onTurnInfo, onError, onClose, onWarning } = callbacks;

  let closedByUs = false;
  const warnedEvents = new Set();
  const guard = createCallbackGuard("FluxSTT", onError);
  const { reportError, invoke } = guard;

  /** @type {WebSocket} */
  let ws;
  try {
    ws = new WebSocket(buildFluxUrl(options), { headers: { Authorization: `Token ${apiKey}` } });
  } catch (err) {
    failConnect(guard, err, onClose);
    return deadStream({ send: false, close: undefined, configure: false, forceEndTurn: false }, { readyState: WebSocket.CLOSED });
  }
  const pinger = createPinger(ws);

  /** @param {any} frame */
  function handleTurnInfo(frame) {
    const event = frame.event;
    if (typeof event !== "string") {
      reportError(new Error("Flux TurnInfo without an event"));
      return;
    }
    if (!TURN_EVENTS.has(event)) {
      // A future Flux event: ignore it, but tell the owner once.
      if (!warnedEvents.has(event)) {
        warnedEvents.add(event);
        invoke(onWarning, { type: "TurnInfo", code: "UNKNOWN_EVENT", message: `ignoring unknown TurnInfo event ${JSON.stringify(event.slice(0, 40))}` });
      }
      return;
    }
    if (!Number.isInteger(frame.turn_index)) {
      reportError(new Error(`Flux TurnInfo ${event} without a numeric turn_index`));
      return;
    }
    const transcript = typeof frame.transcript === "string" ? frame.transcript : "";
    // Silence streams an empty Update ~4x/s forever; drop them here, cheaply.
    if (event === "Update" && transcript.trim() === "") return;

    invoke(onTurnInfo, {
      event,
      turnIndex: frame.turn_index,
      transcript,
      eotConfidence: typeof frame.end_of_turn_confidence === "number" ? frame.end_of_turn_confidence : null,
      trigger: typeof frame.trigger === "string" ? frame.trigger : null,
    });
  }

  ws.on("open", () => {
    // Armed before onOpen so a close() from inside onOpen still clears it.
    pinger.start();
    invoke(onOpen);
  });

  ws.on("message", (data, isBinary) => {
    if (closedByUs || isBinary) return; // Flux only ever sends JSON text
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      // Never echo the payload: a TurnInfo carries caller words.
      reportError(new Error("Flux sent a frame that is not valid JSON"));
      return;
    }
    if (!frame || typeof frame !== "object") {
      reportError(new Error("Flux sent a frame that is not a JSON object"));
      return;
    }
    switch (frame.type) {
      case "TurnInfo":
        handleTurnInfo(frame);
        break;
      case "Error":
        reportError(errorFromFrame(frame));
        break;
      case "Warning":
      case "ConfigureFailure":
        invoke(onWarning, { type: frame.type, code: frame.code ?? null, message: frame.description || frame.code || "" });
        break;
      default:
        break; // Connected, ConfigureSuccess, and any future type: nothing to do
    }
  });

  ws.on("error", (err) => {
    if (closedByUs) return; // our own close() while still connecting is not a failure
    reportError(err);
  });

  ws.on("close", (code, reason) => {
    pinger.stop();
    invoke(onClose, code, reason ? reason.toString() : "", { initiatedByUs: closedByUs });
  });

  /**
   * @param {object} message
   * @returns {boolean}
   */
  function sendJson(message) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  return {
    get readyState() {
      return ws.readyState;
    },

    send(audio) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(audio);
      return true;
    },

    /** Send CloseStream, then close the socket. Idempotent. */
    close() {
      pinger.stop();
      if (closedByUs) return;
      const state = ws.readyState;
      if (state === WebSocket.OPEN) {
        closedByUs = true;
        ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close(1000);
      } else if (state === WebSocket.CONNECTING) {
        closedByUs = true;
        ws.close();
      }
    },

    /**
     * Change thresholds / keyterms / numerals mid-stream. `type` is forced to
     * "Configure": no input can turn this into another message (KeepAlive is fatal).
     */
    configure(settings) {
      return sendJson({ ...settings, type: "Configure" });
    },

    /** End the current turn now (EndOfTurn, trigger "manual"). */
    forceEndTurn() {
      return sendJson({ type: "ForceEndTurn" });
    },
  };
}

module.exports = {
  openFluxStream,
  fluxConfigFromEnv,
  buildFluxUrl,
  FLUX_DEFAULTS,
  _test: { resetConfigWarnings: () => warnedConfig.clear() },
};
