"use strict";

// SCRUM-594 (phone test F5): the demo line promised Arabic and sent Arabic text
// to an English voice. The fast path offers exactly the languages it can hear
// (Flux Multilingual) AND speak (Aura-2), and never sends a voice text in a
// script it can't say. Phone test F9: each sentence is said in the voice of its
// own language (sentenceVoice), and the line follows the model's replies.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  FAST_LANGUAGES,
  FLUX_MULTI_MODEL,
  ENGLISH_FALLBACK_VOICE,
  fastLanguagesEnabled,
  unspeakableText,
  planLanguageSwitch,
  recordLanguageSwitch,
  noteLanguageUsed,
  UNSPEAKABLE_APOLOGY,
  LANGUAGE_UNHEARD_NOTE,
  LANGUAGE_WORDS,
  textLanguage,
  languageVoice,
  sentenceVoice,
  beginReplyLanguage,
} = require("../lib/fast-languages");

describe("FAST_LANGUAGES: what Flux Multilingual hears and Aura-2 speaks", () => {
  it("is English, Spanish, French, German, Italian, Dutch and Japanese — no Arabic", () => {
    assert.deepEqual(Object.keys(FAST_LANGUAGES), ["en", "es", "fr", "de", "it", "nl", "ja"]);
    assert.equal(FAST_LANGUAGES.ar, undefined);
  });

  it("each non-English language has an Aura-2 voice of that language; English keeps the assistant's voice", () => {
    assert.equal(FAST_LANGUAGES.en.voice, null);
    for (const [code, entry] of Object.entries(FAST_LANGUAGES)) {
      if (code === "en") continue;
      assert.match(entry.voice, new RegExp(`^aura-2-[a-z]+-${code}$`), code);
    }
  });

  it("hears through Flux Multilingual", () => {
    assert.equal(FLUX_MULTI_MODEL, "flux-general-multi");
  });

  it("phone test F9: there is no set_language tool any more", () => {
    assert.equal(require("../lib/fast-languages").setLanguageToolDefinition, undefined);
  });
});

describe("fastLanguagesEnabled (kill switch FAST_LANGUAGES=off)", () => {
  it("is on unless FAST_LANGUAGES is off", () => {
    assert.equal(fastLanguagesEnabled({}), true);
    assert.equal(fastLanguagesEnabled({ FAST_LANGUAGES: "on" }), true);
    assert.equal(fastLanguagesEnabled({ FAST_LANGUAGES: "off" }), false);
    assert.equal(fastLanguagesEnabled({ FAST_LANGUAGES: " OFF " }), false);
  });
});

describe("unspeakableText: letters the active voice can't say", () => {
  for (const text of [
    "Thanks for calling, how can I help?",
    "¿En qué puedo ayudarle? Señor Muñoz, mañana a las 10.",
    "Très bien, à demain. Größe, Straße — è perfetto.",
    "Dank je wel! 10:30 AM, $120, 50%.",
    "😀 👍",
    "",
  ]) {
    it(`speakable in English: ${JSON.stringify(text)}`, () => assert.equal(unspeakableText(text, "en"), false));
  }
  for (const text of [
    "نعم، أستطيع التحدث بالعربية.",
    "Yes I can — نعم",
    "Да, конечно.",
    "我可以说中文",
    "Ναι, βεβαίως.",
    "שלום",
    "हाँ",
    "네, 가능합니다",
  ]) {
    it(`unspeakable in English: ${JSON.stringify(text)}`, () => assert.equal(unspeakableText(text, "en"), true));
  }
  it("Japanese is speakable only in the Japanese voice (kana, kanji and the long-vowel mark)", () => {
    const ja = "はい、明日の10時でございます。コーヒー";
    assert.equal(unspeakableText(ja, "ja"), false);
    assert.equal(unspeakableText(ja, "en"), true);
    assert.equal(unspeakableText(ja, "es"), true);
    assert.equal(unspeakableText("한국어", "ja"), true, "Korean is still not Japanese");
  });
  it("the apology is itself speakable", () => {
    assert.equal(unspeakableText(UNSPEAKABLE_APOLOGY, "en"), false);
  });
});

