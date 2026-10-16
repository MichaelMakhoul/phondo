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
 *   - A draft has no timeout of its own: passing a signal to
 *     streamClaudeResponse turns off its default 15 s limit, so whoever starts a
 *     draft must abort it on every path above (and on call cleanup).
 *
 * Logging: one warning when a draft fails for a reason other than abort. It
 * carries the turn key and the error text, never caller words or model text.
 * No error reporting here: the caller decides what is worth reporting.
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
 * Start a speculative reply.
 *
 * `isAdoptable(currentMessages, transcript)` is true only while ALL of these hold:
 *   - the draft is neither aborted, failed, nor already adopted;
 *   - `currentMessages` is the very array the draft started from, at the same
 *     length (so evaluate it BEFORE the committed user turn is appended);
 *   - `transcript === ` the draft's transcript.
 *
 * `adopt(onSentence)` can be called once. It replays the buffered chunks through
 * `onSentence` synchronously and in order, then forwards the live ones, and
 * resolves with the LLM's final result ({type:"content"} or {type:"tool_calls"}).
 *   - On an aborted draft it resolves {type:"aborted"} and replays nothing. It
 *     never rejects because of an abort, whether the abort came before the call
 *     or while the stream was being forwarded.
 *   - It rejects only with an error a live call would also have raised: the
 *     LLM call failing, or `onSentence` throwing (the stream is cancelled then).
 *     A second call rejects too: that is a caller bug.
 *
 * @param {Object} options
 * @param {(messages: object[], options: Record<string, any>) => Promise<any>} options.llm - the streaming LLM call (streamClaudeResponse)
 * @param {object[]} options.messages - the live conversation; read, never written
 * @param {string} options.transcript - the eager transcript to answer; must be non-empty
 * @param {Record<string, any>} [options.llmOptions] - passed through to llm (tools, model, maxTokens ...); chunking, signal and onSentence are replaced by the draft's own
 * @param {string | number} [options.turnKey] - opaque id of the turn, exposed as `turnKey` and used in the failure warning
 * @returns {SpeculativeReply}
 */
function startSpeculativeReply(options) {
  const { llm, messages, transcript, llmOptions, turnKey } = options || /** @type {any} */ ({});
  if (typeof llm !== "function") throw new TypeError("startSpeculativeReply: llm must be a function");
  if (!Array.isArray(messages)) throw new TypeError("startSpeculativeReply: messages must be an array");
  if (typeof transcript !== "string" || transcript.trim() === "") {
    throw new TypeError("startSpeculativeReply: transcript must be a non-empty string");
  }

  const startLength = messages.length;
  const controller = new AbortController();

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
   * Record the first failure and cancel the request so its connection is not left open.
   * Deliberately not abort(): a failed draft is not an aborted one.
   * @param {unknown} error
   */
  function fail(error) {
    if (failure) return;
    failure = { error };
    pending = [];
    controller.abort();
  }

  /**
   * One chunk from the model: buffer it until adoption, forward it after. Silent
   * once the draft is aborted or failed, even if the LLM keeps producing.
   * @param {string} sentence
   */
  function speak(sentence) {
    if (aborted || failure) return;
    if (!sink) {
      pending.push(sentence);
      return;
    }
    try {
      sink(sentence);
    } catch (error) {
      // The adopter's callback broke (say, the TTS socket closed). Stop the
      // stream; adopt() rejects with this error, as a live call would.
      fail(error);
    }
  }

  // An async wrapper so even a synchronous throw from llm becomes a failed draft.
  const call = (async () =>
    llm([...messages, { role: "user", content: transcript }], {
      ...llmOptions,
      chunking: "clause",
      signal: controller.signal,
      onSentence: speak,
    }))();

  // Never rejects, so an unadopted draft cannot produce an unhandled rejection.
  const finished = call.then(
    (value) => {
      settled = true;
      result = value;
    },
    (error) => {
      settled = true;
      if (failure) return; // the adopter's callback failed first; the AbortError here is the cancel we caused
      if (aborted || controller.signal.aborted || /** @type {any} */ (error)?.name === "AbortError") {
        aborted = true;
        return;
      }
      fail(error);
      console.warn(`[SpeculativeReply] draft failed turn=${String(turnKey)}: ${describeError(error)}`);
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
      sink = onSentence;
      const replay = pending;
      pending = [];
      for (const sentence of replay) {
        speak(sentence);
        if (aborted || failure) break;
      }
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
      return finished.then(deliver);
    },

    abort(reason) {
      if (aborted || delivered) return;
      aborted = true;
      pending = [];
      controller.abort(reason === undefined ? undefined : abortError(reason));
    },
  };
}

module.exports = { startSpeculativeReply };
