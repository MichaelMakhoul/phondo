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
 * Why Claude Haiku 4.5: strict tool-use (no free-text fabrication of actions —
 * the model emits a real tool_use block or it doesn't), low latency, low cost.
 * Pairs with Twilio ConversationRelay doing Deepgram STT + ElevenLabs TTS.
 */

const { toAnthropicMessages, toAnthropicTools } = require("./openai-llm");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const CR_LLM_MODEL = process.env.CR_LLM_MODEL || "claude-haiku-4-5-20251001";

// Break on sentence-final punctuation across the languages we serve (Latin +
// Arabic + CJK). Keeps streamed chunks natural for TTS while never splitting
// mid-word. Mirrors the spirit of openai-llm.js's SENTENCE_BREAK.
const SENTENCE_BREAK = /(?<=[.!?؟،。！？])\s+/;

function makeStreamState() {
  return { fullContent: "", textBuffer: "", toolUses: {}, hasToolCalls: false };
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
      state.textBuffer = flushSentences(state.textBuffer + delta.text, onSentence);
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

async function parseClaudeStream(res, onSentence) {
  const state = makeStreamState();
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
 * Stream a Claude response. Mirrors openai-llm.js#streamChatResponse's contract.
 * @param {Array<object>} messages - OpenAI-style messages (system/user/assistant/tool)
 * @param {{ tools?: object[], onSentence?: (s:string)=>void, model?: string, maxTokens?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{type:"content", content:string} | {type:"tool_calls", toolCalls:object[], message:object}>}
 */
async function streamClaudeResponse(messages, opts = {}) {
  const { tools, onSentence, model, maxTokens, signal } = opts;
  if (!messages || messages.length === 0) {
    throw new Error("streamClaudeResponse called with empty messages array");
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for the ConversationRelay (Claude) pipeline");

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
  };
  // temperature is rejected (400) on some newer models (Opus 4.7/4.8). This
  // pipeline targets Haiku/Sonnet; only send it for those so a CR_LLM_MODEL
  // swap to compare tiers doesn't 400 every turn.
  if (/claude-(haiku|sonnet)/i.test(resolvedModel)) body.temperature = 0.7;
  const anthropicTools = toAnthropicTools(tools);
  if (anthropicTools) body.tools = anthropicTools;

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: signal || AbortSignal.timeout(15_000),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    // 429 (rate limit) AND 500/529 (transient overload) are retryable per
    // Anthropic guidance — without this a single blip looks like "Claude failed"
    // and would skew the eval's reliability numbers.
    if ((res.status === 429 || res.status === 500 || res.status === 529) && attempt < 2) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = Math.min(retryAfter ? Number(retryAfter) * 1000 : 1000 * (attempt + 1), 5000);
      console.warn(`[ClaudeChat] Anthropic ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, waitMs));
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
      if (errBody?.error?.type) detail = ` (${errBody.error.type}: ${String(errBody.error.message || "").slice(0, 200)})`;
    } catch { /* body not JSON — omit detail */ }
    throw new Error(`Anthropic API error ${res.status}${detail}`);
  }
  return parseClaudeStream(res, onSentence);
}

module.exports = {
  streamClaudeResponse,
  CR_LLM_MODEL,
  _test: { makeStreamState, flushSentences, handleClaudeEvent, finalizeClaude },
};
