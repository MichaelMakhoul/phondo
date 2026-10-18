"use strict";

// SCRUM-594 (F5 simulated calls): the booking guards in the fast path's other
// languages. A simulated Spanish caller answered "¿Es correcto?" with "Sí, es
// correcto, K-H-O-U-R-Y" and the spelling guard held the booking twice more,
// then stepped aside with an alert: it knew only "Is that right?" and "yes".
// The same blind spot would let a French "Non, attendez" through the cancel gate.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { guardWords } = require("../lib/guard-languages");
const { FAST_LANGUAGES } = require("../lib/fast-languages");
const {
  spelledRuns,
  isAffirmative,
  surnameSpellingConfirmed,
  declinesCancel,
  cancelGoAhead,
  fastCancelGate,
  checkBookingGuards,
} = require("../lib/booking-guards");
const { CallSession } = require("../call-session");

const ai = (content) => ({ role: "assistant", content });
const caller = (content) => ({ role: "user", content });

describe("guardWords", () => {
  it("has words for every language set_language offers, and none for English or any other", () => {
    for (const code of Object.keys(FAST_LANGUAGES)) {
      if (code === "en") assert.equal(guardWords(code), null);
      else assert.ok(guardWords(code), code);
    }
    for (const other of ["ar", "zh", "", null, undefined, "ES"]) assert.equal(guardWords(other), null, String(other));
  });
});

describe("spelledRuns: a spelling written against Japanese text", () => {
  it("reads K-H-O-U-R-Y between kana and kanji", () => {
    assert.deepEqual(spelledRuns("名字はK-H-O-U-R-Yでよろしいでしょうか？"), ["KHOURY"]);
    assert.deepEqual(spelledRuns("「K-H-O-U-R-Y」ですね。"), ["KHOURY"]);
  });

  it("a one-letter word at either end of a spelling isn't one of its letters (\"è K-H-O-U-R-Y. È…\", \"K-H-O-U-R-Y y su número\")", () => {
    assert.deepEqual(spelledRuns("Lo tengo como K-H-O-U-R-Y y su número es el mismo."), ["KHOURY"]);
    assert.deepEqual(spelledRuns("Il cognome è K-H-O-U-R-Y e il numero è questo."), ["KHOURY"]);
    assert.deepEqual(spelledRuns("Il cognome è K-H-O-U-R-Y. È corretto?"), ["KHOURY"]);
    assert.deepEqual(spelledRuns("Il cognome è K, H, O, U, R, Y. È corretto?"), ["KHOURY"]);
    assert.deepEqual(spelledRuns("K, H, O, U, R, Y"), ["KHOURY"]);
    assert.deepEqual(spelledRuns("That's N G, a lovely name."), ["NG"], "a two-letter name spelled with spaces");
    // last confirmation review: short Italian read-backs after "è"
    assert.deepEqual(spelledRuns("Il cognome è L-I. È corretto?"), ["LI"]);
    assert.deepEqual(spelledRuns("Il cognome è N-G, giusto?"), ["NG"]);
    assert.equal(surnameSpellingConfirmed([ai("Il cognome è D-I S-T-E-F-A-N-O. È corretto?"), caller("Sì.")], "Di Stefano", "it").confirmed, true);
    assert.deepEqual(spelledRuns("Is it a K-H-O-U-R-Y?"), ["KHOURY"]);
    assert.deepEqual(spelledRuns("K-H-O-U-R-Y, a lovely name."), ["KHOURY"]);
  });

  it("a spelling with one kind of separator keeps every letter", () => {
    assert.deepEqual(spelledRuns("K h o u r y y"), ["KHOURYY"], "spaces throughout: the y can't be told apart");
    assert.deepEqual(spelledRuns("A, N, N, A."), ["ANNA"]);
    assert.deepEqual(spelledRuns("M. A. K. H. O. U. L."), ["MAKHOUL"]);
  });

  it("English spellings read as before", () => {
    assert.deepEqual(spelledRuns("That's K-H-O-U-R-Y, right?"), ["KHOURY"]);
    assert.deepEqual(spelledRuns("K h o u r y."), ["KHOURY"]);
    assert.deepEqual(spelledRuns("It's M. A. K. H. O. U. L."), ["MAKHOUL"]);
    assert.deepEqual(spelledRuns("Is it C-U-R-R-Y or K-H-O-U-R-Y?"), ["CURRY", "KHOURY"]);
  });
});

