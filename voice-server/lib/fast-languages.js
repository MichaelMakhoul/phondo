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

/** set_language when the call's hearing can't follow (Flux not open, or Flux fell back to Nova). */
const LANGUAGE_UNHEARD_MESSAGE = "NOT SWITCHED: this call can't switch language right now. Tell the caller, in English, that you can only continue in English, and offer to have someone call them back.";

/**
 * The model asked to switch language (set_language): what to switch to — the
 * voice and the hints — without changing the session. server.js switches the
 * streams, then recordLanguageSwitch records it only if that worked.
 * @param {{ fastLanguage?: string|null, baseDeepgramVoice?: string|null }} session
 * @param {unknown} requested - the model's `language` argument
 * @returns {{ ok: boolean, changed: boolean, from?: string, to?: string, voice?: string, hints?: string[], message: string }}
 */
function planLanguageSwitch(session, requested) {
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
  const voice = entry.voice || session.baseDeepgramVoice || ENGLISH_FALLBACK_VOICE;
  const message = code === "en"
    ? "Switched back to English: the caller hears the usual voice again."
    : `Switched to ${entry.name}: the caller now hears a ${entry.name} voice. Speak only ${entry.name} from now on; keep names, numbers, dates, times and confirmation codes exactly as they are, and translate English tool results before you say them.`;
  return { ok: true, changed: true, from, to: code, voice, hints: code === "en" ? ["en"] : [code, "en"], message };
}

/**
 * Record a switch that happened: the call's language, and every language it used.
 * @param {{ fastLanguage?: string|null, languagesUsed?: string[]|null }} session
 * @param {{ changed: boolean, to?: string }} plan - planLanguageSwitch's result
 */
function recordLanguageSwitch(session, plan) {
  if (!plan.changed || !plan.to) return;
  session.fastLanguage = plan.to;
  session.languagesUsed = [...new Set([...(session.languagesUsed || ["en"]), plan.to])];
}

/**
 * Plan and record at once (no streams to switch).
 * @param {{ fastLanguage?: string|null, languagesUsed?: string[]|null, baseDeepgramVoice?: string|null }} session
 * @param {unknown} requested
 * @returns {ReturnType<typeof planLanguageSwitch>}
 */
function applyLanguageSwitch(session, requested) {
  const plan = planLanguageSwitch(session, requested);
  recordLanguageSwitch(session, plan);
  return plan;
}

/**
 * Everyday words of the line's other languages that aren't English words. A
 * caller's name never counts, and nor does a single letter (a spelling's), an
 * article or a preposition (a street's or a suburb's: "Del Mar", "La Perouse").
 * Elided words count by their parts ("d'accord" is "accord"). Portuguese is a
 * language the line doesn't speak: its words keep a Portuguese caller from
 * being taken for a Spanish one.
 * @type {Readonly<Record<string, string[]>>}
 */
