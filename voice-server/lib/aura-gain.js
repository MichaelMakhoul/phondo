"use strict";

/**
 * SCRUM-594 (phone test F7): Deepgram's Aura voices reach the caller 4-8 dB
 * quieter than the Gemini voice this line used to have (Theia's speech level on
 * the phone format is about -21 dBFS, Gemini's recorded level about -14), and the
 * caller couldn't make out every word. Every Aura frame gets a fixed gain on its
 * way to Twilio, with a soft limiter so loud peaks bend instead of clipping.
 *
 * AURA_GAIN_DB sets the gain: default 6; 0 or "off" (false, no, none, disabled)
 * turns it off (the kill switch); clamped to 0-12; anything else warns once and
 * uses the default. Mulaw has only 256 codes, so the gain is a 256-entry table:
 * one lookup a byte.
 *
 * Phone test F9: the voices aren't equally loud, nor equally peaky. The Spanish
 * voice speaks 2 dB louder than Theia with peaks 3 dB higher, so +6 dB drove it
 * into the limiter (its error 10 dB over Theia's) and the caller heard it as
 * "off". AURA_GAIN_DB is Theia's gain, up to her own ceiling (7 dB: more than
 * that no longer changes her); every voice listed below gets the gain that
 * brings it to Theia's level, but never more than its ceiling. A voice not
 * listed gets AURA_GAIN_DB as it is, with a warning (measure it).
 */

const { encodeMulawSample } = require("./audio-converter");

const DEFAULT_GAIN_DB = 6;
const MAX_GAIN_DB = 12;
/** G.711's own ceiling (encodeMulawSample clips there). */
const CLIP = 32635;
/** Below the knee a sample is only scaled; above it, it bends toward CLIP and never reaches past it. */
const KNEE = 0.6 * CLIP;

/** The voice AURA_GAIN_DB was tuned on (phone test F7), whose level the others are matched to. */
const REFERENCE_VOICE = "aura-2-theia-en";
/**
 * Every Aura voice the product speaks with, measured on the phone format (REST,
 * mulaw 8 kHz, AU host, 21 Oct 2026, two runs of 8-18 sentences each):
 * - level: its speech level in dBFS (P.56-like: 20 ms frames within 30 dB of the loudest);
 * - ceiling: the most gain it takes before the limiter is heard, i.e. while the
 *   limiter's error stays 32 dB under the speech, about the mulaw step's own (the
 *   lower of the two runs, rounded down to 0.5 dB).
 * @type {Readonly<Record<string, Readonly<{ level: number, ceiling: number }>>>}
 */
const VOICE_PROFILES = Object.freeze({
  "aura-2-theia-en": Object.freeze({ level: -20.6, ceiling: 7 }),
  "aura-2-asteria-en": Object.freeze({ level: -22.8, ceiling: 6 }),
  "aura-2-luna-en": Object.freeze({ level: -23.6, ceiling: 7.5 }),
  "aura-2-orion-en": Object.freeze({ level: -19.3, ceiling: 4.5 }),
  "aura-2-arcas-en": Object.freeze({ level: -23.9, ceiling: 4 }),
  "aura-2-selena-es": Object.freeze({ level: -18.5, ceiling: 3.5 }),
  "aura-2-agathe-fr": Object.freeze({ level: -25.1, ceiling: 6.5 }),
  "aura-2-elara-de": Object.freeze({ level: -26.8, ceiling: 7.5 }),
  "aura-2-cinzia-it": Object.freeze({ level: -26.5, ceiling: 7.5 }),
  "aura-2-daphne-nl": Object.freeze({ level: -25.6, ceiling: 9.5 }),
  "aura-2-uzume-ja": Object.freeze({ level: -25.5, ceiling: 8.5 }),
});

/** The repo's kill-switch words (GREETING_GUARD=off, FAST_LANGUAGES=off …). */
const OFF_WORDS = /^(?:off|false|no|none|disabled)$/i;

let warnedBadGain = false;
let warnedClamp = false;
let warnedNotAudio = false;
/** The gain the last "[AuraGain]" line announced (null: none yet), so it is logged once, not per frame. */
/** @type {number | null} */
let loggedDb = null;
/** Each listed voice's gain as its own "[AuraGain]" line last announced it. */
/** @type {Map<string, number>} */
const loggedVoiceDb = new Map();
/** Voices with no profile already warned about (a new voice must be measured). */
/** @type {Set<string>} */
const warnedUnprofiled = new Set();
/** The gain tables made so far, by gain (a few: AURA_GAIN_DB's and the listed voices'). */
/** @type {Map<number, Uint8Array>} */
const tables = new Map();

