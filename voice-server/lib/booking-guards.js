"use strict";

/**
 * SCRUM-594 PHASE 2: the fast path's booking guards (B2–B6).
 *
 * The phone tests and the simulated-call baseline (scripts/sim-calls) showed
 * the fast path's Claude booking surnames exactly as the STT heard them —
 * "Curry" for "Khoury" — without ever spelling them back, booking a second
 * appointment where the caller wanted the first one moved, taking four
 * confirmations to cancel, and hanging up on "that's all correct, thanks".
 * These are the server-side rules for that, read off the never-windowed
 * transcript (`session.fullTranscriptMessages`):
 *
 *  - B2 spelling: book_appointment is held until the AI has read the surname
 *    back letter by letter, as its question, and the caller said yes.
 *  - B3 second booking: while this call holds a booking, a booking at another
 *    time is redirected to reschedule_appointment once.
 *  - B4 cancel (fastCancelGate): the CancelGate on the MODEL'S OWN arguments
 *    (so a cancel with no identifier is always held), one held cancel per
 *    booking, a retry confirmed only after the caller has spoken again, a
 *    confirmation kept for the same booking across a handler retry, and the
 *    caller's clear "no / leave it" dropping both. Structural only: the
 *    gate review showed a "yes" read off speech-to-text text can't be trusted
 *    to confirm an irreversible cancel ("Yes, the three PM one").
 *  - B5 hang-up: end_call waits until the caller has said goodbye or that
 *    they're done.
 *  - B6 own booking: a reschedule or cancel of a booking THIS call made carries
 *    the name it was booked under, so the booking system never asks the caller
 *    for it again (phone test F1: "Sorry?" was heard as "Deville" and the move
 *    was refused).
 *
 * B2 and B5 step aside after a cap of holds, counted per CALLER TURN (the
 * model's instant retries can't spend it), so a misread "yes" or "bye" can
 * never strand a call; server.js logs and alerts when a cap is reached.
 *
 * Only sessions with `bookingGuards` set get any of this (server.js
 * applyFastConversationSettings): Gemini, classic and owner calls are untouched.
 */

const { Sentry } = require("./sentry");
const { guardWords } = require("./guard-languages");

/** Caller turns with a spelling hold before the guard steps aside. */
const SPELLING_HOLD_CAP = 2;
/** Caller turns with an end_call hold before the guard steps aside. */
const END_CALL_HOLD_CAP = 2;

/**
 * Two or more single letters with separators, as a model or a caller spells a word aloud.
 * A spelling may touch Japanese text ("名字はK-H-O-U-R-Yですね", SCRUM-594 F5).
 */
const SPELLED_RUN = /(^|[^\p{L}'’]|[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}])(\p{Script=Latin}(?:[\s,.\-–—]+\p{Script=Latin}(?![\p{Script=Latin}'’]))+)/gu;
/** Dotted abbreviations that look like spelled letters ("9 a.m.", "e.g."). */
const ABBREVIATION = /\b(?:a\.\s?m|p\.\s?m|e\.\s?g|i\.\s?e)\b\.?/gi;

/**
 * Spelled-out letter runs in a text — "K-H-O-U-R-Y", "K, H, O, U, R, Y",
 * "K h o u r y." — as uppercase strings, in order.
 * @param {unknown} text
 * @param {boolean} [trim] - set aside a one-letter word next to the spelling (runLetters);
 *   only for the AI's read-back — a caller's letters are read as said
 * @returns {string[]}
 */
function spelledRuns(text, trim = true) {
  if (typeof text !== "string" || !text) return [];
  const runs = [];
  for (const m of text.replace(ABBREVIATION, " ").matchAll(SPELLED_RUN)) {
    const letters = runLetters(m[2], trim);
    if (letters.length >= 2) runs.push(letters);
  }
  return runs;
}

/**
 * A spelled run's letters, uppercase.
 * @param {string} run - SPELLED_RUN's letters with their separators
 * @param {boolean} [trim] - see spelledRuns
 * @returns {string}
 */
function runLetters(run, trim = true) {
  const parts = run.split(/([\s,.\-–—]+)/);
  if (trim && parts.length >= 5) {
    // A one-letter word next to the AI's spelling — Italian "è", Spanish "y", English
    // "a" — is set off by a space (or a sentence end) where its letters had hyphens,
    // commas or dots: "è K-H-O-U-R-Y. È…", "K-H-O-U-R-Y y su número" (SCRUM-594 F5).
    // A space between a surname's words is no such word: "D-E S-I-L-V-A".
    const kind = (/** @type {string} */ sep) => sep.replace(/\s+/g, "") || " ";
    const loose = (/** @type {string} */ sep) => kind(sep) === " " || kind(sep) === "." || kind(sep) === ","; // "K-H-O-U-R-Y, è corretto?"
    if (kind(parts[1]) === " " && kind(parts[3]) !== " " && !(parts.length === 5 && loose(parts[3]))) parts.splice(0, 2); // "N G, a" is NG; "è L-I. È" is LI
    if (parts.length >= 5 && loose(parts[parts.length - 2]) && kind(parts[parts.length - 2]) !== kind(parts[parts.length - 4])) parts.splice(-2);
  }
  return (parts.join("").match(/\p{L}/gu) || []).join("").toUpperCase();
}

/**
 * Where the last spelling of `target` in `text` ends, or -1.
 * @param {string} text
 * @param {string} target - spellableLetters(surname)
 * @returns {number}
 */
function spellingEnd(text, target) {
  let end = -1;
  // Abbreviations blanked to the same length, so indexes stay the text's.
  for (const m of text.replace(ABBREVIATION, (abbr) => " ".repeat(abbr.length)).matchAll(SPELLED_RUN)) {
    if (runSpells(runLetters(m[2]), target)) end = /** @type {number} */ (m.index) + m[1].length + m[2].length;
  }
  return end;
}

