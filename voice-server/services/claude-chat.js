/**
 * Claude chat adapter for the ConversationRelay eval pipeline (SCRUM-378 spike).
 *
 * A thin, SELF-CONTAINED streaming client for Anthropic Messages that ALWAYS
 * uses Claude — independent of the global LLM_PROVIDER (which the classic
 * fallback pipeline owns). It speaks the SAME request/response contract as
 * services/openai-llm.js#streamChatResponse:
 *   - input:  OpenAI-style messages + OpenAI-style tool defs (what the rest of
 *             the voice server already produces)
 *   - output: { type:"content", content } OR { type:"tool_calls", toolCalls, message }
 *
 * Message/tool SHAPING is reused from openai-llm.js (toAnthropicMessages /
 * toAnthropicTools) so there's one source of truth for the format. Only the
 * transport + SSE decode live here, kept tiny and unit-tested via `_test`.
 *
 * Why Claude Haiku: strict tool-use (no free-text fabrication of actions —
 * the model emits a real tool_use block or it doesn't), low latency, low cost.
 * Pairs with Twilio ConversationRelay doing Deepgram STT + ElevenLabs TTS.
 *
 * Also the LLM of the fast classic pipeline (SCRUM-594), which passes
 * `chunking: "clause"` so the voice can start on the first clause. Without that
 * option the behaviour is exactly what ConversationRelay has always had.
 */

const { toAnthropicMessages, toAnthropicTools } = require("./openai-llm");
const { claudeLatencyParams } = require("../lib/model-params");
const { messagesRequest } = require("../lib/anthropic-gateway");

// SCRUM-588: Haiku 5.5 (test-only pipeline). CR_LLM_MODEL swaps tiers.
const CR_LLM_MODEL = process.env.CR_LLM_MODEL || "claude-haiku-5-5";

// Break on sentence-final punctuation across the languages we serve (Latin +
// Arabic + CJK). Keeps streamed chunks natural for TTS while never splitting
// mid-word. Mirrors the spirit of openai-llm.js's SENTENCE_BREAK.
const SENTENCE_BREAK = /(?<=[.!?؟،。！？])\s+/;

// SCRUM-594: clause-level first chunk, opt-in via `chunking: "clause"`.
// The fast classic pipeline streams TTS, so the voice can start on the first
// CLAUSE instead of waiting for a whole sentence. A clause boundary is a comma,
// semicolon, colon, em dash (U+2014) or en dash (U+2013) FOLLOWED BY WHITESPACE;
// requiring the whitespace is what keeps "9:30" and "1,500" in one piece. Only
// the FIRST chunk of a response may end at a clause boundary, and only once it
// holds CLAUSE_MIN_WORDS words. Every later chunk uses SENTENCE_BREAK, as before,
// except that a break right after a common abbreviation is skipped (see below).
const CLAUSE_BREAK = /[,;:\u2014\u2013](?=\s)/g;
const CLAUSE_MIN_WORDS = 3;
const WORD_CHAR = /[\p{L}\p{N}]/u;

// Clause mode only: a sentence break right after one of these is an abbreviation,
// not the end of a thought, and ending a chunk there would hand TTS a fragment
// such as "Dr." on its own. The whole last token before the break must match
// (so "fast." is not "st."), case-insensitively, ignoring leading quotes and
// brackets. The default mode keeps splitting there, exactly as it always has.
const ABBREVIATIONS = new Set(["a.m.", "p.m.", "dr.", "mr.", "mrs.", "ms.", "st.", "e.g.", "i.e."]);
const SENTENCE_BREAK_EVERY = new RegExp(SENTENCE_BREAK.source, "g");
const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]+/u;

/**
 * @param {"clause"} [chunking] - "clause" for SCRUM-594 clause chunking; unset keeps the original sentence-only behaviour
 */