const CALLER_MARKERS = Object.freeze({
  es: ["hola", "buenos", "buenas", "días", "dias", "tardes", "noches", "gracias", "sí", "por", "favor", "quiero", "quisiera", "necesito", "tengo", "tiene", "usted", "habla", "hablar", "hablo", "español", "puede", "puedo", "cita", "cómo", "qué", "está", "estoy", "para", "pero", "muy", "mi", "mis", "es", "que", "con", "se", "su", "sus", "mañana", "hoy", "cocina", "baño", "agua", "llave", "fuga", "gotea", "porque", "también", "ahora", "aquí", "llamo", "nombre", "apellido", "número", "teléfono", "casa", "visita", "hora", "bien", "claro", "bueno", "señor", "señora"],
  fr: ["bonjour", "bonsoir", "salut", "merci", "oui", "non", "je", "vous", "tu", "est", "plaît", "avec", "dans", "mon", "ma", "mes", "parlez", "parler", "parle", "français", "francais", "rendez", "voudrais", "aimerais", "ai", "il", "elle", "nous", "qui", "que", "pas", "très", "aujourd", "demain", "eau", "chaude", "depuis", "deux", "jours", "chez", "moi", "fuite", "salle", "bain", "cuisine", "problème", "besoin", "peux", "pouvez", "mais", "ou", "où", "et", "ce", "cette", "nom", "appelle", "accord", "bien", "ne", "vos", "votre"],
  de: ["hallo", "guten", "morgen", "abend", "danke", "bitte", "ja", "nein", "ich", "sie", "nicht", "und", "ist", "mit", "für", "mein", "meine", "meiner", "meinen", "sprechen", "deutsch", "möchte", "habe", "haben", "termin", "heute", "wir", "können", "kann", "gibt", "es", "auf", "zu", "bei", "wasser", "heizung", "küche", "badezimmer", "auch", "noch", "schon", "aber", "oder", "wie", "warum", "sind", "wäre", "gerne", "gern", "genau", "richtig"],
  it: ["ciao", "buongiorno", "buonasera", "salve", "grazie", "sì", "prego", "favore", "vorrei", "sono", "parla", "parlare", "parlo", "italiano", "che", "non", "mio", "mia", "ho", "è", "appuntamento", "oggi", "domani", "anche", "molto", "perché", "cucina", "bagno", "acqua", "perdita", "sotto", "lavandino", "problema", "mi", "ci", "questo", "questa", "quando", "bene", "allora", "ecco", "nome", "cognome", "numero", "telefono", "casa"],
  nl: ["hallo", "goedemorgen", "goedemiddag", "goedenavond", "dank", "bedankt", "alstublieft", "graag", "ja", "nee", "ik", "je", "jij", "niet", "mijn", "wil", "wilt", "spreekt", "spreken", "nederlands", "afspraak", "vandaag", "morgen", "kunt", "kan", "heb", "hebt", "heeft", "voor", "ook", "onder", "keuken", "badkamer", "lekkage", "gootsteen", "probleem", "maar", "wat", "waar", "zijn", "zou", "kunnen", "dat", "deze"],
});
/** Portuguese: no voice on this line, so a caller speaking it is switched to nothing. */
const UNSPOKEN_MARKERS = Object.freeze({
  pt: ["olá", "obrigado", "obrigada", "você", "vocês", "não", "sim", "tenho", "preciso", "fala", "falar", "português", "bom", "boa", "dia", "uma", "um", "eu", "meu", "minha", "é", "está", "também", "água", "cozinha", "banheiro", "vazamento", "consulta", "amanhã", "hoje", "agora", "então", "isso", "aqui", "muito", "obrigadinho", "encanador"],
});
const MARKER_SETS = [...Object.entries(CALLER_MARKERS), ...Object.entries(UNSPOKEN_MARKERS)].map(([code, words]) => /** @type {[string, Set<string>]} */ ([code, new Set(words)]));
/** English words that say the caller is speaking English after all. */
const ENGLISH_MARKERS = new Set(["the", "you", "your", "i", "i'm", "i'd", "i've", "i'll", "my", "me", "is", "are", "am", "was", "have", "has", "can", "could", "would", "do", "does", "did", "please", "thanks", "thank", "hello", "hi", "yes", "yeah", "need", "want", "what", "when", "how", "where", "and", "to", "of", "it", "that", "this", "with", "for", "on", "in", "at", "speak", "like", "booking", "book", "appointment", "name", "number", "okay", "ok", "not", "just", "one", "there", "here", "be", "will", "it's", "that's", "don't", "can't", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "morning", "afternoon", "today", "tomorrow"]);
/** Kana themselves (Script, not Script_Extensions: 。、「」 are shared with Chinese). */
const KANA = /[\p{sc=Hiragana}\p{sc=Katakana}]/gu;

/**
 * SCRUM-594 (F5 simulated calls): the line's other language a caller is
 * clearly speaking, or null. A French caller's "Bonjour, vous parlez français ?"
 * was answered in French in the English voice: the model never called
 * set_language. Clearly means kana for Japanese; otherwise at least three of
 * the language's everyday words, two more than any other language's, and few
 * English ones ("I'd like a booking, por favor" is English).
 * @param {unknown} text - the caller's words
 * @returns {string|null}
 */
function detectCallerLanguage(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  if ((text.match(KANA) || []).length >= 2) return "ja";
  /** @type {Set<string>} */
  const words = new Set();
  /** @type {Set<string>} */
  const englishWords = new Set();
  for (const raw of text.toLowerCase().replace(/’/g, "'").match(/[\p{L}']+/gu) || []) {
    englishWords.add(raw); // "i'm", "don't"
    for (const part of raw.split("'")) {
      if (!part) continue;
      englishWords.add(part);
      if (!/^[a-z]$/.test(part)) words.add(part); // a spelling's letters are no language's words
    }
  }
  const count = (/** @type {Set<string>} */ found, /** @type {Set<string>} */ set) => [...found].filter((t) => set.has(t)).length;
  const english = count(englishWords, ENGLISH_MARKERS);
  const scores = MARKER_SETS.map(([code, set]) => /** @type {[string, number]} */ ([code, count(words, set)])).sort((a, b) => b[1] - a[1]);
  const [best, score] = scores[0];
  const runnerUp = scores[1][1];
  if (score < 3 || score < runnerUp + 2 || english * 3 > score) return null;
  return Object.prototype.hasOwnProperty.call(CALLER_MARKERS, best) ? best : null;
}

module.exports = {
  detectCallerLanguage,
  FAST_LANGUAGES,
  FLUX_MULTI_MODEL,
  ENGLISH_FALLBACK_VOICE,
  UNSPEAKABLE_APOLOGY,
  fastLanguagesEnabled,
  setLanguageToolDefinition,
  unspeakableText,
  planLanguageSwitch,
  recordLanguageSwitch,
  applyLanguageSwitch,
  LANGUAGE_UNHEARD_MESSAGE,
};
