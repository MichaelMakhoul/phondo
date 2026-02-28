/**
 * Maps ElevenLabs voice IDs to Deepgram Aura voice names.
 *
 * Deepgram Aura voices: https://developers.deepgram.com/docs/tts-models
 * Mapping is by gender, tone, and accent similarity.
 */

const DEFAULT_DEEPGRAM_VOICE = "aura-asteria-en";
const DEFAULT_DEEPGRAM_VOICE_ES = "aura-2-diana-es";

/**
 * ElevenLabs voice ID → Deepgram Aura voice name.
 *
 * Deepgram Aura voices used:
 * Female: asteria (warm), luna (professional), stella (upbeat), hera (soothing)
 * Male: orion (friendly), arcas (calm/pro), orpheus (warm), angus (authoritative), perseus (casual)
 * British: all map to their closest gender match with accent note
 * Australian: map to closest general voice
 */
const VOICE_MAP = {
  // --- American Female ---
  "EXAVITQu4vr4xnSDxMaL": "aura-asteria-en",    // Sarah — warm, professional → Asteria (warm female)
  "21m00Tcm4TlvDq8ikWAM": "aura-luna-en",        // Rachel — professional, authoritative → Luna (professional female)
  "jBpfuIE2acCO8z3wKNLl": "aura-stella-en",      // Emily — upbeat, friendly → Stella (upbeat female)
  "MF3mGyEYCl7XYWbV9V6O": "aura-asteria-en",     // Elli — warm, friendly → Asteria (warm female)
  "AZnzlk1XvdvUeBnXmlld": "aura-stella-en",      // Domi — energetic, friendly → Stella (upbeat female)

  // --- American Male ---
  "pNInz6obpgDQGcFmaJgB": "aura-orion-en",       // Adam — friendly → Orion (friendly male)
  "yoZ06aMxZJJ28mfd3POQ": "aura-arcas-en",       // Sam — calm, professional → Arcas (calm male)
  "ErXwobaYiN019PkySvjV": "aura-orion-en",       // Antoni — friendly, conversational → Orion (friendly male)
  "TxGEqnHWrfWFTfGW9XjX": "aura-orpheus-en",     // Josh — deep, warm → Orpheus (warm male)
  "VR6AewLTigWG4xSOukaG": "aura-angus-en",       // Arnold — authoritative → Angus (authoritative male)
  "CYw3kZ02Hs0563khs1Fj": "aura-perseus-en",     // Dave — casual, conversational → Perseus (casual male)

  // --- British ---
  "onwK4e9ZLuTAKqWW03F9": "aura-arcas-en",       // Daniel — polished British male → Arcas (calm pro)
  "ThT5KcBeYPX3keUQqHPh": "aura-asteria-en",     // Dorothy — warm British female → Asteria (warm)
  "SOYHLrjzK2X1ezoPC6cr": "aura-angus-en",       // Harry — authoritative British → Angus (authoritative)
  "oWAxZDx7w5VEj9dCyTzz": "aura-hera-en",        // Grace — soothing British female → Hera (soothing)

  // --- Australian ---
  "ZQe5CZNOzWyzPSCn5a3c": "aura-arcas-en",       // James — professional AU male → Arcas
  "XB0fDUnXU5powFXDhCwa": "aura-asteria-en",     // Charlotte — warm AU female → Asteria
  "IKne3meq5aSn9XLyUdCD": "aura-orion-en",       // Liam — friendly AU male → Orion
};

/**
 * Spanish ElevenLabs voice ID → Deepgram Aura-2 Spanish voice.
 * When the assistant language is 'es', these override the English mappings.
 * Falls back by gender: female → diana-es, male → javier-es.
 */
