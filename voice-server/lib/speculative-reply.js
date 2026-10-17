"use strict";

/**
 * SCRUM-594: speculative reply drafts for the fast classic pipeline.
 *
 * Deepgram Flux sends `EagerEndOfTurn` a few hundred ms before it is sure the
 * caller has finished, which is long enough to start the LLM already. This
 * module runs that early call as a DRAFT: nothing is spoken while it runs, the
 * chunks it produces are buffered, and the draft ends one of two ways.
 *   - ADOPTED: the turn really ended with the same words. adopt() replays the
 *     buffered chunks at once (synchronously, in order), then forwards the
 *     rest as the model produces it.
 *   - ABORTED: the caller resumed, a different turn started, the commit did not
 *     match, or the call is being torn down. The request is cancelled and the
 *     draft stays silent from then on.
 *
 * Boundaries
 *   - The live conversation is only read. The draft sends [...messages, the
 *     eager transcript] on a fresh array and never appends to `messages`.
 *   - It never runs tools. A `tool_calls` result is stored and handed to the
 *     adopter, who runs the tools exactly as for a live call.
 *   - The LLM call is injected (`llm`, normally streamClaudeResponse). The draft
 *     owns the AbortController behind the signal that call receives.
 *   - The draft owns a deadline. Passing a signal to
 *     streamClaudeResponse turns off its built-in 15 s limit, so the signal the
 *     draft hands over fires on abort() AND after `timeoutMs` (default 15 s). A
 *     call that hits the deadline FAILS: the draft is not adoptable and adopt()
 *     rejects with an Error named "TimeoutError", which is what a live call that
 *     timed out raises. It does not resolve {type:"aborted"}: that is reserved
 *     for abort(), so a hang can never be mistaken for a barge-in (the caller
 *     handles "aborted" silently and a rejection with an apology). The deadline
 *     guards the in-flight call only; an answer that finished in time stays
 *     adoptable however long the caller keeps talking. The draft enforces the
 *     deadline itself as well as handing it to `llm`: at the deadline it is over
 *     (failed, not adoptable, any pending adopt() settles) even if the llm
 *     ignores its signal (an injected one may).
 *   - Whoever starts a draft must still abort it on every path above (and on
 *     call cleanup); the deadline is the backstop, not the plan.
 *
 * Logging: one warning when the LLM call fails for a reason other than abort
 * (the deadline included), carrying the turn key and the error text, never
 * caller words or model text. A failure of the adopter's own callback is not
 * logged: adopt() rejects with that error and the adopter owns it. No error
 * reporting here: the caller decides what is worth reporting.
 */

/**
 * @typedef {{ type: "content", content: string }} DraftContent
 * @typedef {{ type: "tool_calls", toolCalls: object[], message: object }} DraftToolCalls
 * @typedef {{ type: "aborted" }} DraftAborted
 * @typedef {DraftContent | DraftToolCalls | DraftAborted} DraftResult
 * @typedef {"running" | "done" | "aborted" | "adopted"} DraftStatus
 */

/**
 * @typedef {Object} SpeculativeReply
 * @property {string | number | undefined} turnKey - opaque id of the turn the draft was started for
 * @property {string} transcript - the eager transcript the draft answers
 * @property {() => DraftStatus} status - running (LLM call open), done (call finished, not adopted; a draft whose call
 *   failed is also "done" but never adoptable), aborted, adopted
 * @property {(currentMessages: object[], transcript: string) => boolean} isAdoptable - see startSpeculativeReply
 * @property {(onSentence: (sentence: string) => void) => Promise<DraftResult>} adopt - see startSpeculativeReply
 * @property {(reason?: string) => void} abort - cancel the draft; idempotent
 */

/** @returns {DraftAborted} */
const abortedResult = () => ({ type: "aborted" });

/**
 * @param {unknown} error
 * @returns {string} a short description that is safe to log
 */
function describeError(error) {
  const e = /** @type {any} */ (error);
  const name = typeof e?.name === "string" ? e.name : "Error";
  const message = typeof e?.message === "string" ? e.message : "";
  return `${name}: ${message.slice(0, 160)}`;
}

/**
 * The reason handed to AbortController.abort(): an AbortError whose message is
 * the caller's label, so signal.reason (and what fetch rejects with) says why.
 * @param {unknown} reason
 * @returns {Error}
 */
function abortError(reason) {
  const error = new Error(String(reason));
  error.name = "AbortError";
  return error;
}

/**
 * What adopt() rejects with when the deadline passes. Named like the error a
 * live call's AbortSignal.timeout raises; the llm's own error is kept as `cause`.
 * @param {number} ms
 * @param {unknown} cause
 * @returns {Error}
 */
