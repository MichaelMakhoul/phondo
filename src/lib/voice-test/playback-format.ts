/**
 * SCRUM-619: the formats the voice server's audio comes in. The phone's 8 kHz μ-law
 * is the default (the demo, test calls, Gemini). The owner's bubble on the classic
 * pipeline is wideband 16-bit PCM, which the server announces ("audio_format")
 * before any audio — and only to a page that asked for it on the socket URL
 * (playbackQuery), so a page from before this never plays PCM as μ-law.
 */
import { createMulawPlaybackDecoder, StreamingUpsampler } from "./mulaw";

/** The server's wideband rate (voice-server/lib/browser-audio.js). */
export const WIDEBAND_SAMPLE_RATE = 24000;

export type PlaybackFormat = { encoding: "mulaw" } | { encoding: "linear16"; sampleRate: number };

export interface PlaybackDecoder {
  /** Decode the next network chunk into audio at the AudioContext rate (may be empty). */
  decode(data: Uint8Array): Float32Array;
  /** Drop buffered audio (barge-in, end of call). */
  reset(): void;
}

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 48000;

/**
 * The socket URL's ask for wideband audio, when this AudioContext plays it without
 * downsampling (the upsampler's filter is cut for upsampling); otherwise nothing.
 */
export function playbackQuery(contextSampleRate: number): string {
  return contextSampleRate >= WIDEBAND_SAMPLE_RATE ? "&playback=linear16" : "";
}

/** The format an "audio_format" message announces, or null when it isn't one this page plays. */
export function parsePlaybackFormat(msg: unknown): PlaybackFormat | null {
  if (!msg || typeof msg !== "object") return null;
  const { encoding, sampleRate } = msg as { encoding?: unknown; sampleRate?: unknown };
  if (encoding === "mulaw") return { encoding: "mulaw" };
  if (
    encoding === "linear16" &&
    typeof sampleRate === "number" &&
    Number.isInteger(sampleRate) &&
    sampleRate >= MIN_SAMPLE_RATE &&
    sampleRate <= MAX_SAMPLE_RATE
  ) {
    return { encoding: "linear16", sampleRate };
  }
  return null;
}

/**
 * Little-endian 16-bit PCM, upsampled to the AudioContext rate. An odd byte at the
 * end of a chunk waits for the next one, so a sample split across two chunks
 * still decodes as one.
 */
export function createPcm16PlaybackDecoder(inRate: number, outRate: number): PlaybackDecoder {
  const upsampler = new StreamingUpsampler(inRate, outRate);
  let carry: number | null = null;
  return {
    decode(data) {
      let bytes = data;
      if (carry !== null) {
        bytes = new Uint8Array(data.length + 1);
        bytes[0] = carry;
        bytes.set(data, 1);
        carry = null;
      }
      const samples = bytes.length >> 1;
      if (bytes.length % 2 === 1) carry = bytes[bytes.length - 1];
      const pcm = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        const value = bytes[2 * i] | (bytes[2 * i + 1] << 8);
        pcm[i] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
      }
      return upsampler.process(pcm);
    },
    reset() {
      carry = null;
      upsampler.reset();
    },
  };
}

/** One decoder per format change: it carries filter state from chunk to chunk. */
export function createPlaybackDecoder(format: PlaybackFormat, outRate: number): PlaybackDecoder {
  return format.encoding === "linear16"
    ? createPcm16PlaybackDecoder(format.sampleRate, outRate)
    : createMulawPlaybackDecoder(outRate);
}
