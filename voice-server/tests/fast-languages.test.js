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
  asksInLanguage,
  namesLanguage,
  ENGLISH_LOOKALIKES,
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
    ["Je m'appelle Marie, j'ai besoin d'aide.", "fr"], // test review: elisions count by their parts (appelle, ai)
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

describe("asksInLanguage (re-review: \"Sí, en inglés, por favor\" is Spanish asking for English)", () => {
  for (const [code, text] of [
    ["en", "Sí, en inglés, por favor."],
    ["en", "Oui, en anglais s'il vous plaît, merci."],
    ["en", "Ja, bitte auf Englisch, danke."],
    ["en", "Sì, in inglese per favore, grazie."],
    ["en", "Ja, in het Engels graag, dank je."],
    ["en", "はい、英語でお願いします。"],
    ["es", "Can you say that again in Spanish?"],
    ["es", "¿Me lo dice en español?"],
    ["ja", "Can you say that in 日本語?"],
  ]) {
    it(`${JSON.stringify(text)} asks for ${code}`, () => assert.equal(asksInLanguage(text, code), true));
  }
  for (const [code, text] of [
    ["en", "No hablo inglés, ¿habla español?"],
    ["en", "英語は話せません"],
    ["en", "My English is fine"],
    ["es", "No. I just want to check if you speak Spanish."],
    ["es", "The Spanish voice is nice"],
  ]) {
    it(`${JSON.stringify(text)} names ${code} but doesn't ask for it`, () => assert.equal(asksInLanguage(text, code), false));
  }
  it("namesLanguage: any mention, as a whole word", () => {
    assert.equal(namesLanguage("No hablo inglés", "en"), true);
    assert.equal(namesLanguage("Can you speak ENGLISH?", "en"), true);
    assert.equal(namesLanguage("A germane point", "de"), false);
    assert.equal(namesLanguage("日本語は少し", "ja"), true);
  });
});

describe("phone test F9: the switch note and its bookkeeping", () => {
  it("set_language's note says to keep the language until the caller changes it, not \"from now on\" (code review)", () => {
    const { message } = planLanguageSwitch({ fastLanguage: "en", baseDeepgramVoice: "aura-2-theia-en" }, "es");
    assert.match(message, /Speak only Spanish until the caller changes language;/);
    assert.doesNotMatch(message, /from now on/);
  });

  it("any recorded switch ends an automatic return to English", () => {
    const session = { fastLanguage: "en", languagesUsed: ["en", "es"], fastAutoEnglish: true };
    recordLanguageSwitch(session, { changed: true, to: "es" });
    assert.equal(session.fastAutoEnglish, false);
    session.fastAutoEnglish = true;
    recordLanguageSwitch(session, { changed: false, to: "es" });
    assert.equal(session.fastAutoEnglish, true, "no switch, nothing recorded");
  });
});

