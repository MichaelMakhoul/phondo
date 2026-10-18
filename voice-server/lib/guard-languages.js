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
 * `maxWords` words (Japanese, written without spaces: twice as many characters).
 * @param {string} question
 * @param {number} maxWords
 * @returns {boolean}
 */
function latinShort(question, maxWords) {
  return question.trim().split(/\s+/).length <= maxWords;
}

/** @type {(question: string, maxWords: number) => boolean} */
function japaneseShort(question, maxWords) {
  return question.replace(/[\s。．、，！？!?,.「」『』]/g, "").length <= maxWords * 2;
}

/**
 * "I've / we've booked …" with up to six words between, never after a negation
 * ("Ich habe noch nichts gebucht").
 * @param {string} subjects
 * @param {string} negations
 * @param {string} participles
 * @returns {string}
 */
function bookedWithObject(subjects, negations, participles) {
  return `(?:${subjects})(?: (?!(?:${negations})(?![\\p{L}]))[^\\s.!?,]+){0,6}? (?:${participles})`;
}

/**
 * @typedef {{
 *   yes: RegExp,
 *   no: RegExp,
 *   check: RegExp,
 *   spell: RegExp,
 *   field: RegExp,
 *   shortQuestion: (question: string, maxWords: number) => boolean,
 *   decline: RegExp,
 *   agreeingNo: RegExp | null,
 *   booked: RegExp,
 * }} GuardWords
 * - yes / no: a caller's yes, and what stops it being one (checked first)
 * - check: the AI's short "is that right?" after a read-back
 * - spell: the AI's "is that how it's spelled?"
 * - field: a question about another detail (phone, email, address…)
 * - decline: a caller taking a cancel back; agreeingNo: "no problem" phrases set aside first
 * - booked: the AI's own "I've booked you"
 */

