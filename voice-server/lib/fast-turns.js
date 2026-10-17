"use strict";

/**
 * SCRUM-594: the turn engine of the fast classic pipeline (spec 4.6).
 *
 * Deepgram Flux reports the caller's turns as TurnInfo events. This module decides
 * what each event means for the call and says so by calling six injected actions.
 * It is a pure state machine: no timers, no I/O, no logging, no error reporting and
 * no imports. The same events and the same session state always produce the same
 * action calls in the same order; everything real (the LLM, the audio, the session)
 * lives behind the actions.
 *
 * Input
 *   - onTurnInfo({ event, turnIndex, transcript, trigger }): what services/flux-stt.js
 *     delivers. `transcript` is cumulative for the turn (not a delta). Flux increments
 *     `turnIndex` right after each EndOfTurn. Flux's docs also state that an EndOfTurn carries
 *     the words of the EagerEndOfTurn before it unless a TurnResumed came in between; the
 *     one exception is ForceEndTurn (trigger "manual"), which supersedes the eager state
 *     with no TurnResumed (flux-aura-api.md A.6). The engine does not rely on that
 *     guarantee: commit()'s === check against the draft's transcript is what decides
 *     whether a draft is adopted.
 *   - getState() -> { aiSpeaking, processing, expectedInputType, aiSpeakingText }, read
 *     when each event arrives and never cached. `aiSpeakingText` is optional: every word
 *     sent to TTS since the player last went idle, which the session supplies for the
 *     echo filter below.
 *
 * The rules (spec 4.6)
 *   1. A transcript that is empty or only whitespace is ignored. (TurnResumed is the
 *      one event that does not read its transcript: see rule 5.)
 *   2. An event for a turn other than the one a draft belongs to cancels that draft:
 *      cancelSpeculation("new-turn"), before anything else the event causes.
 *   3. Barge-in. On Update and StartOfTurn, and on an EndOfTurn that is not dropped as
 *      echo (rule 6), while aiSpeaking or processing: the first one of a turn whose
 *      transcript has 3 or more words, or starts with an INTERRUPT_RE word, calls
 *      bargeIn(). Once per turnIndex, and not when the words are the AI's own voice
 *      coming back (the echo filter). At an EndOfTurn it comes first, then the final is
 *      answered as in rule 6, so a processing-only state and a 3+ word digit final in
 *      structured mode are covered.
 *   4. EagerEndOfTurn, with speculation on and !aiSpeaking && !processing and general
 *      input expected: speculate(transcript, turnIndex).
 *   5. TurnResumed: cancelSpeculation("resumed"). It does not depend on the transcript:
 *      cancelling is always safe, and a draft must not outlive a resumed turn.
 *   6. EndOfTurn, the first one of a turn:
 *        - aiSpeaking, 2 words or fewer, no interrupt word: the classic echo rule.
 *          dropEcho(transcript), then cancelSpeculation("echo"). Nothing else.
 *        - otherwise rule 3 first (bargeIn(), if it has not fired in this turn), then the
 *          final is answered:
 *            - a structured input type is expected: cancelSpeculation("structured"), then
 *              bufferStructured(transcript). CallSession.bufferTranscript merges the pieces
 *              (digits and spelled names split across Flux turns).
 *            - else commit(transcript, turnIndex, trigger). An EndOfTurn while `processing`
 *              commits too: CallSession.queueOrProcess queues it behind the turn in flight.
 *
 * The speakerphone echo filter (barge-in only)
 *   On a speakerphone the AI's own voice re-enters the caller's mic and Flux transcribes
 *   it, so a 3-word echo would stop the AI mid-sentence. A barge-in candidate is held
 *   back as ECHO only when ALL of these hold:
 *     - aiSpeaking is true (a processing-only state has no audio, so it is never filtered);
 *     - getState().aiSpeakingText is non-empty (otherwise the filter fails open, to rule 3);
 *     - the candidate has more than 2 words as heard and 3 or more normalised words, so a
 *       short interrupt ("wait", "hold on") is never judged: "please wait" overlaps it;
 *     - at least 80% of its normalised words appear in the AI's text; and
 *     - 3 or more of its words in a row appear in a row in the AI's text.
 *   Updates are cumulative, so a candidate held back at 3 words barges in once it grows
 *   words of its own, still once per turn. The matching (isLikelyEcho, speechTokens) folds
 *   case, punctuation, "a.m." and "am", and digits against number words ("10" is "ten",
 *   "9:30" is "nine thirty"). The playback position is not used: Aura synthesises at about
 *   twice real time and the echo transcript lags, so what has been heard is not knowable.
 *   The filter only holds back the barge-in. It never touches dropEcho, and an echo-like
 *   final of 3+ words is still committed, as in classic.
 *
 * Per-turn bookkeeping (what the spec leaves open; pinned in tests/fast-turns.test.js)
 *   - A turn is handled once. After its EndOfTurn (committed, dropped or buffered) the
 *     turn is over: a late duplicate EndOfTurn, and any later event of that turn or an
 *     earlier one, is ignored. So a duplicate cannot commit twice or buffer digits twice,
 *     and a straggler Update cannot barge in on the AI's reply to that very turn.
 *   - Barge-in is keyed by turnIndex, not by time or state: speaking, quiet and speaking
 *     again inside one turn is still one barge-in.
 *   - A draft is keyed by the turnIndex it was started for. The engine holds at most the
 *     one it asked for, and cancels it on rules 2, 5 and 6 and on reset(). A commit does
 *     not cancel it: commit() adopts the draft or aborts it itself.
 *   - Actions get the TRIMMED transcript, and speculate() and commit() get the identical
 *     string for the same words, because the draft is adopted only on `===`.
 *   - Bookkeeping is updated BEFORE each action runs, so an action that throws is not
 *     retried by a duplicate event (at most once). The engine does not catch: the error
 *     reaches the caller of onTurnInfo. One thing is guaranteed on top: an EndOfTurn is
 *     still answered (commit or bufferStructured) when the bargeIn() before it throws.
 *
 * What the actions must do
 *   - cancelSpeculation(reason) may be called when there is no draft (rule 5 always asks)
 *     and must then do nothing. Reasons: "resumed", "new-turn", "echo", "structured",
 *     "reset".
 *   - speculate() must replace a draft the session still holds.
 *   - bargeIn() may decline by returning false (nothing was stopped): the turn's barge-in is
 *     then not spent, and a later event of the turn may barge in. Any other return spends it.
 *   - bargeIn() must also abort the session's draft, if any: the engine does not. At an
 *     EndOfTurn it is called right before commit(), which then queues behind the turn that
 *     bargeIn() aborted (CallSession.queueOrProcess) and is adopted or not by its === check.
 *   - commit() decides whether the draft for this turn is adopted (same transcript) or
 *     aborted, and handles `processing` by queueing.
 *   - They are called as methods of the `actions` object, so a class instance works.
 *
 * The "fast-path" policy (`policy: "fast-path"`; the default policy is everything above)
 *   What a live phone call needs on top (Task 5 review, rulings R12a′ and R13):
 *   - A candidate of ECHO_MAX_WORDS words or fewer never barges in on StartOfTurn or Update,
 *     interrupt word or not: "No" is how "No worries" starts. It is judged at its EndOfTurn.
 *     Three words or more barge in early, exactly as above.
 *   - EndOfTurn, in this order:
 *       - while the AI is speaking, its text ends with a question (endsWithQuestion), at
 *         most QUESTION_TAIL_MS of its audio is still to play (aiRemainingMs, a number) and
 *         the turn began after the question's audio did (its start as received, from the
 *         events' receivedAt, at least START_OF_TURN_LAG_MS after questionAudioStartAt), a
 *         final of ECHO_MAX_WORDS words or fewer is the answer ("…Shall I book 10 AM?"
 *         "Yes"; R14″), backchannel words and content alike: never dropped, it goes to
 *         rule 6's answer. A backchannel does not barge in ("No worries" never cuts the
 *         question); an interrupt word does, as always. Earlier in the reply, or when what
 *         is still to play is unknown (REST audio), the rules below apply: a question the
 *         caller has not heard yet is not what an "okay" answers.
 *       - while the AI is speaking OR processing, a backchannel (isBackchannel: "okay",
 *         "thanks", "no worries" ..., two words or fewer) is no turn: dropEcho(transcript,
 *         "backchannel"), then cancelSpeculation("backchannel"). On the structured path too.
 *       - while the AI is speaking, an echo-like final (isLikelyEcho against aiSpeakingText)
 *         is the AI's own voice coming back: dropEcho(transcript, "echo-like"), then
 *         cancelSpeculation("echo"). Answering it would have the AI answer itself.
 *       - otherwise rule 3 (an interrupt word, or substantial speech, barges in) and rule 6's
 *         answer. The classic echo rule is off: any other short final is a real answer
 *         ("Tuesday"), and the session holds the turn until the AI has finished speaking.
 *
 * Speculation off (`speculationEnabled: false`, e.g. FLUX_EAGER_EOT_THRESHOLD=off): the
 * engine never calls speculate or cancelSpeculation, and does not need them.
 *
 * reset() forgets all bookkeeping (and cancels a draft it holds). Call it when a NEW Flux
 * connection replaces the old one: turn indexes restart at 0 there, and without a reset
 * they would be mistaken for turns that already ended.
 */

