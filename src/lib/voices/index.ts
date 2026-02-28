/**
 * Voice catalog — single source of truth for all voice options.
 *
 * Every UI, API route, and utility that needs voice info should import from
 * here instead of maintaining its own list.
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

export type VoiceAccent = "american" | "british" | "australian";

export type VoiceLanguage = "en" | "es";

export interface CatalogVoice {
  id: string; // ElevenLabs voice ID (for English) or internal ID (for Spanish)
  name: string;
  gender: VoiceGender;
  accent: VoiceAccent;
  tags: VoiceTag[];
  description: string;
  previewText: string;
  deepgramVoice: string; // Deepgram Aura voice model name for self-hosted TTS
  language: VoiceLanguage; // Language this voice speaks
  recommended?: boolean; // Show "Recommended" badge in voice picker
}

// ---------------------------------------------------------------------------
// Catalog
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
    deepgramVoice: "aura-asteria-en",
    language: "en",
    recommended: true,
  },
  {
    id: "ZQe5CZNOzWyzPSCn5a3c",
    name: "James",
    gender: "male",
    accent: "australian",
    tags: ["professional", "calm"],
    description: "Professional Australian male",
    previewText: "G'day! Thanks for calling. How can I help you today?",
    deepgramVoice: "aura-arcas-en",
    language: "en",
    recommended: true,
  },
  {
    id: "IKne3meq5aSn9XLyUdCD",
    name: "Liam",
    gender: "male",
    accent: "australian",
    tags: ["friendly", "conversational"],
    description: "Friendly, laid-back Australian male",
    previewText: "Hey! Good to hear from you. How can I help?",
    deepgramVoice: "aura-orion-en",
    language: "en",
    recommended: true,
  },

  // --- American voices ---
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    name: "Sarah",
    gender: "female",
    accent: "american",
    tags: ["warm", "professional"],
    description: "Warm, professional female",
    previewText: "Hello! Thank you for calling. How may I assist you today?",
    deepgramVoice: "aura-asteria-en",
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
    deepgramVoice: "aura-luna-en",
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
    deepgramVoice: "aura-orion-en",
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
    deepgramVoice: "aura-stella-en",
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
    deepgramVoice: "aura-arcas-en",
    language: "en",
  },
  {
    id: "ErXwobaYiN019PkySvjV",
    name: "Antoni",
    gender: "male",
    accent: "american",
    tags: ["friendly", "conversational"],
    description: "Friendly, conversational male",
    previewText: "Hey, thanks for calling! What can I help you with today?",
    deepgramVoice: "aura-orion-en",
    language: "en",
  },
  {
    id: "MF3mGyEYCl7XYWbV9V6O",
    name: "Elli",
    gender: "female",
    accent: "american",
    tags: ["warm", "friendly"],
    description: "Warm, approachable female",
    previewText: "Hi there! I'm happy to help. What do you need?",
    deepgramVoice: "aura-asteria-en",
    language: "en",
  },
  {
    id: "TxGEqnHWrfWFTfGW9XjX",
    name: "Josh",
    gender: "male",
    accent: "american",
    tags: ["warm", "professional"],
    description: "Deep, warm professional male",
    previewText: "Good to hear from you. How may I be of assistance?",
    deepgramVoice: "aura-orpheus-en",
    language: "en",
  },
  {
    id: "VR6AewLTigWG4xSOukaG",
    name: "Arnold",
    gender: "male",
    accent: "american",
    tags: ["authoritative", "professional"],
    description: "Authoritative, confident male",
    previewText: "Welcome. I'm here to assist you with whatever you need.",
    deepgramVoice: "aura-angus-en",
    language: "en",
  },
  {
    id: "AZnzlk1XvdvUeBnXmlld",
    name: "Domi",
    gender: "female",
    accent: "american",
    tags: ["energetic", "friendly"],
    description: "Energetic, vibrant female",
    previewText: "Hi! Welcome! What can I do for you today?",
    deepgramVoice: "aura-stella-en",
    language: "en",
  },
  {
    id: "CYw3kZ02Hs0563khs1Fj",
    name: "Dave",
    gender: "male",
    accent: "american",
    tags: ["conversational", "friendly"],
    description: "Casual, conversational male",
    previewText: "Hey there! How's it going? What can I help with?",
    deepgramVoice: "aura-perseus-en",
    language: "en",
  },

  // --- British voices ---
  {
    id: "onwK4e9ZLuTAKqWW03F9",
    name: "Daniel",
    gender: "male",
    accent: "british",
    tags: ["professional", "calm"],
    description: "Polished British male",
    previewText: "Good day. How may I assist you this afternoon?",
    deepgramVoice: "aura-arcas-en",
    language: "en",
  },
  {
    id: "ThT5KcBeYPX3keUQqHPh",
    name: "Dorothy",
    gender: "female",
    accent: "british",
    tags: ["warm", "professional"],
    description: "Warm, eloquent British female",
    previewText: "Hello, thank you for reaching out. How can I help?",
    deepgramVoice: "aura-asteria-en",
    language: "en",
  },
  {
    id: "SOYHLrjzK2X1ezoPC6cr",
    name: "Harry",
    gender: "male",
    accent: "british",
    tags: ["professional", "authoritative"],
    description: "Authoritative British male",
    previewText: "Good morning. I'm here to assist you. How may I help?",
    deepgramVoice: "aura-angus-en",
    language: "en",
  },
  {
    id: "oWAxZDx7w5VEj9dCyTzz",
    name: "Grace",
    gender: "female",
    accent: "british",
    tags: ["soothing", "professional"],
    description: "Soothing, refined British female",
    previewText: "Hello, lovely to hear from you. How can I assist?",
    deepgramVoice: "aura-hera-en",
    language: "en",
  },

  // --- Spanish voices ---
  {
    id: "es-diana",
    name: "Diana",
    gender: "female",
    accent: "american",
    tags: ["warm", "professional"],
    description: "Warm, professional Spanish female",
    previewText: "¡Hola! Gracias por llamar. ¿En qué puedo ayudarle hoy?",
    deepgramVoice: "aura-2-diana-es",
    language: "es",
    recommended: true,
  },
  {
    id: "es-javier",
    name: "Javier",
    gender: "male",
    accent: "american",
    tags: ["friendly", "conversational"],
    description: "Friendly, conversational Spanish male",
    previewText: "¡Hola! Bienvenido. ¿Cómo puedo ayudarle?",
    deepgramVoice: "aura-2-javier-es",
    language: "es",
    recommended: true,
  },
  {
    id: "es-carina",
    name: "Carina",
    gender: "female",
    accent: "american",
    tags: ["professional", "authoritative"],
    description: "Professional, authoritative Spanish female",
    previewText: "Buenos días. Estoy aquí para asistirle. ¿En qué puedo servirle?",
    deepgramVoice: "aura-2-carina-es",
    language: "es",
  },
  {
    id: "es-alvaro",
    name: "Álvaro",
    gender: "male",
    accent: "american",
    tags: ["calm", "professional"],
    description: "Calm, professional Spanish male",
    previewText: "Gracias por su llamada. Estoy aquí para ayudarle.",
    deepgramVoice: "aura-2-alvaro-es",
    language: "es",
  },
  {
    id: "es-selena",
    name: "Selena",
    gender: "female",
    accent: "american",
    tags: ["upbeat", "friendly"],
    description: "Upbeat, friendly Spanish female",
    previewText: "¡Hola! ¡Qué gusto escucharle! ¿En qué puedo ayudarle?",
    deepgramVoice: "aura-2-selena-es",
    language: "es",
  },
  {
    id: "es-nestor",
    name: "Néstor",
    gender: "male",
    accent: "american",
    tags: ["warm", "professional"],
    description: "Warm, deep Spanish male",
    previewText: "Buenas. ¿En qué puedo asistirle el día de hoy?",
    deepgramVoice: "aura-2-nestor-es",
    language: "es",
  },
];

// ---------------------------------------------------------------------------
// Default
// ---------------------------------------------------------------------------

/** Sarah — warm, professional female (American). Safe default for any new assistant. */
export const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

