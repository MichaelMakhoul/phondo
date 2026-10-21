"use strict";

/**
 * SCRUM-594 (phone test F9): the fast path's voices, one Aura stream each.
 *
 * An Aura stream's voice is fixed when it opens. Until F9 a call that changed
 * language closed its stream and spoke the rest over REST (1-3.4 s a sentence:
 * every reply 4-4.5 s late), and a sentence in another language than the
 * call's was read by the call's voice (English in the Spanish voice). The
 * router keeps a stream per voice — the assistant's own opens with the call,
 * another opens for its first sentence (70-220 ms on the AU host, probed
 * 2026-10-21 for all seven voices) — and gives each sentence to its voice.
 *
 * Order: the caller hears sentences in the order they were written. Text goes
 * to one stream at a time. Before a sentence in another voice goes out, the
 * stream speaking now is flushed and its Flushed awaited: Aura makes audio at
 * about twice real time, so the hand-over is done long before the audio
 * already sent has played. A flush the budget refuses has no Flushed: that
 * stream is done once its audio has been quiet for `quietMs`. A Flushed that
 * never comes gives way after `handoverWaitMs`.
 *
 * To the server it is the stream it always had (the AuraStream methods it
 * uses, `speak` taking a voice). flush() returns the router's own sequence
 * ids, and onFlushed reports one once all the audio before it has arrived.
 * Until a second voice is used they are the stream's own ids.
 *
 * Failures:
 *  - the assistant's voice's stream failing (an error, a close we did not ask
 *    for) is the router failing: onError / onClose, as the one stream did;
 *  - another voice's stream that never opens (a refused voice, a timeout):
 *    onVoiceFailed, and its sentences go to the assistant's voice;
 *  - another voice's stream failing while it still owes audio: onError (the
 *    server's fallback says again what was never voiced);
 *  - an idle one closing (Aura's idle timeout): forgotten, and opened again
 *    for its next sentence.
 *
 * Like the stream clients it never logs and never imports Sentry: failures and
 * warnings go through callbacks.
 */

const { openAuraStream, DEFAULT_VOICE } = require("./aura-stream");
const { createCallbackGuard } = require("./deepgram-ws-common");

/** Another voice's stream must open within this (the server's AURA_OPEN_TIMEOUT_MS). */
const DEFAULT_OPEN_TIMEOUT_MS = 3000;
/** A voice whose flush was refused is done once its audio has been quiet this long (the server's FAST_AUDIO_QUIET_MS). */
const DEFAULT_QUIET_MS = 500;
/** The longest a sentence in another voice waits for the voice before it to finish. */
const DEFAULT_HANDOVER_WAIT_MS = 3000;
/** Streams open at once, the assistant's own included: for a new voice, the least recently used idle one closes. */
const DEFAULT_MAX_VOICES = 3;

/**
 * @typedef {Object} AuraRouterOptions
 * @property {string} [voice] - the assistant's own voice: its stream opens at once and is the router's (`ready`, `isOpen`); default aura-stream's
 * @property {string} [host]
 * @property {(apiKey: string, options: import("./aura-stream").AuraOptions) => import("./aura-stream").AuraStream} [openStream] - default openAuraStream
 * @property {number} [openTimeoutMs] - another voice's stream must open within this, or that voice has failed
 * @property {number} [quietMs]
 * @property {number} [handoverWaitMs]
 * @property {number} [maxVoices]
 * @property {(audio: Buffer, voice: string) => void} [onAudio] - raw mulaw 8 kHz, with the voice that said it
 * @property {(seq: number|null) => void} [onFlushed] - the audio of everything before that flush has arrived
 * @property {(warning: { code: string|null, message: string, voice: string }) => void} [onWarning]
 * @property {(err: Error) => void} [onError] - the router can't go on: fall back
 * @property {(code: number, reason: string, info: { initiatedByUs: boolean }) => void} [onClose] - the assistant's voice's stream closed
 * @property {(voice: string, err: Error) => void} [onVoiceFailed] - another voice's stream never opened: its sentences go to the assistant's voice
 * @property {(text: string) => string} [rerouteText] - what a sentence queued for a voice that failed becomes in the assistant's voice ("" drops it): the server's speech guard (Japanese text in an English voice is letters)
 */

