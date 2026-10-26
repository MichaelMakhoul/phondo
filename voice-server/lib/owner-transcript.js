"use strict";
/**
 * SCRUM-597 — the owner's side of a browser session's transcript, from Deepgram.
 *
 * On the owner's first browser test (call 9a3838b9, 2026-10-26) Gemini Live's own
 * input transcription turned four of their six lines into random Spanish and
 * Korean, although the model understood them. Phone calls get a Deepgram
 * re-transcription after the call; web sessions get none, so that text was what
 * the owner saw and what was saved. This runs Deepgram on the same inbound audio
 * for the TEXT only: the conversation, and the confirmation gate's clock
 * (noteOwnerSpeech on Gemini's input transcription), stay on Gemini.
 *
 * Never fatal. If Deepgram can't connect, errors or drops, onLost fires once and
 * the session goes on with Gemini's text.
 */

const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {(apiKey: string, callbacks: object, options?: object) => any} o.openStream - services/deepgram-stt.js openDeepgramStream
 * @param {string} [o.industry] - keyterm boosting, as for the classic pipeline
 * @param {(text: string) => void} o.onFinal - one finalised piece of the owner's speech
 * @param {(why: string) => void} o.onLost - Deepgram is gone for this session (called once, never after close())
 * @returns {{ send: (audio: Buffer) => void, close: () => void, readonly active: boolean }}
 */
function createOwnerTranscriber({ apiKey, openStream, industry, onFinal, onLost }) {
  let done = false; // lost, or closed by us
  /** @type {any} */
  let ws = null;

  /** @param {string} why */
  const lose = (why) => {
    if (done) return;
    done = true;
    try {
      if (ws && (ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN)) ws.close();
    } catch {
      // already going away
    }
    onLost(why);
  };

  try {
    ws = openStream(
      apiKey,
      {
        language: "en",
        onTranscript: (/** @type {{ transcript?: unknown, isFinal?: unknown }} */ r) => {
          if (done || r.isFinal !== true || typeof r.transcript !== "string") return;
          const text = r.transcript.trim();
          if (text) onFinal(text);
        },
        onError: (/** @type {any} */ err) => lose(`error: ${err && err.message ? err.message : String(err)}`),
        onClose: (/** @type {number} */ code) => {
          if (code !== 1000 && code !== 1005) lose(`closed with code ${code}`);
        },
      },
      { industry }
    );
  } catch (err) {
    lose(`could not open: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    /** Forward one inbound mulaw frame; dropped unless the stream is open. */
    send(audio) {
      if (!done && ws && ws.readyState === WS_OPEN) ws.send(audio);
    },
    /** Teardown: no onLost, no more finals. */
    close() {
      done = true;
      try {
        if (ws && (ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN)) ws.close(1000);
      } catch {
        // already going away
      }
    },
    get active() {
      return !done;
    },
  };
}

module.exports = { createOwnerTranscriber };