describe("isAffirmative in the call's language", () => {
  const yes = {
    es: ["Sí, es correcto.", "Sí.", "Correcto, K-H-O-U-R-Y.", "Exacto.", "Eso es.", "Así es, gracias.", "Exactamente.", "Sí, no se preocupe, es correcto."],
    fr: ["Oui, c'est ça.", "Oui.", "Exactement.", "C'est correct.", "Tout à fait.", "C'est bien ça.", "Oui, pas de problème, c'est ça."],
    de: ["Ja, genau.", "Ja.", "Richtig.", "Stimmt.", "Das stimmt so.", "Ja, kein Problem, das stimmt."],
    it: ["Sì, esatto.", "Sì.", "Corretto.", "Giusto.", "Perfetto, grazie.", "Sì, nessun problema, è giusto."],
    nl: ["Ja, dat klopt.", "Ja.", "Klopt.", "Precies.", "Dat is juist.", "Ja, geen probleem, dat klopt."],
    ja: ["はい、そうです。", "はい。", "合っています。", "その通りです。", "大丈夫です。", "はい、間違いありません。", "間違いありません。", "はい、問題ありません。", "はい、すみません、そうです。", "相違ありません。"],
  };
  const notYes = {
    es: ["No, es con K.", "No es así.", "Está mal.", "Espere.", "Sí, pero es con K al principio.", "Eso no es correcto.", "¡Claro que no!"],
    fr: ["Non, c'est avec un K.", "Ce n'est pas ça.", "Pas tout à fait.", "Non, pas correct.", "Oui, mais avec un K.", "Pas exactement."],
    de: ["Nein, mit K.", "Nicht ganz.", "Das ist falsch.", "Moment mal.", "Ja, aber mit K.", "Passt nicht.", "Das stimmt leider nicht."],
    it: ["No, con la K.", "Non è giusto.", "Sbagliato.", "Aspetti.", "Sì, ma con la K.", "Non esattamente.", "Non mi sembra giusto."],
    nl: ["Nee, met een K.", "Niet helemaal.", "Dat klopt niet.", "Fout.", "Ja, maar met een K.", "Dat klopt helaas niet."],
    ja: ["いいえ、違います。", "違います。", "ちょっと待ってください。", "はい、でもKから始まります。", "はい、違います。", "ええと、最初の文字はCです。", "はい、CじゃなくてKです。", "合っていません。",
      "はい、違ってます。", "Kじゃなくて、Cです。", "最初が違って、Cです。", "ええっと、最初はCです。", "ええーと…"],
  };
  for (const [language, lines] of Object.entries(yes)) {
    for (const line of lines) it(`"${line}" is a yes on a ${language} call`, () => assert.equal(isAffirmative(line, language), true));
  }
  for (const [language, lines] of Object.entries(notYes)) {
    for (const line of lines) it(`"${line}" is not a yes on a ${language} call`, () => assert.equal(isAffirmative(line, language), false));
  }

  it("words are whole words: \"casi\" (almost) has no \"si\" in it, \"domattina\" no \"ma\"", () => {
    assert.equal(isAffirmative("Casi.", "es"), false);
    assert.equal(isAffirmative("Sì, domattina va bene.", "it"), true);
  });

  it("a French \"non\" outweighs a yes word in the same reply", () => {
    assert.equal(isAffirmative("Ah non, d'accord, je comprends.", "fr"), false);
  });

  it("an English call is unchanged: another language's yes is no yes", () => {
    assert.equal(isAffirmative("Sí, es correcto."), false);
    assert.equal(isAffirmative("Oui."), false);
    assert.equal(isAffirmative("はい。", "en"), false);
    assert.equal(isAffirmative("Yes, that's right."), true);
  });

  it("English words still count on a call in another language", () => {
    assert.equal(isAffirmative("Yes, that's right.", "es"), true);
    assert.equal(isAffirmative("No, that's wrong.", "fr"), false);
  });
});

