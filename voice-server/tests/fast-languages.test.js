"use strict";

// SCRUM-594 (phone test F5): the demo line promised Arabic and sent Arabic text
// to an English voice. The fast path now offers exactly the languages it can
// hear (Flux Multilingual) AND speak (Aura-2), switches with set_language, and
// never sends a voice text in a script it can't say.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  FAST_LANGUAGES,
  FLUX_MULTI_MODEL,
  fastLanguagesEnabled,
  setLanguageToolDefinition,
  unspeakableText,
  applyLanguageSwitch,
  planLanguageSwitch,
  recordLanguageSwitch,
  UNSPEAKABLE_APOLOGY,
  LANGUAGE_UNHEARD_MESSAGE,
  detectCallerLanguage,
  detectCallerEnglish,
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
});

describe("fastLanguagesEnabled (kill switch FAST_LANGUAGES=off)", () => {
  it("is on unless FAST_LANGUAGES is off", () => {
    assert.equal(fastLanguagesEnabled({}), true);
    assert.equal(fastLanguagesEnabled({ FAST_LANGUAGES: "on" }), true);
    assert.equal(fastLanguagesEnabled({ FAST_LANGUAGES: "off" }), false);
    assert.equal(fastLanguagesEnabled({ FAST_LANGUAGES: " OFF " }), false);
  });
});

