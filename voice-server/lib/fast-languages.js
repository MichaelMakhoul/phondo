"use strict";

/**
 * SCRUM-594 (phone test F5): the languages of the demo line's fast path.
 *
 * Asked for Arabic, the AI said "Yes, I can speak Arabic" and sent Arabic text
 * to an English Aura voice: the caller heard letters. The fast path hears with
 * Flux Multilingual (en, es, fr, de, hi, ru, pt, ja, it, nl) and speaks with
 * Aura-2 (en, es, fr, de, it, nl, ja): a call can use their overlap, and
 * nothing else.
 *
 * Phone test F9: the model chooses the language (it answers in the caller's).
 * Each of its sentences is said in the voice of the sentence's own language
 * (sentenceVoice), and the line — Flux's hints, the fillers, the voice of a
 * sentence whose words don't say its language — follows its replies (server.js
 * followReplyLanguage). Nothing switches on the caller's words: the rules that
 * tried to (F5, F9) kept misreading them.
 */

/**
 * The languages a call can speak, each with the Aura-2 voice that speaks it.
 * English keeps the assistant's own voice.
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

/** The model's note when the line can't follow it out of English (the hearing is Nova's, or Flux refused the hints). */
const LANGUAGE_UNHEARD_NOTE = "This line can only hear English now. Answer in English, and if the caller wants another language, tell them that in English and offer to have someone call them back.";

/**
 * The kill switch: FAST_LANGUAGES=off keeps the fast path English-only (Flux
 * English, the assistant's voice for everything) — exactly the behaviour
 * before languages.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function fastLanguagesEnabled(env = process.env) {
  return String(env.FAST_LANGUAGES || "").trim().toLowerCase() !== "off";
}

/**
 * Does this text contain letters the active voice can't say? Aura-2's voices
 * read Latin script (with its accents); Japanese ones also read kana and kanji.
 * Digits, punctuation, symbols and emoji are not letters and pass.
 * @param {unknown} text
 * @param {string} [language] - the language of the voice saying it (default English)
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
 * A move of the line to another language: its voice and Flux's hints, without
 * changing the session. server.js switches the streams, then
 * recordLanguageSwitch records it only if that worked.
 * @param {{ fastLanguage?: string|null, baseDeepgramVoice?: string|null }} session
 * @param {unknown} requested - a FAST_LANGUAGES code
 * @returns {{ changed: boolean, from: string, to?: string, voice?: string, hints?: string[] }}
 */
function planLanguageSwitch(session, requested) {
  const code = String(requested || "").trim().toLowerCase();
  const from = session.fastLanguage || "en";
  if (!Object.hasOwn(FAST_LANGUAGES, code) || code === from) return { changed: false, from };
  const voice = FAST_LANGUAGES[code].voice || session.baseDeepgramVoice || ENGLISH_FALLBACK_VOICE;
  return { changed: true, from, to: code, voice, hints: code === "en" ? ["en"] : [code, "en"] };
}

/**
 * Note a language the call used (calls.metadata.fastPath.languages: re-transcription
 * leaves a call that used two alone, and the booking guards read each one's words).
 * @param {{ languagesUsed?: string[]|null }} session
 * @param {string} code
 */
function noteLanguageUsed(session, code) {
  if (session.languagesUsed?.includes(code)) return;
  session.languagesUsed = [...new Set([...(session.languagesUsed || ["en"]), code])];
}

/**
 * Record a switch that happened: the line's language, and every language the call used.
 * @param {{ fastLanguage?: string|null, languagesUsed?: string[]|null }} session
 * @param {{ changed: boolean, to?: string }} plan - planLanguageSwitch's result
 */
function recordLanguageSwitch(session, plan) {
  if (!plan.changed || !plan.to) return;
  session.fastLanguage = plan.to;
  noteLanguageUsed(session, plan.to);
}