function timeoutError(ms, cause) {
  const error = new Error(`speculative reply timed out after ${ms} ms`, { cause });
  error.name = "TimeoutError";
  return error;
}

/** The same limit streamClaudeResponse applies when it is given no signal. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The longest deadline a draft accepts. Two minutes is far past any phone turn,
 * and it keeps the value well inside what AbortSignal.timeout takes: it clamps
 * or throws a RangeError from 2 ** 31 on.
 */
const MAX_TIMEOUT_MS = 120_000;

/**
 * Start a speculative reply.
 *
 * `isAdoptable(currentMessages, transcript)` is true only while ALL of these hold:
 *   - the draft is neither aborted, failed, nor already adopted;
 *   - `currentMessages` is the very array the draft started from, at the same
 *     length (so evaluate it BEFORE the committed user turn is appended);
 *   - `transcript === ` the draft's transcript.
 *
 * `adopt(onSentence)` can be called once. It replays the buffered chunks through
 * `onSentence` synchronously and in order (a chunk the producer emits from inside
 * `onSentence` meanwhile joins the end of the queue), then forwards the live ones,
 * and resolves with the LLM's final result ({type:"content"} or {type:"tool_calls"}).
 *   - On an aborted draft it resolves {type:"aborted"} and replays nothing. It
 *     never rejects because of an abort, whether the abort came before the call
 *     or while the stream was being forwarded.
 *   - It rejects only with an error a live call would also have raised: the
 *     LLM call failing (a TimeoutError when the deadline passed), or
 *     `onSentence` throwing (the stream is cancelled then). A second call
 *     rejects too: that is a caller bug.
 *
 * @param {Object} options
 * @param {(messages: object[], options: Record<string, any>) => Promise<any>} options.llm - the streaming LLM call (streamClaudeResponse)
 * @param {object[]} options.messages - the live conversation; read, never written
 * @param {string} options.transcript - the eager transcript to answer; must be non-empty
 * @param {Record<string, any>} [options.llmOptions] - passed through to llm (tools, model, maxTokens ...); chunking, signal and onSentence are replaced by the draft's own
 * @param {string | number} [options.turnKey] - opaque id of the turn, exposed as `turnKey` and used in the failure warning
 * @param {number} [options.timeoutMs] - deadline for the LLM call in whole milliseconds, 1 to 120000 (default 15000); injectable for tests
 * @returns {SpeculativeReply}
 */
