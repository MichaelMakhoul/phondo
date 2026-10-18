"use strict";

/**
 * SCRUM-594 (F5 simulated calls): the booking guards' words in the fast path's
 * other languages (lib/fast-languages.js).
 *
 * A simulated Spanish caller answered "¿Es correcto?" with "Sí, es correcto,
 * K-H-O-U-R-Y" and the spelling guard held the booking twice more, then
 * stepped aside with an alert: it knew only "Is that right?" and "yes". The
 * same blind spot would let a French "Non, attendez" through the cancel gate.
 *
 * English words count on every call; these count once the call speaks the
 * language (session.fastLanguage). Where unsure they lean the guards' way: a
 * "yes, but…" is no yes, an unclear answer to a cancel is a no, and a claim
 * only the first person makes ("I've booked you") is a claim.
 */

/**
 * Whole words, accents included (\b is ASCII-only in JavaScript regexes).
 * @param {string[]} alternatives
 * @param {string} [flags]
 * @returns {RegExp}
 */
function wordsRe(alternatives, flags = "iu") {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, flags);
}

/**
 * Is this question short enough to be a bare "is that right?" — at most
 * `maxWords` words (Japanese, written without spaces: two and a half times as many characters).
 * @param {string} question
 * @param {number} maxWords
 * @returns {boolean}
 */
function latinShort(question, maxWords) {
  return question.trim().split(/\s+/).length <= maxWords;
}

/** @type {(question: string, maxWords: number) => boolean} */
function japaneseShort(question, maxWords) {
  return question.replace(/[\s。．、，！？!?,.「」『』]/g, "").length <= Math.round(maxWords * 2.5); // 「違っていたら教えてください」 is 13
}

/**
 * "I've / we've booked …" with up to ten words between — a date's commas and
 * dots included ("Dienstag, den 20. Oktober") — never after a negation
 * ("Ich habe noch nichts gebucht").
 * @param {string} subjects
 * @param {string} negations
 * @param {string} participles
 * @returns {string}
 */
function bookedWithObject(subjects, negations, participles) {
  return `(?:${subjects})(?: (?!(?:${negations})(?![\\p{L}]))[^\\s!?]+){0,10}? (?:${participles})`;
}

/**
 * @typedef {{
 *   yes: RegExp,
 *   no: RegExp,
 *   check: RegExp,
 *   spell: RegExp,
 *   field: RegExp,
 *   time: RegExp,
 *   shortQuestion: (question: string, maxWords: number) => boolean,
 *   decline: RegExp,
 *   goAhead: RegExp,
 *   noLongerNeeded: RegExp,
 *   cancelYes?: RegExp,
 *   agreeingNo: RegExp | null,
 *   booked: RegExp,
 * }} GuardWords
 * - yes / no: a caller's yes, and what stops it being one (checked first)
 * - check: the AI's short "is that right?" after a read-back
 * - spell: the AI's "is that how it's spelled?"
 * - field: a question about another detail (phone, email, address…)
 * - time: a question about a day or time ("¿Le viene bien el martes?")
 * - decline: a caller taking a cancel back; agreeingNo: "no problem" phrases set aside first
 * - goAhead: "cancel it" / "go ahead"; noLongerNeeded: "I don't need it any more" (a go-ahead,
 *   though it says no); cancelYes: a yes to a cancel, where it differs from `yes` (Japanese
 *   「大丈夫です」 can mean "no need")
 * - booked: the AI's own "I've booked you"
 */

