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
    assert.deepEqual(spelledRuns("Is it a K-H-O-U-R-Y?"), ["KHOURY"]);
    assert.deepEqual(spelledRuns("K-H-O-U-R-Y, a lovely name."), ["KHOURYA"], "after a comma it stays, as before: runSpells takes a trailing A");
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
    ja: ["はい、そうです。", "はい。", "合っています。", "その通りです。", "大丈夫です。", "はい、間違いありません。", "間違いありません。", "はい、問題ありません。", "はい、すみません、そうです。"],
  };
  const notYes = {
    es: ["No, es con K.", "No es así.", "Está mal.", "Espere.", "Sí, pero es con K al principio.", "Eso no es correcto.", "¡Claro que no!"],
    fr: ["Non, c'est avec un K.", "Ce n'est pas ça.", "Pas tout à fait.", "Non, pas correct.", "Oui, mais avec un K.", "Pas exactement."],
    de: ["Nein, mit K.", "Nicht ganz.", "Das ist falsch.", "Moment mal.", "Ja, aber mit K.", "Passt nicht.", "Das stimmt leider nicht."],
    it: ["No, con la K.", "Non è giusto.", "Sbagliato.", "Aspetti.", "Sì, ma con la K.", "Non esattamente.", "Non mi sembra giusto."],
    nl: ["Nee, met een K.", "Niet helemaal.", "Dat klopt niet.", "Fout.", "Ja, maar met een K.", "Dat klopt helaas niet."],
    ja: ["いいえ、違います。", "違います。", "ちょっと待ってください。", "はい、でもKから始まります。", "はい、違います。", "ええと、最初の文字はCです。", "はい、CじゃなくてKです。", "合っていません。"],
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
    es: ["Listo, le he reservado el martes a las 2.", "Ya le reservé el martes a las 2.", "Hemos agendado su visita para el martes."],
    fr: ["Je vous ai réservé mardi à 14 h.", "J'ai bien noté votre rendez-vous pour mardi."],
    de: ["Ich habe Sie für Dienstag um 14 Uhr eingetragen.", "Wir haben den Termin gebucht.", "Dann habe ich Sie für Dienstag, den 20. Oktober, um 9 Uhr eingetragen."],
    it: ["Le ho prenotato martedì alle 14.", "Abbiamo fissato l'appuntamento per martedì."],
    nl: ["Ik heb u voor dinsdag om 14 uur ingepland.", "We hebben de afspraak geboekt.", "Dan heb ik u voor dinsdag 20 oktober om 9 uur ingepland."],
    ja: ["火曜日の14時でご予約をお取りしました。", "予約が完了しました。", "ご予約を承りました。"],
  };
  const descriptions = {
    es: ["Su cita está reservada para el lunes a las 10.", "No le he reservado nada nuevo.", "¿Quiere que le reserve otra?"],
    fr: ["Votre rendez-vous est lundi à 10 h.", "Je n'ai rien réservé de nouveau."],
    de: ["Ihr Termin ist am Montag um 10 Uhr.", "Ich habe noch nichts Neues gebucht."],
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
