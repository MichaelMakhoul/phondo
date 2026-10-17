"use strict";

/**
 * SCRUM-594 gate (M4b, N2): the caller talks and Flux reports nothing.
 *
 * Flux is English-only. Speech it cannot transcribe (another language, a very
 * bad line) produces no turn events at all, so the turn engine never hears the
 * caller and the call goes quiet with nothing to page. This watchdog listens to
 * the caller's own audio: once SPEECH_MS of speech energy has gone by within
 * WINDOW_MS with no Flux turn event, it trips. server.js then logs it (the
 * default) or hands the call to Nova (NO_TURN_WATCHDOG=act).
 *
 * Speech energy: the RMS of each 20 ms frame (160 bytes of 8 kHz mulaw, decoded
 * to 16-bit PCM) at or above the threshold. The threshold follows the line
 * (gate N2): NOISE_FACTOR times the line's noise floor (the NOISE_PERCENTILE-th
 * percentile frame RMS over the last NOISE_WINDOW_MS of the caller's audio),
 * and never below RMS_THRESHOLD. A building site or a van is loud, but steady:
 * its floor rises with it, and only speech stands that far above it.
 *
 * Audio is counted only while the AI is not busy (not speaking: its own voice
 * coming back on a speakerphone; not working: hold audio, thinking). Every frame
 * still feeds the noise floor.
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
/** The least RMS (16-bit PCM) a frame needs to be speech, however quiet the line (the bench's). */
const RMS_THRESHOLD = 300;
/** The window the line's noise floor is measured over. */
const NOISE_WINDOW_MS = 10_000;
/** The noise floor: this percentile of the frame RMS values in that window. */
const NOISE_PERCENTILE = 20;
/** Speech stands at least this many times above the noise floor. */
const NOISE_FACTOR = 4;
/** The noise floor is measured again every this many frames (0.5 s). */
const FLOOR_EVERY_FRAMES = 25;

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
 * The p-th percentile (nearest rank) of some numbers.
 * @param {number[]} values - not empty
 * @param {number} p
 * @returns {number}
 */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * @typedef {Object} NoTurnWatchdog
 * @property {(mulaw: Buffer, at: number, aiBusy: boolean) => boolean} onAudio - the caller's audio as it arrives (aiBusy: the AI speaks or works); true once it trips (and every time after, until onTurn)
 * @property {() => void} onTurn - Flux reported a turn event: the caller is being heard
 * @property {() => number} speechMs - speech counted in the current window (for tests and logs)
 * @property {() => number} threshold - the RMS a frame needs to count as speech now
 */

/**
 * @param {{ windowMs?: number, speechMs?: number, rmsThreshold?: number, noiseWindowMs?: number, noiseFactor?: number }} [options]
 * @returns {NoTurnWatchdog}
 */
function createNoTurnWatchdog(options = {}) {
  const {
    windowMs = WINDOW_MS,
    speechMs = SPEECH_MS,
    rmsThreshold = RMS_THRESHOLD,
    noiseWindowMs = NOISE_WINDOW_MS,
    noiseFactor = NOISE_FACTOR,
  } = options;
  /** When each speech frame was heard, oldest first. */
  let speech = /** @type {number[]} */ ([]);
  /** Every frame of the caller's audio in the noise window: when, and its RMS. */
  let levels = /** @type {Array<{ at: number, rms: number }>} */ ([]);
  let floor = 0;
  let framesSinceFloor = Infinity;

  const threshold = () => Math.max(rmsThreshold, noiseFactor * floor);

  return {
    onAudio(mulaw, at, aiBusy) {
      if (!Buffer.isBuffer(mulaw) || !Number.isFinite(at)) return false;
      const pcm = mulawToPcm16(mulaw);
      for (let offset = 0; offset < mulaw.length; offset += FRAME_BYTES) {
        const level = rms(pcm.subarray(offset * 2, Math.min(mulaw.length, offset + FRAME_BYTES) * 2));
        levels.push({ at, rms: level });
        while (levels.length > 0 && levels[0].at <= at - noiseWindowMs) levels.shift();
        framesSinceFloor += 1;
        if (framesSinceFloor >= FLOOR_EVERY_FRAMES) {
          floor = percentile(levels.map((l) => l.rms), NOISE_PERCENTILE);
          framesSinceFloor = 0;
        }
        if (!aiBusy && level >= threshold()) speech.push(at);
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
    threshold,
  };
}

module.exports = { createNoTurnWatchdog, WINDOW_MS, SPEECH_MS, RMS_THRESHOLD, NOISE_WINDOW_MS, NOISE_PERCENTILE, NOISE_FACTOR };
