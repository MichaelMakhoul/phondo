/**
 * Input Validators
 *
 * Per-type completeness checks that run on the accumulated STT buffer
 * to decide: flush now, or keep waiting for more input?
 *
 * Also exports buffer timing configs per input type.
 */

/**
 * Buffer timing configs per input type.
 * - debounceMs: how long to wait after last STT final before flushing
 * - maxWaitMs: hard ceiling — force flush regardless of validation
 * - ignoreUtteranceEnd: if true, Deepgram UtteranceEnd won't trigger early flush
 */
const BUFFER_CONFIGS = {
  phone:     { debounceMs: 2000, maxWaitMs: 12000, ignoreUtteranceEnd: true  },
  email:     { debounceMs: 2000, maxWaitMs: 6000,  ignoreUtteranceEnd: true  },
  name:      { debounceMs: 1200, maxWaitMs: 4000,  ignoreUtteranceEnd: false },
  address:   { debounceMs: 2500, maxWaitMs: 10000, ignoreUtteranceEnd: true  },
  date_time: { debounceMs: 1000, maxWaitMs: 4000,  ignoreUtteranceEnd: false },
  general:   { debounceMs: 600,  maxWaitMs: 3000,  ignoreUtteranceEnd: false },
};

// Spoken digit words mapped to digit strings (English + Spanish)
const SPOKEN_DIGITS = {
  // English
  zero: "0", oh: "0", o: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
  // Spanish
  cero: "0",
  uno: "1", una: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5",
  seis: "6", siete: "7", ocho: "8", nueve: "9",
};

// "double five" → "55", "triple zero" → "000"
// "doble cinco" → "55", "triple cero" → "000"
const MULTIPLIERS = { double: 2, triple: 3, doble: 2 };

// Digit words that are as often ordinary words: "that one", "oh, sorry", "una cita".
// They count only beside real digits (ambiguousCounts), or as the whole answer. SCRUM-594 (phone
// test F6): "Yeah. That one, please." (to the caller-ID number) counted one digit,
// and the buffer waited its full 12 s for a number nobody was saying.
const AMBIGUOUS_DIGIT_WORDS = new Set(["one", "oh", "o", "uno", "una"]);

/**
 * The digit a word stands for. Own keys only: a caller's "double constructor"
 * must not reach Object.prototype (its function made `.repeat` throw inside the
 * buffer's timer, and the uncaught exception exits the whole server).
 * @param {string|undefined} word
 * @returns {string|undefined}
 */
function spokenDigit(word) {
  return word !== undefined && Object.hasOwn(SPOKEN_DIGITS, word) ? SPOKEN_DIGITS[word] : undefined;
}

/** @param {string|undefined} token */
function isDigitToken(token) {
  return token !== undefined && (/^\d+$/.test(token) || spokenDigit(token) !== undefined);
}

/** @param {string|undefined} token a numeral or an unambiguous digit word */
function isRealDigit(token) {
  return token !== undefined && isDigitToken(token) && !AMBIGUOUS_DIGIT_WORDS.has(token);
}

/**
 * Does an ambiguous digit word at tokens[i] count? Only in a run of digits that
 * holds a real one, or, once the number has started (after the text's first real
 * digit: "… five six one, and one one one"), beside another digit. Two ambiguous
 * words alone don't vouch for each other ("Oh, one more thing"), nor does a
 * lead-in before the number ("Oh, one sec. Oh four one two …").
 * @param {string[]} tokens
 * @param {number} i
 * @param {boolean} dictating - tokens[i] comes after the text's first real digit
 */
function ambiguousCounts(tokens, i, dictating, tight) {
  for (const step of [-1, 1]) {
    for (let j = i + step; j >= 0 && j < tokens.length && isDigitToken(tokens[j]); j += step) {
      // Before the number starts, only words said together make a run: "Not that one. Oh four …"
      if (!dictating && !tight[step > 0 ? j - 1 : j]) break;
      if (isRealDigit(tokens[j])) return true;
    }
  }
  return dictating && (isDigitToken(tokens[i - 1]) || isDigitToken(tokens[i + 1]));
}

/**
 * Extract digits from spoken text.
 * Handles: "0412 345 678", "oh four one two", "double five", etc.
 */
