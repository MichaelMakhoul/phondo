/**
 * AudioWorklet processor that captures PCM audio, downsamples to 8kHz,
 * and encodes to mulaw for transmission to the voice server.
 *
 * Browser test/demo calls ONLY (the production phone path is Twilio -> server and
 * never touches this file). A browser mic streams continuous room "air" between
 * words; the voice model's onset detector is tuned to be sensitive, so that idle
 * noise keeps interrupting the assistant / holding the turn open and the caller
 * hears dead air until they mute. To emulate "mute when not speaking" without
 * asking the user to do it, we gate the mic: real audio is sent only while the
 * caller is actually talking, and clean digital silence is sent otherwise. This
 * also lets the greeting play uninterrupted at the start of the call.
 */

const MULAW_BIAS = 33;
const MULAW_MAX = 0x1fff;
const TARGET_SAMPLE_RATE = 8000;
// Send a chunk every ~20ms (160 samples at 8kHz)
const CHUNK_SIZE = 160;

// ── Voice-activity gate tuning ──
// Open threshold is adaptive: max(absolute floor, learned noise floor * ratio),
// so the gate calibrates to each caller's room instead of a fixed level.
const GATE_ABS_MIN = 0.005; // never open on anything quieter than this RMS
const GATE_OPEN_RATIO = 3.0; // open when RMS exceeds this multiple of the noise floor
const GATE_HANGOVER_S = 0.35; // keep sending this long after speech drops (word tails / pauses)
const GATE_PREROLL_SAMPLES = 640; // ~80ms lookahead at 8kHz so speech onsets aren't clipped
const FLOOR_ADAPT = 0.05; // EMA rate for learning the noise floor (only while gate is closed)
const FLOOR_MAX = 0.05; // cap so a noisy room can't push the open threshold absurdly high

function linearToMulaw(sample) {
  // Clamp to 16-bit range
  sample = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// mulaw encoding of a zero (digital silence) sample.
const MULAW_SILENCE = linearToMulaw(0);

class MulawEncoderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._resampleIndex = 0;
    this._chunk = [];

    // Voice-activity gate state.
    this._noiseFloor = 0.003;
    this._holdUntil = 0; // gate stays open until this currentTime (seconds)
    // Pre-roll ring buffer of recent real mulaw samples, so when the gate opens
    // we emit the ~80ms leading up to it (the onset) instead of silence.
    this._preroll = new Uint8Array(GATE_PREROLL_SAMPLES);
    this._prerollPos = 0;
    this._prerollFilled = false;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const pcmData = input[0]; // Float32Array, mono

    // 1. Frame energy (RMS) → gate decision for this render quantum.
    let sumSq = 0;
    for (let i = 0; i < pcmData.length; i++) sumSq += pcmData[i] * pcmData[i];
    const rms = Math.sqrt(sumSq / pcmData.length);

    const openThresh = Math.max(GATE_ABS_MIN, this._noiseFloor * GATE_OPEN_RATIO);
    if (rms >= openThresh) {
      // Speech (or a loud transient): (re)open and refresh the hangover.
      this._holdUntil = currentTime + GATE_HANGOVER_S;
    }
    const gateOpen = currentTime < this._holdUntil;
    if (!gateOpen) {
      // Learn the noise floor only while idle, so speech can't inflate it.
      this._noiseFloor += (rms - this._noiseFloor) * FLOOR_ADAPT;
      if (this._noiseFloor > FLOOR_MAX) this._noiseFloor = FLOOR_MAX;
      if (this._noiseFloor < 0) this._noiseFloor = 0;
    }

    // 2. Downsample to 8kHz, run each sample through the pre-roll delay + gate.
    const ratio = sampleRate / TARGET_SAMPLE_RATE;
    for (let i = 0; i < pcmData.length; i++) {
      this._resampleIndex += 1;
      if (this._resampleIndex >= ratio) {
        this._resampleIndex -= ratio;

        const real = linearToMulaw(pcmData[i]);
        // Delay line: read the sample from ~80ms ago, then store the new one in
        // its slot. When the gate is open we emit the delayed (onset) audio;
        // otherwise we emit clean silence.
        const delayed = this._prerollFilled ? this._preroll[this._prerollPos] : MULAW_SILENCE;
        this._preroll[this._prerollPos] = real;
        this._prerollPos += 1;
        if (this._prerollPos >= GATE_PREROLL_SAMPLES) {
          this._prerollPos = 0;
          this._prerollFilled = true;
        }

        this._chunk.push(gateOpen ? delayed : MULAW_SILENCE);
        if (this._chunk.length >= CHUNK_SIZE) {
          this.port.postMessage(new Uint8Array(this._chunk));
          this._chunk = [];
        }
      }
    }

    return true;
  }
}

registerProcessor("mulaw-encoder-processor", MulawEncoderProcessor);
