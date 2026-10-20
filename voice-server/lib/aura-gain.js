"use strict";

/**
 * SCRUM-594 (phone test F7): Deepgram's Aura voices reach the caller 4-8 dB
 * quieter than the Gemini voice this line used to have (Theia's speech level on
 * the phone format is about -21 dBFS, Gemini's recorded level about -14), and the
 * caller couldn't make out every word. Every Aura frame gets a fixed gain on its
 * way to Twilio, with a soft limiter so loud peaks bend instead of clipping.
 *
 * AURA_GAIN_DB sets the gain: default 6, 0 turns it off, clamped to 0-12.
 * Mulaw has only 256 codes, so the gain is a 256-entry table: one lookup a byte.
 */

const { encodeMulawSample } = require("./audio-converter");

const DEFAULT_GAIN_DB = 6;
const MAX_GAIN_DB = 12;
/** G.711's own ceiling (encodeMulawSample clips there). */
const CLIP = 32635;
/** Below the knee a sample is only scaled; above it, it bends toward CLIP and never reaches past it. */
const KNEE = 0.6 * CLIP;

let warnedBadGain = false;
/** @type {{ db: number, table: Uint8Array } | null} */
let cached = null;

/**
 * The gain in dB from AURA_GAIN_DB: unset or blank is the default, anything that
 * is not a number is the default (warned once), and the rest is clamped to 0-12.
 * @returns {number}
 */
function auraGainDb() {
  const raw = process.env.AURA_GAIN_DB;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GAIN_DB;
  const db = Number(raw);
  if (!Number.isFinite(db)) {
    if (!warnedBadGain) {
      warnedBadGain = true;
      console.warn(`[AuraGain] AURA_GAIN_DB is not a number — using ${DEFAULT_GAIN_DB} dB`);
    }
    return DEFAULT_GAIN_DB;
  }
  return Math.min(MAX_GAIN_DB, Math.max(0, db));
}

/**
 * G.711 mulaw decode, the exact inverse of encodeMulawSample (so 0 dB maps every
 * code to itself; audio-converter's MULAW_TO_PCM16 is off by a small constant).
 * @param {number} code
 * @returns {number}
 */
function decodeMulaw(code) {
  const u = ~code & 0xff;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 0x07)) - 0x84;
  return u & 0x80 ? -magnitude : magnitude;
}

/**
 * The mulaw-to-mulaw table for a gain: each code decoded, scaled, softly limited, re-encoded.
 * @param {number} db
 * @returns {Uint8Array}
 */
function gainTable(db) {
  const gain = 10 ** (db / 20);
  const table = new Uint8Array(256);
  for (let code = 0; code < 256; code++) {
    const scaled = decodeMulaw(code) * gain;
    const size = Math.abs(scaled);
    const bent = size <= KNEE ? size : KNEE + (CLIP - KNEE) * Math.tanh((size - KNEE) / (CLIP - KNEE));
    table[code] = encodeMulawSample(Math.sign(scaled) * Math.round(bent));
  }
  return table;
}

/**
 * Aura audio at line level. A new buffer (the input is never changed); the input
 * itself when the gain is 0.
 * @param {Buffer} audio - raw mulaw 8 kHz
 * @returns {Buffer}
 */
function boostAura(audio) {
  const db = auraGainDb();
  if (db === 0 || !Buffer.isBuffer(audio) || audio.length === 0) return audio;
  if (!cached || cached.db !== db) cached = { db, table: gainTable(db) };
  const { table } = cached;
  const out = Buffer.allocUnsafe(audio.length);
  for (let i = 0; i < audio.length; i++) out[i] = table[audio[i]];
  return out;
}

module.exports = { boostAura, auraGainDb, gainTable, decodeMulaw, DEFAULT_GAIN_DB };
