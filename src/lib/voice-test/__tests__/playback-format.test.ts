import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { StreamingUpsampler } from "../mulaw";
import {
  WIDEBAND_SAMPLE_RATE,
  createPcm16PlaybackDecoder,
  createPlaybackDecoder,
  parsePlaybackFormat,
  playbackQuery,
} from "../playback-format";
import { clampVolume, volumeGain } from "../volume";

// The server's side of the contract, loaded as the voice server runs it.
const require = createRequire(import.meta.url);
const { BROWSER_WIDEBAND, audioFormatMessage } = require(path.resolve(process.cwd(), "voice-server/lib/browser-audio.js"));

// SCRUM-619: the owner's bubble plays wideband 16-bit PCM once the server announces it
// ("audio_format"), and only a page that asked for it on the socket URL is told.

/** Little-endian 16-bit PCM bytes for these samples. */
function pcmBytes(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return bytes;
}

const SAMPLES = Array.from({ length: 600 }, (_, i) => Math.round(12000 * Math.sin(i / 7)));

describe("playbackQuery", () => {
  it("asks for wideband when the context plays it without downsampling", () => {
    expect(WIDEBAND_SAMPLE_RATE).toBe(24000);
    expect(playbackQuery(48000)).toBe("&playback=linear16");
    expect(playbackQuery(44100)).toBe("&playback=linear16");
    expect(playbackQuery(24000)).toBe("&playback=linear16");
  });

  it("asks for nothing on a slower context: the phone's μ-law, as before", () => {
    expect(playbackQuery(22050)).toBe("");
    expect(playbackQuery(16000)).toBe("");
  });
});

describe("parsePlaybackFormat", () => {
  it("reads the server's two formats", () => {
    expect(parsePlaybackFormat({ type: "audio_format", encoding: "linear16", sampleRate: 24000 })).toEqual({
      encoding: "linear16",
      sampleRate: 24000,
    });
    expect(parsePlaybackFormat({ type: "audio_format", encoding: "mulaw" })).toEqual({ encoding: "mulaw" });
  });

  it.each([
    null,
    "linear16",
    {},
    { encoding: "opus", sampleRate: 48000 },
    { encoding: "linear16" },
    { encoding: "linear16", sampleRate: "24000" },
    { encoding: "linear16", sampleRate: 24000.5 },
    { encoding: "linear16", sampleRate: 4000 },
    { encoding: "linear16", sampleRate: 96000 },
  ])("refuses what it can't play: %j", (msg) => {
    expect(parsePlaybackFormat(msg)).toBeNull();
  });
});

describe("createPcm16PlaybackDecoder", () => {
  it("decodes little-endian samples (negatives too) and upsamples them as one stream", () => {
    const decoder = createPcm16PlaybackDecoder(24000, 48000);
    const reference = new StreamingUpsampler(24000, 48000);
    const expected = reference.process(Float32Array.from(SAMPLES, (s) => s / 32768));
    const out = decoder.decode(pcmBytes(SAMPLES));
    expect(out.length).toBe(expected.length);
    expect(Array.from(out)).toEqual(Array.from(expected));
    expect(out.length).toBeGreaterThan(SAMPLES.length); // twice the rate, less the look-ahead
  });

  it("the same output however the network split the bytes — a sample split across chunks included", () => {
    const whole = createPcm16PlaybackDecoder(24000, 48000).decode(pcmBytes(SAMPLES));
    const bytes = pcmBytes(SAMPLES);
    const split = createPcm16PlaybackDecoder(24000, 48000);
    const parts: number[] = [];
    let at = 0;
    for (const size of [1, 2, 3, 7, 100, 333, 1]) {
      parts.push(...split.decode(bytes.subarray(at, at + size)));
      at += size;
    }
    parts.push(...split.decode(bytes.subarray(at)));
    expect(parts.length).toBe(whole.length);
    parts.forEach((value, i) => expect(value).toBeCloseTo(whole[i], 6));
  });

  it("reset drops a half sample and the look-ahead: the next chunk starts a new stream", () => {
    const decoder = createPcm16PlaybackDecoder(24000, 48000);
    decoder.decode(pcmBytes(SAMPLES).subarray(0, 101)); // ends on half a sample
    decoder.reset();
    const fresh = createPcm16PlaybackDecoder(24000, 48000).decode(pcmBytes(SAMPLES));
    expect(Array.from(decoder.decode(pcmBytes(SAMPLES)))).toEqual(Array.from(fresh));
  });

  it("the extremes decode to full scale: 0x8000 is -1, 0x7fff just under +1 (a steady run, past the filter's start)", () => {
    const low = createPcm16PlaybackDecoder(24000, 24000).decode(pcmBytes(Array(400).fill(-32768)));
    const high = createPcm16PlaybackDecoder(24000, 24000).decode(pcmBytes(Array(400).fill(32767)));
    expect(low[300]).toBeCloseTo(-1, 5);
    expect(high[300]).toBeCloseTo(32767 / 32768, 5);
  });
});

describe("createPlaybackDecoder", () => {
  it("wideband PCM for linear16, the phone's μ-law otherwise", () => {
    const pcm = createPlaybackDecoder({ encoding: "linear16", sampleRate: 24000 }, 48000).decode(pcmBytes(SAMPLES));
    const asMulaw = createPlaybackDecoder({ encoding: "mulaw" }, 48000).decode(pcmBytes(SAMPLES));
    // 1200 bytes: 600 PCM samples at 24 kHz vs 1200 μ-law samples at 8 kHz — different lengths at 48 kHz.
    expect(pcm.length).toBeLessThan(asMulaw.length);
    expect(Array.from(pcm)).toEqual(Array.from(createPcm16PlaybackDecoder(24000, 48000).decode(pcmBytes(SAMPLES))));
  });
});

describe("the server's announcement and the page's ask (one contract)", () => {
  it("the page plays exactly what the server announces, and asks for it by the server's name", () => {
    expect(parsePlaybackFormat(JSON.parse(audioFormatMessage(BROWSER_WIDEBAND)))).toEqual({
      encoding: BROWSER_WIDEBAND.encoding,
      sampleRate: BROWSER_WIDEBAND.sampleRate,
    });
    expect(WIDEBAND_SAMPLE_RATE).toBe(BROWSER_WIDEBAND.sampleRate);
    expect(playbackQuery(48000)).toBe(`&playback=${BROWSER_WIDEBAND.encoding}`);
  });
});

describe("volumeGain", () => {
  it.each([
    [1, 1],
    [0.5, 0.25],
    [0, 0],
    [2, 1],
    [-1, 0],
  ])("slider %d plays at gain %d (its square: equal steps sound equal)", (volume, gain) => {
    expect(volumeGain(volume)).toBe(gain);
  });
});

describe("clampVolume", () => {
  it.each([
    [0.5, 0.5],
    [0, 0],
    [1, 1],
    [1.5, 1],
    [-0.2, 0],
  ])("keeps %d as %d", (value, expected) => {
    expect(clampVolume(value)).toBe(expected);
  });

  it.each([Number.NaN, Infinity, "0.5", null, undefined])("is full volume for %j", (value) => {
    expect(clampVolume(value)).toBe(1);
  });
});
