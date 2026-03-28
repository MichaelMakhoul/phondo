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
 * Downsample PCM16 from 24kHz to 8kHz (take every 3rd sample).
 * @param {Buffer} pcm24k - PCM16 at 24kHz
 * @returns {Buffer} PCM16 at 8kHz (1/3 samples)
 */
function downsample24kTo8k(pcm24k) {
  const sampleCount = pcm24k.length / 2;
  const outCount = Math.floor(sampleCount / 3);
  const out = Buffer.alloc(outCount * 2);
  for (let i = 0; i < outCount; i++) {
    const sample = pcm24k.readInt16LE(i * 3 * 2);
    out.writeInt16LE(sample, i * 2);
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
  const pcm8k = mulawToPcm16(mulaw);
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
  twilioToGemini,
  geminiToTwilio,
};
