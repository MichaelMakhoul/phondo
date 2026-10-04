import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { decodeMulaw, StreamingUpsampler, createMulawPlaybackDecoder } from "../mulaw";

// ──────────────────────────────────────────────────────────────────────────
// Browser playback of the assistant's voice (demo + dashboard test calls).
//
// The phone path is decoded by Twilio's own (standard) G.711; this file is the
// browser's equivalent. It used to subtract the wrong μ-law bias (33 instead of
// 0x84), so every sample came out ±99 too far from zero: silence toggled
// between +99 and -99 and every zero crossing jumped 198 steps — the faint
// "electric" crackle callers heard in the browser but never on the phone. It
// then upsampled each network chunk on its own with linear interpolation,
// which leaves strong spectral images above 4 kHz (a metallic, robotic edge)
// and a seam at every chunk boundary.
//
// The decoder is tested against the voice server's REAL encoder: the contract
// is "play exactly what the server encoded", so a local copy of the encoder
// would only prove the two copies agree with each other.
// ──────────────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const { pcm16ToMulaw } = require(
  path.resolve(process.cwd(), "voice-server/lib/audio-converter.js")
) as { pcm16ToMulaw: (pcm: Buffer) => Buffer };

function encodeWithServer(samples: number[]): Uint8Array {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => pcm.writeInt16LE(s, i * 2));
  return new Uint8Array(pcm16ToMulaw(pcm));
}

function sine(freq: number, rate: number, n: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** A voice-ish test signal: harmonics of a gliding pitch under a syllable envelope. */
function speechLike(rate: number, n: number): Float32Array {
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f0 = 140 + 40 * Math.sin(2 * Math.PI * 1.3 * t);
    phase += (2 * Math.PI * f0) / rate;
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 3 * t));
    let s = 0;
    for (let h = 1; h * 140 < 3400; h++) s += Math.sin(h * phase) / h;
    out[i] = 0.3 * envelope * s;
  }
  return out;
}

/** Power of one frequency in `x` (Goertzel), normalised by length. */
function tonePower(x: Float32Array, freq: number, rate: number): number {
  const w = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (x.length * x.length);
}

function rms(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / x.length);
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Feed `input` to `up` in irregular slices, the way network frames arrive. */
function processInChunks(up: StreamingUpsampler, input: Float32Array, sizes: number[]): Float32Array {
  const parts: Float32Array[] = [];
  let i = 0;
  let k = 0;
  while (i < input.length) {
    const size = sizes[k++ % sizes.length];
    parts.push(up.process(input.subarray(i, i + size)));
    i += size;
  }
  return concat(parts);
}

const CHUNK_SIZES = [160, 7, 333, 1, 480, 59, 160, 1024, 3];

describe("decodeMulaw: G.711 μ-law, matching the voice server's encoder", () => {
  it("decodes digital silence to exactly zero", () => {
    // μ-law has a +0 and a -0 code; both must come back as silence.
    const decoded = Array.from(decodeMulaw(encodeWithServer([0, 0, 1, -1])));
    expect(decoded.every((s) => s === 0)).toBe(true);
  });

  it("keeps small samples small, so zero crossings don't step by ±99", () => {
    const decoded = Array.from(decodeMulaw(encodeWithServer([5, -5, 50, -50]))).map((s) => s * 32768);
    expect(decoded).toEqual([8, -8, 48, -48]);
  });

  it("round-trips every in-range level within μ-law's own quantisation error", () => {
    // G.711 reconstructs at the middle of each step, so the error is at most
    // half a step: (|x| + 132) / 32 in the 16-bit domain.
    let worstExcess = -Infinity;
    for (let x = -32635; x <= 32635; x += 13) {
      const decoded = decodeMulaw(encodeWithServer([x]))[0] * 32768;
      const halfStep = (Math.abs(x) + 132) / 32 + 1;
      worstExcess = Math.max(worstExcess, Math.abs(decoded - x) - halfStep);
    }
    expect(worstExcess).toBeLessThanOrEqual(0);
  });
});

