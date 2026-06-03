/**
 * Audio format conversion for Gemini Live API ↔ Twilio Media Streams.
 *
 * Twilio: G.711 mulaw, 8kHz, base64
 * Gemini: PCM16 linear, 16kHz input / 24kHz output, base64
 *
 * All functions operate on raw Buffers (not base64).
 */

// ── G.711 mulaw decode/encode tables ─────────────────────────────────────────

// mulaw → PCM16 lookup table (256 entries)
const MULAW_TO_PCM16 = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff;
  const sign = (mu & 0x80) ? -1 : 1;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  const magnitude = ((mantissa << 1) + 33) * (1 << (exponent + 2)) - 33;
  MULAW_TO_PCM16[i] = sign * magnitude;
}

/**
 * Decode mulaw buffer to PCM16 linear.
 * Each mulaw byte → one 16-bit sample (2 bytes, little-endian).
 * @param {Buffer} mulawBuf
 * @returns {Buffer} PCM16 buffer (2x length)
 */
function mulawToPcm16(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    const sample = MULAW_TO_PCM16[mulawBuf[i]];
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

/**
 * Encode PCM16 linear buffer to mulaw.
 * Each 16-bit sample → one mulaw byte.
 * @param {Buffer} pcmBuf - PCM16 little-endian
 * @returns {Buffer} mulaw buffer (half length)
 */
function pcm16ToMulaw(pcmBuf) {
  const mulaw = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    mulaw[i] = encodeMulawSample(sample);
  }
  return mulaw;
}

function encodeMulawSample(sample) {
  const BIAS = 0x84;
  const MAX = 0x7fff;
  const sign = (sample < 0) ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MAX) sample = MAX;
  sample += BIAS;

  let exponent = 7;
  const expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & expMask) break;
    sample <<= 1;
  }
  const mantissa = (sample >> 10) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// ── Gain normalization ───────────────────────────────────────────────────────

/**
 * SCRUM-375: boost quiet input audio toward a target level so Gemini's
 * native-audio STT can detect language + words reliably. A low-volume caller
 * was mis-detected as a different language and garbled; the upsampler did no
 * gain control, so quiet stayed quiet.
 *
 * Per-frame RMS-targeted gain: silence/near-silence (below the noise floor) is
 * left untouched (so we don't amplify line noise between words), and frames
 * already at/above target are left untouched (so normal-volume callers are
 * unaffected). Only genuinely quiet speech frames are boosted, with a clip
 * guard. Defaults are conservative starting points — tune against call
 * recordings.
 *
 * @param {Buffer} pcm - PCM16 little-endian
 * @param {{targetRms?: number, maxGain?: number, noiseFloor?: number}} [opts]
 * @returns {Buffer} PCM16 (same buffer when no boost is applied)
 */
function normalizeGainPcm16(pcm, { targetRms = 2000, maxGain = 6, noiseFloor = 150 } = {}) {
  const n = pcm.length >> 1;
  if (n === 0) return pcm;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / n);
  if (rms < noiseFloor) return pcm; // silence / background noise — don't amplify
  const gain = Math.min(maxGain, targetRms / rms);
  if (gain <= 1.05) return pcm; // already loud enough
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < n; i++) {
    let v = Math.round(pcm.readInt16LE(i * 2) * gain);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

// ── Resampling ───────────────────────────────────────────────────────────────

/**
 * Upsample PCM16 from 8kHz to 16kHz using linear interpolation.
 * @param {Buffer} pcm8k - PCM16 at 8kHz
 * @returns {Buffer} PCM16 at 16kHz (2x samples)
 */
function upsample8kTo16k(pcm8k) {
  const sampleCount = pcm8k.length / 2;
  const out = Buffer.alloc(sampleCount * 4); // 2x samples, 2 bytes each
  for (let i = 0; i < sampleCount; i++) {
    const s0 = pcm8k.readInt16LE(i * 2);
    const s1 = (i + 1 < sampleCount) ? pcm8k.readInt16LE((i + 1) * 2) : s0;
    const interp = Math.round((s0 + s1) / 2);
    out.writeInt16LE(s0, i * 4);
    out.writeInt16LE(interp, i * 4 + 2);
  }
  return out;
}

/**
 * Downsample PCM16 from 24kHz to 8kHz with averaging filter.
 * Averages 3 adjacent samples instead of naive decimation to reduce aliasing.
 * @param {Buffer} pcm24k - PCM16 at 24kHz
 * @returns {Buffer} PCM16 at 8kHz (1/3 samples)
 */
function downsample24kTo8k(pcm24k) {
  const sampleCount = pcm24k.length / 2;
  const outCount = Math.floor(sampleCount / 3);
  const out = Buffer.alloc(outCount * 2);
  for (let i = 0; i < outCount; i++) {
    const idx = i * 3;
    const s0 = pcm24k.readInt16LE(idx * 2);
    const s1 = (idx + 1 < sampleCount) ? pcm24k.readInt16LE((idx + 1) * 2) : s0;
    const s2 = (idx + 2 < sampleCount) ? pcm24k.readInt16LE((idx + 2) * 2) : s1;
    const avg = Math.round((s0 + s1 + s2) / 3);
    out.writeInt16LE(avg, i * 2);
  }
  return out;
}

// ── Full pipeline helpers ────────────────────────────────────────────────────

/**
 * Convert Twilio audio (base64 mulaw 8kHz) to Gemini format (base64 PCM16 16kHz).
 * @param {string} twilioBase64 - base64-encoded mulaw audio from Twilio
 * @returns {string} base64-encoded PCM16 16kHz audio for Gemini
 */
function twilioToGemini(twilioBase64) {
  const mulaw = Buffer.from(twilioBase64, "base64");
  const pcm8k = normalizeGainPcm16(mulawToPcm16(mulaw)); // SCRUM-375: boost quiet callers
  const pcm16k = upsample8kTo16k(pcm8k);
  return pcm16k.toString("base64");
}

/**
 * Convert Gemini audio (base64 PCM16 24kHz) to Twilio format (base64 mulaw 8kHz).
 * @param {string} geminiBase64 - base64-encoded PCM16 24kHz audio from Gemini
 * @returns {string} base64-encoded mulaw 8kHz audio for Twilio
 */
function geminiToTwilio(geminiBase64) {
  const pcm24k = Buffer.from(geminiBase64, "base64");
  const pcm8k = downsample24kTo8k(pcm24k);
  const mulaw = pcm16ToMulaw(pcm8k);
  return mulaw.toString("base64");
}

module.exports = {
  mulawToPcm16,
  pcm16ToMulaw,
  upsample8kTo16k,
  downsample24kTo8k,
  normalizeGainPcm16,
  twilioToGemini,
  geminiToTwilio,
};
