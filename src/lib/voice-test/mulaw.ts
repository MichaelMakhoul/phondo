/**
 * Browser playback of the voice server's telephone audio (demo + dashboard
 * test calls): G.711 μ-law decoding, then a streaming upsampler from 8 kHz to
 * the AudioContext rate.
 *
 * Phone callers hear the same audio through Twilio's standard G.711 decoder,
 * so this has to match it exactly, or the browser demo sounds worse than a
 * real call.
 */

const MULAW_SAMPLE_RATE = 8000;

/** Standard G.711 μ-law → linear, with the encoder's 0x84 bias removed again. */
const MULAW_TO_FLOAT = (() => {
  const table = new Float32Array(256);
  for (let code = 0; code < 256; code++) {
    const mu = ~code & 0xff;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
    table[code] = (mu & 0x80 ? -magnitude : magnitude) / 32768;
  }
  return table;
})();

/**
 * Decode a Uint8Array of mulaw bytes to Float32 PCM samples.
 */
export function decodeMulaw(mulawData: Uint8Array): Float32Array {
  const pcm = new Float32Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) {
    pcm[i] = MULAW_TO_FLOAT[mulawData[i]];
  }
  return pcm;
}

/** Filter taps on each side of an interpolation point: 3 ms of look-ahead at 8 kHz. */
const HALF_TAPS = 24;
const TAPS = HALF_TAPS * 2;
/** Low-pass cutoff in cycles per input sample (3.6 kHz for 8 kHz audio). */
const CUTOFF = 0.45;
/** More distinct sub-sample phases than this (odd device rates only) get quantised. */
const MAX_PHASE_ROWS = 4096;

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** Blackman-windowed sinc; `d` is the distance from the interpolation point in input samples. */
function kernel(d: number): number {
  const x = 2 * CUTOFF * d;
  const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  const window =
    0.42 + 0.5 * Math.cos((Math.PI * d) / HALF_TAPS) + 0.08 * Math.cos((2 * Math.PI * d) / HALF_TAPS);
  return sinc * window;
}

/**
 * Upsamples a continuous stream that arrives in arbitrary chunks.
 *
 * Filter state carries across chunks, so the output is identical however the
 * network split the audio. Upsampling each chunk on its own leaves a seam at
 * every boundary. A windowed-sinc low-pass also removes the spectral images
 * above 4 kHz that linear interpolation leaves behind, which give the voice a
 * metallic edge.
 */
export class StreamingUpsampler {
  private readonly rows: number;
  private readonly exactPhases: boolean;
  private readonly phaseUnit: number;
  /** `rows` × TAPS coefficients; each row sums to 1 (unity gain at DC). */
  private readonly coeffs: Float32Array;
  private input = new Float32Array(0);
  /** Absolute index of input[0]; samples before index 0 count as silence. */
  private inputStart = 0;
  private received = 0;
  private emitted = 0;

  constructor(
    private readonly inRate: number,
    private readonly outRate: number
  ) {
    this.phaseUnit = gcd(inRate, outRate);
    const exactRows = outRate / this.phaseUnit;
    this.exactPhases = exactRows <= MAX_PHASE_ROWS;
    this.rows = this.exactPhases ? exactRows : MAX_PHASE_ROWS;
    this.coeffs = new Float32Array(this.rows * TAPS);
    for (let row = 0; row < this.rows; row++) {
      const frac = row / this.rows;
      let sum = 0;
      for (let t = 0; t < TAPS; t++) {
        const c = kernel(frac - (t - HALF_TAPS + 1));
        this.coeffs[row * TAPS + t] = c;
        sum += c;
      }
      for (let t = 0; t < TAPS; t++) this.coeffs[row * TAPS + t] /= sum;
    }
  }

  /** Feed the next chunk; returns the output now available (empty while the look-ahead fills). */
  process(chunk: Float32Array): Float32Array {
    if (chunk.length > 0) {
      const merged = new Float32Array(this.input.length + chunk.length);
      merged.set(this.input);
      merged.set(chunk, this.input.length);
      this.input = merged;
      this.received += chunk.length;
    }

    const capacity = Math.ceil(((this.input.length + 2) * this.outRate) / this.inRate) + 2;
    const out = new Float32Array(capacity);
    let count = 0;
    for (;;) {
      // Position of the next output sample on the input timeline, kept in
      // integers so every chunking of the stream lands on identical phases.
      const position = this.emitted * this.inRate;
      let base = Math.floor(position / this.outRate);
      const remainder = position - base * this.outRate;
      let row: number;
      if (this.exactPhases) {
        row = remainder / this.phaseUnit;
      } else {
        row = Math.round((remainder / this.outRate) * this.rows);
        if (row === this.rows) {
          row = 0;
          base += 1;
        }
      }
      if (base + HALF_TAPS > this.received - 1 || count === capacity) break;

      const first = base - HALF_TAPS + 1;
      const offset = row * TAPS;
      let acc = 0;
      for (let t = 0; t < TAPS; t++) {
        const k = first + t;
        if (k >= 0) acc += this.coeffs[offset + t] * this.input[k - this.inputStart];
      }
      out[count++] = acc;
      this.emitted++;
    }

    // Keep only the input the next output sample can still reach.
    const nextBase = Math.floor((this.emitted * this.inRate) / this.outRate);
    const keepFrom = Math.max(this.inputStart, nextBase - HALF_TAPS + 1);
    if (keepFrom > this.inputStart) {
      this.input = this.input.slice(keepFrom - this.inputStart);
      this.inputStart = keepFrom;
    }
    return out.slice(0, count);
  }

  /** Forget everything buffered: the next chunk starts a new stream. */
  reset(): void {
    this.input = new Float32Array(0);
    this.inputStart = 0;
    this.received = 0;
    this.emitted = 0;
  }
}

export interface MulawPlaybackDecoder {
  /** Decode the next network chunk into audio at the AudioContext rate (may be empty). */
  decode(mulawData: Uint8Array): Float32Array;
  /** Drop buffered audio (barge-in, end of call). */
  reset(): void;
}

/** One decoder per call: it carries filter state from chunk to chunk. */
export function createMulawPlaybackDecoder(outRate: number): MulawPlaybackDecoder {
  const upsampler = new StreamingUpsampler(MULAW_SAMPLE_RATE, outRate);
  return {
    decode: (mulawData) => upsampler.process(decodeMulaw(mulawData)),
    reset: () => upsampler.reset(),
  };
}