/**
 * The gain in dB from AURA_GAIN_DB: unset or blank is the default, anything that
 * is not a number is the default (warned once), and the rest is clamped to 0-12.
 * @returns {number}
 */
function auraGainDb() {
  const raw = process.env.AURA_GAIN_DB;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GAIN_DB;
  if (OFF_WORDS.test(raw.trim())) return 0;
  const db = Number(raw);
  if (!Number.isFinite(db)) {
    if (!warnedBadGain) {
      warnedBadGain = true;
      console.warn(`[AuraGain] AURA_GAIN_DB=${JSON.stringify(raw.slice(0, 40))} is not a number or "off" — using ${DEFAULT_GAIN_DB} dB`);
    }
    return DEFAULT_GAIN_DB;
  }
  const clamped = Math.min(MAX_GAIN_DB, Math.max(0, db));
  if (clamped !== db && !warnedClamp) {
    warnedClamp = true;
    console.warn(`[AuraGain] AURA_GAIN_DB=${db} is outside 0-${MAX_GAIN_DB} — using ${clamped} dB`);
  }
  return clamped;
}

/**
 * Phone test F9: one voice's gain. A listed voice gets the gain that matches the
 * reference voice's level at AURA_GAIN_DB, never past its ceiling (nor outside
 * 0-12); a voice not listed gets AURA_GAIN_DB as it is; off is off for every voice.
 * Rounded to 0.1 dB, so a few tables serve every voice.
 * @param {unknown} voice - the Aura model the audio was made with
 * @param {number} [base] - AURA_GAIN_DB's gain (read when not given)
 * @returns {number}
 */
function voiceGainDb(voice, base = auraGainDb()) {
  const profile = typeof voice === "string" && Object.hasOwn(VOICE_PROFILES, voice) ? VOICE_PROFILES[voice] : null;
  if (base === 0 || !profile) return base;
  const matched = base + VOICE_PROFILES[REFERENCE_VOICE].level - profile.level;
  return Math.round(Math.max(0, Math.min(matched, profile.ceiling, MAX_GAIN_DB)) * 10) / 10;
}

/**
 * G.711 mulaw decode, the exact inverse of encodeMulawSample (audio-converter's
 * MULAW_TO_PCM16 decodes every sample 99 too large in magnitude).
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
 * itself when the gain is 0. Anything that isn't bytes goes out as it came, warned once.
 * @param {Uint8Array} audio - raw mulaw 8 kHz (a Buffer, usually)
 * @param {string} [voice] - the Aura voice that made it (phone test F9: each listed voice has its own gain)
 * @returns {Buffer}
 */
function boostAura(audio, voice) {
  if (!(audio instanceof Uint8Array)) {
    if (!warnedNotAudio) {
      warnedNotAudio = true;
      console.warn("[AuraGain] Asked to boost something that isn't audio bytes — sent as it came");
    }
    return audio;
  }
  const base = auraGainDb();
  if (base !== loggedDb) {
    loggedDb = base;
    console.log(base === 0 ? "[AuraGain] Aura boost is OFF (AURA_GAIN_DB)" : `[AuraGain] Aura audio at +${base} dB (AURA_GAIN_DB)`);
  }
  const db = voiceGainDb(voice, base);
  if (typeof voice === "string" && base !== 0 && !Object.hasOwn(VOICE_PROFILES, voice) && !warnedUnprofiled.has(voice) && warnedUnprofiled.size < 32) {
    warnedUnprofiled.add(voice);
    console.warn(`[AuraGain] ${voice.slice(0, 60)} has no measured profile — using AURA_GAIN_DB (+${base} dB); measure it (lib/aura-gain.js)`);
  }
  if (db !== base && typeof voice === "string" && loggedVoiceDb.get(voice) !== db) {
    loggedVoiceDb.set(voice, db);
    console.log(`[AuraGain] ${voice} at +${db} dB (its own level and peaks; AURA_GAIN_DB is ${base})`);
  }
  if (db === 0 || audio.length === 0) return /** @type {Buffer} */ (audio);
  let table = tables.get(db);
  if (!table) {
    if (tables.size >= 32) tables.clear(); // AURA_GAIN_DB changed again and again: start over
    table = gainTable(db);
    tables.set(db, table);
  }
  const out = Buffer.allocUnsafe(audio.length);
  for (let i = 0; i < audio.length; i++) out[i] = table[audio[i]];
  return out;
}

module.exports = { boostAura, auraGainDb, voiceGainDb, gainTable, decodeMulaw, DEFAULT_GAIN_DB, VOICE_PROFILES, REFERENCE_VOICE };