/**
 * @typedef {Object} AuraRouter
 * @property {Promise<void>} ready - the assistant's voice's stream opened
 * @property {() => boolean} isOpen - the assistant's voice's stream is open
 * @property {(text: string, voice?: string|null) => boolean} speak - say text in a voice (default the assistant's); false when nothing was queued
 * @property {() => number|null} flush - the sequence id onFlushed will report, or null when the stream refused (or is not open)
 * @property {() => number} flushesInLastMinute - the speaking stream's
 * @property {() => boolean} clear - barge-in: drop what is queued and Clear each stream that may still send audio
 * @property {() => void} close
 * @property {(voice: string) => void} prepare - open a voice's stream before its first sentence
 * @property {() => string[]} voicesUsed - every voice that was given text, in the order of first use
 */

/**
 * One voice's stream and what it still owes.
 * @typedef {Object} VoiceStream
 * @property {string} voice
 * @property {boolean} isBase - the assistant's own voice
 * @property {import("./aura-stream").AuraStream} stream
 * @property {boolean} opened - it has been open (a failure after that is no failed voice)
 * @property {boolean} dead - closed or given up on: its late callbacks are ignored
 * @property {boolean} unflushed - text went to it since its last flush
 * @property {Array<{ seq: number, routerSeq: number|null }>} pending - its flushes waiting for their Flushed (routerSeq null: a hand-over flush)
 * @property {number[]} quietSeqs - the router's flushes it refused: reported once its audio goes quiet
 * @property {boolean} awaitingQuiet - a flush was refused: it is done once its audio goes quiet
 * @property {ReturnType<typeof setTimeout>|null} quietTimer
 * @property {ReturnType<typeof setTimeout>|null} openTimer
 * @property {number} lastUsedAt
 */

/** @typedef {{ type: "speak", voice: string, text: string } | { type: "flush", seq: number }} Op */