const VOICE_MAP_ES = {
  // Female voices → Spanish female equivalents (only voices in VOICE_CATALOG)
  "EXAVITQu4vr4xnSDxMaL": "aura-2-diana-es",    // Sarah → Diana (warm)
  "21m00Tcm4TlvDq8ikWAM": "aura-2-carina-es",    // Rachel → Carina (professional)
  "jBpfuIE2acCO8z3wKNLl": "aura-2-selena-es",     // Emily → Selena (upbeat)
  "MF3mGyEYCl7XYWbV9V6O": "aura-2-diana-es",      // Elli → Diana (warm)
  "AZnzlk1XvdvUeBnXmlld": "aura-2-selena-es",     // Domi → Selena (closest upbeat female)
  "ThT5KcBeYPX3keUQqHPh": "aura-2-diana-es",      // Dorothy → Diana
  "oWAxZDx7w5VEj9dCyTzz": "aura-2-carina-es",     // Grace → Carina (closest soothing female)
  "XB0fDUnXU5powFXDhCwa": "aura-2-diana-es",      // Charlotte → Diana

  // Male voices → Spanish male equivalents (only voices in VOICE_CATALOG)
  "pNInz6obpgDQGcFmaJgB": "aura-2-javier-es",     // Adam → Javier (friendly)
  "yoZ06aMxZJJ28mfd3POQ": "aura-2-alvaro-es",     // Sam → Alvaro (calm)
  "ErXwobaYiN019PkySvjV": "aura-2-javier-es",     // Antoni → Javier (friendly)
  "TxGEqnHWrfWFTfGW9XjX": "aura-2-nestor-es",     // Josh → Nestor (warm)
  "VR6AewLTigWG4xSOukaG": "aura-2-alvaro-es",     // Arnold → Alvaro (closest authoritative)
  "CYw3kZ02Hs0563khs1Fj": "aura-2-javier-es",     // Dave → Javier (closest casual)
  "onwK4e9ZLuTAKqWW03F9": "aura-2-alvaro-es",     // Daniel → Alvaro
  "SOYHLrjzK2X1ezoPC6cr": "aura-2-alvaro-es",     // Harry → Alvaro
  "ZQe5CZNOzWyzPSCn5a3c": "aura-2-alvaro-es",     // James → Alvaro
  "IKne3meq5aSn9XLyUdCD": "aura-2-javier-es",     // Liam → Javier
};

// Legacy short name support (module-level to avoid recreating on every call)
const SHORT_NAME_TO_ID = {
  rachel: "21m00Tcm4TlvDq8ikWAM",
  sarah: "EXAVITQu4vr4xnSDxMaL",
  adam: "pNInz6obpgDQGcFmaJgB",
  emily: "jBpfuIE2acCO8z3wKNLl",
  sam: "yoZ06aMxZJJ28mfd3POQ",
  domi: "AZnzlk1XvdvUeBnXmlld",
  dave: "CYw3kZ02Hs0563khs1Fj",
};

/**
 * Resolve an ElevenLabs voice ID (or legacy short name) to a Deepgram voice.
 *
 * @param {string} [voiceId] - ElevenLabs voice ID or legacy short name
 * @param {string} [language] - Language code ('en', 'es'). Defaults to 'en'.
 * @returns {string} Deepgram voice model name
 */
function getDeepgramVoice(voiceId, language) {
  const lang = language || "en";

  if (!voiceId) {
    return lang === "es" ? DEFAULT_DEEPGRAM_VOICE_ES : DEFAULT_DEEPGRAM_VOICE;
  }

  const resolvedId = SHORT_NAME_TO_ID[voiceId.toLowerCase()] || voiceId;

  if (lang === "es") {
    return VOICE_MAP_ES[resolvedId] || DEFAULT_DEEPGRAM_VOICE_ES;
  }

  return VOICE_MAP[resolvedId] || DEFAULT_DEEPGRAM_VOICE;
}

module.exports = { getDeepgramVoice, VOICE_MAP, VOICE_MAP_ES, DEFAULT_DEEPGRAM_VOICE, DEFAULT_DEEPGRAM_VOICE_ES };
