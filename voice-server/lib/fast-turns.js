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
 *     `turnIndex` right after each EndOfTurn, and an EndOfTurn carries exactly the words
 *     of the EagerEndOfTurn before it unless a TurnResumed came in between.
 *   - getState() -> { aiSpeaking, processing, expectedInputType }, read when each event
 *     arrives and never cached.
 *
 * The rules (spec 4.6)
 *   1. A transcript that is empty or only whitespace is ignored. (TurnResumed is the
 *      one event that does not read its transcript: see rule 5.)
 *   2. An event for a turn other than the one a draft belongs to cancels that draft:
 *      cancelSpeculation("new-turn"), before anything else the event causes.
 *   3. Barge-in. On Update and StartOfTurn while aiSpeaking or processing, the first
 *      one of a turn whose transcript has 3 or more words, or starts with an
 *      INTERRUPT_RE word, calls bargeIn(). Once per turnIndex.
 *   4. EagerEndOfTurn, with speculation on and !aiSpeaking && !processing and general
 *      input expected: speculate(transcript, turnIndex).
 *   5. TurnResumed: cancelSpeculation("resumed"). It does not depend on the transcript:
 *      cancelling is always safe, and a draft must not outlive a resumed turn.
 *   6. EndOfTurn, the first one of a turn:
 *        - aiSpeaking, 2 words or fewer, no interrupt word: the classic echo rule.
 *          dropEcho(transcript), then cancelSpeculation("echo").
 *        - else a structured input type is expected: cancelSpeculation("structured"),
 *          then bufferStructured(transcript). CallSession.bufferTranscript merges the
 *          pieces (digits and spelled names split across Flux turns).
 *        - else commit(transcript, turnIndex, trigger). An EndOfTurn while `processing`
 *          commits too: CallSession.queueOrProcess queues it behind the turn in flight.
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
 *     reaches the caller of onTurnInfo.
 *
 * What the actions must do
 *   - cancelSpeculation(reason) may be called when there is no draft (rule 5 always asks)
 *     and must then do nothing. Reasons: "resumed", "new-turn", "echo", "structured",
 *     "reset".
 *   - speculate() must replace a draft the session still holds.
 *   - bargeIn() must also abort the session's draft, if any: the engine does not.
 *   - commit() decides whether the draft for this turn is adopted (same transcript) or
 *     aborted, and handles `processing` by queueing.
 *   - They are called as methods of the `actions` object, so a class instance works.
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
 * The classic echo rule drops a final of this many words or fewer while the AI speaks.
 * Barge-in uses the same line from the other side: more than this many words is
 * substantial speech.
 */
const ECHO_MAX_WORDS = 2;

const TURN_EVENTS = new Set(["StartOfTurn", "Update", "EagerEndOfTurn", "TurnResumed", "EndOfTurn"]);
const ALWAYS_REQUIRED_ACTIONS = ["commit", "bargeIn", "dropEcho", "bufferStructured"];
const SPECULATION_ACTIONS = ["speculate", "cancelSpeculation"];

/**
 * @typedef {Object} FastTurnEvent
 * @property {string} event - StartOfTurn | Update | EagerEndOfTurn | TurnResumed | EndOfTurn
 * @property {number} turnIndex - Flux turn_index; it increments right after each EndOfTurn
 * @property {string} transcript - cumulative for the turn so far
 * @property {string | null} [trigger] - EndOfTurn only: "model" | "manual" | "timeout" (an open enum)
 *
 * @typedef {Object} FastTurnState
 * @property {boolean} aiSpeaking - the AI's audio is still playing
 * @property {boolean} processing - the AI is still working on an earlier turn
 * @property {string} [expectedInputType] - "general" | "phone" | "email" | "name" | "address" | "date_time"; missing means general
 *
 * @typedef {Object} FastTurnActions
 * @property {(transcript: string, turnIndex: number) => void} [speculate] - start a draft reply (not needed when speculation is off)
 * @property {(reason: string) => void} [cancelSpeculation] - cancel the draft, if any (not needed when speculation is off)
 * @property {(transcript: string, turnIndex: number, trigger: string | null) => void} commit - the turn is over: answer it
 * @property {() => void} bargeIn - stop the AI's audio and abort the turn in flight
 * @property {(transcript: string) => void} dropEcho - discard a final that is the AI's own echo
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
 * @returns {FastTurnEngine}
 */
function createFastTurnEngine(options) {
  const { getState, actions, speculationEnabled = true } = /** @type {any} */ (options || {});
  if (typeof getState !== "function") throw new TypeError("createFastTurnEngine: getState must be a function");
  if (typeof speculationEnabled !== "boolean") throw new TypeError("createFastTurnEngine: speculationEnabled must be a boolean");
  const offered = /** @type {Record<string, unknown>} */ (actions || {});
  for (const name of speculationEnabled ? [...ALWAYS_REQUIRED_ACTIONS, ...SPECULATION_ACTIONS] : ALWAYS_REQUIRED_ACTIONS) {
    if (typeof offered[name] !== "function") throw new TypeError(`createFastTurnEngine: actions.${name} must be a function`);
  }

  /** The highest turnIndex whose EndOfTurn has been handled; -1 before any. */
  let lastEndedTurn = -1;
  /** The turnIndex barge-in has fired for. */
  let bargedTurn = /** @type {number | null} */ (null);
  /** The turnIndex of the draft we asked the session to start. */
  let draftTurn = /** @type {number | null} */ (null);

  /** @param {string} reason */
  function cancelDraft(reason) {
    draftTurn = null;
    if (speculationEnabled) actions.cancelSpeculation(reason);
  }

  /**
   * Rule 3.
   * @param {number} turnIndex
   * @param {string} text - trimmed, non-empty
   */
  function considerBargeIn(turnIndex, text) {
    if (bargedTurn === turnIndex) return;
    const { aiSpeaking, processing } = getState();
    if (!aiSpeaking && !processing) return;
    if (isInsubstantial(text)) return;
    bargedTurn = turnIndex;
    actions.bargeIn();
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
   * Rule 6.
   * @param {number} turnIndex
   * @param {string} text - trimmed, non-empty
   * @param {unknown} trigger
   */
  function endTurn(turnIndex, text, trigger) {
    const { aiSpeaking, expectedInputType } = getState();
    lastEndedTurn = turnIndex;
    if (aiSpeaking && isInsubstantial(text)) {
      actions.dropEcho(text);
      cancelDraft("echo");
      return;
    }
    if (isStructuredType(expectedInputType)) {
      cancelDraft("structured");
      actions.bufferStructured(text);
      return;
    }
    draftTurn = null; // commit() owns the draft's fate from here: adopt it or abort it
    actions.commit(text, turnIndex, typeof trigger === "string" ? trigger : null);
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
    if (text === "") return; // rule 1

    if (draftTurn !== null && draftTurn !== turnIndex) cancelDraft("new-turn"); // rule 2

    switch (event) {
      case "StartOfTurn":
      case "Update":
        considerBargeIn(turnIndex, text);
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
    draftTurn = null;
    if (holdsDraft) actions.cancelSpeculation("reset");
  }

  return { onTurnInfo, reset };
}

module.exports = { createFastTurnEngine, INTERRUPT_RE, wordCount };
