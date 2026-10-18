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
 *   cancelYes: RegExp,
 *   goAhead: RegExp,
 *   ack: RegExp,
 *   hedge: RegExp,
 *   noLongerNeeded: RegExp,
 *   pointsBack?: RegExp,
 *   agreeingNo: RegExp | null,
 *   booked: RegExp,
 * }} GuardWords
 * - yes / no: a caller's yes, and what stops it being one (checked first)
 * - check: the AI's short "is that right?" after a read-back
 * - spell: the AI's "is that how it's spelled?"
 * - field: a question about another detail (phone, email, address…)
 * - time: a question about a day or time ("¿Le viene bien el martes?")
 * - decline: a caller taking a cancel back; agreeingNo: "no problem" phrases set aside first
 * - a go-ahead to a cancel (cancelGoAhead): cancelYes (a plain yes) or goAhead ("cancel it",
 *   "go ahead") anywhere; ack ("alles klar", "vale") only as the whole answer; never with a
 *   hedge ("I'm still thinking"); noLongerNeeded: "I don't need it any more", "I can't come"
 *   — set aside before any "no" counts (a reason to cancel is no refusal, though on its own
 *   it is no go-ahead either). Japanese 「大丈夫です」 is no cancelYes: it can mean "no need"
 * - pointsBack: a check that points back at what was just read, whatever its length
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
    cancelYes: wordsRe(["s[ií]"]),
    goAhead: wordsRe(["canc[ée]l(?:[ae]la|[ae]lo|e|a|ar|en)", "an[úu]l(?:[ae]la|[ae]lo|e|a|ar|en)", "adelante", "h[áa]galo", "proceda", "confirmo", "dale"]),
    ack: wordsRe(["claro", "vale", "de acuerdo", "est[aá] bien", "muy bien", "perfecto", "correcto", "exacto", "eso es", "as[ií] es", "por supuesto", "desde luego", "efectivamente", "ok(?:ay|ey)?"]),
    hedge: wordsRe(["pens(?:ar(?:lo)?|ando|ar[ée])", "pi[ée]nso", "quiz[áa]s?", "tal vez", "a lo mejor"]),
    noLongerNeeded: wordsRe(["(?:ya )?no (?:la |lo |me )?(?:necesito|hace falta|sirve)(?: m[áa]s)?", "no (?:puedo|podr[ée]|voy a poder)(?: (?:ir|venir|asistir|estar))?", "no me queda (?:otra|m[áa]s remedio)"], "giu"),
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
    cancelYes: wordsRe(["oui", "ouais"]),
    goAhead: wordsRe(["annul(?:ez|e|er)(?:-l[ea])?", "allez-y", "faites-le", "je confirme", "confirm(?:ez|e)"]),
    ack: wordsRe(["d['’]accord", "parfait", "bien s[ûu]r", "tr[èe]s bien", "(?<!mal )entendu", "exact(?:ement)?", "correct", "c['’]est (?:bien )?(?:[çc]a|bon|juste)", "voil[àa]", "absolument", "effectivement", "ok(?:ay)?"]),
    hedge: wordsRe(["r[ée]fl[ée]chi\\p{L}*", "peut-[êe]tre", "je ne sais"]),
    noLongerNeeded: wordsRe(["(?:je )?n['’]en ai plus besoin", "plus besoin", "(?:on |je )ne (?:le |la )garde pas", "je ne (?:peux|pourrai|pourrais) (?:malheureusement )?pas(?: (?:venir|y aller|[êe]tre l[àa]))?"], "giu"),
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
    cancelYes: wordsRe(["ja", "jawohl", "jep"]),
    goAhead: wordsRe(["stornier(?:en|t|e)", "absagen", "machen sie (?:das|es)", "ich best[äa]tige"]),
    ack: wordsRe(["genau", "richtig", "korrekt", "stimmt", "passt", "perfekt", "alles klar", "in ordnung", "ok(?:ay)?", "klar", "nat[üu]rlich", "sicher", "einverstanden", "gerne?", "bitte"]),
    hedge: wordsRe(["[üu]berleg\\p{L}*", "vielleicht", "wei[ßs] (?:nicht|noch)"]),
    noLongerNeeded: wordsRe(["(?:ich )?brauche (?:ihn|sie|es|den termin) nicht mehr", "nicht mehr (?:n[öo]tig|notwendig)", "ich kann (?:da )?(?:leider )?nicht(?: (?:kommen|da sein|hin))?"], "giu"),
    decline: wordsRe(["nein", "nee", "n[öo]", "warten sie", "behalt(?:e|en|et)", "moment(?:mal)?", "nicht (?:stornieren|absagen|l[öo]schen)", "(?:stornieren|absagen|l[öo]schen) sie (?:\\p{L}+ )?(?:bitte )?nicht", "bitte nicht", "lieber nicht", "behalten", "lassen sie", "vergessen sie", "doch nicht", "nicht (?:den|die|diesen|diese)"]),
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
    cancelYes: wordsRe(["s[iì]"]),
    goAhead: wordsRe(["(?:la |lo )?cancell(?:i|ate|are|a)", "(?:la |lo )?annull(?:i|ate|are|a)", "proceda", "vada pure", "confermo"]),
    ack: wordsRe(["d['’]accordo", "certo", "certamente", "sicuro", "benissimo", "va bene", "perfett[oa]", "esatt[oa]", "giust[oa]", "corrett[oa]", "ok(?:ay)?"]),
    hedge: wordsRe(["ci penso", "pensarci", "forse", "non so"]),
    noLongerNeeded: wordsRe(["non (?:mi )?serve più", "non (?:ne )?ho più bisogno", "(?:purtroppo )?non (?:posso|potr[òo]|riesco a)(?: (?:venire|andare|esserci))?"], "giu"),
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
    cancelYes: wordsRe(["ja", "jawel"]),
    goAhead: wordsRe(["annuleer", "annuleren", "zeg (?:hem |maar )?af", "ga (?:je|uw) gang", "doe maar", "bevestig"]),
    ack: wordsRe(["goed", "prima", "in orde", "akkoord", "zeker", "natuurlijk", "klopt", "precies", "perfect", "graag", "ok[ée]?", "okay"]),
    hedge: wordsRe(["nadenk\\p{L}*", "denk (?:er )?(?:nog )?over", "misschien", "weet (?:niet|nog)"]),
    noLongerNeeded: wordsRe(["(?:ik )?heb (?:hem|het|ze) niet meer nodig", "niet meer nodig", "(?:ik kan|kan ik) (?:er )?(?:helaas )?niet(?: (?:komen|zijn))?"], "giu"),
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
    // 2× is the length cap: 「ご来院は初めてでよろしいですか」 is another question (re-review).
    // 「それでは、」 is a conjunction: 「それで」 only before the check itself (final confirmation review).
    pointsBack: /^(?:もし)?(?:違|間違)っていたら|^(?:こちら|これ|それ|そちら)で(?=よろし|お間違い|間違い|合って|正し)|ご?確認(?:を)?(?:ください|下さい|お願い|して|いただけ)/,
    goAhead: /キャンセルして|キャンセルで(?!す)|そうしてください|取り消して|お願い(?:いた)?します|やめます|構いません|かまいません/,
    ack: /了解(?:です|しました)?|承知(?:しました|いたしました)|わかりました|分かりました/,
    // 「考えます」/「迷っています」 hedge; 「考えた」 and 「迷惑」 don't.
    hedge: /考え(?:ます|させて|中|たい|てみ)|かもしれ|わから|分から|迷(?:って|い|う)/,
    noLongerNeeded: /(?:もう)?(?:必要|要り|いり)(?:ありません|ません|ない|なくなりました)|(?:行け|来られ|伺え)(?:ません|ない|なくなりました)/g,
    cancelYes: /はい|ええ(?![ーっ]*と)|そうです|(?<![うふ])うん(?!と)/,
    decline: /いいえ|いえ|いや|ううん|待って|まって|しないで|さないで|しなくて(?:いい|大丈夫|結構)|キャンセル(?:は|の)?(?:必要|いり|要り)(?:ありません|ません|ない)|(?<!取り)やめて|やっぱり|そのまま(?!キャンセル|取り消)|結構です|違い|ちがい|違う|ちがう/,
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