/**
 * The classic echo rule's interrupt words (server.js, "Echo suppression"). A copy, because
 * the classic path stays untouched; tests/fast-turns.test.js fails if the two drift.
 */
const INTERRUPT_RE = /^(stop|wait|hold on|no|cancel|nevermind|never mind|excuse me|hello|hey)\b/i;

/**
 * R14′: a short final answers the AI's question only in its tail, while at most this
 * much of the AI's audio is still to play (getState().aiRemainingMs). Earlier, it is
 * a backchannel over the reply's first sentences, not an answer to a question the
 * caller has not heard yet.
 */
const QUESTION_TAIL_MS = 2000;

/**
 * R14″: Flux's StartOfTurn reaches the server about this long after the caller's first
 * sound. A turn heard to start at least this long after the question's audio started
 * began while the caller was hearing the question, not the sentence before it.
 */
const START_OF_TURN_LAG_MS = 500;

/**
 * The classic echo rule drops a final of this many words or fewer while the AI speaks.
 * Barge-in uses the same line from the other side: more than this many words is
 * substantial speech.
 */
const ECHO_MAX_WORDS = 2;

/**
 * The fewest normalised words the echo test will judge; fewer say too little to tell echo from a
 * caller. ECHO_MIN_RUN already implies it (a candidate shorter than the run cannot share one). It is
 * its own limit so that tuning the run length never starts judging a two-word fragment, and it
 * answers before the AI's text is tokenised.
 */