function startSpeculativeReply(options) {
  const { llm, messages, transcript, llmOptions, turnKey, timeoutMs = DEFAULT_TIMEOUT_MS } = options || /** @type {any} */ ({});
  if (typeof llm !== "function") throw new TypeError("startSpeculativeReply: llm must be a function");
  if (!Array.isArray(messages)) throw new TypeError("startSpeculativeReply: messages must be an array");
  if (typeof transcript !== "string" || transcript.trim() === "") {
    throw new TypeError("startSpeculativeReply: transcript must be a non-empty string");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`startSpeculativeReply: timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`);
  }

  const startLength = messages.length;
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  /** Chunks produced before adoption, in order. Dropped on abort or failure: they must never be spoken. */
  let pending = /** @type {string[]} */ ([]);
  /** The adopter's callback. Once set, chunks go straight to it. */
  let sink = /** @type {((sentence: string) => void) | null} */ (null);
  let adopted = false;
  let aborted = false;
  /** The adopter has its outcome, so a later abort() has nothing left to cancel. */
  let delivered = false;
  /** The LLM call has finished (result, failure or abort). */
  let settled = false;
  let result = /** @type {DraftResult | null} */ (null);
  /** First non-abort error: the LLM call failing, or the adopter's callback throwing. */
  let failure = /** @type {{ error: unknown } | null} */ (null);

  /**
   * Record the first failure and, unless `cancel` is false, cancel the request so
   * its connection is not left open. Deliberately not abort(): a failed draft is
   * not an aborted one. The deadline path passes cancel=false: the timeout signal
   * has cancelled the request itself, and aborting our controller as well would
   * race it for the composite signal's abort reason.
   * @param {unknown} error
   * @param {boolean} [cancel]
   */
  function fail(error, cancel = true) {
    if (failure) return;
    failure = { error };
    pending = [];
    if (cancel) controller.abort();
  }

  /**
   * A failure on the LLM side: record it, cancel the request (unless `cancel` is
   * false, see fail), and say so once.
   * @param {unknown} error
   * @param {boolean} [cancel]
   */
  function failCall(error, cancel = true) {
    fail(error, cancel);
    console.warn(`[SpeculativeReply] draft failed turn=${String(turnKey)}: ${describeError(error)}`);
  }

  /** Resolves when the deadline passes, so adopt() never waits on an llm that ignores its signal. */
  let expire = () => {};
  const expired = new Promise((resolve) => {
    expire = () => resolve(undefined);
  });

  /**
   * The deadline passed. Unless the call already finished (or the draft was
   * aborted or failed), the draft is over NOW: failed, not adoptable, and any
   * adopt() waiting on it settles, whether or not the llm reacts to its signal.
   */
  function onDeadline() {
    if (settled || aborted || failure) return;
    settled = true;
    failCall(timeoutError(timeoutMs, timeoutSignal.reason), false);
    expire();
  }
  timeoutSignal.addEventListener("abort", onDeadline, { once: true });

  /**
   * Hand one chunk to the adopter's callback. If it throws (say, the TTS socket
   * closed) the draft fails: the stream is stopped and adopt() rejects with that
   * error, as a live call would.
   * @param {(sentence: string) => void} callback
   * @param {string} sentence
   */
  function deliverTo(callback, sentence) {
    try {
      callback(sentence);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * One chunk from the model: buffer it until adoption, forward it after. Silent
   * once the draft is aborted or failed, even if the LLM keeps producing.
   * @param {string} sentence
   */
  function speak(sentence) {
    if (aborted || failure) return;
    if (sink) deliverTo(sink, sentence);
    else pending.push(sentence);
  }

  // An async wrapper so even a synchronous throw from llm becomes a failed draft.
  const call = (async () =>
    llm([...messages, { role: "user", content: transcript }], {
      ...llmOptions,
      chunking: "clause",
      signal: AbortSignal.any([controller.signal, timeoutSignal]),
      onSentence: speak,
    }))();

  // Never rejects, so an unadopted draft cannot produce an unhandled rejection.
  const finished = call.then(
    (value) => {
      settled = true;
      timeoutSignal.removeEventListener("abort", onDeadline); // do not hold this draft in memory until the timer fires
      result = value; // ignored if the draft already failed (deliver() checks failure first)
    },
    (error) => {
      settled = true;
      timeoutSignal.removeEventListener("abort", onDeadline);
      // The adopter's callback failed first, or the deadline passed first: the
      // AbortError arriving here is the cancel we caused ourselves.
      if (failure) return;
      if (aborted) return; // the caller's own abort() came first
      if (controller.signal.aborted || /** @type {any} */ (error)?.name === "AbortError") {
        aborted = true;
        return;
      }
      failCall(error);
    },
  );

  /** What adopt() settles with once the LLM call has finished. */
  function deliver() {
    delivered = true;
    if (aborted) return abortedResult();
    if (failure) throw failure.error;
    return result;
  }

  return {
    turnKey,
    transcript,

    status() {
      if (aborted) return "aborted";
      if (adopted) return "adopted";
      return settled ? "done" : "running";
    },

    isAdoptable(currentMessages, currentTranscript) {
      return (
        !aborted &&
        failure === null &&
        !adopted &&
        currentMessages === messages &&
        currentMessages.length === startLength &&
        currentTranscript === transcript
      );
    },

    adopt(onSentence) {
      if (typeof onSentence !== "function") return Promise.reject(new TypeError("adopt: onSentence must be a function"));
      if (adopted) return Promise.reject(new Error("adopt: a speculative reply can only be adopted once"));
      if (aborted) return Promise.resolve(abortedResult());

      adopted = true;
      // Drain what is buffered while `sink` is still unset: a chunk the producer
      // emits from inside onSentence meanwhile is appended to `pending` and
      // delivered after the ones before it. Live forwarding starts only once the
      // queue is empty, so the order never depends on nothing else running.
      while (pending.length > 0 && !aborted && !failure) {
        deliverTo(onSentence, /** @type {string} */ (pending.shift()));
      }
      sink = onSentence;
      // The caller's own abort outranks a failure (as in deliver()), and both settle at once:
      // there is nothing to wait for.
      if (aborted) {
        delivered = true;
        return Promise.resolve(abortedResult());
      }
      if (failure) {
        delivered = true;
        return Promise.reject(failure.error);
      }
      return Promise.race([finished, expired]).then(deliver);
    },

    abort(reason) {
      if (aborted || delivered) return;
      aborted = true;
      pending = [];
      controller.abort(reason === undefined ? undefined : abortError(reason));
    },
  };
}

module.exports = { startSpeculativeReply, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