describe("surnameSpellingConfirmed in the call's language", () => {
  const confirmed = {
    es: ["Su apellido es K-H-O-U-R-Y. ¿Es correcto?", "Sí, es correcto."],
    fr: ["Votre nom s'écrit K-H-O-U-R-Y. C'est bien ça ?", "Oui, c'est ça."],
    de: ["Ihr Nachname ist K-H-O-U-R-Y. Stimmt das?", "Ja, genau."],
    it: ["Il cognome è K-H-O-U-R-Y. È corretto?", "Sì, esatto."],
    nl: ["Uw achternaam is K-H-O-U-R-Y. Klopt dat?", "Ja, dat klopt."],
    ja: ["名字はK-H-O-U-R-Yですね。よろしいでしょうか？", "はい、そうです。"],
  };
  for (const [language, [question, answer]] of Object.entries(confirmed)) {
    it(`${language}: a read-back, a short "is that right?" and a yes confirm it`, () => {
      assert.deepEqual(surnameSpellingConfirmed([ai(question), caller(answer)], "Khoury", language), { confirmed: true, reason: "confirmed" });
    });
  }

  const spellQuestion = {
    es: ["K-H-O-U-R-Y. ¿Así se escribe su apellido?", "Sí."],
    fr: ["K-H-O-U-R-Y. C'est comme ça que ça s'écrit ?", "Oui."],
    de: ["K-H-O-U-R-Y. Schreibt man das so?", "Ja."],
    it: ["K-H-O-U-R-Y. Si scrive così?", "Sì."],
    nl: ["K-H-O-U-R-Y. Schrijf je het zo?", "Ja."],
    ja: ["K-H-O-U-R-Y。このつづりで合っていますか？", "はい。"],
  };
  for (const [language, [question, answer]] of Object.entries(spellQuestion)) {
    it(`${language}: "is that how it's spelled?" after the read-back counts too`, () => {
      assert.equal(surnameSpellingConfirmed([ai(question), caller(answer)], "Khoury", language).confirmed, true);
    });
  }

  const otherQuestion = {
    es: "Lo tengo como K-H-O-U-R-Y. ¿Y su número de teléfono?",
    fr: "C'est K-H-O-U-R-Y. Et votre numéro de téléphone ?",
    de: "K-H-O-U-R-Y. Und Ihre Telefonnummer?",
    it: "K-H-O-U-R-Y. E il suo numero di telefono?",
    nl: "K-H-O-U-R-Y. En uw telefoonnummer?",
    ja: "K-H-O-U-R-Yですね。お電話番号はこちらの番号でよろしいですか？",
  };
  for (const [language, question] of Object.entries(otherQuestion)) {
    it(`${language}: a read-back followed by another question isn't asked — the yes answers that question`, () => {
      assert.deepEqual(surnameSpellingConfirmed([ai(question), caller(language === "ja" ? "はい。" : "Sí.")], "Khoury", language), { confirmed: false, reason: "not-asked" });
    });
  }

  it("the F5 simulated call: the read-back, \"¿Es correcto?\", and the caller's yes (it was held twice, then an alert)", () => {
    const t = [
      ai("Gracias por corregirme, Sami. Lo tengo como K-H-O-U-R-Y. ¿Y tu número de móvil es el +61412555013, el mismo desde el que llamas?"),
      caller("Sí, ese es mi número, el mismo desde el que llamo."),
      ai("Solo para confirmar: tu apellido es K-H-O-U-R-Y. ¿Es correcto?"),
      caller("Sí, es correcto, K h o u r y."),
    ];
    assert.deepEqual(surnameSpellingConfirmed(t, "Khoury", "es"), { confirmed: true, reason: "confirmed" });
    assert.equal(surnameSpellingConfirmed(t.slice(0, 2), "Khoury", "es").reason, "not-asked", "the first read-back went on to the phone number");
  });

  it("the simulated Japanese call: a question ending in 「か。」 is a question — the yes went to the phone number, not the spelling", () => {
    const t = [
      ai("ありがとうございます。K-H-O-U-R-Y様ですね。次に、折り返し連絡に使える携帯番号を教えていただけますか。今おかけになっている番号でも構いません。"),
      caller("今おかけしているこの番号で大丈夫です。"),
    ];
    assert.deepEqual(surnameSpellingConfirmed(t, "Khoury", "ja"), { confirmed: false, reason: "not-asked" });
    const asked = [ai("K-H-O-U-R-Y様で間違いございませんか。"), caller("はい、間違いありません。")];
    assert.deepEqual(surnameSpellingConfirmed(asked, "Khoury", "ja"), { confirmed: true, reason: "confirmed" });
    // a long question that only sounds like "is that right?" is about something else (the time)
    const time = [ai("K-H-O-U-R-Y様ですね。ご予約は火曜日の午前9時から10時までの枠でよろしいでしょうか。"), caller("はい。")];
    assert.equal(surnameSpellingConfirmed(time, "Khoury", "ja").reason, "not-asked");
  });

  it("the simulated Spanish call: another detail named between the spelling and a generic \"¿Es ese el correcto?\" — that question is about the detail", () => {
    const t = [
      ai("Perfecto, K-H-O-U-R-Y. ¿Y su número de móvil para confirmar la cita? Lo estoy viendo desde el número desde el que llama, +61 412 555 013. ¿Es ese el correcto?"),
      caller("Sí, ese número es correcto."),
    ];
    assert.deepEqual(surnameSpellingConfirmed(t, "Khoury", "es"), { confirmed: false, reason: "not-asked" });
  });

  it("gate review: a short question about a day or time isn't a spelling check (\"¿Le viene bien el martes?\")", () => {
    for (const [language, question, yes] of [
      ["es", "K-H-O-U-R-Y. ¿Le viene bien el martes?", "Sí."],
      ["es", "K-H-O-U-R-Y. ¿A las 9?", "Sí."],
      ["fr", "K-H-O-U-R-Y. Mardi, ça vous va ?", "Oui."],
      ["de", "K-H-O-U-R-Y. Passt Dienstag?", "Ja."],
      ["it", "K-H-O-U-R-Y. Va bene martedì?", "Sì."],
      ["nl", "K-H-O-U-R-Y. Is dinsdag goed?", "Ja."],
      ["ja", "K-H-O-U-R-Yですね。火曜日でよろしいですか？", "はい。"],
      ["en", "K-H-O-U-R-Y. Is Tuesday okay?", "Yes."],
    ]) {
      assert.equal(surnameSpellingConfirmed([ai(question), caller(yes)], "Khoury", language).reason, "not-asked", `${language}: ${question}`);
    }
  });

  it("final run: a Japanese request (「…教えてください。」) after the read-back is the question — the yes was about the phone", () => {
    const t = [ai("失礼しました。K-H-O-U-R-Y で、サミ・コウリーさんですね。次に、連絡の取れる携帯番号を教えてください。"), caller("今おかけしている番号で大丈夫です。")];
    assert.deepEqual(surnameSpellingConfirmed(t, "Khoury", "ja"), { confirmed: false, reason: "not-asked" });
    // final review: 確認 alone is no check (「確認ですが、緊急ですか」 asks about urgency); a check that asks to be told if it's wrong is one
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Yですね。確認ですが、緊急ですか。"), caller("はい、急ぎです。")], "Khoury", "ja").reason, "not-asked");
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Yでよろしいですか。違っていたら教えてください。"), caller("はい、合っています。")], "Khoury", "ja").confirmed, true);
    // final confirmation review: 「それでは、」 is a conjunction, not 「それで（よろしいですか）」
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Yですね。それでは、ご来院は初めてでよろしいですか。"), caller("はい。")], "Khoury", "ja").reason, "not-asked");
    // re-review: a short question of the right length about something else isn't a check (「ご来院は初めて…」)
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Yですね。ご来院は初めてでよろしいですか。"), caller("はい。")], "Khoury", "ja").reason, "not-asked");
    // final review: the spelling and another detail in one request (a comma, not 。)
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Yですね、では携帯番号を教えてください。"), caller("大丈夫です。")], "Khoury", "ja").reason, "not-asked");
    const photo = [ai("K-H-O-U-R-Yですね。次に、写真をお願いします。"), caller("はい。")];
    assert.equal(surnameSpellingConfirmed(photo, "Khoury", "ja").reason, "not-asked", "a request for something else, no detail named");
    const confirm = [ai("K-H-O-U-R-Yですね。ご確認をお願いします。"), caller("はい、合っています。")];
    assert.deepEqual(surnameSpellingConfirmed(confirm, "Khoury", "ja"), { confirmed: true, reason: "confirmed" });
  });

  it("final run: a read-back with no question that goes on to another detail isn't a spelling check (English too)", () => {
    assert.equal(surnameSpellingConfirmed([ai("That's K-H-O-U-R-Y. And your phone number, please."), caller("Yes.")], "Khoury").reason, "not-asked");
    assert.equal(surnameSpellingConfirmed([ai("Lo tengo como K-H-O-U-R-Y. Ahora su número de teléfono, por favor."), caller("Sí.")], "Khoury", "es").reason, "not-asked");
    assert.equal(surnameSpellingConfirmed([ai("That's K-H-O-U-R-Y."), caller("Yes.")], "Khoury").confirmed, true, "a bare read-back still counts");
  });

  it("gate review: a short question needs a check word (\"¿Y usted?\" is no spelling check)", () => {
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Y. ¿Y usted?"), caller("Sí.")], "Khoury", "es").reason, "not-asked");
  });

  it("an English call is unchanged: \"¿Es correcto?\" is no question it knows", () => {
    assert.equal(surnameSpellingConfirmed([ai("Su apellido es K-H-O-U-R-Y. ¿Es correcto?"), caller("Yes.")], "Khoury").reason, "not-asked");
  });
});