const ECHO_MIN_WORDS = 3;
/** The share of the candidate's words that must be in the AI's text, in percent. */
const ECHO_MIN_OVERLAP_PERCENT = 80;
/** Words in a row that must also appear in a row in the AI's text. */
const ECHO_MIN_RUN = 3;

const TURN_EVENTS = new Set(["StartOfTurn", "Update", "EagerEndOfTurn", "TurnResumed", "EndOfTurn"]);
const POLICIES = new Set(["default", "fast-path"]);

/**
 * What a caller says to keep the conversation going without taking a turn (ruling R12a′),
 * in the form backchannelTokens() leaves them, plus the spellings a transcript gives the
 * same sounds ("all right", "mhm", "uh huh").
 */
const BACKCHANNEL_PHRASES = new Set([
  "okay", "ok", "yeah", "yep", "yes", "sure", "right", "alright", "all right", "cool", "great", "perfect",
  "thanks", "thank you", "mm hmm", "mhm", "mhmm", "mmhmm", "uh huh", "uhhuh", "no worries", "no problem",
]);
const ALWAYS_REQUIRED_ACTIONS = ["commit", "bargeIn", "dropEcho", "bufferStructured"];
const SPECULATION_ACTIONS = ["speculate", "cancelSpeculation"];

const NUMBER_ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const NUMBER_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A clock time (9:30) or a run of digits or a run of letters, in that order of preference. */
const SPEECH_PIECE = /(\d+):(\d{2})|\d+|\p{L}+/gu;