function makeStreamState(chunking) {
  const clause = chunking === "clause";
  return {
    fullContent: "",
    textBuffer: "",
    toolUses: {},
    hasToolCalls: false,
    // SCRUM-594. All three are false in the default mode, which keeps it
    // byte-identical for ConversationRelay.
    clauseMode: clause,
    // The first chunk is out: from here on only SENTENCE_BREAK applies.
    chunkEmitted: false,
    // Speak the buffered tail of a reply before returning tool_calls (see finalizeClaude).
    speakToolPreamble: clause,
  };
}

/** Words in `text`: whitespace-separated tokens that contain a letter or digit (a bare dash is not a word). */
function countWords(text) {
  let count = 0;
  for (const token of text.split(/\s+/)) {
    if (WORD_CHAR.test(token)) count++;
  }
  return count;
}

/** True when the last whitespace-separated token of `text` is one of ABBREVIATIONS. */
function endsWithAbbreviation(text) {
  let start = text.length;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  return ABBREVIATIONS.has(text.slice(start).replace(LEADING_PUNCTUATION, "").toLowerCase());
}

/** The first sentence break in `buffer` that does not follow an abbreviation (a match with .index and [0]), or null. */
function nextSentenceBreak(buffer) {
  for (const match of buffer.matchAll(SENTENCE_BREAK_EVERY)) {
    if (!endsWithAbbreviation(buffer.slice(0, match.index))) return match;
  }
  return null;
}

/**
 * Clause-mode counterpart of flushSentences: emit every complete sentence in the
 * buffer except that a break right after an abbreviation is not a break. Returns
 * the trailing remainder to keep buffering.
 */
function flushClauseSentences(buffer, emit) {
  let rest = buffer;
  for (;;) {
    const sentenceBreak = nextSentenceBreak(rest);
    if (!sentenceBreak) return rest;
    const sentence = rest.slice(0, sentenceBreak.index).trim();
    rest = rest.slice(sentenceBreak.index + sentenceBreak[0].length);
    if (sentence) emit(sentence);
  }
}

/**
 * Where the first chunk of `buffer` ends (clause mode): the earlier of a sentence
 * break (any length, exactly as in the default mode, but never right after an
 * abbreviation) and the first clause boundary whose chunk already has
 * CLAUSE_MIN_WORDS words. Returns the index just past the chunk, or -1 while the
 * buffer holds no usable boundary yet.
 */
function firstChunkEnd(buffer) {
  const sentence = nextSentenceBreak(buffer);
  const sentenceEnd = sentence ? sentence.index : -1;
  for (const clause of buffer.matchAll(CLAUSE_BREAK)) {
    const end = clause.index + 1;
    if (sentenceEnd !== -1 && end > sentenceEnd) break;
    if (countWords(buffer.slice(0, end)) >= CLAUSE_MIN_WORDS) return end;
  }
  return sentenceEnd;
}

/**
 * Clause-mode counterpart of flushSentences: until the first chunk is out it may
 * end at a clause boundary; afterwards only sentence breaks apply (never right
 * after an abbreviation). Returns the trailing remainder to keep buffering.
 */
function flushClauseChunks(state, buffer, onSentence) {
  if (!onSentence) return buffer;
  const emit = (chunk) => {
    state.chunkEmitted = true;
    onSentence(chunk);
  };
  let rest = buffer;
  if (!state.chunkEmitted) {
    const end = firstChunkEnd(rest);
    if (end !== -1) {
      const chunk = rest.slice(0, end).trim();
      rest = rest.slice(end).trimStart();
      if (chunk) emit(chunk);
    }
  }
  return flushClauseSentences(rest, emit);
}

/**
 * Emit any COMPLETE sentences from the buffer via onSentence; return the
 * trailing remainder (no sentence-final punctuation yet) to keep buffering.
 */
function flushSentences(buffer, onSentence) {
  if (!onSentence) return buffer;
  const parts = buffer.split(SENTENCE_BREAK);
  // The last element has no trailing break — it stays buffered.
  while (parts.length > 1) {
    const sentence = parts.shift();
    if (sentence.trim()) onSentence(sentence.trim());
  }
  return parts[0];
}

