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
  UNSPEAKABLE_APOLOGY,
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