/**
 * @typedef {Object} FastTurnEvent
 * @property {string} event - StartOfTurn | Update | EagerEndOfTurn | TurnResumed | EndOfTurn
 * @property {number} turnIndex - Flux turn_index; it increments right after each EndOfTurn
 * @property {string} transcript - cumulative for the turn so far
 * @property {string | null} [trigger] - EndOfTurn only: "model" | "manual" | "timeout" (an open enum)
 * @property {number} [receivedAt] - Date.now() when the server received it (server.js stamps every event); R14″ reads it
 *
 * @typedef {Object} FastTurnState
 * @property {boolean} aiSpeaking - the AI's audio is still playing
 * @property {boolean} processing - the AI is still working on an earlier turn
 * @property {string} [expectedInputType] - "general" | "phone" | "email" | "name" | "address" | "date_time"; missing means general
 * @property {string} [aiSpeakingText] - every word sent to TTS since the player last went idle; missing or empty switches the echo filter off
 * @property {number|null} [aiRemainingMs] - ms of the AI's audio still to play (the player's estimate); null or missing when unknown (REST audio)
 * @property {number|null} [questionAudioStartAt] - Date.now() estimate of when the audio of the AI's last question starts playing; null or missing when unknown
 *
 * @typedef {Object} FastTurnActions
 * @property {(transcript: string, turnIndex: number) => void} [speculate] - start a draft reply (not needed when speculation is off)
 * @property {(reason: string) => void} [cancelSpeculation] - cancel the draft, if any (not needed when speculation is off)
 * @property {(transcript: string, turnIndex: number, trigger: string | null) => void} commit - the turn is over: answer it
 * @property {() => boolean|void} bargeIn - stop the AI's audio and abort the turn in flight; false: the session declined (nothing was stopped), and the turn may still barge in later
 * @property {(transcript: string, reason?: string) => void} dropEcho - discard a final that is no turn: the AI's own echo (no reason: the classic rule), or under the "fast-path" policy "backchannel" / "echo-like"
 * @property {(transcript: string) => void} bufferStructured - hand a structured-input final to the session's debounce buffer
 *
 * @typedef {Object} FastTurnEngine
 * @property {(evt: FastTurnEvent) => void} onTurnInfo
 * @property {() => void} reset
 */

/**
 * Number of whitespace-separated words; anything that is not a string has none.
 * @param {unknown} text
 * @returns {number}
 */