/**
 * Fold a single parsed Anthropic SSE event into the running state. Pure +
 * synchronous so it's directly unit-testable. Throws on a server `error` event.
 */
function handleClaudeEvent(state, ev, onSentence) {
  if (!ev || typeof ev !== "object") return;
  if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
    state.hasToolCalls = true;
    state.toolUses[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, arguments: "" };
  } else if (ev.type === "content_block_delta") {
    const delta = ev.delta;
    if (delta?.type === "text_delta") {
      state.fullContent += delta.text;
      state.textBuffer = state.clauseMode
        ? flushClauseChunks(state, state.textBuffer + delta.text, onSentence)
        : flushSentences(state.textBuffer + delta.text, onSentence);
    } else if (delta?.type === "input_json_delta") {
      if (state.toolUses[ev.index]) state.toolUses[ev.index].arguments += delta.partial_json;
    }
  } else if (ev.type === "error") {
    throw new Error(`Anthropic stream error: ${ev.error?.message || JSON.stringify(ev)}`);
  }
  // message_start / content_block_stop / message_delta / message_stop: implicit.
}

/**
 * Convert accumulated state into the openai-llm.js-compatible return shape.
 * @returns {{type:"content", content:string} | {type:"tool_calls", toolCalls:any[], message:any}}
 */
function finalizeClaude(state, onSentence) {
  if (state.hasToolCalls) {
    // SCRUM-594: what the model said before the tool call (the "let me check"
    // filler) can still be sitting in the buffer here. A text block that ends
    // right where the tool_use begins has no whitespace after its last sentence,
    // so SENTENCE_BREAK never fires on it, and that tail is the filler. Clause
    // mode speaks it before returning, so the caller is not left in silence while
    // the tool runs. The default mode leaves it unspoken, as it always has
    // (ConversationRelay): see speakToolPreamble in makeStreamState.
    if (state.speakToolPreamble && onSentence && state.textBuffer.trim()) onSentence(state.textBuffer.trim());
    const toolCalls = Object.keys(state.toolUses)
      .sort((a, b) => Number(a) - Number(b))
      .map((idx) => {
        const tu = state.toolUses[idx];
        return { id: tu.id, type: "function", function: { name: tu.name, arguments: tu.arguments || "{}" } };
      });
    const message = { role: "assistant", content: state.fullContent || null, tool_calls: toolCalls };
    return { type: "tool_calls", toolCalls, message };
  }
  // Flush the final remainder that had no trailing sentence break.
  if (onSentence && state.textBuffer.trim()) onSentence(state.textBuffer.trim());
  if (!state.fullContent) throw new Error("Anthropic stream returned no content");
  return { type: "content", content: state.fullContent };
}

async function parseClaudeStream(res, onSentence, chunking) {
  const state = makeStreamState(chunking);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let parseFailures = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(line.indexOf(":") + 1).trim();
      if (!data) continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        // A `data:` line that won't parse is a protocol problem, not a
        // keepalive (those are comment lines / `event: ping`) — surface it so a
        // dropped `error` event isn't invisible. Rate-limited to avoid spam.
        parseFailures++;
        if (parseFailures <= 3) console.warn(`[ClaudeChat] SSE parse failure #${parseFailures} on a data: line`);
        continue;
      }
      handleClaudeEvent(state, ev, onSentence);
    }
  }
  if (parseFailures > 3) console.warn(`[ClaudeChat] stream completed with ${parseFailures} SSE parse failures`);
  return finalizeClaude(state, onSentence);
}

/**
 * The retry back-off. With the caller's signal it ends early when that aborts,
 * rejecting with its reason (a caller who has stopped listening, such as a
 * barge-in, must not wait out a back-off of up to 5 s); without one it is the
 * plain sleep it always was.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function backoff(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Stream a Claude response. Mirrors openai-llm.js#streamChatResponse's contract.
 * @param {Array<object>} messages - OpenAI-style messages (system/user/assistant/tool)
 * @param {{ tools?: object[], onSentence?: (s:string)=>void, model?: string, maxTokens?: number, signal?: AbortSignal, chunking?: "clause" }} [opts]
 *   chunking: "clause" lets the first chunk passed to onSentence end at a clause boundary (SCRUM-594), never ends a
 *   chunk right after a common abbreviation (Dr., a.m., ...), and speaks the tail of a reply before tool_calls is
 *   returned; unset keeps the original sentence-only behaviour
 * @returns {Promise<{type:"content", content:string} | {type:"tool_calls", toolCalls:object[], message:object}>}
 */