/**
 * Phone test F9: everyday words of each language as the model writes them, that no
 * other language here writes too ("de", "la", "en", "me", "in", "per", "no"… are left
 * out: they are words of several). A word counts for one language only (pinned by a
 * test). Portuguese has no voice on this line: its words keep a Portuguese sentence
 * from passing for Spanish.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const LANGUAGE_WORDS = Object.freeze({
  en: ["the", "you", "your", "you're", "you'll", "yours", "are", "were", "have", "would", "could", "should", "can", "it", "it's", "its", "that's", "there's", "i'm", "i'll", "i've", "i'd", "we're", "we'll", "we've", "they'll", "let", "let's", "for", "with", "this", "that", "these", "what", "when", "how", "where", "which", "who", "why", "and", "to", "at", "be", "been", "does", "did", "don't", "can't", "won't", "isn't", "please", "thank", "thanks", "yes", "yeah", "yep", "sure", "today", "tomorrow", "morning", "afternoon", "evening", "appointment", "available", "booked", "booking", "book", "there", "here", "now", "just", "any", "anything", "something", "someone", "else", "great", "need", "get", "got", "my", "our", "us", "about", "from", "they", "them", "their", "she", "not", "one", "good", "number", "phone", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "o'clock", "time", "times", "like", "sorry", "right", "all", "spell", "spelled", "speak", "english", "spanish", "french", "german", "italian", "dutch", "japanese", "only", "welcome", "everything", "cheers", "bye", "goodbye", "worries", "alright", "lovely", "hello", "hi", "hey", "tap", "sink", "leak", "drip", "dripping", "running", "wide", "steadily", "visit", "fix", "send", "under", "last", "first", "call", "calling", "back", "soon", "later", "plumber", "quote", "address", "after", "before", "then", "than", "if", "but", "lock"],
  es: ["el", "los", "las", "citas", "están", "estoy", "usted", "ustedes", "sus", "muy", "más", "pero", "gracias", "hola", "bueno", "buenos", "buenas", "cita", "hoy", "mañana", "día", "días", "puedo", "puede", "quiere", "quiero", "tiene", "tengo", "tenemos", "hay", "soy", "cómo", "qué", "cuál", "cuándo", "dónde", "también", "ahora", "aquí", "perfecto", "nombre", "apellido", "teléfono", "ayudarle", "ayudar", "señor", "señora", "sí", "hablar", "hablo", "habla", "español", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo", "necesita", "listo", "ya", "entonces", "permítame", "déjeme", "dígame", "eso", "esto", "este", "esta", "para", "por", "favor", "claro", "está", "algo", "nada", "hora", "horas", "tarde", "número", "reservar", "reserva", "reservado", "reservada", "entendido", "así", "solo", "sola", "confirmar", "correcto", "correcta", "piezas", "grifo", "gotea", "goteo", "fregadero", "cocina", "baño", "agua", "emergencia", "mismo", "misma", "desde", "llamando", "llamar", "llama", "llamada", "verificar", "correo", "dirección", "muchas", "adiós", "hasta", "luego", "buen", "tenga", "mandar"],
  fr: ["est", "et", "vous", "nous", "pour", "avec", "dans", "sur", "pas", "très", "merci", "bonjour", "oui", "votre", "vos", "mon", "notre", "cette", "au", "aux", "c'est", "j'ai", "d'accord", "rendez", "demain", "aujourd'hui", "heure", "heures", "plaît", "s'il", "peux", "pouvez", "voulez", "souhaitez", "parfait", "elle", "suis", "êtes", "avez", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche", "numéro", "nom", "prénom", "parle", "parler", "français", "ça", "voilà", "une", "téléphone", "rappeler", "plombier", "fuite", "évier", "cuisine", "salle", "bain", "chez", "voici", "vérifie", "vérifier", "réserve", "réserver", "réservé", "confirmer", "bonne", "journée", "revoir", "matin", "après", "midi", "leur", "quel", "quelle", "pourquoi", "quand", "où", "aussi", "beaucoup", "désolé", "désolée"],
  de: ["der", "die", "den", "und", "ist", "nicht", "ich", "sie", "wir", "ihnen", "ihre", "ihr", "mit", "für", "auf", "zu", "bei", "von", "ein", "eine", "einen", "einem", "nein", "danke", "bitte", "gerne", "gern", "guten", "heute", "termin", "uhr", "haben", "habe", "kann", "können", "möchten", "möchte", "wann", "gibt", "auch", "noch", "schon", "aber", "oder", "sehr", "gut", "sind", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag", "deutsch", "sprechen", "nummer", "telefonnummer", "uhrzeit", "passt", "nachname", "vorname", "richtig", "korrekt", "buchen", "gebucht", "eintragen", "eingetragen", "übermorgen", "wasserhahn", "tropft", "küche", "schicken", "senden", "klar", "schönen", "wiederhören", "wiedersehen", "etwas", "anderes", "kein", "keine", "natürlich", "genau", "dass", "wo", "warum", "wer", "welche", "uns", "unser"],
  it: ["della", "delle", "dello", "gli", "di", "che", "è", "sono", "ci", "grazie", "buongiorno", "buonasera", "prego", "appuntamento", "oggi", "domani", "alla", "sì", "perfetto", "bene", "può", "vuole", "vorrei", "ho", "abbiamo", "cognome", "anche", "molto", "dove", "perché", "allora", "ecco", "qualcosa", "altro", "parlo", "parla", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica", "telefono", "orario", "disponibile", "aiutarla", "aiutare", "prenoto", "prenotare", "prenotazione", "posso", "certo", "nome", "numero", "benissimo", "quindi", "mattina", "pomeriggio", "rubinetto", "perde", "cucina", "bagno", "mandare", "confermare", "giusto", "corretto", "arrivederci", "buona", "giornata", "c'è", "lei", "suo", "sua", "questo", "questa", "quale", "tutto"],
  nl: ["het", "een", "voor", "op", "niet", "ik", "uw", "jij", "wij", "zijn", "hebben", "heb", "heeft", "kan", "kunnen", "kunt", "wilt", "graag", "dank", "bedankt", "alstublieft", "nee", "goed", "goedemorgen", "goedemiddag", "goedenavond", "afspraak", "vandaag", "uur", "hoe", "wat", "wanneer", "waar", "ook", "nog", "maar", "dat", "deze", "naar", "mijn", "daar", "bij", "spreekt", "spreken", "nederlands", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag", "tijd", "telefoonnummer", "naam", "achternaam", "beschikbaar", "zou", "wel", "kraan", "lekt", "lekkage", "keuken", "badkamer", "sturen", "voornaam", "klopt", "juist", "boeken", "geboekt", "ingepland", "inplannen", "tot", "ziens", "dag", "fijne", "iets", "wacht", "kijk", "jullie", "onze", "waarom", "welke"],
  pt: ["não", "você", "vocês", "obrigado", "obrigada", "olá", "tenho", "preciso", "falar", "português", "bom", "boa", "uma", "meu", "minha", "também", "então", "isso", "aqui", "muito", "amanhã", "hoje", "agora", "consegue", "gostaria", "horário", "dia", "às", "nós", "ajudar", "pode", "terça", "feira"],
});
/**
 * Letters only one of them writes: two words' worth (ñ ¿ ¡ ß œ ã õ), or one (ä ö ü î û).
 * @type {Readonly<Record<string, ReadonlyArray<[RegExp, number]>>>}
 */
