"use strict";

/**
 * SCRUM-594: audio out to Twilio for the fast classic pipeline.
 *
 * Aura streams raw mulaw in whatever frame sizes it likes (290 / 320 / 30
 * bytes seen) at about twice real time. This re-chunks it into Twilio's native
 * 160-byte (20 ms) frames and sends each one immediately: Twilio buffers
 * playback, so there is nothing to pace here.
 *
 * "Is the AI still talking?" is answered from Twilio's own mark echoes, not
 * from our send side. Each finished utterance gets a mark; Twilio echoes it
 * when the audio before it has actually been played. `isPlaying()` is true
 * while any audio handed to the player has not been covered by an echoed
 * mark, which avoids the classic path's `tts-done` bug (the first echoed mark
 * flipped isSpeaking off while later audio was still queued).
 *
 * Pure: no sockets, no Sentry, no logging. The caller supplies `sendJson`
 * (serialises and writes one Twilio message) and may supply a clock.
 */

/** Twilio's native frame: 20 ms of 8 kHz mulaw. */
const FRAME_BYTES = 160;
/** 8000 samples/s of one byte each. */
const BYTES_PER_MS = 8;
/** How long past the estimated end of playback whenIdle() waits for a mark that never comes. */
const DEFAULT_IDLE_CAP_MS = 2000;
const MARK_PREFIX = "fast-";

const EMPTY = Buffer.alloc(0);

/**
 * @typedef {Object} FastPlayer
 * @property {(audio: Uint8Array) => void} push - hand over TTS audio (a Buffer is a Uint8Array); whole 160-byte frames go out at once
 * @property {() => string} endUtterance - flush the tail, send a mark, return its name
 * @property {(name: string) => boolean} onMark - Twilio echoed a mark; true when it was one of ours
 * @property {() => boolean} isPlaying
 * @property {(capMs?: number) => Promise<void>} whenIdle
 * @property {() => void} stop - barge-in: Twilio `clear`, drop everything queued
 * @property {(at?: number) => number|null} remainingMs - ms of the audio sent since the player was last idle that Twilio has still to play (an estimate, never negative); null when nothing was sent since then. `at` defaults to the clock
 */

/**
 * @param {{ sendJson: (message: object) => void, streamSid: string, now?: () => number }} options
 *   sendJson - serialise and write one message to the Twilio media-stream socket (may throw if it is closed);
 *   streamSid - the call's Twilio stream id, stamped on every message;
 *   now - clock in ms (default Date.now); injectable for tests
 * @returns {FastPlayer}
 */
function createFastPlayer(options) {
  const { sendJson, streamSid, now = () => Date.now() } = options || /** @type {any} */ ({});
  if (typeof sendJson !== "function") throw new TypeError("createFastPlayer: sendJson must be a function");
  if (typeof streamSid !== "string" || streamSid === "") throw new TypeError("createFastPlayer: streamSid is required");

  /** Bytes (fewer than one frame) waiting for the next push or endUtterance. */
  let carry = EMPTY;
  /** Bytes handed over since the last mark; a mark covers everything before it. */
  let unmarkedBytes = 0;
  /** Marks sent and not yet echoed, in send order. */
  let outstanding = /** @type {string[]} */ ([]);
  /** Never reset: after stop() Twilio echoes the cleared marks late, and a reused name would be mistaken for a new one. */
  let markSeq = 0;
  let waiters = /** @type {Array<{ resolve: () => void, timer: ReturnType<typeof setTimeout> }>} */ ([]);
  /**
   * The audio sent since the player was last idle (or stopped): bytes on the wire, and
   * the wall-clock estimate of when all of it will have played (whenIdle's deadline and
   * remainingMs). Twilio plays the frames back to back from the first one, so endsAt is
   * that frame's time + bytes/8, unless the audio ran dry in between (a late sentence):
   * then the late frames play later, and endsAt moves with them.
   */
  let sinceIdle = { bytes: 0, endsAt: 0 };

  function isPlaying() {
    return outstanding.length > 0 || unmarkedBytes > 0;
  }

  function remainingPlaybackMs() {
    return Math.max(sinceIdle.endsAt - now(), 0);
  }

  /** @param {{ resolve: () => void, timer: ReturnType<typeof setTimeout> }} waiter */
  function release(waiter) {
    clearTimeout(waiter.timer);
    waiters = waiters.filter((w) => w !== waiter);
    waiter.resolve();
  }

  function releaseAll() {
    for (const waiter of [...waiters]) release(waiter);
  }

  /** @param {Buffer} frame */
  function sendFrame(frame) {
    sendJson({ event: "media", streamSid, media: { payload: frame.toString("base64") } });
    const t = now();
    sinceIdle.bytes += frame.length;
    sinceIdle.endsAt = Math.max(sinceIdle.endsAt, t) + frame.length / BYTES_PER_MS;
  }

  return {
    push(audio) {
      if (!(audio instanceof Uint8Array) || audio.length === 0) return;
      unmarkedBytes += audio.length;

      const chunk = Buffer.isBuffer(audio) ? audio : Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
      const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const whole = data.length - (data.length % FRAME_BYTES);
      // Copy the remainder (the caller may reuse its buffer) and record it
      // BEFORE sending: if sendJson throws, these bytes must not be replayed.
      carry = whole < data.length ? Buffer.from(data.subarray(whole)) : EMPTY;
      for (let offset = 0; offset < whole; offset += FRAME_BYTES) {
        sendFrame(data.subarray(offset, offset + FRAME_BYTES));
      }
    },

    endUtterance() {
      if (carry.length > 0) {
        const tail = carry;
        carry = EMPTY;
        sendFrame(tail);
      }
      markSeq += 1;
      const name = `${MARK_PREFIX}${markSeq}`;
      sendJson({ event: "mark", streamSid, mark: { name } });
      outstanding.push(name);
      unmarkedBytes = 0;
      return name;
    },

    onMark(name) {
      const index = typeof name === "string" ? outstanding.indexOf(name) : -1;
      if (index === -1) return false;
      // Twilio plays in order, so an echo also proves every earlier mark has
      // played: retire those too, or one lost echo would wedge isPlaying().
      outstanding.splice(0, index + 1);
      if (!isPlaying()) {
        sinceIdle = { bytes: 0, endsAt: 0 };
        releaseAll();
      }
      return true;
    },

    isPlaying,

    whenIdle(capMs = DEFAULT_IDLE_CAP_MS) {
      if (!isPlaying()) return Promise.resolve();
      const cap = Number.isFinite(capMs) && capMs >= 0 ? capMs : DEFAULT_IDLE_CAP_MS;
      const deadlineMs = remainingPlaybackMs() + cap;
      return new Promise((resolve) => {
        /** @type {{ resolve: () => void, timer: ReturnType<typeof setTimeout> }} */
        const waiter = { resolve, timer: setTimeout(() => release(waiter), deadlineMs) };
        waiters.push(waiter);
      });
    },

    stop() {
      // Local state first, so it is reset even if the Twilio socket is already gone.
      carry = EMPTY;
      unmarkedBytes = 0;
      outstanding = [];
      sinceIdle = { bytes: 0, endsAt: 0 };
      releaseAll();
      // Always sent, even when nothing looks queued: Twilio may still hold audio.
      sendJson({ event: "clear", streamSid });
    },

    remainingMs(at = now()) {
      if (sinceIdle.bytes === 0) return null;
      return Math.max(0, sinceIdle.endsAt - at);
    },
  };
}

module.exports = { createFastPlayer };
