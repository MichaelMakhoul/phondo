"use strict";

/**
 * SCRUM-594 gate (M4b): the caller talks and Flux reports nothing.
 *
 * Flux is English-only. Speech it cannot transcribe (another language, a very
 * bad line) produces no turn events at all, so the turn engine never hears the
 * caller and the call goes quiet with nothing to page. This watchdog listens to
 * the caller's own audio: once SPEECH_MS of speech energy has gone by within
 * WINDOW_MS with no Flux turn event, it trips, and server.js hands the call to
 * Nova (multilingual) and reports it.
 *
 * Speech energy: the RMS of each 20 ms frame (160 bytes of 8 kHz mulaw, decoded
 * to 16-bit PCM) at or above RMS_THRESHOLD. Silence and line hiss sit far below
 * it. Audio is counted only while the AI is NOT speaking, so the AI's own voice
 * coming back on a speakerphone never trips it.
 *
 * Pure: no timers, no I/O, no logging. Time comes in with the audio.
 */

const { mulawToPcm16 } = require("./audio-converter");

/** One 20 ms frame of 8 kHz mulaw. */
const FRAME_BYTES = 160;
const FRAME_MS = 20;
/** The window speech is counted over. */
const WINDOW_MS = 8000;
/** This much speech within the window, with no turn event, trips it. */
const SPEECH_MS = 3000;
/** A frame at or above this RMS (16-bit PCM) is speech (the bench's threshold). */
const RMS_THRESHOLD = 300;

/**
 * RMS of a run of 16-bit little-endian PCM samples.
 * @param {Buffer} pcm
 * @returns {number}
 */
function rms(pcm) {
  const samples = pcm.length >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

/**
 * @typedef {Object} NoTurnWatchdog
 * @property {(mulaw: Buffer, at: number, aiSpeaking: boolean) => boolean} onAudio - the caller's audio as it arrives; true once it trips (and every time after, until onTurn)
 * @property {() => void} onTurn - Flux reported a turn event: the caller is being heard
 * @property {() => number} speechMs - speech counted in the current window (for tests and logs)
 */

/**
 * @param {{ windowMs?: number, speechMs?: number, rmsThreshold?: number }} [options]
 * @returns {NoTurnWatchdog}
 */
function createNoTurnWatchdog(options = {}) {
  const { windowMs = WINDOW_MS, speechMs = SPEECH_MS, rmsThreshold = RMS_THRESHOLD } = options;
  /** When each speech frame was heard, oldest first. */
  let speech = /** @type {number[]} */ ([]);

  return {
    onAudio(mulaw, at, aiSpeaking) {
      if (!Buffer.isBuffer(mulaw) || !Number.isFinite(at)) return false;
      if (!aiSpeaking) {
        const pcm = mulawToPcm16(mulaw);
        for (let offset = 0; offset < mulaw.length; offset += FRAME_BYTES) {
          if (rms(pcm.subarray(offset * 2, Math.min(mulaw.length, offset + FRAME_BYTES) * 2)) >= rmsThreshold) speech.push(at);
        }
      }
      while (speech.length > 0 && speech[0] <= at - windowMs) speech.shift();
      return speech.length * FRAME_MS >= speechMs;
    },
    onTurn() {
      speech = [];
    },
    speechMs() {
      return speech.length * FRAME_MS;
    },
  };
}

module.exports = { createNoTurnWatchdog, WINDOW_MS, SPEECH_MS, RMS_THRESHOLD };