/** @param {ReturnType<typeof setTimeout>} timer */
function unref(timer) {
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * @param {string} apiKey
 * @param {AuraRouterOptions} [options]
 * @returns {AuraRouter}
 */
function createAuraRouter(apiKey, options = {}) {
  const { host, onAudio, onFlushed, onWarning, onClose, onVoiceFailed } = options;
  const openStream = options.openStream || openAuraStream;
  const baseVoice = options.voice || DEFAULT_VOICE;
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const handoverWaitMs = options.handoverWaitMs ?? DEFAULT_HANDOVER_WAIT_MS;
  const maxVoices = Math.max(1, options.maxVoices ?? DEFAULT_MAX_VOICES);
  // The server's callbacks are reached only through these (never a throw into a socket handler or a timer).
  const { reportError, invoke } = createCallbackGuard("AuraRouter", options.onError);

  /** @type {Map<string, VoiceStream>} */
  const streams = new Map();
  /** @type {Op[]} what waits to go out, in order */
  const queue = [];
  /** @type {Set<string>} */
  const failedVoices = new Set();
  /** @type {string[]} */
  const used = [];
  /** @type {VoiceStream|null} the stream the text being said went to */
  let current = null;
  let nextSeq = 0;
  let closed = false;
  /** Until another voice is asked for, a Flushed the router never asked for still reaches the server, as it did. */
  let oneVoice = true;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let handoverTimer = null;

  /**
   * @param {VoiceStream} vs
   * @returns {boolean}
   */
  function owes(vs) {
    return vs.unflushed || vs.pending.length > 0 || vs.awaitingQuiet;
  }

  /** @param {VoiceStream} vs */
  function stopTimers(vs) {
    if (vs.quietTimer) clearTimeout(vs.quietTimer);
    if (vs.openTimer) clearTimeout(vs.openTimer);
    vs.quietTimer = null;
    vs.openTimer = null;
  }

  function stopHandoverTimer() {
    if (handoverTimer) clearTimeout(handoverTimer);
    handoverTimer = null;
  }

  /**
   * @param {string} voice
   * @param {boolean} isBase
   * @returns {VoiceStream}
   */
  function open(voice, isBase) {
    /** @type {VoiceStream} */
    const vs = {
      voice, isBase, stream: /** @type {any} */ (null), opened: false, dead: false, unflushed: false,
      pending: [], quietSeqs: [], awaitingQuiet: false, quietTimer: null, openTimer: null, lastUsedAt: Date.now(),
    };
    streams.set(voice, vs);
    vs.stream = openStream(apiKey, {
      voice,
      host,
      onAudio: (audio) => onStreamAudio(vs, audio),
      onFlushed: (seq) => onStreamFlushed(vs, seq),
      onWarning: (warning) => {
        if (!vs.dead) invoke(onWarning, { code: warning.code, message: warning.message, voice });
      },
      onError: (err) => onStreamFailure(vs, err),
      onClose: (code, reason, info) => onStreamClose(vs, code, reason, info),
    });
    if (!isBase) {
      vs.openTimer = unref(setTimeout(() => {
        vs.openTimer = null;
        if (!vs.dead && !closed && !vs.stream.isOpen()) failVoice(vs, new Error(`Aura voice ${voice} did not open within ${openTimeoutMs} ms`));
      }, openTimeoutMs));
    }
    vs.stream.ready.then(
      () => {
        if (vs.openTimer) clearTimeout(vs.openTimer);
        vs.openTimer = null;
        if (vs.dead || closed) return;
        vs.opened = true;
        pump();
      },
      () => {}, // a stream that never opens reports through onError / onClose
    );
    return vs;
  }

  /**
   * The open stream for a voice, opening it (after closing the least recently used
   * idle one, at maxVoices) when there is none.
   * @param {string} voice
   * @returns {VoiceStream}
   */
  function streamFor(voice) {
    const existing = streams.get(voice);
    if (existing && !existing.dead) return existing;
    if (streams.size >= maxVoices) {
      // Idle: not speaking, owing nothing, and no sentence waiting for it (one still connecting counts).
      const waiting = new Set(queue.map((op) => (op.type === "speak" ? op.voice : null)));
      const idle = [...streams.values()].filter((vs) => !vs.isBase && vs !== current && !owes(vs) && !waiting.has(vs.voice)).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (idle) forget(idle);
    }
    return open(voice, false);
  }

  /**
   * Stop using a stream: closed, and nothing it does from now on counts.
   * @param {VoiceStream} vs
   */
  function forget(vs) {
    vs.dead = true;
    stopTimers(vs);
    if (streams.get(vs.voice) === vs) streams.delete(vs.voice);
    if (current === vs) {
      current = null;
      stopHandoverTimer();
    }
    try {
      vs.stream.close();
    } catch (err) {
      invoke(onWarning, { code: "CLOSE_FAILED", message: `closing ${vs.voice} threw: ${err instanceof Error ? err.message : String(err)}`, voice: vs.voice });
    }
  }

  /**
   * Another voice's stream never opened: that voice is done for the call, and its
   * sentences go to the assistant's voice.
   * @param {VoiceStream} vs
   * @param {Error} err
   */
  function failVoice(vs, err) {
    if (vs.dead) return;
    forget(vs);
    failedVoices.add(vs.voice);
    invoke(onVoiceFailed, vs.voice, err); // first: the server's speech guard then knows the voice failed
    /** @type {Op[]} */
    const kept = [];
    for (const op of queue) {
      if (op.type !== "speak" || op.voice !== vs.voice) {
        kept.push(op);
        continue;
      }
      const text = reroute(op.text);
      if (text) kept.push({ type: "speak", voice: baseVoice, text });
    }
    queue.splice(0, queue.length, ...kept);
    pump();
  }

  /**
   * A sentence that was queued for a voice that failed, as the assistant's voice will say it.
   * @param {string} text
   * @returns {string} "" to drop it
   */
  function reroute(text) {
    if (typeof options.rerouteText !== "function") return text;
    try {
      const said = options.rerouteText(text);
      return typeof said === "string" ? said : text;
    } catch (err) {
      reportError(err instanceof Error ? err : new Error(String(err)));
      return text;
    }
  }

  /**
   * @param {VoiceStream} vs
   * @param {Error} err
   */
  function onStreamFailure(vs, err) {
    if (vs.dead || closed) return;
    if (vs.isBase) {
      reportError(err); // the router failing, as the one stream did
      return;
    }
    if (!vs.opened && !vs.stream.isOpen()) {
      failVoice(vs, err);
      return;
    }
    if (owes(vs)) {
      forget(vs);
      reportError(err); // mid-sentence: the server's fallback says again what it never voiced
      return;
    }
    forget(vs); // idle (Aura's idle timeout): opened again for its next sentence
    invoke(onWarning, { code: "VOICE_CLOSED", message: `${vs.voice} stopped while idle (${err.message.slice(0, 80)}) - it opens again for its next sentence`, voice: vs.voice });
  }

  /**
   * @param {VoiceStream} vs
   * @param {number} code
   * @param {string} reason
   * @param {{ initiatedByUs: boolean }} info
   */
  function onStreamClose(vs, code, reason, info) {
    if (vs.isBase) {
      invoke(onClose, code, reason, info); // as the one stream did: the server ignores its own closes
      return;
    }
    if (info?.initiatedByUs || vs.dead || closed) return;
    onStreamFailure(vs, new Error(`Aura voice ${vs.voice} closed: ${code} ${String(reason).slice(0, 80)}`));
  }

  /**
   * @param {VoiceStream} vs
   * @param {Buffer} audio
   */
  function onStreamAudio(vs, audio) {
    if (vs.dead || closed) return;
    if (vs.awaitingQuiet) armQuiet(vs);
    invoke(onAudio, audio, vs.voice);
  }

  /**
   * @param {VoiceStream} vs
   * @param {number|null} seq - Aura's sequence id (null when the frame had none: the oldest flush)
   */
  function onStreamFlushed(vs, seq) {
    if (vs.dead || closed) return;
    const done = Number.isInteger(seq) ? /** @type {number} */ (seq) : (vs.pending[0]?.seq ?? null);
    const finished = done === null ? [] : vs.pending.filter((p) => p.seq <= done);
    if (finished.length === 0) {
      // A Flushed the router never asked for: the one stream reported it, so it still does.
      if (oneVoice && vs.isBase) invoke(onFlushed, seq);
      return;
    }
    vs.pending = vs.pending.filter((p) => p.seq > /** @type {number} */ (done));
    for (const p of finished) if (p.routerSeq !== null) invoke(onFlushed, p.routerSeq);
    pump(); // a sentence in another voice may be waiting for this one
  }

  /**
   * A refused flush has no Flushed: the stream is done once its audio has been quiet.
   * @param {VoiceStream} vs
   */
  function armQuiet(vs) {
    if (vs.quietTimer) clearTimeout(vs.quietTimer);
    vs.quietTimer = unref(setTimeout(() => {
      vs.quietTimer = null;
      if (vs.dead || closed || !vs.awaitingQuiet) return;
      vs.awaitingQuiet = false;
      for (const seq of vs.quietSeqs.splice(0)) invoke(onFlushed, seq);
      pump();
    }, quietMs));
  }

  /**
   * Flush one stream.
   * @param {VoiceStream} vs
   * @param {number|null} routerSeq - the router's flush this is, or null for a hand-over flush
   * @returns {number|null} the stream's sequence id, or null when it refused
   */
  function flushStream(vs, routerSeq) {
    const seq = vs.stream.flush();
    vs.unflushed = false;
    if (seq === null) {
      if (routerSeq !== null) vs.quietSeqs.push(routerSeq);
      vs.awaitingQuiet = true;
      armQuiet(vs);
      return null;
    }
    vs.pending.push({ seq, routerSeq });
    return seq;
  }

  /**
   * Has this stream finished, so the next voice can speak? If not: it is flushed (a
   * hand-over flush) and waited for, at most handoverWaitMs.
   * @param {VoiceStream} vs
   * @returns {boolean}
   */
  function handOver(vs) {
    if (vs.dead) return true;
    if (vs.unflushed) flushStream(vs, null);
    if (!owes(vs)) {
      stopHandoverTimer();
      return true;
    }
    if (!handoverTimer) {
      handoverTimer = unref(setTimeout(() => {
        handoverTimer = null;
        if (closed || current !== vs || vs.dead || !owes(vs)) return;
        invoke(onWarning, { code: "HANDOVER_TIMEOUT", message: `${vs.voice} still owed audio ${handoverWaitMs} ms after its flush - the next voice goes on`, voice: vs.voice });
        const seqs = [...vs.pending.map((p) => p.routerSeq), ...vs.quietSeqs];
        vs.pending = [];
        vs.quietSeqs = [];
        vs.awaitingQuiet = false;
        if (vs.quietTimer) clearTimeout(vs.quietTimer);
        vs.quietTimer = null;
        for (const seq of seqs) if (seq !== null) invoke(onFlushed, seq);
        pump();
      }, handoverWaitMs));
    }
    return false;
  }

  /** Send what can go now, in order; a sentence in another voice waits until the voice before it has finished. */
  function pump() {
    while (!closed && queue.length > 0) {
      const op = queue[0];
      if (op.type === "flush") {
        const target = current || base;
        if (!target.stream.isOpen()) return;
        queue.shift();
        flushStream(target, op.seq);
        continue;
      }
      if (current && current.voice !== op.voice) {
        if (!handOver(current)) return; // its Flushed (or its quiet, or the timeout) pumps again
        current = null;
      }
      const vs = streamFor(op.voice);
      if (!vs.stream.isOpen()) return; // connecting: its ready (or its failure) pumps again
      vs.opened = true;
      queue.shift();
      if (!vs.stream.speak(op.text)) continue; // the socket went in between: its close says so
      vs.unflushed = true;
      vs.lastUsedAt = Date.now();
      if (!used.includes(vs.voice)) used.push(vs.voice);
      current = vs;
    }
  }

  const base = open(baseVoice, true);

  return {
    ready: base.stream.ready,

    isOpen() {
      return !closed && base.stream.isOpen();
    },

    speak(text, voice) {
      if (closed || typeof text !== "string" || !text.trim() || !base.stream.isOpen()) return false;
      const target = typeof voice === "string" && voice && !failedVoices.has(voice) ? voice : baseVoice;
      if (target !== baseVoice) {
        oneVoice = false;
        streamFor(target); // opening while the voice before it finishes
      }
      queue.push({ type: "speak", voice: target, text });
      pump();
      return true;
    },

    flush() {
      if (closed) return null;
      if (queue.length > 0) {
        // Behind a hand-over: it goes out after the text before it, and is reported once that has played out.
        const seq = nextSeq++;
        queue.push({ type: "flush", seq });
        pump();
        return seq;
      }
      const target = current || base;
      if (!target.stream.isOpen()) return null;
      const streamSeq = target.stream.flush();
      target.unflushed = false;
      if (streamSeq === null) {
        // Refused (the budget): no Flushed, as before. A hand-over waits for its quiet.
        target.awaitingQuiet = true;
        armQuiet(target);
        return null;
      }
      // One voice: the two counts move together, so the router's ids are the stream's own.
      const seq = nextSeq++;
      target.pending.push({ seq: streamSeq, routerSeq: seq });
      return seq;
    },

    flushesInLastMinute() {
      return (current && !current.dead ? current : base).stream.flushesInLastMinute();
    },

    clear() {
      if (closed) return false;
      queue.length = 0;
      stopHandoverTimer();
      let sent = false;
      for (const vs of streams.values()) {
        // Only a stream that may still send audio: a Clear's lost Cleared mutes the next
        // sentence's audio for up to CLEARED_BACKSTOP_MS (an idle Aura is never cleared).
        if (vs.dead || !vs.stream.isOpen() || (vs !== current && !owes(vs))) continue;
        if (vs.stream.clear()) sent = true;
        // A Clear discards pending flushes: their Flushed never comes.
        vs.unflushed = false;
        vs.pending = [];
        vs.quietSeqs = [];
        vs.awaitingQuiet = false;
        if (vs.quietTimer) clearTimeout(vs.quietTimer);
        vs.quietTimer = null;
      }
      current = null;
      return sent;
    },

    close() {
      if (closed) return;
      closed = true;
      queue.length = 0;
      stopHandoverTimer();
      current = null;
      /** @type {unknown} */
      let failure = null;
      for (const vs of [...streams.values()]) {
        stopTimers(vs);
        try {
          vs.stream.close();
        } catch (err) {
          failure = failure || err;
        }
      }
      // Every stream was closed first; the first failure is the caller's to log.
      if (failure) throw failure;
    },

    prepare(voice) {
      if (closed || typeof voice !== "string" || !voice || voice === baseVoice || failedVoices.has(voice)) return;
      streamFor(voice);
    },

    voicesUsed() {
      return [...used];
    },
  };
}

module.exports = {
  createAuraRouter,
  DEFAULT_OPEN_TIMEOUT_MS,
  DEFAULT_QUIET_MS,
  DEFAULT_HANDOVER_WAIT_MS,
  DEFAULT_MAX_VOICES,
};