describe("planLanguageSwitch / recordLanguageSwitch: the line moving (decide, then record only what happened)", () => {
  const session = () => ({ fastLanguage: "en", baseDeepgramVoice: "aura-2-theia-en", deepgramVoice: "aura-2-theia-en" });

  it("to Spanish: the Spanish voice, Spanish-then-English hints; the plan changes nothing, recording it does", () => {
    const s = session();
    const plan = planLanguageSwitch(s, "es");
    assert.deepEqual(plan, { changed: true, from: "en", to: "es", voice: FAST_LANGUAGES.es.voice, hints: ["es", "en"] });
    assert.equal(s.fastLanguage, "en");
    assert.equal(s.languagesUsed, undefined);
    recordLanguageSwitch(s, plan);
    assert.equal(s.fastLanguage, "es");
    assert.deepEqual(s.languagesUsed, ["en", "es"]);
  });

  it("back to English: the assistant's own voice and an English hint; the languages used stay", () => {
    const s = session();
    recordLanguageSwitch(s, planLanguageSwitch(s, "fr"));
    const plan = planLanguageSwitch(s, "EN");
    assert.deepEqual(plan, { changed: true, from: "fr", to: "en", voice: "aura-2-theia-en", hints: ["en"] });
    recordLanguageSwitch(s, plan);
    assert.equal(s.fastLanguage, "en");
    assert.deepEqual(s.languagesUsed, ["en", "fr"]);
  });

  it("the language in use, or one this line can't speak, changes nothing", () => {
    const s = session();
    for (const code of ["en", "ar", "Arabic", "zh", "", null, undefined]) {
      const plan = planLanguageSwitch(s, code);
      assert.deepEqual(plan, { changed: false, from: "en" }, String(code));
      recordLanguageSwitch(s, plan);
    }
    assert.equal(s.fastLanguage, "en");
    assert.equal(s.languagesUsed, undefined);
  });

  it("back to English without a recorded base voice: an English voice, never the last language's", () => {
    assert.equal(planLanguageSwitch({ fastLanguage: "es" }, "en").voice, ENGLISH_FALLBACK_VOICE);
  });

  it("noteLanguageUsed keeps each language once, English first", () => {
    const s = {};
    noteLanguageUsed(s, "es");
    noteLanguageUsed(s, "es");
    noteLanguageUsed(s, "ja");
    assert.deepEqual(s.languagesUsed, ["en", "es", "ja"]);
  });

  it("the unheard note says to carry on in English and offer a call-back", () => {
    assert.match(LANGUAGE_UNHEARD_NOTE, /only hear English/);
    assert.match(LANGUAGE_UNHEARD_NOTE, /call (?:them )?back/);
  });
});