/** @type {Readonly<Record<string, GuardWords>>} */
const GUARD_WORDS = Object.freeze({
  es: {
    yes: wordsRe(["s[ií]", "claro", "correct[oa]", "exact[oa]", "eso es", "as[ií] es", "perfect[oa]", "vale", "de acuerdo", "est[aá] bien", "muy bien"]),
    no: wordsRe(["incorrect[oa]", "mal", "equivocad[oa]", "esper[ae]", "un momento", "pero(?! (?:claro|s[ií]|por supuesto))", "no es as[ií]"]),
    check: wordsRe(["correct[oa]", "bien", "as[ií]", "vale", "verdad", "cierto", "exact[oa]"]),
    spell: wordsRe(["se escribe", "escrito", "deletre\\p{L}*", "ortograf[ií]a"]),
    field: wordsRe(["correo", "e-?mail", "direcci[oó]n", "calle", "barrio", "n[uú]mero", "tel[eé]fono", "m[oó]vil", "celular", "nombre de pila"]),
    shortQuestion: latinShort,
    decline: wordsRe(["esper[ae]", "un momento", "no (?:la |lo )?(?:cancele|anule)", "mejor no", "d[ée]jel[oa]", "mant[ée]ngal[oa]", "olv[ií]del[oa]", "me equivoqu[ée]", "no es (?:esa|ese)"]),
    agreeingNo: wordsRe(["no hay problema", "sin problema", "no se preocupe", "ning[uú]n problema", "no pasa nada"], "giu"),
    booked: wordsRe([
      "(?<!no (?:\\S+ )?)(?:(?:le|te|lo|la|les) )?(?:he|hemos) (?:reservado|agendado|programado|apuntado)",
      "(?<!no (?:\\S+ )?)(?:le|te|les) (?:reservé|agendé|apunté)",
    ]),
  },
  fr: {
    yes: wordsRe(["oui", "ouais", "exact(?:ement)?", "correct", "parfait", "c['’]est (?:[çc]a|bon|juste|exact|correct)", "d['’]accord", "tout [àa] fait", "bien s[ûu]r"]),
    no: wordsRe(["non", "pas (?:[çc]a|correct|exact|juste|tout [àa] fait|du tout)", "faux", "incorrect", "attendez", "un instant", "ce n['’]est pas", "mais(?! (?:oui|bien s[ûu]r|certainement|absolument))"]),
    check: wordsRe(["correct", "exact", "juste", "bon", "bien [çc]a", "c['’]est [çc]a", "d['’]accord"]),
    spell: wordsRe(["s['’][ée]crit", "[ée]crit", "orthographe", "[ée]pel\\p{L}*"]),
    field: wordsRe(["pr[ée]nom", "e-?mail", "courriel", "adresse", "rue", "num[ée]ro", "t[ée]l[ée]phone", "portable"]),
    shortQuestion: latinShort,
    decline: wordsRe(["non", "attendez", "un instant", "n['’]annulez pas", "ne l['’]annulez pas", "gardez", "laissez", "oubliez", "pas (?:celui|celle)-l[àa]", "finalement non"]),
    agreeingNo: wordsRe(["pas de probl[èe]me", "pas de souci", "sans probl[èe]me"], "giu"),
    booked: wordsRe(["(?:je vous ai|je t['’]ai|j['’]ai|nous vous avons|nous avons|on vous a|on a) (?:bien )?(?:r[ée]serv[ée]e?s?|programm[ée]e?s?|inscrite?s?|not[ée]e?s?|pris (?:votre|le|un) rendez-vous)"]),
  },
  de: {
    yes: wordsRe(["ja", "genau", "richtig", "korrekt", "stimmt", "passt", "perfekt", "jawohl"]),
    no: wordsRe(["nein", "nicht (?:richtig|korrekt|ganz|so)", "falsch", "moment(?:mal)?", "warten sie", "stimmt nicht", "aber(?! (?:gerne?|sicher|klar|nat[üu]rlich))"]),
    check: wordsRe(["richtig", "korrekt", "stimmt", "genau", "passt"]),
    spell: wordsRe(["schreibt", "geschrieben", "buchstabiert", "schreibweise"]),
    field: wordsRe(["vorname\\p{L}*", "e-?mail", "adresse", "stra(?:ß|ss)e", "\\p{L}*nummer", "telefon\\p{L}*", "handy\\p{L}*"]),
    shortQuestion: latinShort,
    decline: wordsRe(["nein", "warten sie", "moment(?:mal)?", "nicht (?:stornieren|absagen|l[öo]schen)", "behalten", "lassen sie", "vergessen sie", "doch nicht", "nicht (?:den|die|diesen|diese)"]),
    agreeingNo: wordsRe(["kein problem", "keine sorge"], "giu"),
    booked: wordsRe([bookedWithObject("ich habe|wir haben", "nicht|nichts|kein\\p{L}*", "gebucht|eingetragen|reserviert|eingeplant|vereinbart")]),
  },
  it: {
    yes: wordsRe(["s[iì]", "esatt(?:o|a|amente)", "corrett[oa]", "giust[oa]", "perfett[oa]", "va bene", "certo", "d['’]accordo"]),
    no: wordsRe(["non (?:[èe]|va)", "sbagliat[oa]", "scorrett[oa]", "aspett[ia]", "un attimo", "un momento", "ma(?! (?:certo|s[iì]|sicuro|figurati))", "per[oò]"]),
    check: wordsRe(["corrett[oa]", "giust[oa]", "esatt[oa]", "cos[iì]", "va bene", "vero"]),
    spell: wordsRe(["si scrive", "scritto", "ortografia"]),
    field: wordsRe(["e-?mail", "indirizzo", "via", "numero", "telefono", "cellulare"]),
    shortQuestion: latinShort,
    decline: wordsRe(["aspett[ia]", "un attimo", "un momento", "non (?:la |lo )?(?:cancelli|annulli)", "la tenga", "lo tenga", "lasci stare", "lasciamo stare", "non quell[ao]", "ci ho ripensato"]),
    agreeingNo: wordsRe(["nessun problema", "non c['’][èe] problema", "non si preoccupi"], "giu"),
    booked: wordsRe(["(?<!non (?:\\S+ )?)(?:(?:le|ti|vi|gliel[oa]) )?(?:ho|abbiamo) (?:prenotato|fissato|segnato|registrato)"]),
  },
  nl: {
    yes: wordsRe(["ja", "klopt", "correct", "juist", "precies", "perfect", "goed", "prima", "inderdaad"]),
    no: wordsRe(["nee", "neen", "niet (?:goed|juist|correct|helemaal|zo)", "fout", "verkeerd", "wacht", "momentje", "klopt niet", "(?:(?<=^\\s*)|(?<=[,;]\\s*))maar(?=\\s)"]),
    check: wordsRe(["klopt", "correct", "juist", "goed"]),
    spell: wordsRe(["schrijf\\p{L}*", "geschreven", "gespeld", "spelling"]),
    field: wordsRe(["voornaam", "e-?mail", "adres", "straat", "\\p{L}*nummer", "telefoon\\p{L}*", "mobiel\\p{L}*"]),
    shortQuestion: latinShort,
    decline: wordsRe(["nee", "neen", "wacht", "momentje", "niet annuleren", "niet afzeggen", "laat maar", "houd", "hou", "toch niet", "niet die", "niet deze"]),
    agreeingNo: wordsRe(["geen probleem", "geen zorgen"], "giu"),
    booked: wordsRe([bookedWithObject("ik heb|we hebben|wij hebben", "niet|niets|geen", "geboekt|ingepland|gereserveerd|vastgelegd|ingeboekt")]),
  },
  ja: {
    yes: /はい|ええ|そうです|その通り|合って(?:い)?ます|あって(?:い)?ます|大丈夫です|正しいです|間違い(?:ありません|ございません|ない)/,
    // "間違いありません" (no mistake) is a yes: only the forms that say it's wrong are a no.
    no: /いいえ|いえ、|違います|ちがいます|違う|ちがう|間違って|まちがって|間違え|まちがえ|待って|まって|でも|けど|ではありません|じゃありません|じゃない/,
    check: /よろしい|正しい|合って|あって|間違い|まちがい/,
    spell: /つづり|綴り|スペル|書き方/,
    field: /メール|住所|番号|電話|携帯|下の(?:お)?名前/,
    shortQuestion: japaneseShort,
    decline: /いいえ|いや|待って|まって|キャンセルしないで|(?<!取り)やめ|やっぱり|結構です|違います|ちがいます|違う|ちがう/,
    agreeingNo: null,
    booked: /予約(?:いた)?しました|予約を(?:お取り|お入れ|承り)(?:いた)?しました|予約が(?:完了(?:いた)?しました|取れました)/,
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