/**
 * Is `run` the spelling of `target`? A one-letter word run into either end of
 * a spelling ("Is it a K-H-O-U-R-Y?", "…R-Y, a lovely name") still counts.
 * @param {string} run
 * @param {string} target
 * @returns {boolean}
 */
function runSpells(run, target) {
  if (run === target) return true;
  if (run.length !== target.length + 1) return false;
  return (/^[AI]/.test(run) && run.slice(1) === target) || (/[AI]$/.test(run) && run.slice(0, -1) === target);
}

/**
 * A surname's letters as they are spelled aloud: A–Z only, accents folded,
 * hyphens and apostrophes dropped. Empty when the name has letters outside
 * A–Z (another script): there is nothing the caller could confirm letter by letter.
 * @param {unknown} surname
 * @returns {string}
 */
function spellableLetters(surname) {
  if (typeof surname !== "string") return "";
  const folded = surname.normalize("NFD").replace(/\p{M}/gu, "");
  if (/[^A-Za-z\s'’.\-]/.test(folded)) return "";
  return folded.replace(/[^A-Za-z]/g, "").toUpperCase();
}

const LEADING_NEGATIVE = /^\W*(no|nope|nah|not|wrong|wait|hang on|hold on)\b/i;
const NEGATIVE_ANYWHERE = /\b(nah|wrong|incorrect|not (?:right|correct|quite|sure)|isn'?t (?:right|correct)|that'?s not|(?:definitely|absolutely|certainly) not|hang on|hold on|wait|leave it|don'?t|yeah,? no)\b|(?:^|[,.]\s*)no\s*(?:[,.!]|$)/i;
const POSITIVE = /\b(yes|yeah|yep|yup|yea|correct|right|exactly|perfect|spot on|that'?s it|you got it|sounds good|good|sure|absolutely|definitely|okay|ok|uh[- ]?huh|mm[- ]?hmm)\b/i;

/**
 * Does the caller's reply say yes to what was just read back? ("Yes, Khoury,
 * not Curry" is a yes; "Definitely not", "Okay, hold on", "Yeah, no" are not.)
 * On a call in another language its words count too ("Sí, es correcto").
 * @param {unknown} text
 * @param {string} [language] - the call's language (session.fastLanguage)
 * @returns {boolean}
 */
function isAffirmative(text, language = "en") {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t || LEADING_NEGATIVE.test(t) || NEGATIVE_ANYWHERE.test(t)) return false;
  const words = guardWords(language);
  if (words) {
    // "No hay problema", 「間違いありません」 agree: set aside before any no counts.
    if (words.no.test(words.agreeingNo ? t.replace(words.agreeingNo, " ") : t)) return false;
    if (words.yes.test(t)) return true;
  }
  return POSITIVE.test(t);
}

/** Another detail the AI asks about (its own question, never the spelling's). */
const OTHER_FIELD = /\b(first|email|e-mail|address|street|suburb|number|phone|mobile|cell|postcode|post code|zip)\b/i;

/** A day, a time of day or any number: a question about the booking's time. */
const ABOUT_TIME = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|morning|afternoon|evening|noon|midday|o['’]?clock)\b|\d/i;

/** A short "is that right?" after a read-back — not a question about something else. */
const GENERIC_CHECK = /\b(right|correct|yes|ok(?:ay)?)\b/i;

/**
 * Does this AI message ask the caller to check `target`'s spelling? Its LAST
 * question must be the spelling (contain the letters) or a short generic check
 * ("Is that right?"); a read-back with no question at all counts too. A read-back
 * followed by another question ("…K-H-O-U-R-Y. And is the best mobile…?") does
 * not: the caller's "yep" answers that question.
 * On a call in another language, its "is that right?" and its other details
 * count too (a Japanese question ends in 「？」 or 「か。」).
 * @param {string} content
 * @param {string} target - spellableLetters(surname)
 * @param {string} [language] - the call's language (session.fastLanguage)
 * @returns {boolean}
 */
function asksToCheckSpelling(content, target, language = "en") {
  // Japanese asks with a closing 「か」 as often as with 「？」, and with a request
  // (「…教えてください。」) as often as either (final simulated run).
  const questions = language === "ja"
    ? content.split(/(?<=[。．！？!?])/).filter((sentence) => /(?:[?？]|か|ください|下さい|お願い(?:いた)?します)[。．]?\s*$/.test(sentence))
    : content.split(/(?<=[.!?。！？])/).filter((sentence) => /[?？]\s*$/.test(sentence));
  const other = guardWords(language);
  if (questions.length === 0) {
    // A read-back with no question counts — unless it goes on to another detail
    // ("That's K-H-O-U-R-Y. And your phone number, please.").
    const runEnd = spellingEnd(content, target);
    const after = runEnd >= 0 ? content.slice(runEnd) : "";
    return !(OTHER_FIELD.test(after) || Boolean(other?.field.test(after)));
  }
  const last = questions[questions.length - 1];
  const namesField = (/** @type {string} */ text) => OTHER_FIELD.test(text) || Boolean(other?.field.test(text));
  if (spelledRuns(last).some((run) => runSpells(run, target))) {
    // …unless it goes on to another detail: "Is it K-H-O-U-R-Y, and is your mobile…?" (final review)
    const end = spellingEnd(last, target);
    return !namesField(end >= 0 ? last.slice(end) : "");
  }
  const words = last.trim().split(/\s+/).length;
  // Gate review: a question about a day or a time is about the booking, not the
  // spelling ("K-H-O-U-R-Y. ¿Le viene bien el martes?", "Is Tuesday okay?").
  if (ABOUT_TIME.test(last) || Boolean(other?.time.test(last))) return false;
  // "Is that how you spell it?" — a longer question is the spelling only when it
  // points back at it ("Could you spell your first name?" is another question).
  // Another detail named between the spelling and the question makes it that
  // detail's question: "K-H-O-U-R-Y. ¿Y su móvil…? …013. ¿Es ese el correcto?"
  // (SCRUM-594 F5 simulated calls).
  const lastAt = content.lastIndexOf(last);
  const runEnd = spellingEnd(content, target);
  const span = runEnd >= 0 && runEnd <= lastAt ? content.slice(runEnd, lastAt + last.length) : last;
  const otherField = namesField(span);
  if (otherField) return false;
  if (/\bspell/i.test(last) && /\b(it|that)\b/i.test(last)) return words <= 10;
  if (words <= 6 && GENERIC_CHECK.test(last)) return true;
  if (!other) return false;
  if (other.spell.test(last)) return other.shortQuestion(last, 10);
  // A check that points back at what was read needs no length cap (「違っていたら教えてください」).
  return (Boolean(other.pointsBack?.test(last.trim())) || other.shortQuestion(last, 6)) && other.check.test(last);
}

/**
 * Has `surname` been spelled back to the caller and confirmed? The LATEST
 * read-back of exactly these letters decides, by the caller's next words.
 * @param {Array<{ role: string, content: unknown }>} transcript - session.fullTranscriptMessages
 * @param {unknown} surname - the last name about to be saved
 * @param {string} [language] - the call's language (session.fastLanguage)
 * @returns {{ confirmed: boolean, reason: "confirmed" | "not-spellable" | "not-read-back" | "not-asked" | "awaiting-reply" | "caller-respelled" | "not-affirmed" }}
 */
function surnameSpellingConfirmed(transcript, surname, language = "en") {
  const target = spellableLetters(surname);
  if (target.length < 2) return { confirmed: true, reason: "not-spellable" };
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m.role !== "assistant" || !spelledRuns(m.content).some((run) => runSpells(run, target))) continue;
    if (!asksToCheckSpelling(String(m.content), target, language)) return { confirmed: false, reason: "not-asked" };
    const reply = transcript.slice(i + 1).find((x) => x.role === "user");
    if (!reply) return { confirmed: false, reason: "awaiting-reply" };
    const replyRuns = spelledRuns(reply.content, false); // gate review: "No, C-L-A-R-K. E." is a respelling
    const respelledSame = replyRuns.some((run) => runSpells(run, target));
    if (replyRuns.length > 0 && !respelledSame) return { confirmed: false, reason: "caller-respelled" };
    if (isAffirmative(reply.content, language) || respelledSame) return { confirmed: true, reason: "confirmed" };
    return { confirmed: false, reason: "not-affirmed" };
  }
  return { confirmed: false, reason: "not-read-back" };
}

/**
 * The tool result for a booking held for spelling: what the model would save,
 * letter by letter, so the caller can say yes or correct it.
 * @param {string} surname
 * @returns {string}
 */
function spellingHoldMessage(surname) {
  const letters = spellableLetters(surname).split("").join("-");
  return `DO NOT BOOK YET. Read the caller's last name back to them letter by letter, exactly as you will save it — for "${surname}" that is ${letters} — and ask "Is that right?" as its own question, with nothing else in that reply. If they correct it, save their spelling. Call book_appointment again only after they say yes.`;
}

/**
 * @typedef {{
 *   spellingHolds: number, lastSpellingHoldTurn: number,
 *   secondBookingNudged: boolean,
 *   endCallHolds: number, lastEndCallHoldTurn: number
 * }} GuardState
 */

/**
 * The session's guard counters, created on first use.
 * @param {{ bookingGuardState?: Partial<GuardState> }} session
 * @returns {GuardState}
 */
function guardState(session) {
  const state = /** @type {GuardState} */ (session.bookingGuardState ||= {});
  state.spellingHolds ??= 0;
  state.lastSpellingHoldTurn ??= -1;
  state.secondBookingNudged ??= false;
  state.endCallHolds ??= 0;
  state.lastEndCallHoldTurn ??= -1;
  return state;
}

/** "Don't cancel (it)", or a closing "…don't" — a decline even after a yes. */
const DONT_CANCEL = /\b(?:don['’]?t|do not) (?:(?:want to |need to )?cancel\b|want (?:it|that|them|this|my \w+) cancel)|\b(?:can|could|would) you not cancel\b|\b(?:don['’]?t|do not)\W*$/i;
/** "No" words that agree: "No worries", "No problem", "No dramas", "Nah yeah". */
const AGREEING_NO = /\b(?:no (?:worries|problems?|dramas?|probs?|stress)|nah,? yeah)\b/gi;
/** A yes word that still means no: "Yeah nah", "Yeah, no". */
const YES_BUT_NO = /^\W*(?:yes|yeah|yep|yup|ok(?:ay)?|sure)\W+(?:nah|no)\b/i;
const NO_AT_EDGE = /^\W*(?:(?:uh|um|er|erm|oh|ah|well|hmm)\W+)*(?:no|nope|nah)\b|\b(?:no|nope|nah)\W*$/i;
const DECLINE_PHRASE = /\b(?:leave it|never ?mind|changed my mind|forget it|not sure|hold on|hang on|wait|not (?:that|this|the|my)(?: \w+){0,3} one|wrong one|that['’]?s (?:wrong|not (?:it|right|the one))|don['’]?t do (?:it|that)|(?:absolutely|definitely|certainly|of course) not|not at all|rather not|(?<!\b(?:can['’]?t|can ?not|won['’]?t|couldn['’]?t|not|never|unable)(?: (?!cancel)\w+){0,3} )keep(?:ing)? (?:it(?! handy)|the booking|the appointment|my booking|my appointment))\b/i;
/** "No, just cancel it": a no to the other option, and a go-ahead for the booking read back. */
const NO_JUST_CANCEL_IT = /^\W*(?:no|nope|nah)\W+just cancel (?:it|that)\W*$/i;

/**
 * Does this caller message take a cancel back? Any sign of a no counts: "don't
 * (cancel)", "yeah nah", "leave it / keep it / never mind / forget it / wait…",
 * "not that one / wrong one", or a "no" at either end — once the "no" words that agree ("no worries", "nah
 * yeah") are set aside. A go-ahead never outweighs it ("No, cancel the other
 * one" is a no to this one); only "No, just cancel it" is a yes. Ambiguous words
 * count as a decline: that costs one more read-back, never a cancel the caller
 * refused. On a call in another language its words count too ("Non, attendez"),
 * and a held cancel goes through only on a clear go-ahead (cancelGoAhead).
 * @param {unknown} text
 * @param {string} [language] - the call's language (session.fastLanguage)
 * @returns {boolean}
 */
function declinesCancel(text, language = "en") {
  if (typeof text !== "string") return false;
  const words = guardWords(language);
  let t = text.trim().replace(AGREEING_NO, " ");
  if (words?.agreeingNo) t = t.replace(words.agreeingNo, " ");
  if (DONT_CANCEL.test(t) || YES_BUT_NO.test(t) || DECLINE_PHRASE.test(t)) return true;
  if (NO_JUST_CANCEL_IT.test(t)) return false;
  if (!words) return NO_AT_EDGE.test(t);
  if (words.decline.test(t)) return true;
  // Any "no" too, once the reasons that mean cancel ("I don't need it any more",
  // "I can't come") are set aside.
  const said = t.replace(words.noLongerNeeded, " ");
  return words.no.test(said) || NO_AT_EDGE.test(said);
}

/**
 * Does this caller message clearly say go ahead with a cancel — a yes or "cancel it",
 * and no refusal? On a call in another language a held cancel goes through only on one
 * (confirmation reviews): no table lists every way to take a cancel back ("Lascia
 * stare", 「そのままでお願いします」), so an answer that is neither keeps the cancel held
 * for one more read-back — never a cancel the caller refused, never a dropped one.
 * English: anything but a refusal, as before (the gate is structural).
 * @param {unknown} text
 * @param {string} [language] - the call's language (session.fastLanguage)
 * @returns {boolean}
 */
function cancelGoAhead(text, language = "en") {
  if (typeof text !== "string") return false;
  if (declinesCancel(text, language)) return false;
  const words = guardWords(language);
  if (!words) return true;
  const raw = text.trim();
  // Never a question ("Wäre es in Ordnung, ihn zu verlegen?", 「キャンセルですか」) or a
  // hedge ("In Ordnung, ich überlege noch"): security review.
  if (/[?？]\s*$/.test(raw) || (language === "ja" && /か[。．!！]?\s*$/.test(raw))) return false;
  if (words.hedge.test(raw)) return false;
  if (words.cancelYes.test(raw) || words.goAhead.test(raw) || EN_YES.test(raw)) return true;
  // "Alles klar", "Vale", "Okay" only as the whole answer (with a thanks or a please).
  const rest = raw.replace(new RegExp(words.ack.source, `${words.ack.flags}g`), " ").replace(EN_ACK, " ").replace(ACK_COURTESY, " ");
  return (words.ack.test(raw) || EN_ACK_ONE.test(raw)) && !/\p{L}/u.test(rest);
}

/** A plain English yes, anywhere in a caller's answer on a call in another language. */
const EN_YES = /\b(?:yes|yeah|yep)\b/i;
/** English acknowledgements: a go-ahead only as the whole answer. */
const EN_ACK = /\b(?:ok(?:ay)?|sure|fine|alright|all right|perfect|great)\b/gi;
const EN_ACK_ONE = /\b(?:ok(?:ay)?|sure|fine|alright|all right|perfect|great)\b/i;
/** A thanks, a please, a filler or a goodbye that may go with an acknowledgement ("Ah, vale.", "Vale, gracias, adiós."). */
const ACK_COURTESY = /(?<![\p{L}\p{N}])(?:(?:muchas )?gracias|merci(?: beaucoup)?|danke(?: sch[öo]n)?|grazie|bedankt|dank (?:je|u)(?: wel)?|thanks|thank you|por favor|s['’]il vous pla[iî]t|bitte|per favore|alstublieft|graag|お願いします|ありがとうございます|ah|eh|euh|oh|ehm|[äe]hm?|mm+h?|uhm?|adi[oó]s|au revoir|tsch[üu]ss?|ciao|chao|doei|arrivederci)(?![\p{L}\p{N}])/giu;

/**
 * How many times the caller has spoken: the turn a hold belongs to.
 * @param {Array<{ role: string }>} transcript
 * @returns {number}
 */
function callerTurns(transcript) {
  return transcript.filter((m) => m.role === "user").length;
}

/**
 * B4: the fast path's CancelGate (call-session.js confirmFastCancel) on the
 * MODEL'S OWN arguments — before any caller-ID fill, so a cancel with no
 * identifier of its own is always held — with the caller's latest decline: a
 * held or remembered confirmation made before it no longer counts.
 * @param {import("../call-session").CallSession} session
 * @param {Record<string, any>} modelArgs
 * @param {number} nowMs
 * @returns {{ proceed: boolean, via: "confirmed" | "retry" | null, reason: "no-identifier" | "first-attempt" | "awaiting-caller" | "caller-declined" | null, dropped: number }}
 */
function fastCancelGate(session, modelArgs, nowMs) {
  const transcript = session.fullTranscriptMessages;
  const language = session.fastLanguage || "en";
  const otherLanguage = guardWords(language) !== null;
  let declinedAt = -1;
  let assistantAt = -1;
  let callerAt = -1;
  let unclearAt = -1;
  transcript.forEach((m, i) => {
    if (m.role === "user") {
      callerAt = i;
      if (declinesCancel(m.content, language)) declinedAt = i;
      else if (otherLanguage && !cancelGoAhead(m.content, language)) unclearAt = i;
    }
    if (m.role === "assistant") assistantAt = i;
  });
  // Another language: an answer that is neither a refusal nor a clear go-ahead keeps a
  // held cancel held, and puts a confirmed one back on hold: the clear yes must follow a
  // fresh read-back (confirmation reviews, security review).
  return session.confirmFastCancel(modelArgs || {}, nowMs, {
    callerTurn: callerTurns(transcript),
    transcriptAt: transcript.length,
    declinedAt,
    assistantAt,
    callerUnclear: callerAt >= 0 && callerAt === unclearAt,
    unclearAt,
  });
}

/**
 * "Monday 19 October, 9:00 AM" for a model-supplied local datetime
 * ("2026-10-19T09:00:00"); the raw value when it isn't one.
 * @param {unknown} datetime
 * @returns {string}
 */
function describeLocal(datetime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(datetime || ""));
  if (!m) return String(datetime || "an earlier time");
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}

/**
 * The fast path's checks on a book_appointment, before it runs. Null lets it
 * through. `hold: true` means nothing is booked and the message goes back to
 * the model as the tool result; `capReached: true` lets an unconfirmed
 * spelling through after SPELLING_HOLD_CAP caller turns of holds (server.js
 * logs and alerts on it). Counts its holds on `session.bookingGuardState`.
 *
 * @param {{ bookingGuards?: boolean, bookingGuardState?: Partial<GuardState>, fullTranscriptMessages: Array<{ role: string, content: unknown }>, confirmedBookings?: Map<string, { datetime?: string, name?: string, at?: number }>, fastLanguage?: string|null }} session
 * @param {Record<string, any>} args - the model's book_appointment arguments
 * @param {(args: Record<string, any>) => string} bookingKey - lib/booking-key.js
 * @returns {{ hold: true, kind: "second-booking" | "spelling", message: string, reason: string, count?: number, cap?: number } | { hold: false, kind: "spelling", capReached: true, reason: string } | null}
 */
function checkBookingGuards(session, args, bookingKey = require("./booking-key").bookingKey) {
  if (!session.bookingGuards) return null;
  const state = guardState(session);
  const a = args || {};

  // B3: this call already holds a booking and the model books another time.
  const held = session.confirmedBookings;
  if (held && held.size > 0 && !held.has(bookingKey(a)) && !state.secondBookingNudged) {
    state.secondBookingNudged = true;
    const existing = [...held.values()].sort((x, y) => (y.at || 0) - (x.at || 0))[0];
    return {
      hold: true,
      kind: "second-booking",
      reason: "this-call-holds-a-booking",
      message: `NOT BOOKED — no new appointment was made. This caller already has a booking from this call: ${describeLocal(existing.datetime)} for ${existing.name || "them"}. If they want to CHANGE it to the new time, call reschedule_appointment instead (current_datetime "${existing.datetime}", new_datetime "${a.datetime}") — do not book a second appointment. Only if they clearly want a SECOND, separate appointment as well, confirm that with them, then call book_appointment again.`,
    };
  }

  // B2: the surname must have been spelled back and confirmed.
  const surname = typeof a.last_name === "string" && a.last_name.trim()
    ? a.last_name.trim()
    : String(a.name || "").trim().split(/\s+/).slice(1).join(" ");
  if (!surname) return null;
  const check = surnameSpellingConfirmed(session.fullTranscriptMessages, surname, session.fastLanguage || "en");
  if (check.confirmed) return null;
  const turn = callerTurns(session.fullTranscriptMessages);
  if (state.lastSpellingHoldTurn !== turn) {
    if (state.spellingHolds >= SPELLING_HOLD_CAP) return { hold: false, kind: "spelling", capReached: true, reason: check.reason };
    state.spellingHolds++;
    state.lastSpellingHoldTurn = turn;
  }
  return { hold: true, kind: "spelling", reason: check.reason, count: state.spellingHolds, cap: SPELLING_HOLD_CAP, message: spellingHoldMessage(surname) };
}

/** The handlers match a cancel or reschedule's time to a booking within ±15 minutes (SCRUM-381). */
const MATCH_WINDOW_MS = 15 * 60 * 1000;

/**
 * The booking a model-supplied datetime means, the way the handlers pick it:
 * an exact match, else the closest within ±15 minutes; null when none is, or
 * when two are equally close.
 * @param {Array<{ datetime?: string }>} entries
 * @param {unknown} datetime
 * @param {(datetime: unknown) => string} normalizeDatetime
 * @returns {any}
 */
function closestWithinWindow(entries, datetime, normalizeDatetime) {
  const target = Date.parse(normalizeDatetime(datetime));
  if (!Number.isFinite(target)) return null;
  const scored = entries
    .map((e) => ({ e, gap: Math.abs(Date.parse(normalizeDatetime(e.datetime)) - target) }))
    .filter((x) => Number.isFinite(x.gap) && x.gap <= MATCH_WINDOW_MS)
    .sort((x, y) => x.gap - y.gap);
  if (scored.length === 0 || (scored.length > 1 && scored[0].gap === scored[1].gap)) return null;
  return scored[0].e;
}

/**
 * The ledger entry (session.confirmedBookings) a reschedule or cancel is about:
 * by its time or date when the model gave one, else the call's only booking.
 * Never a guess between two.
 * @param {Record<string, any>} args
 * @param {Map<string, { datetime?: string, name?: string }> | undefined} ledger
 * @param {(datetime: unknown) => string} normalizeDatetime - lib/booking-key.js
 * @returns {{ datetime?: string, name?: string } | null}
 */
function ledgerEntryFor(args, ledger, normalizeDatetime) {
  if (!(ledger instanceof Map) || ledger.size === 0) return null;
  const entries = [...ledger.values()];
  const datetime = String(args.current_datetime || args.datetime || "").trim();
  if (datetime) return closestWithinWindow(entries, datetime, normalizeDatetime);
  const date = String(args.current_date || args.date || "").trim();
  if (date) {
    const hits = entries.filter((e) => typeof e.datetime === "string" && e.datetime.startsWith(date));
    return hits.length === 1 ? hits[0] : null;
  }
  return entries.length === 1 ? entries[0] : null;
}

/**
 * B6: a reschedule or cancel of a booking this call made, with the name it was
 * booked under when the model didn't pass one.
 * @param {Record<string, any>} args
 * @param {Map<string, { datetime?: string, name?: string }> | undefined} ledger - session.confirmedBookings
 * @param {(datetime: unknown) => string} normalizeDatetime - lib/booking-key.js
 * @returns {Record<string, any>} args itself, or a copy with `name` filled
 */
function withBookedName(args, ledger, normalizeDatetime) {
  const a = args || {};
  if (typeof a.name === "string" && a.name.trim()) return a;
  const entry = ledgerEntryFor(a, ledger, normalizeDatetime);
  return entry && typeof entry.name === "string" && entry.name.trim() ? { ...a, name: entry.name } : a;
}

/**
 * B6: after a successful update_appointment that changed the name, the ledger
 * entry carries the new one (withBookedName must pass what the booking now says).
 * @param {Map<string, { datetime?: string, name?: string }> | undefined} ledger
 * @param {Record<string, any>} args - update_appointment's arguments
 * @param {(datetime: unknown) => string} normalizeDatetime
 */
function noteNameCorrection(ledger, args, normalizeDatetime) {
  const a = args || {};
  const first = typeof a.first_name === "string" ? a.first_name.trim() : "";
  const last = typeof a.last_name === "string" ? a.last_name.trim() : "";
  if (!first && !last) return;
  const entry = ledgerEntryFor(a, ledger, normalizeDatetime);
  if (!entry) return;
  const parts = String(entry.name || "").trim().split(/\s+/);
  const oldFirst = parts[0] || "";
  const oldLast = parts.slice(1).join(" ");
  entry.name = `${first || oldFirst} ${last || oldLast}`.trim();
}

/** The fast path's cancel note when this call still holds another booking (CANCEL_NUDGE says it holds none). */
const CANCEL_KEPT_NUDGE =
  " NOTE: that appointment is cancelled, but the caller still has another appointment booked on this call — don't tell them they have nothing booked.";

/**
 * After a successful fast-path cancel: forget the cancelled booking from this
 * call's ledger, and only it. A cancel by time or date that matches none of
 * this call's bookings (an earlier call's) leaves the ledger alone; one it
 * can't place (a code, two the same day) forgets them all, as every pipeline did.
 * @param {Map<string, { datetime?: string }> | undefined} ledger - session.confirmedBookings
 * @param {Record<string, any>} args - the cancel's arguments
 * @param {(datetime: unknown) => string} normalizeDatetime
 * @returns {{ remaining: number, clearedAll: boolean }}
 */
function forgetCancelledBooking(ledger, args, normalizeDatetime) {
  if (!(ledger instanceof Map) || ledger.size === 0) return { remaining: 0, clearedAll: false };
  const a = args || {};
  const entry = ledgerEntryFor(a, ledger, normalizeDatetime);
  if (entry) {
    for (const [key, value] of ledger) if (value === entry) ledger.delete(key);
    return { remaining: ledger.size, clearedAll: false };
  }
  const datetime = String(a.datetime || "").trim();
  const date = String(a.date || "").trim();
  // A time or date none of this call's bookings is near: an earlier call's booking — the ledger stands.
  const near = (/** @type {{ datetime?: string }} */ e) => typeof e.datetime === "string" && (datetime ? closestWithinWindow([e], datetime, normalizeDatetime) !== null : e.datetime.startsWith(date));
  if ((datetime || date) && ![...ledger.values()].some(near)) return { remaining: ledger.size, clearedAll: false };
  ledger.clear();
  return { remaining: 0, clearedAll: true };
}

/** A goodbye in any position: the caller is done. */
const GOODBYE = /\b(bye|goodbye|see ya|see you|nothing else|that'?ll be all|no thanks|no,? thank you|have a (?:good|great|nice) (?:one|day|night|weekend|afternoon|evening))\b/i;
/** "That's all (thanks)" closes a call; "that's all correct / fine" answers a read-back. */
const THATS_ALL = /\bthat'?s all\b(?=\s*(?:$|[,.!]|thanks|thank you|for (?:now|today)|from me|i need|cheers|bye))/i;
/** Done only as an answer to "anything else?" — after "is everything correct?" they answer the read-back. */
const DONE_IF_ASKED = /\b(that'?s it|that'?s everything|all good|all done|cheers|i'?m (?:good|fine|done|right|all set)|we'?re (?:good|done|all set)|that'?s all)\b/i;
const PLAIN_NO = /^\W*(no|nope|nah|not really)\b/i;

// SCRUM-594 (F5): the same closings in the other languages the fast path speaks
// (lib/fast-languages.js: es, fr, de, it, nl, ja) — read only once the call has
// switched to one (an English call keeps the English patterns: "Jenny Chau" is a
// surname). Like THATS_ALL, a closing counts only at the END of what the caller
// said ("Das war's nicht…", "C'est tout ce que…" are not goodbyes), optionally
// followed by a thanks. JS's \b is ASCII-only, so words are bounded by \p{L}.
const THANKS = "(?:muchas )?gracias|merci(?: beaucoup)?|danke(?: sch[öo]n| sehr)?|vielen dank|grazie(?: mille)?|bedankt|dank (?:je|u)(?: wel)?|thanks|thank you";
/** Words a closing may follow at a clause's start: "and", "okay", "yes", "thanks"… */
const CLAUSE_LEAD = `(?:y|et|und|e|en|alors|also|allora|dus|pues|entonces|ok(?:ay|é)?|vale|bueno|bien|gut|bene|goed|s[ií]|s[iì]|oui|ja|perfect[oa]|perfetto|parfait|d['’]accord|bon|super|prima|top|nou|klar|alles klar|va bene|muy bien|tr[èe]s bien|adi[oó]s|ciao|chao|tsch[üu]ss|doei|${THANKS})`;
/**
 * Where a clause starts: the reply's start or after punctuation, then at most two lead
 * words ("Sí hasta mañana", "Merci, à mardi"). A lead word mid-sentence is no start
 * ("Déplacez-le alors à jeudi"). Bounded repeats: no O(n²) on long runs of spaces.
 */
const CLAUSE_START = `(?<=(?:^|[.,;:!?¡…])[\\s¡¿"'«]{0,3}(?:${CLAUSE_LEAD},?\\s{1,2}){0,2})`;
/**
 * @param {string[]} alternatives
 * @param {{ clauseStart?: boolean }} [options] - clauseStart: only where a clause starts
 */
const closingAtEnd = (alternatives, options = {}) => new RegExp(`(?<![\\p{L}\\p{N}])${options.clauseStart ? CLAUSE_START : ""}(?:(?=(?:no|non|nein|nee)[\\s,])|(?<!(?<![\\p{L}\\p{N}])(?:non|no|nicht|niet|pas)\\s))(?:${alternatives.join("|")})(?:[\\s,.!¡]+(?:y |et |und |e |en )?(?:${THANKS}))?[\\s,.!¡…]*$`, "iu");
const GOODBYE_OTHER = closingAtEnd([
  "adi[oó]s", "hasta (?:luego|pronto|la pr[oó]xima)", "que tenga (?:un )?buen d[ií]a", "no,? (?:muchas )?gracias", "eso (?:es|ser[ií]a) todo",
  "au revoir", "[àa] bient[ôo]t", "bonne (?:journ[ée]e|soir[ée]e)", "non,? merci", "c['’]est tout", "ce sera tout",
  "tsch[üu]ss?", "auf wieder(?:h[öo]ren|sehen)", "sch[öo]nen tag(?: noch)?", "nein,? danke", "das w[aä]r['’]?s", "das ist alles",
  "arrivederci", "buona (?:giornata|serata)", "a presto", "no,? grazie", "[èe] tutto",
  "doei", "tot ziens", "fijne dag(?: nog)?", "nee,? (?:bedankt|dank (?:je|u)(?: wel)?)", "dat was het", "dat is alles",
]);
/**
 * "See you tomorrow / on Tuesday" — only where a clause starts ("Merci, à mardi !"),
 * never at the end of a scheduling sentence ("je voudrais le déplacer à mardi",
 * "estoy de viaje hasta el lunes"): final review.
 */
const SEE_YOU_OTHER = closingAtEnd([
  "hasta (?:ma[ñn]ana|el (?:lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo))",
  "[àa] (?:demain|plus tard|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)",
  "bis (?:morgen|dann|bald|sp[äa]ter|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)",
  "a (?:domani|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica)", "ci vediamo",
  "tot (?:morgen|dan|straks|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)",
], { clauseStart: true });
/** "Chao" / "ciao" / "dag" only as the whole reply ("Linda Chao" is a name; "Ciao, vorrei…" a greeting). */
const CIAO_ALONE = new RegExp(`^[\\s¡¿"'«]*(?:(?:${THANKS}|vale|bueno|perfecto|perfetto|ok(?:ay)?)[\\s,.!]+)?(?:chao|chau|ciao|dag)(?:[\\s,]+(?:chao|chau|ciao|dag))?(?:[\\s,.!]+(?:${THANKS}))?[\\s,.!…]*$`, "iu");
const GOODBYE_JA = /(?:さようなら|失礼(?:します|いたします)|また(?:明日|あした|今度))[。．！!.\s]*$/;
const DONE_IF_ASKED_OTHER = closingAtEnd([
  "nada(?: m[aá]s)?", "es todo", "estoy bien", "ya est[aá]",
  "rien(?: d['’]autre)?", "[çc]a ira", "c['’]est bon",
  "nichts(?: weiter)?", "alles gut", "passt so",
  "niente(?: altro)?", "nient['’]altro", "a posto", "va bene cos[iì]",
  "niets(?: meer)?", "verder niets",
]);
const DONE_IF_ASKED_JA = /(?:大丈夫です|特にありません|以上です|ありがとうございました|いいえ)[。．！!.\s]*$/;
/** A bare "no" (or "no, thanks") as the whole reply. */
const PLAIN_NO_OTHER = new RegExp(`^[\\s¡¿"'«]*(?:no|non|nein|nee|nada|niente|nichts|niets)(?:[\\s,.!]+(?:no|non|nein|nee))*(?:[\\s,.!]+(?:${THANKS}))?[\\s,.!…]*$`, "iu");
/** "Anything else?" — never "something earlier / later" (a time offer). */
const ANYTHING_ELSE_OTHER = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[
  "algo m[aá]s(?!\\s+(?:temprano|tarde|pronto|cerca|barato|caro))", "alguna otra cosa",
  "autre chose", "rien d['’]autre", "quelque chose d['’]autre",
  "sonst noch(?!(?:\\s+(?:etwas|was))?\\s+(?:fr[üu]her|sp[äa]ter|eher))(?:\\s+(?:etwas|was))?", "noch etwas(?!\\s+(?:fr[üu]her|sp[äa]ter|eher))", "noch was(?!\\s+(?:fr[üu]her|sp[äa]ter|eher))",
  "qualcos['’]altro", "nient['’]altro", "c['’][èe] altro(?!\\s+(?:orario|giorno))",
  "nog iets(?!\\s+(?:eerder|later|vroeger))", "verder nog",
].join("|")})(?![\\p{L}\\p{N}])`, "iu");
const ANYTHING_ELSE_JA = /他に|ほかに/;

/**
 * B5: has the caller said goodbye, or — asked if there's anything else — that
 * they need nothing more? ("Yep, that's it, thanks." answering "Is everything
 * correct?" is a yes to the read-back, not a goodbye.)
 * @param {Array<{ role: string, content: unknown }>} transcript - session.fullTranscriptMessages
 * @param {string} [language] - the call's language (fast path); another language's closings count only then
 * @returns {boolean}
 */
function callerIsDone(transcript, language = "en") {
  const last = transcript.length - 1;
  if (last < 0 || transcript[last].role !== "user" || typeof transcript[last].content !== "string") return false;
  const said = transcript[last].content;
  const other = language !== "en"; // F5: another language's closings only once the call speaks it
  if (GOODBYE.test(said) || THATS_ALL.test(said)) return true;
  if (other && (GOODBYE_OTHER.test(said) || SEE_YOU_OTHER.test(said) || CIAO_ALONE.test(said) || GOODBYE_JA.test(said))) return true;
  const asked = transcript[last - 1];
  const question = asked && asked.role === "assistant" ? String(asked.content) : "";
  // "Is that all correct?" is a read-back, not "anything else?".
  const askedAnythingElse = Boolean(question) && (
    /anything else|anything more|\bis that (?:everything|all)\b(?!\s*,?\s*(?:correct|right|ok(?:ay)?|good|fine|accurate|alright|true))/i.test(question)
    || (other && (ANYTHING_ELSE_OTHER.test(question) || ANYTHING_ELSE_JA.test(question)))
  );
  if (!askedAnythingElse) return false;
  // English "no" only on an English call: "No, espere…" is not "no, nothing else" (confirmation review).
  if (DONE_IF_ASKED.test(said) || (!other && PLAIN_NO.test(said))) return true;
  return other && (DONE_IF_ASKED_OTHER.test(said) || DONE_IF_ASKED_JA.test(said) || PLAIN_NO_OTHER.test(said));
}

/**
 * B5: the fast path's check on an end_call the end_call guard allowed. Null
 * lets the call end; `allow: false` keeps it up with the message as the tool
 * result; `capReached` lets it end after END_CALL_HOLD_CAP caller turns of
 * holds (server.js logs and alerts on it).
 * @param {{ bookingGuards?: boolean, bookingGuardState?: Partial<GuardState>, fullTranscriptMessages: Array<{ role: string, content: unknown }>, fastLanguage?: string|null }} session
 * @returns {{ allow: false, message: string, count: number, cap: number } | { allow: true, capReached: true } | null}
 */
function checkCallerDone(session) {
  if (!session.bookingGuards) return null;
  const state = guardState(session);
  if (callerIsDone(session.fullTranscriptMessages, session.fastLanguage || "en")) return null;
  const turn = callerTurns(session.fullTranscriptMessages);
  if (state.lastEndCallHoldTurn !== turn) {
    if (state.endCallHolds >= END_CALL_HOLD_CAP) return { allow: true, capReached: true };
    state.endCallHolds++;
    state.lastEndCallHoldTurn = turn;
  }
  return {
    allow: false,
    count: state.endCallHolds,
    cap: END_CALL_HOLD_CAP,
    // Phone test F6: the held reply had already said "Have a good day"; another goodbye next round would be the third.
    message: "DON'T END THE CALL YET, and don't say goodbye again: the caller hasn't said goodbye or that they're done. Ask if there's anything else you can help with, and end the call only after they say goodbye or that's all.",
  };
}

/**
 * A guard stepped aside after its cap of holds: the booking or the hang-up goes
 * ahead unconfirmed. Logged and alerted, never silent (no caller words).
 * @param {{ callSid?: string }} session
 * @param {"spelling" | "end_call"} guard
 * @param {string} what - what went unconfirmed
 */
function noteBookingGuardCap(session, guard, what) {
  console.warn(`[BookingGuard] ${guard} guard stepped aside after its cap: ${what}. callSid=${session.callSid}`);
  Sentry.withScope((scope) => {
    scope.setTag("service", "booking_guard");
    scope.setExtras({ callSid: session.callSid, guard });
    Sentry.captureMessage(`Booking guard cap reached (${guard}) — going ahead unconfirmed`, "warning");
  });
}

module.exports = {
  SPELLING_HOLD_CAP,
  END_CALL_HOLD_CAP,
  CANCEL_KEPT_NUDGE,
  spelledRuns,
  spellableLetters,
  isAffirmative,
  surnameSpellingConfirmed,
  spellingHoldMessage,
  declinesCancel,
  cancelGoAhead,
  fastCancelGate,
  checkBookingGuards,
  withBookedName,
  noteNameCorrection,
  forgetCancelledBooking,
  callerIsDone,
  checkCallerDone,
  noteBookingGuardCap,
};