describe("setLanguageToolDefinition", () => {
  it("offers exactly the supported languages", () => {
    assert.equal(setLanguageToolDefinition.type, "function");
    assert.equal(setLanguageToolDefinition.function.name, "set_language");
    const language = setLanguageToolDefinition.function.parameters.properties.language;
    assert.deepEqual(language.enum, Object.keys(FAST_LANGUAGES));
    assert.deepEqual(setLanguageToolDefinition.function.parameters.required, ["language"]);
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
  it("Japanese is speakable only while the call is in Japanese (kana, kanji and the long-vowel mark)", () => {
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

describe("applyLanguageSwitch", () => {
  const session = () => ({ fastLanguage: "en", baseDeepgramVoice: "aura-2-theia-en", deepgramVoice: "aura-2-theia-en" });

  it("switches to Spanish: the Spanish voice, Spanish-then-English hints, recorded on the session", () => {
    const s = session();
    const sw = applyLanguageSwitch(s, "es");
    assert.equal(sw.ok, true);
    assert.equal(sw.changed, true);
    assert.equal(sw.from, "en");
    assert.equal(sw.to, "es");
    assert.equal(sw.voice, FAST_LANGUAGES.es.voice);
    assert.deepEqual(sw.hints, ["es", "en"]);
    assert.equal(s.fastLanguage, "es");
    assert.deepEqual(s.languagesUsed, ["en", "es"]);
    assert.match(sw.message, /Spanish/);
    assert.match(sw.message, /names, numbers, dates, times/);
  });

  it("back to English: the assistant's own voice and an English hint", () => {
    const s = session();
    applyLanguageSwitch(s, "fr");
    const sw = applyLanguageSwitch(s, "EN");
    assert.equal(sw.changed, true);
    assert.equal(sw.voice, "aura-2-theia-en");
    assert.deepEqual(sw.hints, ["en"]);
    assert.equal(s.fastLanguage, "en");
    assert.deepEqual(s.languagesUsed, ["en", "fr"]);
  });

  it("the language already in use changes nothing", () => {
    const s = session();
    const sw = applyLanguageSwitch(s, "en");
    assert.equal(sw.ok, true);
    assert.equal(sw.changed, false);
    assert.equal(s.languagesUsed, undefined);
  });

  it("a language this line can't speak is refused, and the model is told what to say instead", () => {
    const s = session();
    for (const bad of ["ar", "Arabic", "zh", "", null, undefined]) {
      const sw = applyLanguageSwitch(s, bad);
      assert.equal(sw.ok, false, String(bad));
      assert.equal(sw.changed, false);
      assert.match(sw.message, /English, Spanish, French, German, Italian, Dutch and Japanese/);
      assert.match(sw.message, /call (?:them )?back/);
    }
    assert.equal(s.fastLanguage, "en");
  });

  it("back to English without a recorded base voice: an English voice, never the Spanish one", () => {
    const s = { fastLanguage: "es", deepgramVoice: "aura-2-selena-es" };
    assert.equal(applyLanguageSwitch(s, "en").voice, "aura-2-theia-en");
  });
});

describe("planLanguageSwitch / recordLanguageSwitch (gate review: decide, then record only what happened)", () => {
  it("a plan changes nothing on the session; recording it does", () => {
    const s = { fastLanguage: "en", baseDeepgramVoice: "aura-2-theia-en", deepgramVoice: "aura-2-theia-en" };
    const plan = planLanguageSwitch(s, "de");
    assert.equal(plan.changed, true);
    assert.equal(plan.voice, "aura-2-elara-de");
    assert.equal(s.fastLanguage, "en");
    assert.equal(s.languagesUsed, undefined);
    recordLanguageSwitch(s, plan);
    assert.equal(s.fastLanguage, "de");
    assert.deepEqual(s.languagesUsed, ["en", "de"]);
  });
  it("the unheard message says to carry on in English and offer a call-back", () => {
    assert.match(LANGUAGE_UNHEARD_MESSAGE, /^NOT SWITCHED/);
    assert.match(LANGUAGE_UNHEARD_MESSAGE, /English/);
    assert.match(LANGUAGE_UNHEARD_MESSAGE, /call (?:them )?back/);
  });
});

describe("detectCallerLanguage (F5 simulated calls: a French caller was answered in French by the English voice)", () => {
  for (const [text, code] of [
    ["Bonjour, vous parlez français ?", "fr"],
    ["Mon eau chaude est tiède depuis deux jours. Ce n'est pas urgent.", "fr"],
    ["Hola, ¿habla español?", "es"],
    ["Tengo un problema, por favor.", "es"], // confirmation review: "por favor" is Spanish, not a Portuguese decoy's
    ["Sí, por favor. Necesito que arreglen una llave que gotea en la cocina.", "es"],
    ["Guten Tag, sprechen Sie Deutsch?", "de"],
    ["Ich habe ein Problem mit meiner Heizung.", "de"],
    ["Buongiorno, parla italiano?", "it"],
    ["Ho una perdita sotto il lavandino della cucina.", "it"],
    ["Goedemiddag, spreekt u Nederlands?", "nl"],
    ["Ik heb een lekkage onder de gootsteen.", "nl"],
    ["日本語で話してもいいですか？", "ja"],
    ["トイレの水が止まらないんです。", "ja"],
  ]) {
    it(`${JSON.stringify(text)} is ${code}`, () => assert.equal(detectCallerLanguage(text), code));
  }

  for (const text of [
    "Hello, do you speak Spanish?",
    "Can you speak French?",
    "My name is José García.",
    "I live on Calle de la Rosa.",
    "Merci.",
    "Sí.",
    "Ja.",
    "Oui, d'accord.",
    "Gracias",
    "I'd like a booking on Monday, por favor.",
    "Yes, the Rue de la Paix one, thanks.",
    "Hi, I need a cita para mañana por favor, thanks.",
    // gate review
    "你好。我叫王小明。",
    "15 Avenida Del Mar, Los Gatos, Las Vegas.",
    "Olá, você fala português? Preciso de um encanador.",
    "Eu preciso de uma consulta para amanhã, por favor, obrigado.",
    "Hola, gracias, buenos días; ciao, grazie, buongiorno.",
    "Hello ね, thanks.",
    "Necesito cita mañana, por favor, thanks, okay.", // two English words to five Spanish: still English enough
    "مرحبا، هل تتكلم العربية؟",
    "我想预约",
    "",
    null,
  ]) {
    it(`${JSON.stringify(text)} is no clear other language`, () => assert.equal(detectCallerLanguage(text), null));
  }
});

describe("detectCallerEnglish (phone test F9: back in English, the caller heard the Spanish voice read English)", () => {
  for (const text of [
    "No. I just want to check if you speak any other languages.", // F9, word for word
    "No. I just want to check if you speak any other languages. Thank you.",
    "Can you speak English?",
    "Do you speak English?",
    "Can we speak in English, please?",
    "Hello, can you hear me?",
    "No. That's all. Thank you.",
    "What time is available today?",
    "The appointment is for tomorrow at two.",
    "I'm sorry. Can you repeat that again, please?",
    "Okay, thank you very much.",
    "My name is Juan García.",
    "Yes, I want to book 明日",
  ]) {
    it(`${JSON.stringify(text)} is English`, () => assert.equal(detectCallerEnglish(text), true));
  }

  for (const text of [
    // too short to tell: a Spanish caller says these too
    "Okay, thank you.",
    "Thank you very much.",
    "Yes, please.",
    "English, please.",
    "Sorry?",
    "Hello? Hello?",
    "Alright. Anything else?",
    "Two PM is good.",
    "Yes I do",
    // mixed: the other language holds its own
    "Sí, sí, thank you, gracias.",
    "Gracias, thank you very much, adiós.",
    "Okay, thank you. ¿Y a qué hora llega?",
    "Quiero hablar en inglés, please.",
    "Necesito cita mañana, por favor, thanks, okay.",
    // the line's other languages ("is" is Dutch too)
    "¿Hablas español?",
    "Muy bien, gracias. ¿Y usted?",
    "Mi nombre es Juan.",
    "Bonjour, vous parlez français ?",
    "Oui, d'accord, merci beaucoup, c'est parfait pour moi.",
    "Ja, ich habe heute einen Termin.",
    "Is het mogelijk om morgen te komen?",
    "Is dinsdagochtend nog vrij?",
    "Ho una perdita sotto il lavandino.",
    "トイレの水が止まらないんです。",
    // a spelling, repeats, nothing
    "J O R D A N",
    "J-O-R-D-A-N.",
    "ok ok ok ok",
    "the the the the",
    "",
    "   ",
    null,
    undefined,
    42,
  ]) {
    it(`${JSON.stringify(text)} is not clearly English`, () => assert.equal(detectCallerEnglish(text), false));
  }

  it("the edges: four words with three English ones is enough; three words or two English ones are not", () => {
    assert.equal(detectCallerEnglish("Can you hear this"), true); // can, you, this
    assert.equal(detectCallerEnglish("Can you hear"), false, "three words");
    assert.equal(detectCallerEnglish("Can you hear jamón"), false, "two English words");
  });

  it("the edges: at least three times as many English words as any other language's", () => {
    // 4 English (i, want, to, the) to 2 Spanish (para, hoy): 2 x 3 > 4
    assert.equal(detectCallerEnglish("I want to see the plumber para hoy"), false);
    // 7 English (i, want, to, the, and, need, it) to 2 Spanish: 2 x 3 <= 7
    assert.equal(detectCallerEnglish("I want to see the plumber para hoy and need it"), true);
    // 3 English (i, want, to) to 1 Spanish (hoy): exactly three times
    assert.equal(detectCallerEnglish("I want to go hoy"), true);
    // 3 English to 2 Spanish
    assert.equal(detectCallerEnglish("I want to go hoy para"), false);
  });
});