describe("detectCallerEnglish (phone test F9: back in English, the caller heard the Spanish voice read English)", () => {
  for (const text of [
    "No. I just want to check if you speak any other languages.", // F9, word for word
    "What's the time? There's a leak under the sink.", // test review: a contraction counts by its parts (what, there)
    "No. I just want to check if you speak any other languages. Thank you.",
    "Can you speak English?",
    "Do you speak English?",
    "Can we speak in English, please?",
    "Hello, can you hear me?",
    "No. That's all. Thank you.",
    "What time is available today?",
    "The appointment is for tomorrow at two.",
    "I'm sorry. Can you repeat that again, please?",
    "My name is Juan García.",
    "Yes, I want to book 明日", // one kanji, no kana
    "Yes, I want to book あ", // one kana
  ]) {
    it(`${JSON.stringify(text)} is English`, () => assert.equal(detectCallerEnglish(text), true));
  }

  for (const text of [
    // too short to tell, or only the courtesies anyone uses: a Spanish caller says these too
    "Okay, thank you.",
    "Okay, thank you very much.",
    "Okay, thanks. It's Sami Khoury.",
    "Thank you so much, have a good day",
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
    // re-review: Japanese with English words in it (else the line flips en ⇄ ja every turn)
    "はい、I want to book an appointment for tomorrow",
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

  it("the courtesies anyone uses (okay, ok, thanks, thank, yes, yeah, please, hello, hi) don't count toward English", () => {
    assert.equal(detectCallerEnglish("Okay, yes, thanks, please, hello, hi, yeah, ok, thank"), false);
    assert.equal(detectCallerEnglish("Okay thanks, so I can see you"), true); // i, can, you
    assert.equal(detectCallerEnglish("Okay thanks, so I can see"), false, "two besides the courtesies");
  });

  it("security review: the line's own words that look English never count there", () => {
    for (const [language, text] of [
      ["de", "Ich will am Montag in der Früh kommen"],
      ["de", "Was will er am Montag in der Werkstatt"],
      ["nl", "Het lek is in de badkamer en het was erg"],
      ["it", "I tubi in cucina, me lo può dire"],
      // code review and silent-failure review: booking talk, with English day and time words nearby
      ["de", "Was geht am Dienstag in der Früh?"],
      ["de", "Am Montag in der Früh, was ist da frei?"],
      ["de", "Was kostet das am Montag in der Früh?"],
      ["de", "Was ist am Dienstag in der Früh?"],
      ["de", "Ich will am Montag in die Stadt."],
      ["nl", "Is dinsdag in de ochtend of in de middag?"],
      ["nl", "Is morgen in de ochtend of in de middag beter?"],
      ["nl", "Het is in de badkamer, want de kraan lekt."],
      ["nl", "Is het in de ochtend of in de middag?"],
      ["nl", "Was het in de ochtend of in de middag?"],
      ["nl", "Is het mogelijk om in de middag te komen, want ik werk in de ochtend?"],
    ]) {
      assert.equal(detectCallerEnglish(text, language), false, `${language}: ${text}`);
    }
    assert.equal(detectCallerEnglish("No. I just want to check if you speak any other languages.", "de"), true, "real English still is");
    assert.equal(detectCallerEnglish("No. I just want to check if you speak any other languages.", "es"), true);
  });

  it("code review: English words asking for the line's own language are the model's to answer, not a switch back", () => {
    for (const [language, text] of [
      ["es", "Can you say that again in Spanish?"],
      ["es", "Can you say something else in español?"],
      ["fr", "Can you say that again in French, please?"],
      ["de", "Can you say that again in German, please?"],
      ["it", "Can you say that again in Italian, please?"],
      ["nl", "Can you say that again in Dutch, please?"],
      ["ja", "Can you say that again in Japanese, please?"],
      ["ja", "Can you say that again in 日本語, please?"],
    ]) {
      assert.equal(detectCallerEnglish(text, language), false, `${language}: ${text}`);
      assert.equal(detectCallerEnglish(text), true, `without the line's language it reads as English: ${text}`);
    }
    assert.equal(detectCallerEnglish("Can we switch back to English instead of Spanish?", "es"), true, "naming English too: a switch back");
    // re-review: only a request IN the language; a mention or a refusal is English
    for (const text of [
      "No. I just want to check if you speak Spanish.",
      "Sorry, I don't speak Spanish.",
      "Sorry, my Spanish is not very good.",
      "Why are you speaking Spanish? I need to book an appointment.",
      "I can't understand you in Spanish, I want to book an appointment",
      "Why in Spanish? I want to book an appointment please",
    ]) assert.equal(detectCallerEnglish(text, "es"), true, text);
    assert.equal(detectCallerEnglish("No, I want it in Spanish.", "es"), false);
    assert.equal(detectCallerEnglish("Could you repeat that in Spanish for me", "es"), false);
    assert.equal(detectCallerEnglish("Can you say that again in Spanish?", "fr"), true, "another line's language is no request for this one");
    assert.equal(detectCallerEnglish("That is a germane point, can you help me with the booking", "de"), true, "a whole word only");
  });

  it("each look-alike counts as English everywhere but on its own language's line", () => {
    for (const [language, words] of Object.entries(ENGLISH_LOOKALIKES)) {
      for (const word of words) {
        const text = `${word} you can xyz`;
        assert.equal(detectCallerEnglish(text, language), false, `${language}: ${word}`);
        assert.equal(detectCallerEnglish(text, "ja"), true, `ja: ${word}`);
        assert.equal(detectCallerEnglish(text), true, `no language: ${word}`);
      }
    }
    assert.deepEqual(Object.fromEntries(Object.entries(ENGLISH_LOOKALIKES).map(([code, set]) => [code, [...set].sort()])), {
      es: ["has", "me"],
      fr: ["me", "on"],
      de: ["am", "in", "name", "was", "will"],
      it: ["do", "i", "in", "me"],
      nl: ["in", "is", "me", "of", "want", "was"],
    });
  });

  it("the edges: four words with three English ones is enough; three words or two English ones are not", () => {
    assert.equal(detectCallerEnglish("Can you hear this"), true); // can, you, this
    assert.equal(detectCallerEnglish("Can you speak"), false, "three words, all three English");
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
