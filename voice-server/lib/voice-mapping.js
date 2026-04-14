/**
 * Maps voice IDs to their backing Gemini Live and Deepgram Aura voice models.
 *
 * Design: the user-facing catalog exposes 8 distinct voices, each mapped to
 * a different Gemini Live voice (the primary audio pipeline). The Deepgram
 * voices are used by the classic fallback pipeline only. Voices removed from
 * the catalog (British, Spanish, duplicate US) are aliased via VOICE_ID_REDIRECT
 * so legacy assistants with stale voice IDs continue to work.
 */

const DEFAULT_DEEPGRAM_VOICE = "aura-2-asteria-en";
const DEFAULT_GEMINI_VOICE = "Kore";

// ---------------------------------------------------------------------------
// Legacy redirects — old voice IDs that no longer exist in the catalog map
// to a surviving replacement so getDeepgramVoice/getGeminiVoice keep working.
// Keep in sync with SHORT_NAME_TO_ID in src/lib/voices/index.ts.
// ---------------------------------------------------------------------------
const VOICE_ID_REDIRECT = {
  // Short-name legacy (pre-catalog era)
  rachel: "21m00Tcm4TlvDq8ikWAM",
  sarah: "EXAVITQu4vr4xnSDxMaL",
  adam: "pNInz6obpgDQGcFmaJgB",
  emily: "jBpfuIE2acCO8z3wKNLl",
  sam: "yoZ06aMxZJJ28mfd3POQ",
  // Removed catalog entries → nearest surviving voice
  "29vD33N1CtxCmqQRPOHJ": "pNInz6obpgDQGcFmaJgB", // Drew → Adam
  "ErXwobaYiN019PkySvjV": "pNInz6obpgDQGcFmaJgB", // Antoni → Adam
  "MF3mGyEYCl7XYWbV9V6O": "EXAVITQu4vr4xnSDxMaL", // Elli → Sarah
  "TxGEqnHWrfWFTfGW9XjX": "yoZ06aMxZJJ28mfd3POQ", // Josh → Sam
  "VR6AewLTigWG4xSOukaG": "pNInz6obpgDQGcFmaJgB", // Arnold → Adam
  "AZnzlk1XvdvUeBnXmlld": "EXAVITQu4vr4xnSDxMaL", // Domi → Sarah
  "CYw3kZ02Hs0563khs1Fj": "yoZ06aMxZJJ28mfd3POQ", // Dave → Sam
  "onwK4e9ZLuTAKqWW03F9": "IKne3meq5aSn9XLyUdCD", // Daniel (British) → Liam
  "ThT5KcBeYPX3keUQqHPh": "EXAVITQu4vr4xnSDxMaL", // Dorothy (British) → Sarah
  "SOYHLrjzK2X1ezoPC6cr": "ZQe5CZNOzWyzPSCn5a3c", // Harry (British) → James
  "oWAxZDx7w5VEj9dCyTzz": "jBpfuIE2acCO8z3wKNLl", // Grace (British) → Emily
  "es-diana": "EXAVITQu4vr4xnSDxMaL", // Diana (ES) → Sarah
  "es-javier": "pNInz6obpgDQGcFmaJgB", // Javier (ES) → Adam
  "es-carina": "21m00Tcm4TlvDq8ikWAM", // Carina (ES) → Rachel
  "es-alvaro": "yoZ06aMxZJJ28mfd3POQ", // Alvaro (ES) → Sam
  "es-selena": "jBpfuIE2acCO8z3wKNLl", // Selena (ES) → Emily
  "es-nestor": "ZQe5CZNOzWyzPSCn5a3c", // Nestor (ES) → James
};

function resolveVoiceId(voiceId) {
  if (!voiceId) return null;
  return VOICE_ID_REDIRECT[voiceId] || VOICE_ID_REDIRECT[voiceId.toLowerCase()] || voiceId;
}

// ---------------------------------------------------------------------------
// ElevenLabs catalog ID → Deepgram Aura voice (fallback pipeline only)
// ---------------------------------------------------------------------------
const VOICE_MAP = {
  // Australian
  "XB0fDUnXU5powFXDhCwa": "aura-2-asteria-en",  // Charlotte
  "ZQe5CZNOzWyzPSCn5a3c": "aura-2-arcas-en",    // James
  "IKne3meq5aSn9XLyUdCD": "aura-2-orion-en",    // Liam
  // American
  "EXAVITQu4vr4xnSDxMaL": "aura-2-asteria-en",  // Sarah
  "21m00Tcm4TlvDq8ikWAM": "aura-2-luna-en",     // Rachel
  "jBpfuIE2acCO8z3wKNLl": "aura-2-asteria-en",  // Emily
  "pNInz6obpgDQGcFmaJgB": "aura-2-orion-en",    // Adam
  "yoZ06aMxZJJ28mfd3POQ": "aura-2-arcas-en",    // Sam
};

// ---------------------------------------------------------------------------
// ElevenLabs catalog ID → Gemini Live voice (primary pipeline)
// Every voice in the catalog maps to a DISTINCT Gemini voice so users get
// audibly different options.
// ---------------------------------------------------------------------------
const GEMINI_VOICE_MAP = {
  // Australian
  "XB0fDUnXU5powFXDhCwa": "Kore",     // Charlotte
  "ZQe5CZNOzWyzPSCn5a3c": "Puck",     // James
  "IKne3meq5aSn9XLyUdCD": "Charon",   // Liam
  // American
  "EXAVITQu4vr4xnSDxMaL": "Aoede",    // Sarah
  "21m00Tcm4TlvDq8ikWAM": "Leda",     // Rachel
  "jBpfuIE2acCO8z3wKNLl": "Zephyr",   // Emily
  "pNInz6obpgDQGcFmaJgB": "Fenrir",   // Adam
  "yoZ06aMxZJJ28mfd3POQ": "Orus",     // Sam
};

/**
 * Resolve an ElevenLabs voice ID (or legacy short name / removed catalog ID)
 * to a Deepgram Aura voice model name (classic fallback pipeline only).
 *
 * @param {string} [voiceId]
 * @returns {string}
 */
function getDeepgramVoice(voiceId) {
  if (!voiceId) return DEFAULT_DEEPGRAM_VOICE;
  const resolved = resolveVoiceId(voiceId);
  return VOICE_MAP[resolved] || DEFAULT_DEEPGRAM_VOICE;
}

/**
 * Resolve an ElevenLabs voice ID (or legacy short name / removed catalog ID)
 * to a Gemini Live voice name (primary pipeline).
 *
 * @param {string} [voiceId]
 * @returns {string}
 */
function getGeminiVoice(voiceId) {
  if (!voiceId) return DEFAULT_GEMINI_VOICE;
  const resolved = resolveVoiceId(voiceId);
  return GEMINI_VOICE_MAP[resolved] || DEFAULT_GEMINI_VOICE;
}

module.exports = {
  getDeepgramVoice,
  getGeminiVoice,
  VOICE_MAP,
  GEMINI_VOICE_MAP,
  VOICE_ID_REDIRECT,
  DEFAULT_DEEPGRAM_VOICE,
  DEFAULT_GEMINI_VOICE,
};