const LANGUAGE_LETTERS = Object.freeze({
  es: [[/[¿¡ñ]/u, 2]],
  de: [[/ß/u, 2], [/[äöü]/u, 1]],
  fr: [[/œ/u, 2], [/[îû]/u, 1]],
  pt: [[/[ãõ]/u, 2]],
});
const WORD_SETS = Object.entries(LANGUAGE_WORDS).map(([code, words]) => /** @type {[string, Set<string>]} */ ([code, new Set(words)]));
/** Kana themselves (Script, not Script_Extensions: 。、「」 are shared with Chinese). */
const KANA = /[\p{sc=Hiragana}\p{sc=Katakana}]/gu;

/**
 * Each language's count of its everyday words (each word once) and letters in the text, best first.
 * @param {string} text
 * @returns {Array<[string, number]>}
 */
function languageScores(text) {
  const lower = text.toLowerCase().replace(/’/g, "'");
  /** @type {Set<string>} */
  const words = new Set();
  // A spelling's letters are no language's words; an accented one-letter word is ("è").
  const isWord = (/** @type {string} */ w) => w.length > 1 || /[^a-z']/.test(w);
  for (const raw of lower.match(/[\p{L}']+/gu) || []) {
    if (isWord(raw)) words.add(raw); // "c'est", "i'm"
    for (const part of raw.split("'")) if (isWord(part)) words.add(part);
  }
  return WORD_SETS.map(([code, set]) => {
    let score = 0;
    for (const word of words) if (set.has(word)) score += 1;
    for (const [letters, weight] of LANGUAGE_LETTERS[code] || []) if (letters.test(lower)) score += weight;
    return /** @type {[string, number]} */ ([code, score]);
  }).sort((a, b) => b[1] - a[1]);
}

/**
 * Phone test F9: the line's language a piece of the model's text (or the caller's) is
 * clearly in, or null. Clearly: two kana for Japanese; otherwise more than twice as many
 * of the language's words (a letter only it writes counts double) as any other
 * language's, and at least one ("Gracias, Sami." is Spanish). Strict, for a whole reply
 * or the caller's turn: three, and more than three times. Portuguese is never an answer:
 * the line can't speak it.
 * @param {unknown} text
 * @param {{ strict?: boolean }} [options]
 * @returns {string|null} a FAST_LANGUAGES code
 */
function textLanguage(text, options = {}) {
  if (typeof text !== "string" || !text.trim()) return null;
  if ((text.match(KANA) || []).length >= 2) return "ja";
  const [[best, score], [, runnerUp]] = languageScores(text);
  const [least, times] = options.strict ? [3, 3] : [1, 2];
  if (score < least || score <= runnerUp * times) return null;
  return Object.hasOwn(FAST_LANGUAGES, best) ? best : null;
}

/**
 * What sentenceVoice reads and keeps on a call (a CallSession).
 * @typedef {Object} FastVoiceSession
 * @property {boolean} [fastLanguages]
 * @property {string|null} [fastLanguage]
 * @property {string|null} [deepgramVoice]
 * @property {string|null} [baseDeepgramVoice]
 * @property {string|null} [fastTurnLanguage]
 * @property {string|null} [fastReplyLanguage]
 * @property {string[]|null} [fastFailedVoices]
 * @property {string[]|null} [languagesUsed]
 */

/**
 * The voice of a language on this call: the assistant's own for English, and for a
 * language whose voice failed earlier in the call (null: the TTS clients' default).
 * @param {FastVoiceSession} session
 * @param {string} code
 * @returns {string|null}
 */
function languageVoice(session, code) {
  const voice = Object.hasOwn(FAST_LANGUAGES, code) ? FAST_LANGUAGES[code].voice : null;
  return voice && !session.fastFailedVoices?.includes(voice) ? voice : session.baseDeepgramVoice || null;
}

/**
 * Phone test F9: the language and voice of one sentence of the model's. Its own
 * language when its words say so clearly (textLanguage); otherwise this reply's so
 * far, then the caller's this turn, then the line's. So the model's English on a
 * Spanish line is said in English, and its Spanish before the line has followed it,
 * in Spanish. Off with the kill switch: the line's voice, as before languages.
 * @param {FastVoiceSession} session
 * @param {string} text
 * @returns {{ language: string, voice: string|null }} voice null: the assistant's own
 */
function sentenceVoice(session, text) {
  if (!session.fastLanguages) return { language: session.fastLanguage || "en", voice: session.deepgramVoice || null };
  const found = textLanguage(text);
  if (found) {
    session.fastReplyLanguage = found;
    noteLanguageUsed(session, found);
  }
  const language = found || session.fastReplyLanguage || session.fastTurnLanguage || session.fastLanguage || "en";
  return { language, voice: languageVoice(session, language) };
}

/**
 * The start of a caller's turn: the language their words are clearly in (strict) is
 * the reply's language for sentences whose own words don't say theirs.
 * @param {FastVoiceSession} session
 * @param {string} transcript - the caller's words this turn
 */
function beginReplyLanguage(session, transcript) {
  session.fastReplyLanguage = null;
  session.fastTurnLanguage = session.fastLanguages ? textLanguage(transcript, { strict: true }) : null;
  if (session.fastTurnLanguage) noteLanguageUsed(session, session.fastTurnLanguage);
}

module.exports = {
  FAST_LANGUAGES,
  FLUX_MULTI_MODEL,
  ENGLISH_FALLBACK_VOICE,
  UNSPEAKABLE_APOLOGY,
  LANGUAGE_UNHEARD_NOTE,
  LANGUAGE_WORDS,
  fastLanguagesEnabled,
  unspeakableText,
  planLanguageSwitch,
  recordLanguageSwitch,
  noteLanguageUsed,
  textLanguage,
  languageVoice,
  sentenceVoice,
  beginReplyLanguage,
};