function wordCount(text) {
  if (typeof text !== "string") return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * A whole number from 0 to 99 as the words it is spoken in.
 * @param {number} n
 * @returns {string[]}
 */
function numberWords(n) {
  if (n < 20) return [NUMBER_ONES[n]];
  const tens = NUMBER_TENS[Math.floor(n / 10)];
  return n % 10 === 0 ? [tens] : [tens, NUMBER_ONES[n % 10]];
}

/**
 * A run of digits as spoken: one or two digits are a number ("10" is ten, "45" is forty
 * five); a longer run (a year, a phone number) has no single reading and stays as written.
 * @param {string} digits
 * @returns {string[]}
 */
function digitWords(digits) {
  return digits.length <= 2 ? numberWords(Number(digits)) : [digits];
}

/**
 * A clock time as spoken: 9:30 is nine thirty, 9:05 is nine oh five, 9:00 is just nine.
 * @param {string} hours
 * @param {string} minutes - two digits
 * @returns {string[]}
 */
function clockWords(hours, minutes) {
  let spoken = numberWords(Number(minutes));
  if (minutes === "00") spoken = [];
  else if (minutes.startsWith("0")) spoken = ["oh", ...spoken];
  return [...digitWords(hours), ...spoken];
}

/**
 * The words of a piece of speech in a form the AI's text (what went to TTS) and a
 * transcript of it have in common: lower case, no punctuation (an apostrophe inside a
 * word just closes it up: o'clock is oclock), "a.m." and "am" the same word, and digits
 * as the words they are spoken as. Both sides go through this, so 10 and ten, or 9:30 and
 * nine thirty, meet in the middle.
 * @param {unknown} text
 * @returns {string[]} no tokens for anything that is not a string
 */
function speechTokens(text) {
  if (typeof text !== "string") return [];
  const plain = text
    .toLowerCase()
    .replace(/(?<=\p{L})['\p{Pf}](?=\p{L})/gu, "")
    .replace(/\b([ap])\s*\.\s*m\b\.?/g, "$1m");
  const tokens = /** @type {string[]} */ ([]);
  for (const [piece, hours, minutes] of plain.matchAll(SPEECH_PIECE)) {
    if (minutes !== undefined) tokens.push(...clockWords(hours, minutes));
    else if (/^\d/.test(piece)) tokens.push(...digitWords(piece));
    else tokens.push(piece);
  }
  return tokens;
}

/**
 * Do `a` and `b` share `length` or more tokens in a row?
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} length
 * @returns {boolean}
 */
function hasSharedRun(a, b, length) {
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] >= length) return true;
    }
    previous = current;
  }
  return false;
}

/**
 * Is `candidate` the AI's own voice coming back through the caller's mic? Yes only when it
 * has 3 or more normalised words, at least 80% of them are words the AI said, and 3 or more
 * in a row are in a row in what the AI said. Fewer words say too little to judge, and with
 * no AI text nothing is shared, so it fails open: false.
 * @param {unknown} candidate - what the caller seems to have said
 * @param {unknown} aiText - everything sent to TTS since the player last went idle
 * @returns {boolean}
 */
/**
 * True when a normalised token is a number: digits, or a number word from the tables above.
 * @param {string} token - one output token of speechTokens
 * @returns {boolean}
 */
function isNumberToken(token) {
  return /^\d/.test(token) || (token !== "" && (NUMBER_ONES.includes(token) || NUMBER_TENS.includes(token)));
}

function isLikelyEcho(candidate, aiText) {
  const said = speechTokens(candidate);
  if (said.length < ECHO_MIN_WORDS) return false;
  const spoken = speechTokens(aiText);
  const known = new Set(spoken);
  // A number the AI never said means a person correcting it ("ten fifteen" against
  // the AI's "ten thirty"), never an echo: let it barge in.
  if (said.some((token) => isNumberToken(token) && !known.has(token))) return false;
  const shared = said.filter((token) => known.has(token)).length;
  if (shared * 100 < said.length * ECHO_MIN_OVERLAP_PERCENT) return false;
  return hasSharedRun(said, spoken, ECHO_MIN_RUN);
}

/**
 * Lower case words, with punctuation (hyphens too: "mm-hmm" is "mm hmm") folded to spaces.
 * @param {string} text
 * @returns {string[]}
 */
function backchannelTokens(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean);
}

/**
 * Is `text` only a backchannel ("okay", "thank you", "mm-hmm", "no worries", or two of
 * them)? Two words or fewer as heard, every word part of a BACKCHANNEL_PHRASES phrase.
 * @param {unknown} text
 * @returns {boolean}
 */