describe("declinesCancel in the call's language", () => {
  const declines = {
    es: ["No, espere.", "No la cancele, por favor.", "Mejor no.", "Déjela como está.", "Un momento.", "Por favor, no la canceles.", "Déjala.", "Cambié de opinión."],
    fr: ["Non, attendez.", "Ne l'annulez pas.", "Gardez-le, finalement.", "Non.", "Laissez tomber.", "Finalement, je le garde.", "J'ai changé d'avis."],
    de: ["Nein, warten Sie.", "Bitte nicht stornieren.", "Lassen Sie ihn.", "Nein.", "Doch nicht.", "Nee.", "Nö.", "Stornieren Sie ihn bitte nicht.", "Lieber nicht.", "Stornieren Sie ihn nicht."],
    it: ["No, aspetti.", "Non la cancelli.", "Lasci stare.", "Un attimo.", "Ci ho ripensato.", "Lasci perdere.", "Ho cambiato idea."],
    nl: ["Nee, wacht.", "Niet annuleren.", "Laat maar.", "Nee.", "Toch niet.", "Toch maar niet.", "Liever niet."],
    ja: ["いいえ、待ってください。", "キャンセルしないでください。", "やっぱりやめます。", "いいえ。", "キャンセルはしないでください。", "取り消さないでください。"],
  };
  const goAheads = {
    es: ["Sí, cancélela, por favor.", "Sí, no hay problema.", "Sí, por favor, ya no la necesito.", "No hay problema, cancélela.", "No se preocupe, cancélela."],
    fr: ["Oui, annulez-le.", "Oui, pas de problème."],
    de: ["Ja, bitte stornieren.", "Ja, kein Problem."],
    it: ["Sì, la cancelli.", "Sì, nessun problema."],
    nl: ["Ja, annuleer maar.", "Ja, geen probleem."],
    ja: ["はい、キャンセルしてください。", "はい、お願いします。", "はい、間違いありません。", "はい、取りやめてください。"],
  };
  for (const [language, lines] of Object.entries(declines)) {
    for (const line of lines) it(`"${line}" takes the cancel back on a ${language} call`, () => assert.equal(declinesCancel(line, language), true));
  }
  for (const [language, lines] of Object.entries(goAheads)) {
    for (const line of lines) it(`"${line}" doesn't take it back on a ${language} call`, () => assert.equal(declinesCancel(line, language), false));
  }

  it("an English call is unchanged", () => {
    assert.equal(declinesCancel("Non, attendez."), false);
    assert.equal(declinesCancel("No, wait."), true);
  });
});

