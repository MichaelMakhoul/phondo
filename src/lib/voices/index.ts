/**
 * Voice catalog — single source of truth for all voice options.
 *
 * Every UI, API route, and utility that needs voice info should import from
 * here instead of maintaining its own list.
 *
 * Design note: the 8 voices below each map to a DISTINCT Gemini Live voice.
 * We deliberately do NOT expose multiple "branded" voices that share a Gemini
 * backend — that was confusing (e.g., "Charlotte" and "Elli" used to both map
 * to Kore, so picking one vs the other made no audible difference). The AU
 * voices (Charlotte/James/Liam) carry the persona branding for the primary
 * market; the US set rounds out the remaining Gemini voices.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceGender = "female" | "male";

export type VoiceTag =
  | "professional"
  | "friendly"
  | "calm"
  | "warm"
  | "upbeat"
  | "authoritative"
  | "conversational"
  | "energetic"
  | "soothing";

export type VoiceAccent = "american" | "british" | "australian" | "latin_american";

export type VoiceLanguage = "en" | "es";

export interface CatalogVoice {
  id: string; // ElevenLabs voice ID (still used as a stable backend identifier)
  name: string;
  gender: VoiceGender;
  accent: VoiceAccent;
  tags: VoiceTag[];
  description: string;
  previewText: string;
  deepgramVoice: string; // Deepgram Aura voice model name for the fallback pipeline
  geminiVoice: string; // Gemini Live voice name — the primary pipeline uses this
  language: VoiceLanguage;
  recommended?: boolean; // Show "Recommended" badge in voice picker
  personaTagline?: string; // Short persona branding (e.g. "The Sydney Office Manager")
}

// ---------------------------------------------------------------------------
// Catalog — 8 voices, each mapped to a distinct Gemini Live voice
// ---------------------------------------------------------------------------

export const VOICE_CATALOG: CatalogVoice[] = [
  // --- Australian voices (front-and-center for AU market) ---
  {
    id: "XB0fDUnXU5powFXDhCwa",
    name: "Charlotte",
    gender: "female",
    accent: "australian",
    tags: ["warm", "friendly"],
    description: "Warm, friendly Australian female",
    previewText: "Hi there! Thanks for getting in touch. What can I do for you?",
    deepgramVoice: "aura-2-asteria-en",
    geminiVoice: "Kore",
    language: "en",
    recommended: true,
    personaTagline: "The Sydney Office Manager",
  },
  {
    id: "ZQe5CZNOzWyzPSCn5a3c",
    name: "James",
    gender: "male",
    accent: "australian",
    tags: ["professional", "calm"],
    description: "Professional Australian male",
    previewText: "G'day! Thanks for calling. How can I help you today?",
    deepgramVoice: "aura-2-arcas-en",
    geminiVoice: "Puck",
    language: "en",
    recommended: true,
    personaTagline: "The Melbourne Professional",
  },
  {
    id: "IKne3meq5aSn9XLyUdCD",
    name: "Liam",
    gender: "male",
    accent: "australian",
    tags: ["friendly", "conversational"],
    description: "Friendly, laid-back Australian male",
    previewText: "Hey! Good to hear from you. How can I help?",
    deepgramVoice: "aura-2-orion-en",
    geminiVoice: "Charon",
    language: "en",
    recommended: true,
    personaTagline: "The Brisbane All-Rounder",
  },

  // --- American voices (round out the remaining Gemini voices) ---
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    name: "Sarah",
    gender: "female",
    accent: "american",
    tags: ["warm", "professional"],
    description: "Warm, professional female",
    previewText: "Hello! Thank you for calling. How may I assist you today?",
    deepgramVoice: "aura-2-asteria-en",
    geminiVoice: "Aoede",
    language: "en",
  },
  {
    id: "21m00Tcm4TlvDq8ikWAM",
    name: "Rachel",
    gender: "female",
    accent: "american",
    tags: ["professional", "authoritative"],
    description: "Professional, authoritative female",
    previewText: "Good morning! I'd be happy to help you with your inquiry.",
    deepgramVoice: "aura-2-luna-en",
    geminiVoice: "Leda",
    language: "en",
  },
  {
    id: "jBpfuIE2acCO8z3wKNLl",
    name: "Emily",
    gender: "female",
    accent: "american",
    tags: ["upbeat", "friendly"],
    description: "Upbeat, enthusiastic female",
    previewText: "Hey! Great to hear from you! How can I help?",
    deepgramVoice: "aura-2-asteria-en",
    geminiVoice: "Zephyr",
    language: "en",
  },
  {
    id: "pNInz6obpgDQGcFmaJgB",
    name: "Adam",
    gender: "male",
    accent: "american",
    tags: ["friendly"],
    description: "Friendly, trustworthy male",
    previewText: "Hi there! Thanks for reaching out. What can I do for you?",
    deepgramVoice: "aura-2-orion-en",
    geminiVoice: "Fenrir",
    language: "en",
  },
  {
    id: "yoZ06aMxZJJ28mfd3POQ",
    name: "Sam",
    gender: "male",
    accent: "american",
    tags: ["calm", "professional"],
    description: "Calm, professional male",
    previewText: "Thank you for your call. I'm here to help you today.",
    deepgramVoice: "aura-2-arcas-en",
    geminiVoice: "Orus",
    language: "en",
  },
];

// ---------------------------------------------------------------------------
// Default
// ---------------------------------------------------------------------------

/** Charlotte — warm Australian female, the recommended primary voice. */
export const DEFAULT_VOICE_ID = "XB0fDUnXU5powFXDhCwa";