function extractSpokenDigits(text) {
  let digits = "";

  // First pass: expand "double/triple X" patterns
  let expanded = text.toLowerCase();
  for (const [mult, count] of Object.entries(MULTIPLIERS)) {
    const re = new RegExp(`${mult}\\s+(\\w+)`, "gi");
    expanded = expanded.replace(re, (_, word) => {
      const d = spokenDigit(word) || (word.match(/^\d$/) ? word : "");
      return d ? d.repeat(count) : word;
    });
  }
  // "… three four five, one sec,": a pause asked for, not a digit (nor the "oh" before it). After the
  // expansion above, so the "oh" of "double oh" is already a numeral and is not eaten.
  expanded = expanded.replace(/\b(?:oh[^a-z0-9]+)?one\s+(?:more\s+)?(?:sec|second|moment|minute|tick)\b/g, " ");

  // Second pass: extract all digit characters and spoken digit words
  // Punctuation ends a token too: "… 0412 555 013?" and "… six seven eight?" (not ":", so "10:30" stays one).
  const parts = expanded.split(/([\s,.\-?!;()"“”–—]+)/);
  /** @type {string[]} */
  const tokens = [];
  /** @type {boolean[]} tight[k]: tokens[k] and tokens[k + 1] are joined by spaces (or a dash) only */
  const tight = [];
  for (let p = 0; p < parts.length; p += 2) {
    if (!parts[p]) continue;
    tokens.push(parts[p]);
    tight.push(/^[\s-]*$/.test(parts[p + 1] ?? ""));
  }
  const firstReal = tokens.findIndex(isRealDigit);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\d+$/.test(token)) {
      digits += token;
    } else if (spokenDigit(token) !== undefined) {
      if (AMBIGUOUS_DIGIT_WORDS.has(token) && tokens.length > 1 && !ambiguousCounts(tokens, i, firstReal !== -1 && i > firstReal, tight)) continue;
      digits += spokenDigit(token);
    }
  }

  return digits;
}

// A plain yes, and nothing else, as the whole answer: "Yeah. That one, please.",
// "Yep, that's the one", "Yeah, sure." Anything more ("Sure, my number is",
// "Yes, but use my work one") may be the start of another number.
const YES_WORDS = "(?:yes|yeah|yep|yup|yeh|okay|ok|correct|right|sure|absolutely|definitely|perfect|that one|this one|(?:the )?same one|that'?s (?:it|right|correct|perfect|fine|good)|that is (?:it|right|correct|the one)|that'?s the (?:right )?(?:one|number)(?: i'?m calling from)?|that (?:one|number)'?s (?:fine|good|right)|the (?:one|number) i'?m calling from(?: is (?:fine|good|right))?)";
const YES_TAIL = "(?:please|thanks|thank you|ta|cheers|mate|no worries|all good|sounds good|that works|that'?ll do|it is|go ahead|use that(?: one)?|the same(?: number)?|that'?s (?:the number|my (?:mobile|number|mobile number)))";
const PLAIN_YES_RE = new RegExp(`^\\W*(?:(?:uh|um|er)[\\s,.]+)?${YES_WORDS}(?:[\\s,.!-]+(?:${YES_WORDS}|${YES_TAIL}))*[\\s,.!]*$`, "i");

/**
 * Is `text` a plain yes to a phone question that offered a number? SCRUM-594
 * (phone test F6): a yes to "I can see you're calling from 0414 141 883, is that
 * the one?" needs no wait for digits that aren't coming. A yes to a plain "what's
 * your number?" is a lead-in (gate review), and so is any yes that goes on.
 * @param {string} type
 * @param {string} text
 * @param {boolean} offered - the AI's last words held a whole number
 * @returns {boolean}
 */
function isPlainYes(type, text, offered) {
  return type === "phone" && offered === true && typeof text === "string" && PLAIN_YES_RE.test(text);
}

// The caller asking to hear it again, or checking the line, and nothing else (English and
// Spanish, the languages the input-type detector knows). A bare "sorry" (or "excuse me",
// "perdón", "disculpe", "bueno") counts only as a question: "Oh, sorry." is an apology that
// may lead into the answer. A lone flat "Hello." doesn't count either (FLAT_HELLO_RE): it may
// start one ("hello at …"); "Hello? Hello." and "Hello. Hello." still do.
const ASKED = "(?=\\s*\\?)"; // the word is followed by a question mark
const LINE_CHECK_PHRASES = [
  "hello", "(?:(?:are )?you (?:still )?|still )(?:there|with me|on the line)", "(?:is )?(?:any|some)(?:one|body) (?:there|home)",
  "i can'?t hear you", "(?:can|could) (?:you|any(?:one|body)) (?:still )?hear me(?: (?:ok(?:ay)?|now|alright|all right))?",
  "(?:did i lose|have i lost) you", "did we get cut off",
  "hola", "al[oó]", `bueno${ASKED}`, "(?:est[aá]s|est[aá]|sigues?) ah[ií]", "me (?:escuchas?|oyes?)(?: bien)?",
  "no (?:te |le )?(?:escucho|oigo)", "(?:hay )?alguien(?: ah[ií])?",
];
const REPEAT_PHRASES = [
  `sorry${ASKED}`, `excuse me${ASKED}`, `perd[oó]n${ASKED}`, `disculpe${ASKED}`,
  "pardon(?: me)?", "what", "huh", "eh", "again", "come again", "one more time",
  "what was that", "what'?s that", "what did you (?:just )?say",
  "(?:can|could|would) you (?:please )?repeat(?: (?:that|it|yourself|the question|what you said))?",
  "(?:can|could|would) you (?:please )?say (?:that|it) again",
  "repeat(?: (?:that|it))?", "say (?:that|it) again",
  "i didn'?t (?:catch|hear|get|understand) (?:that|you|it|what you said)", "i (?:missed|lost) (?:that|it|you)",
  "c[oó]mo", "qu[eé]", "mande", "otra vez",
  "(?:me )?(?:lo )?(?:puede|podr[ií]a) repetir(?:lo)?", "rep[ií]ta(?:lo|me)?", "no (?:le |te )?(?:escuch[eé]|entend[ií]|o[ií])",
];
// "say": "say again", and a stutter ("Say say again?", phone test F8). A word with a "?" after
// it is a phrase, without one a filler: one way to read each word keeps the match from
// backtracking exponentially (with a filler between phrases, "Sorry? Sorry? …" doubled per word).
const NOT_ASKED = "(?!\\s*\\?)";
const REPAIR_FILLER = `(?:oh|um|uh|er|ah|sorry${NOT_ASKED}|excuse me${NOT_ASKED}|perd[oó]n${NOT_ASKED}|disculpe${NOT_ASKED}|hey|hi|yeah|no|say|sí|si)`;
// No word of the tail is also a phrase, for the same reason.
const REPAIR_TAIL = "(?:please|mate|por favor)";
/**
 * A whole turn of `phrases`, each optionally led by fillers ("Hello? Sorry, can you hear me?"),
 * with a polite tail ("please"). A filler never ends the turn: "Hello? Oh." may be "oh four …".
 * @param {string[]} phrases
 */
function wholeTurnOf(phrases) {
  const any = phrases.join("|");
  const sep = "[\\s,.!?¿¡]+";
  const fillers = `(?:${REPAIR_FILLER}${sep})*`;
  return new RegExp(`^[\\s¿¡]*${fillers}(?:${any})(?:${sep}${fillers}(?:${any}|${REPAIR_TAIL}))*[\\s,.!?]*$`, "i");
}
const REPAIR_RE = wholeTurnOf([...REPEAT_PHRASES, ...LINE_CHECK_PHRASES]);
const LINE_CHECK_RE = wholeTurnOf(LINE_CHECK_PHRASES);
// One flat hello and nothing else ("Hello.", "Oh, hello."): a greeting or the start of an answer.
const FLAT_HELLO_RE = new RegExp(`^[\\s¿¡]*(?:${REPAIR_FILLER}[\\s,.!]+)*(?:hello|hola|al[oó])[\\s,.!]*$`, "i");
const REPAIR_MAX_WORDS = 12;

/**
 * A repair is a few words. The cap also bounds the regexes' backtracking (the fillers overlap
 * the phrases), so it counts words split the way the regexes split them: "sorry,sorry,…" is
 * many words, not one.
 * @param {string} text
 */
function fewWords(text) {
  return text.split(/[\s,.!?¿¡]+/).filter(Boolean).length <= REPAIR_MAX_WORDS;
}

/**
 * Is `text` only a request to hear the AI again ("Sorry?", "Can you repeat that?") or a
 * check that the line is alive ("Hello?")? SCRUM-594 (phone test F8): the caller's
 * "Sorry?" to "Can I grab your first and last name?" sat in the name buffer for its 4 s
 * maximum; the caller asked again just as the reply started, and the barge-in cut it off.
 * Such a turn is never the data the buffer waits for, so it is answered at once.
 * @param {unknown} text
 * @returns {boolean}
 */
function isRepairRequest(text) {
  return typeof text === "string" && fewWords(text) && !FLAT_HELLO_RE.test(text) && REPAIR_RE.test(text);
}

/**
 * Is `text` only a check that the line is alive ("Hello?", "Are you still there?")? The
 * caller has heard nothing for a while: whatever the buffer holds is answered now, even in
 * the middle of a number (silent-failure review, F8: "555 1234." then "Hello?" waited 16 s).
 * @param {unknown} text
 * @returns {boolean}
 */
function isLineCheck(text) {
  return typeof text === "string" && fewWords(text) && !FLAT_HELLO_RE.test(text) && LINE_CHECK_RE.test(text);
}

/**
 * Do the AI's words say a whole phone number? A run of numerals joined by spaces,
 * dashes, dots or brackets ("0414 141 883", "(02) 3820 5672") with 8+ digits, or,
 * with no numerals at all, 8+ spoken digits. A date read back ("Tuesday 20
 * October 2026 at 10") is several short runs, not a number.
 * @param {unknown} text
 * @returns {boolean}
 */
function saysPhoneNumber(text) {
  if (typeof text !== "string") return false;
  const runs = text.match(/\+?\(?\d[\d\s().-]*\d/g);
  if (runs) return runs.some((run) => run.replace(/\D/g, "").length >= 8);
  return extractSpokenDigits(text).length >= 8;
}

// An hour, as said or as a numeral.
const HOUR = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d{1,2})";
// Clock times said as words, which the am/pm check misses. SCRUM-594 (phone test F6):
// "Four thirty is good." had no time for it, so the buffer sat out its 4 s maximum.
const SPOKEN_TIME_RE = new RegExp([
  `\\b${HOUR}\\s+(?:thirty|fifteen|forty[\\s-]?five|oh\\s+\\w+|(?:twenty|forty|fifty)(?:[\\s-]?(?:one|two|three|four|five|six|seven|eight|nine))?)\\b`,
  `\\b${HOUR}\\s*(?:o'?clock|a\\.?\\s?m|p\\.?\\s?m)\\b`,
  "\\b(?:five|ten|twenty(?:[\\s-]five)?|quarter|half)\\s+(?:past|to|after)\\b",
  `\\b(?:at|around|about|by|after|before|from|until|till)\\s+${HOUR}\\b`,
  // "Four is fine", "Two works": an hour as the answer
  `\\b${HOUR}\\s+(?:is|works|would|sounds|suits)\\b`,
  "\\b(?:noon|midday|midnight|lunchtime|lunch\\s+time)\\b",
  // Spanish: "a la una", "a las cuatro y media"
  "\\ba\\s+las?\\s+(?:una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|\\d{1,2})\\b",
].join("|"), "i");

/**
 * Check if the user's speech is a question rather than structured data input.
 * When the AI expects a date/time but the user asks "When is the first
 * available appointment?", we should flush immediately instead of waiting
 * for a date/time value that will never come.
 */
const QUESTION_STARTERS = /^(when|what|where|which|who|how|is\s+there|are\s+there|do\s+you|does|can\s+you|could\s+you|will|would)\b/i;

function isUserQuestion(text) {
  return QUESTION_STARTERS.test(text.trim());
}

// Words that begin an answer rather than give a name: Flux can end a turn after one ("Yeah."
// … "Michael Makhoul."), and answering it alone would ask again over the name (F8 review).
const NAME_LEAD_INS = /^(?:yes|yeah|yep|yup|yeh|sure|okay|ok|right|alright|um+|uh+|er+|erm|ah+|oh|so|well|hmm+|mm+|no|nah|hi|hey|s[ií]|claro|vale|bueno|pues|este)$/i;

/**
 * Validate whether the accumulated buffer text is a complete input
 * for the given type.
 *
 * @param {string} type - Input type from detectExpectedInput()
 * @param {string} text - Combined buffer text
 * @param {{ bothNameParts?: boolean }} [context] - bothNameParts: the AI asked for the first and last name together
 * @returns {{ complete: boolean, reason?: string }}
 */
function validateInput(type, text, context = {}) {
  // If the user is asking a question instead of providing data, flush
  // immediately. E.g., AI expects date_time but user says "When is the
  // first available appointment?"
  if (type !== "general" && isUserQuestion(text)) {
    return { complete: true, reason: "user question detected — not data input" };
  }

  switch (type) {
    case "phone": {
      const digits = extractSpokenDigits(text);
      if (digits.length >= 8) {
        return { complete: true, reason: `${digits.length} digits found` };
      }
      // If no digits at all, the user is speaking conversationally
      if (digits.length === 0) {
        return { complete: true, reason: "no digits — conversational response" };
      }
      return { complete: false, reason: `only ${digits.length} digits so far` };
    }

    case "email": {
      const lower = text.toLowerCase();
      // Look for TLD patterns: "dot com", ".com", "dot com dot au"
      const hasTld = /\.(com|net|org|edu|gov|io|au|uk|nz|co)(\.\w{2,3})?/i.test(lower)
        || /dot\s*(com|net|org|edu|gov|io|au|uk|nz|co)/i.test(lower);
      if (hasTld) {
        return { complete: true, reason: "TLD found" };
      }
      return { complete: false, reason: "no TLD yet" };
    }

    case "name": {
      const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
      if (words.length >= 2) {
        return { complete: true, reason: `${words.length} words (first+last)` };
      }
      // SCRUM-594 (phone test F8): one whole word answers a question for one part ("McCook."
      // to "And your last name?"), and waiting the 4 s maximum for a second one left the
      // caller in silence. Still waiting: a lone letter (a spelling just begun), a lead-in
      // ("Yeah." … "Michael Makhoul."), and one word when the AI asked for both names.
      const letters = words.length === 1 ? words[0].replace(/[^\p{L}]/gu, "") : "";
      if (letters.length >= 2 && !NAME_LEAD_INS.test(letters) && context.bothNameParts !== true) {
        return { complete: true, reason: "one whole word" };
      }
      return { complete: false, reason: `only ${words.length} word(s)` };
    }

    case "address": {
      const lower = text.toLowerCase();
      // Look for postcode/zip (4-5 digits) or street number + name (English + Spanish)
      const hasPostcode = /\b\d{4,5}\b/.test(lower);
      const hasStreetNumber = /\b\d+\s+\w+\s*(street|st|road|rd|avenue|ave|drive|dr|lane|ln|place|pl|court|ct|way|boulevard|blvd|crescent|cres|terrace|tce)/i.test(lower);
      const hasSpanishAddress = /\b(calle|avenida|carrera|diagonal|transversal|paseo|camino|colonia|municipio|delegaci[oó]n)\s+[\w\d]/i.test(lower);
      if (hasPostcode || hasStreetNumber || hasSpanishAddress) {
        return { complete: true, reason: hasPostcode ? "postcode found" : "address found" };
      }
      return { complete: false, reason: "no structural address elements yet" };
    }

    case "date_time": {
      const lower = text.toLowerCase();
      // Look for day/date references (English + Spanish)
      const hasDate = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next\s+\w+|this\s+\w+|\d{1,2}(st|nd|rd|th)?(\s+of)?(\s+\w+)?)\b/i.test(lower)
        || /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[nñ]ana|hoy|pr[oó]ximo|esta\s+semana|el\s+\d{1,2})\b/i.test(lower);
      const hasTime = /\b(\d{1,2}(:\d{2})?\s*(am|pm|a\.m|p\.m)|morning|afternoon|evening)\b/i.test(lower)
        || /\b(por la ma[nñ]ana|tarde|noche|mediod[ií]a)\b/i.test(lower)
        || SPOKEN_TIME_RE.test(lower);
      if (hasDate || hasTime) {
        return { complete: true, reason: hasDate ? "date reference found" : "time reference found" };
      }
      return { complete: false, reason: "no date/time reference yet" };
    }

    case "general":
    default:
      return { complete: true };
  }
}

/**
 * Get buffer config for a given input type.
 * @param {string} type
 * @returns {{ debounceMs: number, maxWaitMs: number, ignoreUtteranceEnd: boolean }}
 */
function getBufferConfig(type) {
  return BUFFER_CONFIGS[type] || BUFFER_CONFIGS.general;
}

module.exports = { validateInput, getBufferConfig, BUFFER_CONFIGS, extractSpokenDigits, isPlainYes, isRepairRequest, isLineCheck, saysPhoneNumber };