describe("a held cancel in another language goes through only on a clear go-ahead (confirmation reviews)", () => {
  // The tables can't list every way to take a cancel back ("Lascia stare", 「そのままでお願いします」):
  // an explicit refusal drops the cancel, an unclear answer keeps it held for one more read-back,
  // and only a clear yes or "cancel it" lets it through — never a cancel the caller refused.
  const declines = {
    es: ["Por favor, no la canceles.", "Déjala.", "Mejor déjala.", "Olvídalo.", "Mantenla.", "He cambiado de opinión.", "Cambié de opinión.", "Mejor la mantengo.", "Prefiero mantenerla.",
      "Pensándolo bien, mejor la dejo.", "Un segundo.", "Ni hablar.", "Espera.", "Para, para.", "Al final no.", "Todavía no.", "No la cancelen.", "Mejor que no.", "Quiero mantener la cita.", "Sí, pero la del jueves, no esta."],
    fr: ["Finalement, je le garde.", "Je préfère le garder.", "J'ai changé d'avis.", "Attends.", "Une seconde.", "Pas question.", "Surtout pas.", "Ne l'annulez surtout pas.", "Je vais le garder.",
      "Laissez-le.", "Gardez-le.", "Oubliez ça.", "Plutôt pas.", "N'annulez rien.", "Je le garde finalement."],
    de: ["Nee.", "Nö.", "Ne, lieber nicht.", "Lieber nicht.", "Bitte nicht.", "Ich behalte ihn.", "Ich behalte den Termin.", "Ich hab's mir anders überlegt.", "Halt.", "Stopp.", "Warte.",
      "Stornieren Sie ihn bitte nicht.", "Lass mal.", "Noch nicht.", "Nicht stornieren.", "Den Termin bitte behalten.", "Ach, lassen Sie es.", "Einen Moment."],
    it: ["Ho cambiato idea.", "La tengo.", "Preferisco tenerla.", "Lascia stare.", "Lascia perdere.", "Lasci perdere.", "Non la cancellare.", "Non annullarla.", "Fermo.", "Aspetta.",
      "Meglio di no.", "Non ancora.", "La voglio tenere.", "No, la tengo."],
    nl: ["Niet doen.", "Liever niet.", "Nog niet.", "Ik wil hem houden.", "Ik ben van gedachten veranderd.", "Toch maar niet.", "Laat maar zitten.", "Wacht even.", "Houd hem maar.",
      "Annuleer hem maar niet.", "Momentje.", "Nee hoor."],
    ja: ["いえ。", "いえ、そのままでお願いします。", "そのままでお願いします。", "取り消さないでください。", "大丈夫です。", "やっぱりいいです。", "いや、待って。", "キャンセルはしないでください。",
      "ちょっと待ってください。", "結構です。", "キャンセルしなくていいです。"],
  };
  const goAheads = {
    es: ["Sí, cancélala.", "Sí, por favor, cancélela.", "Sí, no la necesito.", "Sí, ya no la necesito.", "Sí, adelante.", "Vale, cancélala.", "Sí, sin problema.", "Sí, no te preocupes.", "Sí.", "Correcto.", "Ok, cancélela.", "Okay."],
    fr: ["Oui, annulez-le.", "Oui, je n'en ai plus besoin.", "Oui, allez-y.", "D'accord, annulez.", "Oui, sans problème.", "Oui, on ne le garde pas.", "Oui.", "Je confirme."],
    de: ["Ja, bitte stornieren.", "Ja, ich brauche ihn nicht mehr.", "Ja, gerne.", "Ja, machen Sie das.", "Ja, kein Problem.", "Ja.", "Genau."],
    it: ["Sì, la cancelli.", "Sì, non mi serve più.", "Sì, grazie.", "Va bene, la cancelli.", "Sì, nessun problema.", "Sì.", "Confermo."],
    nl: ["Ja, annuleer maar.", "Ja, ik heb hem niet meer nodig.", "Ja, graag.", "Prima, annuleer hem maar.", "Ja, geen probleem.", "Ja.", "Klopt."],
    ja: ["はい、キャンセルしてください。", "はい、お願いします。", "はい、もう必要ありません。", "はい、取り消してください。", "キャンセルをお願いします。", "予約をやめます。", "はい。"],
  };
  for (const [language, lines] of Object.entries(declines)) {
    it(`${language}: no way of taking it back is a go-ahead`, () => {
      const through = lines.filter((line) => cancelGoAhead(line, language));
      assert.deepEqual(through, []);
    });
  }
  for (const [language, lines] of Object.entries(goAheads)) {
    it(`${language}: a clear go-ahead lets it through, and is no refusal`, () => {
      const held = lines.filter((line) => !cancelGoAhead(line, language) || declinesCancel(line, language));
      assert.deepEqual(held, []);
    });
  }
  it("final confirmation review: natural yeses are go-aheads, a reason to cancel is no refusal", () => {
    for (const [language, line] of [["de", "Alles klar."], ["de", "In Ordnung."], ["es", "Por supuesto."], ["fr", "Très bien."], ["ja", "うん。"], ["ja", "キャンセルで。"], ["es", "Sí, cancélela, no puedo ir."], ["fr", "Oui, annulez, je ne peux pas venir."], ["de", "Ja, ich kann nicht kommen."], ["it", "Sì, non posso venire."], ["nl", "Ja, ik kan niet komen."], ["ja", "はい、行けません。"]]) {
      assert.equal(cancelGoAhead(line, language), true, `${language}: ${line}`);
      assert.equal(declinesCancel(line, language), false, `${language}: ${line}`);
    }
  });
  it("final confirmation review: a yes that keeps it is a refusal", () => {
    for (const [language, line] of [["de", "Ja, ich behalte ihn."], ["ja", "はい、キャンセルは必要ありません。"], ["ja", "ううん。"]]) {
      assert.equal(cancelGoAhead(line, language), false, `${language}: ${line}`);
    }
    assert.equal(declinesCancel("Ja, ich behalte ihn.", "de"), true);
    assert.equal(declinesCancel("はい、キャンセルは必要ありません。", "ja"), true);
  });
  it("security review: an acknowledgement is a go-ahead only as the whole answer; never a question, never a hedge", () => {
    for (const [language, line] of [
      ["de", "In Ordnung, ich überlege noch."], ["es", "Vale, me lo pienso."], ["fr", "Très bien, je vais réfléchir."], ["nl", "Akkoord, ik denk er nog over na."], ["it", "Certo, forse."],
      ["de", "Alles klar, und was kostet das?"], ["es", "Claro, pero antes una pregunta."],
      ["ja", "キャンセルですか？"], ["ja", "キャンセルでしょうか。"], ["de", "Wäre es in Ordnung, ihn zu verlegen?"], ["fr", "Pardon, j'ai mal entendu."], ["es", "¿Cancelarla?"],
      ["es", "Vale, mi marido lo trae."], ["de", "Alles klar, mein Mann ruft an."],
      ["de", "Ja, vielleicht."], ["es", "Sí, quizás."], ["nl", "Ja, misschien."], ["ja", "はい、ちょっと考えます。"],
      // last confirmation review: 「キャンセルです。」 states a purpose, 「ふうん。」 is "I see"; "Ik denk er nog over na." hedges
      ["ja", "キャンセルです。"], ["ja", "ふうん。"], ["nl", "Ik denk er nog over na."],
      ["ja", "はい、考えておきます。"], ["ja", "はい、まだ考えています。"], ["ja", "はい、考えとく。"], ["nl", "Ja, ik denk erover na."], ["nl", "Ja, ik denk er nog even over na."],
    ]) {
      assert.equal(cancelGoAhead(line, language), false, `${language}: ${line}`);
    }
    for (const [language, line] of [["de", "Alles klar, danke."], ["es", "Vale, gracias."], ["nl", "Zeker."], ["de", "Klar."], ["it", "Certamente."], ["fr", "Voilà."], ["es", "Dale."], ["ja", "了解しました。"], ["ja", "そうしてください。"], ["ja", "はい、そのままキャンセルしてください。"], ["de", "Ja, ich kann leider nicht."], ["fr", "Yes, cancel it please."],
      // last confirmation review: several acknowledgements, an English one with a thanks, a filler or a goodbye; narrower hedges
      ["it", "Perfetto, va bene."], ["es", "Vale, perfecto."], ["es", "Sure, gracias."], ["es", "Ah, vale."], ["fr", "Euh, d'accord."], ["es", "Vale, gracias, adiós."],
      ["ja", "ご迷惑をおかけしてすみません、キャンセルでお願いします。"], ["ja", "考えた結果、キャンセルでお願いします。"], ["nl", "Ja, dat denk ik wel."]]) {
      assert.equal(cancelGoAhead(line, language), true, `${language}: ${line}`);
    }
  });
  it("an English call is unchanged: only a clear decline holds", () => {
    assert.equal(declinesCancel("What does it cost to cancel?"), false);
    assert.equal(declinesCancel("No, wait."), true);
  });
});