async function streamClaudeResponse(messages, opts = {}) {
  const { tools, onSentence, model, maxTokens, signal, chunking } = opts;
  if (!messages || messages.length === 0) {
    throw new Error("streamClaudeResponse called with empty messages array");
  }
  if (chunking != null && chunking !== "clause") {
    throw new Error(`streamClaudeResponse: unknown chunking mode "${String(chunking)}" (expected "clause" or unset)`);
  }
  const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);
  const resolvedModel = model || CR_LLM_MODEL;
  /** @type {Record<string, any>} */
  const body = {
    model: resolvedModel,
    system: system || undefined,
    messages: anthropicMsgs,
    // 600 (not 300) for the tool path: a book_appointment turn carries a filler
    // sentence + a multi-arg tool call; too low truncates the tool JSON mid-
    // stream (→ parse failure → empty args). Voice replies are short otherwise.
    max_tokens: maxTokens || (tools?.length > 0 ? 600 : 200),
    stream: true,
    // Haiku: thinking off (latency; Haiku 5.5 thinks by default). Other tiers
    // keep their defaults so a CR_LLM_MODEL swap to compare tiers never 400s.
    ...claudeLatencyParams(resolvedModel),
  };
  // No temperature: Haiku 5.5, Sonnet 5.x and Opus 4.7+ all 400 on a
  // non-default value (SCRUM-588 dropped the old Haiku/Sonnet-only 0.7).
  const anthropicTools = toAnthropicTools(tools);
  if (anthropicTools) body.tools = anthropicTools;
  // Straight to Anthropic, or through OpenRouter (ANTHROPIC_GATEWAY=openrouter, Haiku 5.5 only).
  // Throws when the gateway has no key or won't take the model.
  const request = messagesRequest(body);
  const via = request.gateway === "openrouter" ? " via OpenRouter" : "";

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(request.url, {
      method: "POST",
      signal: signal || AbortSignal.timeout(15_000),
      headers: request.headers,
      body: request.body,
    });
    // 429 (rate limit) AND 500/529 (transient overload) are retryable per
    // Anthropic guidance — without this a single blip looks like "Claude failed"
    // and would skew the eval's reliability numbers.
    if ((res.status === 429 || res.status === 500 || res.status === 529) && attempt < 2) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = Math.min(retryAfter ? Number(retryAfter) * 1000 : 1000 * (attempt + 1), 5000);
      console.warn(`[ClaudeChat] Anthropic ${res.status}${via}, retrying in ${waitMs}ms (attempt ${attempt + 1}/3)`);
      await backoff(waitMs, signal);
      continue;
    }
    break;
  }

  if (!res.ok) {
    // Surface the status + the structured error type/message only — never dump
    // the raw body to logs (keeps this file's "nothing un-gated to stdout"
    // invariant; the body is an error envelope, but we don't rely on that).
    let detail = "";
    try {
      const errBody = /** @type {any} */ (await res.json());
      // Anthropic names the error's type; OpenRouter may give only a code ("Key limit exceeded" is a 402).
      const kind = errBody?.error?.type || errBody?.error?.code;
      if (kind) detail = ` (${kind}: ${String(errBody.error.message || "").slice(0, 200)})`;
    } catch { /* body not JSON — omit detail */ }
    throw new Error(`Anthropic API error ${res.status}${via}${detail}`);
  }
  return parseClaudeStream(res, onSentence, chunking);
}

module.exports = {
  streamClaudeResponse,
  CR_LLM_MODEL,
  _test: { makeStreamState, flushSentences, handleClaudeEvent, finalizeClaude },
};