// ---------------------------------------------------------------------------
// Legacy short-name mapping
// ---------------------------------------------------------------------------

/**
 * Maps the old Vapi-style short names (e.g. "rachel") and now-deprecated
 * catalog IDs (e.g. "es-diana") to an equivalent voice still in the catalog.
 * This keeps assistants created before the catalog trim from breaking — they
 * silently fall through to a live voice.
 */
export const SHORT_NAME_TO_ID: Record<string, string> = {
  // Short-name legacy (pre-catalog era)
  rachel: "21m00Tcm4TlvDq8ikWAM",
  sarah: "EXAVITQu4vr4xnSDxMaL",
  adam: "pNInz6obpgDQGcFmaJgB",
  emily: "jBpfuIE2acCO8z3wKNLl",
  sam: "yoZ06aMxZJJ28mfd3POQ",
  // Removed-catalog entries (now aliased to the nearest surviving voice)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If `id` is a legacy short name or a removed catalog entry, return a valid
 * replacement ID. Otherwise return `id` as-is. Safe to call on already-resolved IDs.
 */
export function resolveVoiceId(id: string): string {
  if (!id) return DEFAULT_VOICE_ID;
  return SHORT_NAME_TO_ID[id] ?? SHORT_NAME_TO_ID[id.toLowerCase()] ?? id;
}

/** Look up a voice by its ID. */
export function getVoiceById(voiceId: string): CatalogVoice | undefined {
  const resolved = resolveVoiceId(voiceId);
  return VOICE_CATALOG.find((v) => v.id === resolved);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface VoiceFilter {
  key: string;
  label: string;
  predicate: (v: CatalogVoice) => boolean;
}

export const VOICE_FILTERS: VoiceFilter[] = [
  { key: "all", label: "All", predicate: () => true },
  { key: "female", label: "Female", predicate: (v) => v.gender === "female" },
  { key: "male", label: "Male", predicate: (v) => v.gender === "male" },
  { key: "australian", label: "Australian", predicate: (v) => v.accent === "australian" },
];

/** Return catalog voices matching a filter key (defaults to "all"). */
export function filterVoices(filterKey: string, _language: VoiceLanguage = "en"): CatalogVoice[] {
  const f = VOICE_FILTERS.find((vf) => vf.key === filterKey);
  if (!f) return VOICE_CATALOG;
  return VOICE_CATALOG.filter(f.predicate);
}

/** Get the default voice ID. Language param kept for backward compat; unused. */
export function getDefaultVoiceId(_language: VoiceLanguage = "en"): string {
  return DEFAULT_VOICE_ID;
}
