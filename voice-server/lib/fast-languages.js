"use strict";

/**
 * SCRUM-594 (phone test F5): the languages of the demo line's fast path.
 *
 * Asked for Arabic, the AI said "Yes, I can speak Arabic" and sent Arabic text
 * to an English Aura voice: the caller heard letters. The fast path hears with
 * Flux Multilingual (en, es, fr, de, hi, ru, pt, ja, it, nl) and speaks with
 * Aura-2 (en, es, fr, de, it, nl, ja): a caller can switch to their overlap,
 * and to nothing else.
 */

/**
 * The languages a call can switch to (set_language), each with the Aura-2
 * voice that speaks it. English keeps the assistant's own voice.
 * @type {Readonly<Record<string, { name: string, voice: string|null }>>}
 */
const FAST_LANGUAGES = Object.freeze({
  en: { name: "English", voice: null },
  es: { name: "Spanish", voice: "aura-2-selena-es" },
  fr: { name: "French", voice: "aura-2-agathe-fr" },
  de: { name: "German", voice: "aura-2-elara-de" },
  it: { name: "Italian", voice: "aura-2-cinzia-it" },
  nl: { name: "Dutch", voice: "aura-2-daphne-nl" },
  ja: { name: "Japanese", voice: "aura-2-uzume-ja" },
});

/** Flux's multilingual model: same thresholds, keyterms and price as flux-general-en, hints changed mid-stream. */
const FLUX_MULTI_MODEL = "flux-general-multi";

/** Back to English with no recorded base voice: an English voice, never the last language's. */
const ENGLISH_FALLBACK_VOICE = "aura-2-theia-en";

/** What a caller hears instead of text the active voice can't say. */
const UNSPEAKABLE_APOLOGY = "Sorry, I can only speak English, Spanish, French, German, Italian, Dutch or Japanese on this line.";

const LANGUAGE_LIST = "English, Spanish, French, German, Italian, Dutch and Japanese";

/**
 * The kill switch: FAST_LANGUAGES=off keeps the fast path English-only (Flux
 * English, no set_language) — exactly the behaviour before languages.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function fastLanguagesEnabled(env = process.env) {
  return String(env.FAST_LANGUAGES || "").trim().toLowerCase() !== "off";
}

const setLanguageToolDefinition = Object.freeze({
  type: "function",
  function: {
    name: "set_language",
    description:
      "Switch the language of this call: the voice the caller hears and the language you listen for. Call it when the caller clearly asks for one of these languages, or speaks a full sentence in it, before you answer in it. Use \"en\" to go back to English.",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: Object.keys(FAST_LANGUAGES),
          description: "en English, es Spanish, fr French, de German, it Italian, nl Dutch, ja Japanese",
        },
      },
      required: ["language"],
    },
  },
});

/**
 * Does this text contain letters the active voice can't say? Aura-2's voices
 * read Latin script (with its accents); Japanese ones also read kana and kanji.
 * Digits, punctuation, symbols and emoji are not letters and pass.
 * @param {unknown} text
 * @param {string} [language] - the call's active language (default English)
 * @returns {boolean}
 */
function unspeakableText(text, language = "en") {
  for (const ch of String(text || "")) {
    if (!/\p{L}/u.test(ch)) continue;
    if (/\p{Script=Latin}/u.test(ch)) continue;
    if (language === "ja" && /[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}]/u.test(ch)) continue;
    return true;
  }
  return false;
}

/**
 * The model asked to switch language (set_language). Records the call's
 * language on the session and says what the streams must do; the caller
 * (server.js) changes the hints and the voice.
 * @param {{ fastLanguage?: string, languagesUsed?: string[], baseDeepgramVoice?: string|null, deepgramVoice?: string|null }} session
 * @param {unknown} requested - the model's `language` argument
 * @returns {{ ok: boolean, changed: boolean, from?: string, to?: string, voice?: string, hints?: string[], message: string }}
 */
function applyLanguageSwitch(session, requested) {
  const code = String(requested || "").trim().toLowerCase();
  const entry = Object.prototype.hasOwnProperty.call(FAST_LANGUAGES, code) ? FAST_LANGUAGES[code] : null;
  if (!entry) {
    return {
      ok: false,
      changed: false,
      message: `NOT SWITCHED: this line can only speak ${LANGUAGE_LIST}. Tell the caller that in English, in one short sentence, and offer to have someone call them back. Don't write any words in another language.`,
    };
  }
  const from = session.fastLanguage || "en";
  if (code === from) return { ok: true, changed: false, from, to: code, message: `Already speaking ${entry.name}.` };
  session.fastLanguage = code;
  session.languagesUsed = [...new Set([...(session.languagesUsed || ["en"]), code])];
  const voice = entry.voice || session.baseDeepgramVoice || ENGLISH_FALLBACK_VOICE;
  const message = code === "en"
    ? "Switched back to English: the caller hears the usual voice again."
    : `Switched to ${entry.name}: the caller now hears a ${entry.name} voice. Speak only ${entry.name} from now on; keep names, numbers, dates, times and confirmation codes exactly as they are, and translate English tool results before you say them.`;
  return { ok: true, changed: true, from, to: code, voice, hints: code === "en" ? ["en"] : [code, "en"], message };
}

module.exports = {
  FAST_LANGUAGES,
  FLUX_MULTI_MODEL,
  ENGLISH_FALLBACK_VOICE,
  UNSPEAKABLE_APOLOGY,
  fastLanguagesEnabled,
  setLanguageToolDefinition,
  unspeakableText,
  applyLanguageSwitch,
};