describe("the guards read the call's language (session.fastLanguage)", () => {
  const MON_9 = { datetime: "2026-10-19T09:00:00" };

  it("fastCancelGate: a French \"Non, attendez\" after the read-back drops the held cancel", () => {
    const s = new CallSession("CA-fr");
    s.bookingGuards = true;
    s.fastLanguage = "fr";
    s.addMessage("user", "Je voudrais annuler mon rendez-vous de lundi.");
    assert.equal(fastCancelGate(s, MON_9, 1000).reason, "first-attempt");
    s.addMessage("assistant", "Vous voulez annuler le rendez-vous de lundi à 9 h ?");
    s.addMessage("user", "Non, attendez.");
    assert.deepEqual(fastCancelGate(s, MON_9, 2000), { proceed: false, via: null, reason: "caller-declined", dropped: 1 });
  });

  it("final confirmation review: an unclear answer keeps the cancel held — one more read-back, not three — and a clear yes then lets it through", () => {
    const s = new CallSession("CA-de");
    s.bookingGuards = true;
    s.fastLanguage = "de";
    s.addMessage("user", "Ich möchte meinen Termin am Montag stornieren.");
    assert.equal(fastCancelGate(s, MON_9, 1000).reason, "first-attempt");
    s.addMessage("assistant", "Soll ich den Termin am Montag um 9 Uhr stornieren?");
    s.addMessage("user", "Mmh, also…");
    assert.equal(fastCancelGate(s, MON_9, 2000).reason, "awaiting-caller", "unclear: still held, not dropped");
    s.addMessage("assistant", "Bitte sagen Sie ja oder nein: stornieren?");
    s.addMessage("user", "Alles klar.");
    assert.deepEqual(fastCancelGate(s, MON_9, 3000), { proceed: true, via: "retry", reason: null, dropped: 0 });
  });

  it("security review: an unclear answer after a confirmation puts it back on hold — a detail costs one more yes, an unlisted refusal never cancels", () => {
    const confirmed = (said) => {
      const s = new CallSession("CA-es");
      s.bookingGuards = true;
      s.fastLanguage = "it";
      s.addMessage("user", "Vorrei cancellare l'appuntamento di lunedì.");
      fastCancelGate(s, MON_9, 1000);
      s.addMessage("assistant", "Cancello l'appuntamento di lunedì alle 9?");
      s.addMessage("user", "Sì, grazie.");
      assert.equal(fastCancelGate(s, MON_9, 2000).proceed, true);
      s.addMessage("assistant", "A che nome è l'appuntamento?");
      s.addMessage("user", said);
      return s;
    };
    for (const said of ["Sami Khoury.", "Lascia stare, la tengo io."]) {
      const s = confirmed(said);
      assert.deepEqual(fastCancelGate(s, MON_9, 3000), { proceed: false, via: null, reason: "awaiting-caller", dropped: 0 }, said);
      assert.equal(fastCancelGate(s, MON_9, 3100).proceed, false, `${said}: an instant retry is still held`);
    }
    const s = confirmed("Sami Khoury.");
    fastCancelGate(s, MON_9, 3000);
    s.addMessage("assistant", "Confermo: cancello lunedì alle 9?");
    s.addMessage("user", "Sì.");
    assert.equal(fastCancelGate(s, MON_9, 4000).proceed, true, "a clear yes after a fresh read-back");
  });

  it("last confirmation review: an unlisted refusal right after the hold (no AI line between) still re-arms it", () => {
    const s = new CallSession("CA-es");
    s.bookingGuards = true;
    s.fastLanguage = "es";
    s.addMessage("user", "Quiero cancelar el lunes.");
    fastCancelGate(s, MON_9, 1000);
    s.addMessage("user", "Para, para. Mejor la mantengo.");
    s.addMessage("assistant", "¿Algo más?");
    s.addMessage("user", "Sí, una pregunta.");
    assert.equal(fastCancelGate(s, MON_9, 2000).proceed, false);
  });

  it("final confirmation review: a yes to \"anything else?\" after an unlisted refusal never confirms the held cancel", () => {
    const s = new CallSession("CA-es");
    s.bookingGuards = true;
    s.fastLanguage = "es";
    s.addMessage("user", "Quiero cancelar el lunes.");
    fastCancelGate(s, MON_9, 1000);
    s.addMessage("assistant", "¿Cancelo el lunes a las 9?");
    s.addMessage("user", "Para, para. Mejor la mantengo.");
    s.addMessage("assistant", "Perfecto, la mantenemos. ¿Le ayudo con algo más?");
    s.addMessage("user", "Sí, una pregunta sobre el parking.");
    assert.equal(fastCancelGate(s, MON_9, 2000).proceed, false);
  });

  it("checkBookingGuards: a Spanish read-back and yes let the booking through", () => {
    const s = {
      bookingGuards: true,
      fastLanguage: "es",
      bookingGuardState: { spellingHolds: 0, secondBookingNudged: false },
      confirmedBookings: new Map(),
      fullTranscriptMessages: [caller("Me llamo Sami Khoury."), ai("Su apellido es K-H-O-U-R-Y. ¿Es correcto?"), caller("Sí, es correcto.")],
    };
    assert.equal(checkBookingGuards(s, { datetime: "2026-10-20T09:00:00", first_name: "Sami", last_name: "Khoury" }), null);
  });
});

