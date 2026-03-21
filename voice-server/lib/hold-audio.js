/**
 * Hold Audio Generator — Ambient Noise
 *
 * Generates continuous ambient background noise (mulaw 8kHz) to play
 * while the AI is "thinking". Uses brown/pink noise instead of sine
 * wave tones — sounds like a live phone line rather than beeping.
 *
 * Industry defaults map to different ambient profiles:
 * - medical/dental/spa → soft brown noise with gentle warmth (calming)
 * - legal/finance → clean brown noise, no warmth (professional)
 * - restaurant/hospitality → pink noise with mid-range warmth (warm)
 * - trades/other → clean brown noise (neutral)
 */

const SAMPLE_RATE = 8000;

// mulaw encoding (PCM 16-bit → mulaw byte)
function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;

  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Ambient noise presets.
 * - noiseType: "brown" (soft hiss) or "pink" (gentle wind)
 * - volume: overall noise amplitude (0.02-0.03 range — very subtle)
 * - warmthHz: low-frequency sine wave added for warmth (0 = none)
 * - warmthVol: amplitude of warmth tone
 */
const PRESETS = {
  calm:         { noiseType: "brown", volume: 0.04, warmthHz: 70,  warmthVol: 0.012 },
  professional: { noiseType: "brown", volume: 0.035, warmthHz: 0,   warmthVol: 0 },
  warm:         { noiseType: "pink",  volume: 0.04, warmthHz: 100, warmthVol: 0.015 },
  neutral:      { noiseType: "brown", volume: 0.035, warmthHz: 0,   warmthVol: 0 },
  silent:       null,
};

/** Map industry to preset */
const INDUSTRY_DEFAULTS = {
  dental: "calm",
  medical: "calm",
  healthcare: "calm",
  spa: "calm",
  wellness: "calm",
  legal: "professional",
  finance: "professional",
  accounting: "professional",
  consulting: "professional",
  restaurant: "warm",
  hospitality: "warm",
  "food-beverage": "warm",
  "real-estate": "professional",
  real_estate: "professional",
  trades: "neutral",
  home_services: "neutral",
  "home-services": "neutral",
  plumbing: "neutral",
  electrical: "neutral",
  automotive: "neutral",
  veterinary: "calm",
  salon: "warm",
  fitness: "neutral",
  other: "neutral",
};

/**
 * Generate brown noise samples.
 * Brown noise: integrate white noise — each sample is prev + small random delta.
 * Sounds like a soft, deep hiss / distant waterfall.
 */
function generateBrownNoise(count, volume) {
  const samples = new Float64Array(count);
  let last = 0;

  for (let i = 0; i < count; i++) {
    const white = (Math.random() * 2 - 1) * 0.02;
    last = (last + white) * 0.998; // slight decay to prevent drift
    // Clamp
    if (last > 1) last = 1;
    if (last < -1) last = -1;
    samples[i] = last * volume;
  }

  return samples;
}

/**
 * Generate pink noise samples using Voss-McCartney algorithm.
 * Pink noise: 1/f spectrum — sounds like gentle wind or ocean.
 */
function generatePinkNoise(count, volume) {
  const samples = new Float64Array(count);
  const NUM_ROWS = 12;
  const rows = new Float64Array(NUM_ROWS);
  let runningSum = 0;

  // Initialize rows
  for (let i = 0; i < NUM_ROWS; i++) {
    rows[i] = (Math.random() * 2 - 1);
    runningSum += rows[i];
  }

  for (let i = 0; i < count; i++) {
    // Determine which row to update (based on trailing zeros of counter)
    let n = i;
    let k = 0;
    while (k < NUM_ROWS && (n & 1) === 0) {
      n >>= 1;
      k++;
    }
    if (k < NUM_ROWS) {
      runningSum -= rows[k];
      rows[k] = (Math.random() * 2 - 1);
      runningSum += rows[k];
    }

    // Normalize and scale
    const value = runningSum / NUM_ROWS;
    samples[i] = value * volume;
  }

  return samples;
}

/**
 * Generate a hold audio buffer (mulaw 8kHz).
 *
 * @param {number} durationMs - How long the buffer should be
 * @param {string} [preset="neutral"] - Preset name or industry name
 * @returns {Buffer|null} mulaw audio buffer, or null if preset is "silent"
 */
function generateHoldAudio(durationMs, preset = "neutral") {
  const resolvedPreset = PRESETS[preset] !== undefined ? preset : (INDUSTRY_DEFAULTS[preset] || "neutral");
  const config = PRESETS[resolvedPreset];
  if (!config) return null;

  const totalSamples = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const buf = Buffer.alloc(totalSamples);

  // Generate noise base
  const noise = config.noiseType === "pink"
    ? generatePinkNoise(totalSamples, config.volume)
    : generateBrownNoise(totalSamples, config.volume);

  // Apply fade-in over first 50ms to avoid click
  const fadeInSamples = Math.floor(0.05 * SAMPLE_RATE);

  for (let i = 0; i < totalSamples; i++) {
    let sample = noise[i];

    // Add warmth tone (very subtle low-frequency sine)
    if (config.warmthHz > 0 && config.warmthVol > 0) {
      sample += config.warmthVol * Math.sin(2 * Math.PI * config.warmthHz * i / SAMPLE_RATE);
    }

    // Fade in
    if (i < fadeInSamples) {
      sample *= i / fadeInSamples;
    }

    // Convert to 16-bit PCM range and encode to mulaw
    const pcm = Math.max(-32767, Math.min(32767, Math.floor(sample * 32767)));
    buf[i] = linearToMulaw(pcm);
  }

  return buf;
}

/**
 * Get the hold audio preset for an industry.
 * @param {string} industry
 * @returns {string}
 */
function getHoldPreset(industry) {
  return INDUSTRY_DEFAULTS[industry] || "neutral";
}

module.exports = { generateHoldAudio, getHoldPreset, PRESETS, INDUSTRY_DEFAULTS };