describe("StreamingUpsampler: 8 kHz telephone audio to the AudioContext rate", () => {
  for (const outRate of [48000, 44100]) {
    describe(`at ${outRate} Hz`, () => {
      it("produces identical audio however the network chunked it", () => {
        const input = speechLike(8000, 4000);
        const whole = new StreamingUpsampler(8000, outRate).process(input);
        const chunked = processInChunks(new StreamingUpsampler(8000, outRate), input, CHUNK_SIZES);
        expect(chunked.length).toBe(whole.length);
        let maxDiff = 0;
        for (let i = 0; i < whole.length; i++) maxDiff = Math.max(maxDiff, Math.abs(chunked[i] - whole[i]));
        expect(maxDiff).toBe(0);
      });

      it("keeps voice-band tones at their original level", () => {
        for (const freq of [300, 1000, 2500]) {
          const out = new StreamingUpsampler(8000, outRate).process(sine(freq, 8000, 8000));
          const steady = out.subarray(outRate / 10, out.length - outRate / 10);
          const gainDb = 20 * Math.log10(rms(steady) / (0.5 / Math.SQRT2));
          expect(Math.abs(gainDb)).toBeLessThan(0.5);
        }
      });

      it("suppresses the spectral images that make linear interpolation sound metallic", () => {
        // A tone at f in 8 kHz audio images to 8000 - f and 8000 + f when upsampled.
        for (const freq of [1000, 2000, 3000]) {
          const out = new StreamingUpsampler(8000, outRate).process(sine(freq, 8000, 8000));
          const steady = out.subarray(outRate / 10, out.length - outRate / 10);
          const tone = tonePower(steady, freq, outRate);
          for (const image of [8000 - freq, 8000 + freq]) {
            const rejectionDb = 10 * Math.log10(tonePower(steady, image, outRate) / tone);
            expect(rejectionDb).toBeLessThan(-60);
          }
        }
      });
    });
  }

  it("holds back only a few milliseconds of look-ahead", () => {
    const up = new StreamingUpsampler(8000, 48000);
    const out = up.process(new Float32Array(800));
    // 100 ms in → at least 95 ms out (the filter needs a short look-ahead).
    expect(out.length).toBeGreaterThanOrEqual(0.095 * 48000);
    expect(out.length).toBeLessThanOrEqual(0.1 * 48000);
  });

  it("returns an empty block (not an error) while it is still filling its look-ahead", () => {
    const up = new StreamingUpsampler(8000, 48000);
    expect(up.process(new Float32Array(3)).length).toBe(0);
  });

  it("reset() forgets pre-barge-in audio entirely", () => {
    const after = speechLike(8000, 1200).subarray(400);
    const up = new StreamingUpsampler(8000, 48000);
    up.process(speechLike(8000, 1200));
    up.reset();
    const resumed = up.process(after);
    const fresh = new StreamingUpsampler(8000, 48000).process(after);
    expect(Array.from(resumed)).toEqual(Array.from(fresh));
  });
});

describe("createMulawPlaybackDecoder", () => {
  it("decodes and upsamples server μ-law into continuous audio at the context rate", () => {
    const pcm = Array.from(sine(1000, 8000, 8000, 0.3), (s) => Math.round(s * 32768));
    const mulaw = encodeWithServer(pcm);
    const decoder = createMulawPlaybackDecoder(48000);
    const out = concat([decoder.decode(mulaw.subarray(0, 3000)), decoder.decode(mulaw.subarray(3000))]);
    const steady = out.subarray(4800, out.length - 4800);
    const gainDb = 20 * Math.log10(rms(steady) / (0.3 / Math.SQRT2));
    expect(Math.abs(gainDb)).toBeLessThan(0.5);
  });
});