describe("hasUnfinishedBooking: the AI's own \"I've booked you\" in the call's other language", () => {
  const FOUND = [{ name: "lookup_appointment", successful: true, found: true, at: 100 }];
  const call = (languagesUsed, line) => {
    const s = new CallSession("CA-said");
    s.toolCallAudit = FOUND;
    s.bookingGuards = true;
    s.languagesUsed = languagesUsed;
    s.addMessage("assistant", line);
    return s;
  };
  const claims = {
    es: ["Listo, le he reservado el martes a las 2.", "Ya le reservé el martes a las 2.", "Hemos agendado su visita para el martes.", "Le he reservado el martes a las diez, ¿necesita algo más?"],
    fr: ["Je vous ai réservé mardi à 14 h.", "J'ai bien noté votre rendez-vous pour mardi."],
    de: ["Ich habe Sie für Dienstag um 14 Uhr eingetragen.", "Wir haben den Termin gebucht.", "Dann habe ich Sie für Dienstag, den 20. Oktober, um 9 Uhr eingetragen."],
    it: ["Le ho prenotato martedì alle 14.", "Abbiamo fissato l'appuntamento per martedì."],
    nl: ["Ik heb u voor dinsdag om 14 uur ingepland.", "We hebben de afspraak geboekt.", "Dan heb ik u voor dinsdag 20 oktober om 9 uur ingepland."],
    ja: ["火曜日の14時でご予約をお取りしました。", "予約が完了しました。", "ご予約を承りました。"],
  };
  const descriptions = {
    es: ["Su cita está reservada para el lunes a las 10.", "No le he reservado nada nuevo.", "¿Quiere que le reserve otra?", "¿Hemos agendado algo, o es la primera vez?"],
    fr: ["Votre rendez-vous est lundi à 10 h.", "Je n'ai rien réservé de nouveau."],
    de: ["Ihr Termin ist am Montag um 10 Uhr.", "Ich habe noch nichts Neues gebucht.", "Haben wir schon etwas für Dienstag gebucht?", "Habe ich Sie eingetragen, oder soll ich warten?"],
    it: ["Il suo appuntamento è lunedì alle 10.", "Non ho prenotato niente di nuovo."],
    nl: ["Uw afspraak staat op maandag om 10 uur.", "Ik heb nog niets nieuws geboekt."],
    ja: ["ご予約は月曜日の10時です。", "まだ予約していません。"],
  };
  for (const [language, lines] of Object.entries(claims)) {
    for (const line of lines) {
      it(`${language}: "${line}" is a claim — a call about their booking still blocks`, () => {
        assert.equal(call(["en", language], line).hasUnfinishedBooking("booking complete"), true);
      });
    }
  }
  for (const [language, lines] of Object.entries(descriptions)) {
    for (const line of lines) {
      it(`${language}: "${line}" is no claim`, () => {
        assert.equal(call(["en", language], line).hasUnfinishedBooking("caller kept their booking"), false);
      });
    }
  }
  it("an English-only call never reads another language's claim (as before)", () => {
    assert.equal(call(null, "Listo, le he reservado el martes a las 2.").hasUnfinishedBooking("caller kept their booking"), false);
  });
});