describe("textLanguage: the language the model's words are clearly in (phone test F9)", () => {
  const clear = {
    en: ["Got it, a slow drip.", "Thanks, Michael. And your last name?", "Let me book that for you.", "Is there anything else you need today?", "Sure. This line speaks English, Spanish, French, German, Italian, Dutch and Japanese.", "Before I lock it in, let me spell your last name back to you: J-O-R-D-A-N.", "Today we have 9:30 AM, 10 AM, 11 AM, 2 PM, 3 PM and 4 PM open. Which suits you?", "Yes, I can. Would you like to continue in Spanish?", UNSPEAKABLE_APOLOGY],
    es: ["Claro, ahora podemos seguir en español.", "¿Hay algo más en lo que pueda ayudarle hoy?", "Sí, hablo español.", "Muy bien, gracias por preguntar.", "Permítame reservar eso.", "Listo, su cita es el miércoles a las dos.", "¡Perfecto!"],
    fr: ["D'accord, je vous réserve demain à 9 heures.", "Bien sûr, je peux vous proposer demain à 9 h.", "Merci, votre rendez-vous est confirmé."],
    de: ["Gerne, ich kann Sie am Montag eintragen.", "Alles klar, ich buche Sie für Montag um 9 Uhr.", "Danke, bis morgen um zehn Uhr."],
    it: ["Perfetto, la prenoto per domani alle 9.", "Certo, posso aiutarla con un appuntamento.", "Grazie, a che ora preferisce?"],
    nl: ["Prima, ik plan u in voor morgen om 9 uur.", "Wat is uw achternaam?", "Dank u wel, ik heb het genoteerd."],
    ja: ["はい、日本語でご案内します。", "ご予約は水曜日の午後2時です。"],
  };
  for (const [code, texts] of Object.entries(clear)) {
    for (const text of texts) it(`${JSON.stringify(text)} is ${code}`, () => assert.equal(textLanguage(text), code));
  }

  for (const text of ["Michael Jordan, J-O-R-D-A-N.", "Great.", "Perfecto.", "One moment.", "Un momento.", "Okay, Michael.", "0412 345 678", "", "   ", null, undefined, 42]) {
    it(`${JSON.stringify(text)} says no language of its own`, () => assert.equal(textLanguage(text), null));
  }

  it("Portuguese is no answer: the line can't speak it, so it's never taken for Spanish", () => {
    for (const text of ["Olá, você pode me ajudar amanhã?", "Obrigado, tenho uma consulta hoje.", "Não, muito obrigada."]) assert.equal(textLanguage(text), null, text);
  });

  it("names and places in another language don't move a sentence: its own words decide", () => {
    assert.equal(textLanguage("Your booking with Dr. Muñoz is at 10 on Wednesday."), "en");
    assert.equal(textLanguage("Su cita con el Dr. Smith es el lunes."), "es");
    assert.equal(textLanguage("Is that García, G-A-R-C-I-A?"), null, "too little to say");
  });

  it("a word counts for one language only (each list is the words no other here writes)", () => {
    const seen = new Map();
    for (const [code, words] of Object.entries(LANGUAGE_WORDS)) {
      for (const word of words) {
        assert.ok(!seen.has(word), `${word}: ${seen.get(word)} and ${code}`);
        seen.set(word, code);
        assert.equal(word, word.toLowerCase(), word);
      }
    }
    assert.deepEqual(Object.keys(LANGUAGE_WORDS), ["en", "es", "fr", "de", "it", "nl", "pt"]);
  });

  it("the edges: two words with nothing else is enough; one isn't; a rival needs to be outnumbered more than twice", () => {
    assert.equal(textLanguage("Thank you!"), "en");
    assert.equal(textLanguage("Gracias."), null);
    assert.equal(textLanguage("Thank you, gracias."), null, "2 against 1");
    assert.equal(textLanguage("Thank you so much, gracias."), null, "still 2 against 1");
    assert.equal(textLanguage("Thank you for that, gracias."), "en", "4 against 1");
    assert.equal(textLanguage("Gracias, muy bien, thanks."), null, "2 against 1");
  });

  it("a letter only one language writes counts twice: ¿ ¡ ñ, ß, œ, ã õ", () => {
    assert.equal(textLanguage("¿Mañana?"), "es");
    assert.equal(textLanguage("Die Straße."), "de");
    assert.equal(textLanguage("Não."), null, "Portuguese");
  });

  it("strict (a whole reply, or the caller's words): three words, and more than three times any other language's", () => {
    assert.equal(textLanguage("Sí, claro.", { strict: true }), null);
    assert.equal(textLanguage("Sí, hablo español.", { strict: true }), "es");
    assert.equal(textLanguage("Do you speak any other languages, by the way?", { strict: true }), "en");
    assert.equal(textLanguage("Two PM is good.", { strict: true }), null);
    assert.equal(textLanguage("Oh, plus español.", { strict: true }), "es", "español, with its ñ");
    assert.equal(textLanguage("I'd like a booking on Monday, por favor, gracias.", { strict: true }), "en", "4 against 1");
    assert.equal(textLanguage("Thank you, gracias, muy bien.", { strict: true }), null);
    assert.equal(textLanguage("日本語で話してもいいですか？", { strict: true }), "ja");
  });

  it("is linear on adversarial input", () => {
    const long = "la ".repeat(200_000) + "ñ".repeat(100_000);
    const t0 = Date.now();
    textLanguage(long);
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  });
});

