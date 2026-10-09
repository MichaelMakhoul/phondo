/**
 * Per-model-family request fields for the LLM calls the voice server makes
 * (SCRUM-588).
 *
 * Every model ID here is an env-overridable revert lever (ANALYSIS_MODEL,
 * VALIDATOR_MODEL, LLM_MODEL, CR_LLM_MODEL), so the request shape has to
 * follow the MODEL, not the call site: a body built for the new model would
 * 400 on the old one and vice versa, and the lever would only work in one
 * direction. Rules below were confirmed against the live APIs on 2026-10-09.
 */

/**
 * OpenAI reasoning-family chat models (o-series, GPT-5 and later). On
 * /v1/chat/completions they reject `max_tokens` (400 unsupported_parameter —
 * they take `max_completion_tokens`) and, at their default effort, spend
 * hidden reasoning tokens out of the same cap. gpt-4.x — and the Gemini models
 * that share the OpenAI-compatible body in openai-llm.js — keep the classic
 * shape.
 * @param {string} model
 * @returns {boolean}
 */
function isOpenAIReasoningModel(model) {
  return /^(o\d|gpt-([5-9]|[1-9]\d))/i.test(String(model || ""));
}

/**
 * The reasoning models whose effort scale goes down to "none": GPT-5.1 and
 * later point releases, and GPT-6+ (gpt-6-luna). gpt-5 / gpt-5-mini / -nano
 * bottom out at "minimal" and the o-series at "low" — both 400 on "none".
 * @param {string} model
 * @returns {boolean}
 */
function acceptsReasoningEffortNone(model) {
  return /^gpt-(5\.[1-9]\d*|[6-9](\.\d+)?|[1-9]\d+(\.\d+)?)(?=$|[-.])/i.test(String(model || ""));
}

/**
 * Token-cap, sampling and reasoning fields for a chat-completions body.
 *
 * - GPT-5.1+/GPT-6+ get `reasoning_effort: "none"` (gpt-6-luna rejects
 *   "minimal"): no hidden reasoning tokens eating the cap and leaving
 *   `content` empty, function calling allowed on chat completions (gpt-6-luna
 *   only supports tools there at "none"), and the only level at which a
 *   non-default temperature is accepted — at its default effort gpt-6-luna
 *   400s on any temperature but 1. Raising the effort means dropping
 *   `temperature`.
 * - Older reasoning models (gpt-5, gpt-5-mini/nano, o-series) get
 *   `max_completion_tokens` ONLY: they reject "none" and any non-default
 *   temperature, so they run at their default effort.
 * - Everything else (gpt-4.x, Gemini on the compat endpoint) keeps
 *   `max_tokens` + `temperature`.
 *
 * @param {string} model
 * @param {{ maxTokens: number, temperature: number }} opts
 * @returns {Record<string, number|string>}
 */
function openAIChatParams(model, { maxTokens, temperature }) {
  if (acceptsReasoningEffortNone(model)) {
    return { max_completion_tokens: maxTokens, reasoning_effort: "none", temperature };
  }
  if (isOpenAIReasoningModel(model)) {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens, temperature };
}

/**
 * Claude fields for the latency-critical calls (mid-call validator, classic
 * fallback LLM, ConversationRelay eval).
 *
 * Haiku 5.5 runs adaptive thinking when `thinking` is omitted: the response
 * then STARTS with a thinking block (so content[0] is no longer the answer),
 * the hidden tokens come out of a deliberately small max_tokens, and time to
 * first token grows. `disabled` restores Haiku 4.5's behaviour and Haiku 4.5
 * accepts it too, so the revert levers keep working. Other tiers keep their
 * defaults — Sonnet/Opus 5.5 reject `disabled` — so a tier swap never 400s.
 *
 * Callers send NO sampling params: Haiku 5.5 rejects any non-default
 * temperature (400 "`temperature` is deprecated for this model").
 *
 * @param {string} model
 * @returns {{ thinking?: { type: "disabled" } }}
 */
function claudeLatencyParams(model) {
  return /^claude-haiku-/i.test(String(model || "")) ? { thinking: { type: "disabled" } } : {};
}

/**
 * Text of a Messages API response. Reads the first `text` block by TYPE —
 * never content[0], which is a thinking block whenever the model thought.
 * @param {unknown} content - the response's `content` array
 * @returns {string} "" when there is no text block
 */
function claudeResponseText(content) {
  if (!Array.isArray(content)) return "";
  const block = content.find((b) => b && b.type === "text" && typeof b.text === "string");
  return block ? block.text : "";
}

module.exports = {
  isOpenAIReasoningModel,
  acceptsReasoningEffortNone,
  openAIChatParams,
  claudeLatencyParams,
  claudeResponseText,
};