/** @type {Readonly<Record<string, GuardWords>>} */
const GUARD_WORDS = Object.freeze({
  es: {
    yes: wordsRe(["s[ií]", "claro", "correct[oa]", "exact(?:[oa]|amente)", "eso es", "as[ií] es", "perfect[oa]", "vale", "de acuerdo", "est[aá] bien", "muy bien"]),
    // Gate review: a plain "no" anywhere ("Eso no es correcto", "¡Claro que no!"), once "no hay problema" is set aside.
    no: wordsRe(["no", "nunca", "tampoco", "incorrect[oa]", "mal", "equivocad[oa]", "esper[ae]", "un momento", "pero(?! (?:claro|s[ií]|por supuesto))"]),
    check: wordsRe(["correct[oa]", "bien", "as[ií]", "vale", "verdad", "cierto", "exact[oa]"]),
    spell: wordsRe(["se escribe", "escrito", "deletre\\p{L}*", "ortograf[ií]a"]),
    field: wordsRe(["correo", "e-?mail", "direcci[oó]n", "calle", "barrio", "n[uú]mero", "tel[eé]fono", "m[oó]vil", "celular", "nombre de pila"]),
    time: wordsRe(["lunes", "martes", "mi[ée]rcoles", "jueves", "viernes", "s[áa]bado", "domingo", "hoy", "ma[ñn]ana", "tarde", "noche", "horas?", "mediod[ií]a"]),
    shortQuestion: latinShort,
    goAhead: wordsRe(["canc[ée]l(?:[ae]la|[ae]lo|e|a|ar|en)", "an[úu]l(?:[ae]la|[ae]lo|e|a|ar|en)", "adelante", "h[áa]galo", "proceda", "confirmo"]),
    noLongerNeeded: wordsRe(["(?:ya )?no (?:la |lo |me )?(?:necesito|hace falta|sirve)(?: m[áa]s)?"], "giu"),
    decline: wordsRe(["esper[ae]", "un momento", "no (?:me )?(?:la |lo )?(?:cancel|anul)(?:e|es)", "mejor no", "d[ée]j(?:el|al)[oa]", "mant[ée]n(?:gal|l)[oa]", "olv[ií]d(?:el|al)[oa]", "me equivoqu[ée]", "no es (?:esa|ese)", "cambi[ée] de (?:opini[oó]n|idea)", "pens[aá]ndolo bien"]),
    agreeingNo: wordsRe(["no hay problema", "sin problema", "no se preocupe", "no te preocupes", "ning[uú]n problema", "no pasa nada"], "giu"),
    booked: wordsRe([
      "(?<!no (?:\\S+ )?)(?:(?:le|te|lo|la|les) )?(?:he|hemos) (?:reservado|agendado|programado|apuntado)",
      "(?<!no (?:\\S+ )?)(?:le|te|les) (?:reservé|agendé|apunté)",
    ]),
  },
  fr: {
    yes: wordsRe(["oui", "ouais", "exact(?:ement)?", "correct", "parfait", "c['’]est (?:bien )?(?:[çc]a|bon|juste|exact|correct)", "d['’]accord", "tout [àa] fait", "bien s[ûu]r"]),
    // Gate review: a plain "pas" / "ne" / "non" anywhere ("Pas exactement"), once "pas de problème" is set aside.
    no: wordsRe(["non", "pas", "ne", "n['’]\\p{L}+", "jamais", "faux", "incorrect", "attendez", "un instant", "mais(?! (?:oui|bien s[ûu]r|certainement|absolument))"]),
    check: wordsRe(["correct", "exact", "juste", "bon", "bien [çc]a", "c['’]est [çc]a", "d['’]accord"]),
    spell: wordsRe(["s['’][ée]crit", "[ée]crit", "orthographe", "[ée]pel\\p{L}*"]),
    field: wordsRe(["pr[ée]nom", "e-?mail", "courriel", "adresse", "rue", "num[ée]ro", "t[ée]l[ée]phone", "portable"]),
    time: wordsRe(["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche", "aujourd['’]hui", "demain", "matin", "apr[èe]s-midi", "soir", "heures?", "midi"]),
    shortQuestion: latinShort,
    goAhead: wordsRe(["annul(?:ez|e|er)(?:-l[ea])?", "allez-y", "faites-le", "je confirme", "confirm(?:ez|e)"]),
    noLongerNeeded: wordsRe(["(?:je )?n['’]en ai plus besoin", "plus besoin", "(?:on |je )ne (?:le |la )garde pas"], "giu"),
    decline: wordsRe(["non", "attendez", "un instant", "n['’]annulez pas", "ne l['’]annulez pas", "gardez", "laissez", "oubliez", "pas (?:celui|celle)-l[àa]", "finalement non", "je (?:le|la) garde", "j['’]ai chang[ée] d['’]avis"]),
    agreeingNo: wordsRe(["pas de probl[èe]me", "pas de souci", "sans probl[èe]me"], "giu"),
    booked: wordsRe(["(?:je vous ai|je t['’]ai|j['’]ai|nous vous avons|nous avons|on vous a|on a) (?:bien )?(?:r[ée]serv[ée]e?s?|programm[ée]e?s?|inscrite?s?|not[ée]e?s?|pris (?:votre|le|un) rendez-vous)"]),
  },
  de: {
    yes: wordsRe(["ja", "genau", "richtig", "korrekt", "stimmt", "passt", "perfekt", "jawohl"]),
    // Gate review: a plain "nicht" / "kein" anywhere ("Passt nicht", "Stimmt leider nicht"), once "kein Problem" is set aside.
    no: wordsRe(["nein", "nee", "n[öo]", "nicht", "kein\\p{L}*", "nie", "falsch", "moment(?:mal)?", "warten sie", "aber(?! (?:gerne?|sicher|klar|nat[üu]rlich))"]),
    check: wordsRe(["richtig", "korrekt", "stimmt", "genau", "passt"]),
    spell: wordsRe(["schreibt", "geschrieben", "buchstabiert", "schreibweise"]),
    field: wordsRe(["vorname\\p{L}*", "e-?mail", "adresse", "stra(?:ß|ss)e", "\\p{L}*nummer", "telefon\\p{L}*", "handy\\p{L}*"]),
    time: wordsRe(["montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag", "heute", "morgen", "vormittag", "nachmittag", "abend", "uhr", "mittag"]),
    shortQuestion: latinShort,
    goAhead: wordsRe(["stornier(?:en|t|e)", "absagen", "machen sie (?:das|es)", "gerne?", "bitte", "ich best[äa]tige"]),
    noLongerNeeded: wordsRe(["(?:ich )?brauche (?:ihn|sie|es|den termin) nicht mehr", "nicht mehr (?:n[öo]tig|notwendig)"], "giu"),
    decline: wordsRe(["nein", "nee", "n[öo]", "warten sie", "moment(?:mal)?", "nicht (?:stornieren|absagen|l[öo]schen)", "(?:stornieren|absagen|l[öo]schen) sie (?:\\p{L}+ )?(?:bitte )?nicht", "bitte nicht", "lieber nicht", "behalten", "lassen sie", "vergessen sie", "doch nicht", "nicht (?:den|die|diesen|diese)"]),
    agreeingNo: wordsRe(["kein problem", "keine sorge"], "giu"),
    booked: wordsRe([bookedWithObject("ich habe|wir haben|habe ich|haben wir", "nicht|nichts|kein\\p{L}*", "gebucht|eingetragen|reserviert|eingeplant|vereinbart")]),
  },
  it: {
    yes: wordsRe(["s[iì]", "esatt(?:o|a|amente)", "corrett[oa]", "giust[oa]", "perfett[oa]", "va bene", "certo", "d['’]accordo"]),
    // Gate review: a plain "no" / "non" anywhere ("Non esattamente"), once "nessun problema" is set aside.
    no: wordsRe(["no", "non", "mai", "sbagliat[oa]", "scorrett[oa]", "aspett[ia]", "un attimo", "un momento", "ma(?! (?:certo|s[iì]|sicuro|figurati))", "per[oò]"]),
    check: wordsRe(["corrett[oa]", "giust[oa]", "esatt[oa]", "cos[iì]", "va bene", "vero"]),
    spell: wordsRe(["si scrive", "scritto", "ortografia"]),
    field: wordsRe(["e-?mail", "indirizzo", "via", "numero", "telefono", "cellulare"]),
    time: wordsRe(["luned[iì]", "marted[iì]", "mercoled[iì]", "gioved[iì]", "venerd[iì]", "sabato", "domenica", "oggi", "domani", "mattina", "pomeriggio", "sera", "ore", "mezzogiorno"]),
    shortQuestion: latinShort,
    goAhead: wordsRe(["(?:la |lo )?cancell(?:i|ate|are|a)", "(?:la |lo )?annull(?:i|ate|are|a)", "proceda", "vada pure", "confermo"]),
    noLongerNeeded: wordsRe(["non (?:mi )?serve più", "non (?:ne )?ho più bisogno"], "giu"),
    decline: wordsRe(["aspett[ia]", "un attimo", "un momento", "non (?:la |lo )?(?:cancelli|annulli|cancellare|annullare)", "la tenga", "lo tenga", "lasci(?:amo)? (?:stare|perdere)", "non quell[ao]", "ci ho ripensato", "ho cambiato idea"]),
    agreeingNo: wordsRe(["nessun problema", "non c['’][èe] problema", "non si preoccupi"], "giu"),
    booked: wordsRe(["(?<!non (?:\\S+ )?)(?:(?:le|ti|vi|gliel[oa]) )?(?:ho|abbiamo) (?:prenotato|fissato|segnato|registrato)"]),
  },
  nl: {
    yes: wordsRe(["ja", "klopt", "correct", "juist", "precies", "perfect", "goed", "prima", "inderdaad"]),
    // Gate review: a plain "niet" / "geen" anywhere ("Dat klopt helaas niet"), once "geen probleem" is set aside.
    no: wordsRe(["nee", "neen", "niet", "geen", "nooit", "fout", "verkeerd", "wacht", "momentje", "(?:(?<=^\\s{0,3})|(?<=[,;]\\s{0,3}))maar(?=\\s)"]),
    check: wordsRe(["klopt", "correct", "juist", "goed"]),
    spell: wordsRe(["schrijf\\p{L}*", "geschreven", "gespeld", "spelling"]),
    field: wordsRe(["voornaam", "e-?mail", "adres", "straat", "\\p{L}*nummer", "telefoon\\p{L}*", "mobiel\\p{L}*"]),
    time: wordsRe(["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag", "vandaag", "morgen", "ochtend", "middag", "avond", "uur"]),
    shortQuestion: latinShort,
    goAhead: wordsRe(["annuleer", "annuleren", "zeg (?:hem |maar )?af", "ga (?:je|uw) gang", "doe maar", "graag", "bevestig"]),
    noLongerNeeded: wordsRe(["(?:ik )?heb (?:hem|het|ze) niet meer nodig", "niet meer nodig"], "giu"),
    decline: wordsRe(["nee", "neen", "wacht", "momentje", "niet annuleren", "niet afzeggen", "laat maar", "houd", "hou", "toch (?:maar )?niet", "liever niet", "niet die", "niet deze"]),
    agreeingNo: wordsRe(["geen probleem", "geen zorgen"], "giu"),
    booked: wordsRe([bookedWithObject("ik heb|we hebben|wij hebben|heb ik|hebben we|hebben wij", "niet|niets|geen", "geboekt|ingepland|gereserveerd|vastgelegd|ingeboekt")]),
  },
  ja: {
    // 「ええと」 (um) is no 「ええ」 (yes).
    yes: /はい|ええ(?![ーっ]*と)|そうです|その通り|合って(?:い)?ます|あって(?:い)?ます|大丈夫です|正しいです|(?:間違い|相違)(?:ありません|ございません|ない)/,
    // Gate review: any negative form (ない, ません, じゃなく…), once the ones that agree — 「間違いありません」,
    // 「問題ありません」, 「すみません」 — are set aside (agreeingNo).
    no: /いいえ|いえ、|違い|ちがい|違う|ちがう|違っ|ちがっ|間違|まちが|待って|まって|でも|けど|ですが|じゃなく|ではなく|なく(?:て|ても)|ない|ません/,
    // 「確認」 only as "please confirm" (「確認ですが、緊急ですか」 asks something else): final review.
    check: /よろしい|正しい|合って|あって|間違い|まちがい|違っていたら|ご?確認(?:を)?(?:ください|下さい|お願い|して|いただけ)/,
    spell: /つづり|綴り|スペル|書き方/,
    field: /メール|住所|番号|電話|携帯|下の(?:お)?名前/,
    time: /曜日|今日|明日|明後日|午前|午後|(?<![当同])時|朝|夕方|夜/,
    shortQuestion: japaneseShort,
    goAhead: /キャンセルして|取り消して|お願い(?:いた)?します|やめます|構いません|かまいません/,
    noLongerNeeded: /(?:もう)?(?:必要|要り|いり)(?:ありません|ません|ない|なくなりました)/g,
    cancelYes: /はい|ええ(?![ーっ]*と)|そうです/,
    decline: /いいえ|いえ|いや|待って|まって|しないで|さないで|しなくて(?:いい|大丈夫|結構)|(?<!取り)やめて|やっぱり|そのまま|結構です|違い|ちがい|違う|ちがう/,
    agreeingNo: /(?:間違い|相違)(?:ありません|ございません|ない)|問題(?:は)?(?:ありません|ございません|ない)|構いません|かまいません|すみません|すいません|申し訳(?:あり|ござい)ません/g,
    booked: /予約(?:いた)?しました|予約を(?:お取り(?:いた)?しました|お入れ(?:いた)?しました|承りました)|予約が(?:完了(?:いた)?しました|取れました)/,
  },
});

/**
 * The guards' words for a call's language: null for English (the guards' own
 * words) and for anything set_language doesn't offer.
 * @param {unknown} language - session.fastLanguage
 * @returns {GuardWords | null}
 */
function guardWords(language) {
  return typeof language === "string" && Object.prototype.hasOwnProperty.call(GUARD_WORDS, language) ? GUARD_WORDS[language] : null;
}

module.exports = { guardWords };