describe("sentenceVoice: each sentence in its own language's voice (phone test F9)", () => {
  const session = (o = {}) => ({ fastLanguages: true, fastLanguage: "en", deepgramVoice: "aura-2-theia-en", baseDeepgramVoice: "aura-2-theia-en", ...o });

  it("a sentence clearly in a language gets that language's voice, whatever the line's", () => {
    assert.deepEqual(sentenceVoice(session(), "¡Claro! Puedo ayudarle en español."), { language: "es", voice: "aura-2-selena-es" });
    assert.deepEqual(sentenceVoice(session({ fastLanguage: "es", deepgramVoice: "aura-2-selena-es" }), "Let me book that for you."), { language: "en", voice: "aura-2-theia-en" });
    assert.deepEqual(sentenceVoice(session(), "はい、日本語で大丈夫です。"), { language: "ja", voice: "aura-2-uzume-ja" });
  });

  it("one whose words don't say: this reply's language so far, then the caller's this turn, then the line's", () => {
    const s = session({ fastLanguage: "fr", deepgramVoice: "aura-2-agathe-fr" });
    beginReplyLanguage(s, "Two PM is good.");
    assert.equal(s.fastTurnLanguage, null);
    assert.equal(sentenceVoice(s, "Perfecto.").language, "fr", "the line's");
    beginReplyLanguage(s, "Hola, buenos días, necesito una cita para mañana.");
    assert.equal(s.fastTurnLanguage, "es");
    assert.equal(sentenceVoice(s, "Perfecto.").voice, "aura-2-selena-es", "the caller's");
    assert.equal(sentenceVoice(s, "Of course, I can help you with that.").language, "en");
    assert.equal(sentenceVoice(s, "Michael Jordan.").language, "en", "this reply's so far");
    beginReplyLanguage(s, "Two PM is good.");
    assert.equal(s.fastReplyLanguage, null, "a new turn starts afresh");
    assert.equal(sentenceVoice(s, "Michael Jordan.").language, "fr");
  });

  it("a language whose voice failed is said in the assistant's voice", () => {
    const s = session({ fastFailedVoices: ["aura-2-selena-es"] });
    assert.deepEqual(sentenceVoice(s, "Sí, hablo español."), { language: "es", voice: "aura-2-theia-en" });
    assert.equal(languageVoice(s, "fr"), "aura-2-agathe-fr");
    assert.equal(languageVoice({ baseDeepgramVoice: null }, "en"), null, "no voice of its own: the clients' default");
  });

  it("notes every language it hears clearly (calls.metadata.fastPath.languages: re-transcription leaves such calls alone)", () => {
    const s = session();
    sentenceVoice(s, "Of course.");
    assert.equal(s.languagesUsed, undefined, "English alone is no switch");
    sentenceVoice(s, "Sí, hablo español.");
    beginReplyLanguage(s, "Bonjour, vous parlez français ? J'ai besoin d'un rendez-vous.");
    assert.deepEqual(s.languagesUsed, ["en", "es", "fr"]);
  });

  it("off with the kill switch: the line's voice, as before languages, and no caller language", () => {
    const s = session({ fastLanguages: false });
    assert.deepEqual(sentenceVoice(s, "¡Claro! Puedo ayudarle en español."), { language: "en", voice: "aura-2-theia-en" });
    beginReplyLanguage(s, "Hola, buenos días, necesito una cita para mañana.");
    assert.equal(s.fastTurnLanguage, null);
    assert.equal(s.languagesUsed, undefined);
  });
});