/** Diana — warm, professional Spanish female. Default for Spanish assistants. */
export const DEFAULT_VOICE_ID_ES = "es-diana";

// ---------------------------------------------------------------------------
// Legacy short-name mapping
// ---------------------------------------------------------------------------

/**
 * Maps the old Vapi-style short names (e.g. "rachel") that were stored in the
 * DB prior to the catalog overhaul → the real ElevenLabs voice IDs.
 */
export const SHORT_NAME_TO_ID: Record<string, string> = {
  rachel: "21m00Tcm4TlvDq8ikWAM",
  drew: "29vD33N1CtxCmqQRPOHJ",
  clyde: "2EiwWnXFnvU5JabPnv8n",
  paul: "5Q0t7uMcjvnagumLfvZi",
  domi: "AZnzlk1XvdvUeBnXmlld",
  dave: "CYw3kZ02Hs0563khs1Fj",
  fin: "D38z5RcWu1voky8WS1ja",
  sarah: "EXAVITQu4vr4xnSDxMaL",
  adam: "pNInz6obpgDQGcFmaJgB",
  emily: "jBpfuIE2acCO8z3wKNLl",
  sam: "yoZ06aMxZJJ28mfd3POQ",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If `id` is a legacy short name (e.g. "rachel") return the real ElevenLabs ID.
 * Otherwise return `id` as-is. Safe to call on already-resolved IDs.
 */
export function resolveVoiceId(id: string): string {
  return SHORT_NAME_TO_ID[id.toLowerCase()] ?? id;
}

/** Look up a voice by its ElevenLabs ID. */
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
  { key: "professional", label: "Professional", predicate: (v) => v.tags.includes("professional") },
  { key: "friendly", label: "Friendly", predicate: (v) => v.tags.includes("friendly") },
  { key: "australian", label: "Australian", predicate: (v) => v.accent === "australian" },
];

/** Return catalog voices matching a filter key (defaults to "all"), scoped to a language. */
export function filterVoices(filterKey: string, language: VoiceLanguage = "en"): CatalogVoice[] {
  const languageFiltered = VOICE_CATALOG.filter((v) => v.language === language);
  const f = VOICE_FILTERS.find((vf) => vf.key === filterKey);
  if (!f) return languageFiltered;
  return languageFiltered.filter(f.predicate);
}

/** Get the default voice ID for a given language. */
export function getDefaultVoiceId(language: VoiceLanguage = "en"): string {
  return language === "es" ? DEFAULT_VOICE_ID_ES : DEFAULT_VOICE_ID;
}
