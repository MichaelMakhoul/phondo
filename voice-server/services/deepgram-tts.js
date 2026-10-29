/**
 * Deepgram Aura TTS — outputs raw mulaw 8kHz directly.
 * container=none prevents WAV header artifacts.
 */

const { boostAura } = require("../lib/aura-gain");

const DEFAULT_VOICE = "aura-2-asteria-en";
const DEFAULT_HOST = "api.deepgram.com";

/**
 * @param {string} apiKey
 * @param {string} text
 * @param {{ voice?: string, host?: string, encoding?: "mulaw" | "linear16", sampleRate?: number, boost?: boolean }} [options] -
 *   host: the Deepgram API host, default api.deepgram.com (SCRUM-594: the fast path passes the AU host);
 *   encoding/sampleRate: mulaw 8 kHz by default (the phone's), linear16 for a browser (SCRUM-619);
 *   boost: the phone's line-level gain (AURA_GAIN_DB), mulaw only, on by default
 * @returns {Promise<Buffer>} Raw audio bytes — mulaw at line level by default
 */
async function synthesizeSpeech(apiKey, text, options) {
  if (!text || !text.trim()) {
    throw new Error("synthesizeSpeech called with empty text");
  }

  const voice = options?.voice || DEFAULT_VOICE;
  const host = options?.host || DEFAULT_HOST;
  const encoding = options?.encoding === "linear16" ? "linear16" : "mulaw";
  // PCM at a wrong rate would play too fast or too slow: never guess one.
  if (encoding === "linear16" && !Number.isInteger(options?.sampleRate)) {
    throw new Error("synthesizeSpeech: linear16 needs a whole-number sampleRate");
  }
  const sampleRate = encoding === "linear16" ? Number(options?.sampleRate) : 8000;

  const url =
    `https://${host}/v1/speak?` +
    `model=${voice}` +
    `&encoding=${encoding}` +
    `&sample_rate=${sampleRate}` +
    "&container=none" +
    "&mip_opt_out=true"; // SCRUM-595: no training on what the AI says to callers

  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 500);
    throw new Error(`Deepgram TTS error ${res.status}: ${errText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  // SCRUM-594 (phone test F7): Aura comes out quieter than line level (lib/aura-gain.js);
  // phone test F9: by how much depends on the voice. SCRUM-619: that's the phone's — a
  // browser plays Aura at its own level (the gain table is mulaw's anyway).
  if (encoding !== "mulaw" || options?.boost === false) return Buffer.from(arrayBuffer);
  return boostAura(Buffer.from(arrayBuffer), voice);
}

/**
 * Chunks raw mulaw audio into 160-byte segments (20ms at 8kHz)
 * and base64-encodes each for Twilio Media Streams.
 *
 * @param {Buffer} buffer
 * @returns {string[]} Array of base64-encoded chunks
 */
function chunkAudioForTwilio(buffer) {
  const CHUNK_SIZE = 160;
  const chunks = [];
  for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
    const chunk = buffer.subarray(i, i + CHUNK_SIZE);
    chunks.push(chunk.toString("base64"));
  }
  return chunks;
}

module.exports = { synthesizeSpeech, chunkAudioForTwilio };
