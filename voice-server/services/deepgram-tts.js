/**
 * Deepgram Aura TTS — outputs raw mulaw 8kHz directly.
 * container=none prevents WAV header artifacts.
 */

const DEFAULT_VOICE = "aura-asteria-en";

/**
 * @param {string} apiKey
 * @param {string} text
 * @param {{ voice?: string }} [options]
 * @returns {Promise<Buffer>} Raw mulaw audio bytes
 */
async function synthesizeSpeech(apiKey, text, options) {
  if (!text || !text.trim()) {
    throw new Error("synthesizeSpeech called with empty text");
  }

  const voice = options?.voice || DEFAULT_VOICE;

  const url =
    "https://api.deepgram.com/v1/speak?" +
    `model=${voice}` +
    "&encoding=mulaw" +
    "&sample_rate=8000" +
    "&container=none";

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
  return Buffer.from(arrayBuffer);
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