function isBackchannel(text) {
  if (typeof text !== "string" || wordCount(text) > ECHO_MAX_WORDS) return false;
  const tokens = backchannelTokens(text);
  if (tokens.length === 0) return false;
  for (let i = 0; i < tokens.length;) {
    if (i + 1 < tokens.length && BACKCHANNEL_PHRASES.has(`${tokens[i]} ${tokens[i + 1]}`)) i += 2;
    else if (BACKCHANNEL_PHRASES.has(tokens[i])) i += 1;
    else return false;
  }
  return true;
}

/**
 * Does the AI's text end with a question ("…Shall I book 10 AM?")? Trailing whitespace
 * and closing quotes are skipped; only a question mark counts ("…AM?!" does not).
 * @param {unknown} text
 * @returns {boolean}
 */
function endsWithQuestion(text) {
  return typeof text === "string" && text.replace(/["'\u201D\u2019\u00BB\s]+$/u, "").endsWith("?");
}

/**
 * R14′: is the AI's audio in its last QUESTION_TAIL_MS? Unknown (null, missing: REST
 * audio) is not.
 * @param {unknown} remainingMs - getState().aiRemainingMs
 * @returns {boolean}
 */
function inQuestionTail(remainingMs) {
  return typeof remainingMs === "number" && remainingMs <= QUESTION_TAIL_MS;
}

/**
 * CallSession treats a missing type as "general" (setExpectedInputType), and so does this.
 * @param {string | undefined} type
 * @returns {boolean}
 */
function isStructuredType(type) {
  return Boolean(type) && type !== "general";
}

/**
 * The classic echo test, from the other side of the line: a final of ECHO_MAX_WORDS words
 * or fewer that does not start with an interrupt word is not substantial speech.
 * @param {string} text - trimmed, non-empty
 * @returns {boolean}
 */
function isInsubstantial(text) {
  return wordCount(text) <= ECHO_MAX_WORDS && !INTERRUPT_RE.test(text);
}

/**
 * @param {Object} options
 * @param {() => FastTurnState} options.getState - the session's state, read when each event arrives
 * @param {FastTurnActions} options.actions - what the engine asks of the session
 * @param {boolean} [options.speculationEnabled] - false when Flux sends no EagerEndOfTurn (default true)
 * @param {"default"|"fast-path"} [options.policy] - "fast-path": short candidates are judged at their EndOfTurn, a short final while the AI asks a question is its answer, and other backchannels and echo-like finals while the AI is busy are dropped (see the module comment); default "default"
 * @returns {FastTurnEngine}
 */
function createFastTurnEngine(options) {
  const { getState, actions, speculationEnabled = true, policy = "default" } = /** @type {any} */ (options || {});
  if (typeof getState !== "function") throw new TypeError("createFastTurnEngine: getState must be a function");
  if (typeof speculationEnabled !== "boolean") throw new TypeError("createFastTurnEngine: speculationEnabled must be a boolean");
  if (!POLICIES.has(policy)) throw new TypeError('createFastTurnEngine: policy must be "default" or "fast-path"');
  const fastPolicy = policy === "fast-path";
  const offered = /** @type {Record<string, unknown>} */ (actions || {});
  for (const name of speculationEnabled ? [...ALWAYS_REQUIRED_ACTIONS, ...SPECULATION_ACTIONS] : ALWAYS_REQUIRED_ACTIONS) {
    if (typeof offered[name] !== "function") throw new TypeError(`createFastTurnEngine: actions.${name} must be a function`);
  }

  /** The highest turnIndex whose EndOfTurn has been handled; -1 before any. */
  let lastEndedTurn = -1;
  /** The turnIndex barge-in has fired for. */
  let bargedTurn = /** @type {number | null} */ (null);
  /**
   * R14″: when the current turn started, as the server received it: its StartOfTurn,
   * else its first event with words. `fromStart` marks a StartOfTurn's time, which a
   * later event of the same turn never moves.
   */
  let turnStart = { index: /** @type {number | null} */ (null), at: /** @type {number | null} */ (null), fromStart: false };
  /** The turnIndex of the draft we asked the session to start. */
  let draftTurn = /** @type {number | null} */ (null);

  /** @param {string} reason */
  function cancelDraft(reason) {
    draftTurn = null;
    if (speculationEnabled) actions.cancelSpeculation(reason);
  }

  /**
   * Rule 3, and its echo filter.
   * @param {number} turnIndex
   * @param {string} text - trimmed, non-empty
   * @param {FastTurnState} state
   */
  function considerBargeIn(turnIndex, text, state) {
    if (bargedTurn === turnIndex) return;
    const { aiSpeaking, processing, aiSpeakingText } = state;
    if (!aiSpeaking && !processing) return;
    if (isInsubstantial(text)) return;
    // The AI's own voice coming back is not the caller. Judged only above ECHO_MAX_WORDS words as
    // heard: a short interrupt ("wait") would overlap almost any sentence the AI is saying.
    if (aiSpeaking && wordCount(text) > ECHO_MAX_WORDS && isLikelyEcho(text, aiSpeakingText)) return;
    const spent = bargedTurn;
    bargedTurn = turnIndex;
    // The session may decline (false: the recording disclosure is playing, or the call is
    // ending): then nothing was stopped, and a later event of this turn may still barge in.
    // Set first, so a bargeIn() that throws is not retried (at most once).
    if (actions.bargeIn() === false) bargedTurn = spent;
  }

  /**
   * Rule 4.
   * @param {number} turnIndex
   * @param {string} text - trimmed, non-empty
   */
  function considerDraft(turnIndex, text) {
    if (!speculationEnabled) return;
    const { aiSpeaking, processing, expectedInputType } = getState();
    if (aiSpeaking || processing || isStructuredType(expectedInputType)) return;
    draftTurn = turnIndex;
    actions.speculate(text, turnIndex);
  }

  /**
   * Rule 6, once the echo drop and the barge-in are done: structured input is buffered, anything else committed.
   * @param {number} turnIndex
   * @param {string} text - trimmed, non-empty
   * @param {unknown} trigger
   * @param {string | undefined} expectedInputType
   */
  function answerTurn(turnIndex, text, trigger, expectedInputType) {
    if (isStructuredType(expectedInputType)) {
      cancelDraft("structured");
      actions.bufferStructured(text);
      return;
    }
    draftTurn = null; // commit() owns the draft's fate from here: adopt it or abort it
    actions.commit(text, turnIndex, typeof trigger === "string" ? trigger : null);
  }

  /**
   * R14″: did this turn begin after the question's audio started? Its start as the server
   * heard it (StartOfTurn, else its first words) lags the caller's first sound by about
   * START_OF_TURN_LAG_MS. Unknown times (an unstamped event, no question) are not.
   * @param {number} turnIndex
   * @param {unknown} questionAudioStartAt - getState().questionAudioStartAt
   * @returns {boolean}
   */
  function startedAfterQuestion(turnIndex, questionAudioStartAt) {
    const startedAt = turnStart.index === turnIndex ? turnStart.at : null;
    return typeof startedAt === "number" && typeof questionAudioStartAt === "number" && startedAt >= questionAudioStartAt + START_OF_TURN_LAG_MS;
  }

  /**
   * R14″: note when a turn started: its StartOfTurn (even an empty one), else its first
   * event with words.
   * @param {string} event
   * @param {number} turnIndex
   * @param {string} text - trimmed
   * @param {unknown} receivedAt
   */
  function noteTurnStart(event, turnIndex, text, receivedAt) {
    const at = typeof receivedAt === "number" && Number.isFinite(receivedAt) ? receivedAt : null;
    if (event === "StartOfTurn") {
      if (turnStart.index !== turnIndex || !turnStart.fromStart) turnStart = { index: turnIndex, at, fromStart: true };
    } else if (text !== "" && turnStart.index !== turnIndex) {
      turnStart = { index: turnIndex, at, fromStart: false };
    }
  }

  /**
   * Rule 6.
   * @param {number} turnIndex
   * @param {string} text - trimmed, non-empty
   * @param {unknown} trigger
   */
  function endTurn(turnIndex, text, trigger) {
    const state = getState();
    lastEndedTurn = turnIndex;
    let mayBargeIn = true;
    if (fastPolicy) {
      if (state.aiSpeaking && wordCount(text) <= ECHO_MAX_WORDS && endsWithQuestion(state.aiSpeakingText) && inQuestionTail(state.aiRemainingMs) && startedAfterQuestion(turnIndex, state.questionAudioStartAt)) {
        // R14″: the answer to the question the AI is still asking ("…Shall I book 10 AM?"
        // "Yes"): heard in its tail, and begun after the question started. Answered, never
        // dropped: the session holds the turn until the AI has finished. A backchannel
        // never cuts the question; an interrupt word still does.
        mayBargeIn = !isBackchannel(text);
      } else {
        if ((state.aiSpeaking || state.processing) && isBackchannel(text)) {
          actions.dropEcho(text, "backchannel");
          cancelDraft("backchannel");
          return;
        }
        if (state.aiSpeaking && isLikelyEcho(text, state.aiSpeakingText)) {
          actions.dropEcho(text, "echo-like");
          cancelDraft("echo");
          return;
        }
      }
    } else if (state.aiSpeaking && isInsubstantial(text)) {
      actions.dropEcho(text);
      cancelDraft("echo");
      return;
    }
    try {
      if (mayBargeIn) considerBargeIn(turnIndex, text, state);
    } finally {
      // Stopping the audio must never cost the caller their turn: it is answered even if bargeIn() threw
      // (the error still reaches the caller of onTurnInfo).
      answerTurn(turnIndex, text, trigger, state.expectedInputType);
    }
  }

  /** @param {FastTurnEvent} evt */
  function onTurnInfo(evt) {
    if (evt === null || typeof evt !== "object") return;
    const { event, turnIndex } = evt;
    if (!TURN_EVENTS.has(event) || !Number.isInteger(turnIndex)) return;
    if (turnIndex <= lastEndedTurn) return; // that turn is over

    if (event === "TurnResumed") {
      cancelDraft("resumed"); // rule 5
      return;
    }

    const text = typeof evt.transcript === "string" ? evt.transcript.trim() : "";
    noteTurnStart(event, turnIndex, text, evt.receivedAt);
    if (text === "") return; // rule 1

    if (draftTurn !== null && draftTurn !== turnIndex) cancelDraft("new-turn"); // rule 2

    switch (event) {
      case "StartOfTurn":
      case "Update":
        // "fast-path": a short candidate is judged at its EndOfTurn ("No" is how "No worries" starts).
        if (!fastPolicy || wordCount(text) > ECHO_MAX_WORDS) considerBargeIn(turnIndex, text, getState());
        break;
      case "EagerEndOfTurn":
        considerDraft(turnIndex, text);
        break;
      case "EndOfTurn":
        endTurn(turnIndex, text, evt.trigger);
        break;
    }
  }

  function reset() {
    const holdsDraft = draftTurn !== null;
    lastEndedTurn = -1;
    bargedTurn = null;
    turnStart = { index: null, at: null, fromStart: false };
    draftTurn = null;
    if (holdsDraft) actions.cancelSpeculation("reset");
  }

  return { onTurnInfo, reset };
}

module.exports = { createFastTurnEngine, INTERRUPT_RE, wordCount, isLikelyEcho, speechTokens, isBackchannel, endsWithQuestion, QUESTION_TAIL_MS, START_OF_TURN_LAG_MS };
