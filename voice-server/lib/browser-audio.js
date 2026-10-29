// SCRUM-619: a browser session (the owner's bubble, and dashboard test calls on the
// classic pipeline) is not a phone line. It was sent the phone's audio — 8 kHz mulaw,
// boosted +6 dB with a soft limiter for Twilio (lib/aura-gain.js) — which sounded muffled
// on a laptop and loud and squashed on a phone. Browser sessions get Aura at 24 kHz
// 16-bit PCM at its own level instead, announced to the page first ("audio_format"),
// which then decodes it (src/lib/voice-test/playback-format.ts). Gemini sessions are
// unchanged: their audio is mulaw and nothing is announced.

/** @typedef {{ encoding: "linear16", sampleRate: number, bytesPerMs: number }} BrowserAudioFormat */

/** Wideband: 24 kHz, 16-bit little-endian PCM — 48 bytes a millisecond. @type {Readonly<BrowserAudioFormat>} */
const BROWSER_WIDEBAND = Object.freeze({ encoding: /** @type {"linear16"} */ ("linear16"), sampleRate: 24000, bytesPerMs: 48 });
/** The phone's format, what the page plays when nothing is announced: 8 bytes a millisecond. */
const PHONE_BYTES_PER_MS = 8;

/**
 * The page's audio format message, sent before any audio of the session.
 * @param {Readonly<BrowserAudioFormat>} format
 * @returns {string}
 */
function audioFormatMessage(format) {
  return JSON.stringify({ type: "audio_format", encoding: format.encoding, sampleRate: format.sampleRate });
}

/**
 * synthesizeSpeech's options for a browser session: its voice, its Deepgram host when it
 * has one, and — once wideband was announced — the wideband format with no phone boost.
 * @param {{ deepgramVoice?: string | null, ttsHost?: string | null, browserAudio?: Readonly<BrowserAudioFormat> | null } | null} session
 * @returns {{ voice?: string, host?: string, encoding?: "mulaw" | "linear16", sampleRate?: number, boost?: boolean }}
 */
function browserTtsOptions(session) {
  /** @type {{ voice?: string, host?: string }} */
  const options = { voice: session?.deepgramVoice || undefined };
  if (session?.ttsHost) options.host = session.ttsHost;
  const format = session?.browserAudio;
  return format ? { ...options, encoding: format.encoding, sampleRate: format.sampleRate, boost: false } : options;
}

/**
 * How many milliseconds `bytes` of this session's audio play for.
 * @param {{ browserAudio?: { bytesPerMs: number } | null } | null} session
 * @param {number} bytes
 * @returns {number}
 */
function browserAudioMs(session, bytes) {
  return Math.round(bytes / (session?.browserAudio?.bytesPerMs || PHONE_BYTES_PER_MS));
}

module.exports = { BROWSER_WIDEBAND, PHONE_BYTES_PER_MS, audioFormatMessage, browserTtsOptions, browserAudioMs };
