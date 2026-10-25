/**
 * SCRUM-594: where the voice server's Anthropic Messages requests go.
 *
 * ANTHROPIC_GATEWAY=openrouter (with OPENROUTER_API_KEY) sends them to
 * OpenRouter's Anthropic-compatible Messages endpoint, pinned to Anthropic's own
 * servers, on the owner's capped key: a stopgap while the Anthropic balance is
 * empty (the owner, 25 Oct 2026). Only Haiku 5.5 goes there, never Sonnet, Fable
 * or Opus. Unset or "anthropic" (the default): api.anthropic.com with
 * ANTHROPIC_API_KEY, as before.
 *
 * Used by services/claude-chat.js (the fast path and ConversationRelay) and
 * services/turn-validator.js. The classic fallback's LLM_PROVIDER=anthropic
 * (services/openai-llm.js) still calls Anthropic directly.
 */

const { Sentry } = require("./sentry");

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const OPENROUTER_MESSAGES_URL = "https://openrouter.ai/api/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** OpenRouter's names for the models that may be sent there: Haiku 5.5 only (the key is capped). */
const OPENROUTER_MODELS = new Map([["claude-haiku-5-5", "anthropic/claude-haiku-5.5"]]);

/** OpenRouter's own routing fields: any of them could send a request to another model or provider. */
const OPENROUTER_ROUTING = ["models", "route", "preset", "plugins", "provider"];

/**
 * ANTHROPIC_GATEWAY: unset or "anthropic" (the default), or "openrouter".
 * @param {Record<string, string|undefined>} [env]
 * @returns {"anthropic" | "openrouter"}
 */
function anthropicGateway(env = process.env) {
  const value = env.ANTHROPIC_GATEWAY;
  if (!value || value === "anthropic") return "anthropic";
  if (value === "openrouter") return "openrouter";
  throw new Error(`ANTHROPIC_GATEWAY must be "anthropic" or "openrouter" (got "${value}")`);
}

/**
 * The env var whose key the gateway sends, for messages about a missing one.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function gatewayKeyName(env = process.env) {
  try {
    return anthropicGateway(env) === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
  } catch {
    return 'ANTHROPIC_GATEWAY ("anthropic" or "openrouter")';
  }
}

/**
 * Why no Messages request can be sent (a bad ANTHROPIC_GATEWAY, or no key for
 * it), or null when one can. An empty key counts as missing.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string | null}
 */
function gatewayProblem(env = process.env) {
  let gateway;
  try {
    gateway = anthropicGateway(env);
  } catch (err) {
    return /** @type {Error} */ (err).message;
  }
  if (gateway === "openrouter") return env.OPENROUTER_API_KEY ? null : "OPENROUTER_API_KEY not set (ANTHROPIC_GATEWAY=openrouter)";
  return env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY not set";
}

/**
 * Why `model` can't go through the gateway, or null when it can: OpenRouter
 * takes only Haiku 5.5. A bad ANTHROPIC_GATEWAY is gatewayProblem's to name.
 * @param {unknown} model
 * @param {Record<string, string|undefined>} [env]
 * @returns {string | null}
 */
function gatewayModelProblem(model, env = process.env) {
  let gateway;
  try {
    gateway = anthropicGateway(env);
  } catch {
    return null;
  }
  if (gateway !== "openrouter" || (typeof model === "string" && OPENROUTER_MODELS.has(model))) return null;
  return `${model || "(no model)"} may not be sent through OpenRouter (claude-haiku-5-5 only)`;
}

/**
 * The URL, headers and JSON body for one Messages request. Throws when the
 * gateway can't send (see gatewayProblem), or when OpenRouter is asked for any
 * model but Haiku 5.5, or a body carries one of OpenRouter's routing fields.
 * @param {Record<string, any>} body - an Anthropic Messages request body
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ gateway: "anthropic" | "openrouter", url: string, headers: Record<string, string>, body: string }}
 */
function messagesRequest(body, env = process.env) {
  const problem = gatewayProblem(env) ?? gatewayModelProblem(body.model, env);
  if (problem) throw new Error(problem);
  if (anthropicGateway(env) === "anthropic") {
    return {
      gateway: "anthropic",
      url: ANTHROPIC_MESSAGES_URL,
      headers: { "x-api-key": String(env.ANTHROPIC_API_KEY), "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }
  const routing = OPENROUTER_ROUTING.filter((field) => field in body);
  if (routing.length > 0) throw new Error(`a Messages request may not carry OpenRouter's routing fields (${routing.join(", ")})`);
  return {
    gateway: "openrouter",
    url: OPENROUTER_MESSAGES_URL,
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
    // Pinned to Anthropic's own servers: no other provider, no fallback.
    body: JSON.stringify({ ...body, model: OPENROUTER_MODELS.get(body.model), provider: { only: ["anthropic"], allow_fallbacks: false } }),
  };
}

/** The standing refusal the demo line is avoiding, or "" (see noteGatewayRefusal). */
let refusal = "";

/**
 * Whether an error response will repeat on every request until someone acts:
 * no credit (Anthropic's 400 "credit balance is too low", phone test F10), a
 * spent limit (Anthropic's 400 "usage limits", OpenRouter's 402, a 403 naming
 * a limit) or a bad key (401).
 * @param {number} status
 * @param {string} [message] - the API's error message
 * @returns {boolean}
 */
function isStandingRefusal(status, message = "") {
  if (status === 401 || status === 402) return true;
  if (status === 403) return /limit/i.test(message);
  if (status === 400) return /credit balance|usage limits?/i.test(message);
  return false;
}

/**
 * Notes an error response. A standing refusal latches until the server restarts:
 * new demo-line calls take the global pipeline instead of apologising on every
 * turn (F10). Not on a timer (on a quiet line a lapse hands the next caller to
 * the refused key) and not on a later success (near a spent cap a small request,
 * like the turn validator's, can pass while the fast path's are refused; a slow
 * success can land after the refusal). A new key (`fly secrets set`) restarts the
 * server; after a top-up or a raised cap, `fly apps restart phondo-voice`. The
 * first refusal raises an [ALERT:error].
 * @param {number} status
 * @param {string} [message] - the API's error message
 * @returns {boolean} whether this response set the latch
 */
function noteGatewayRefusal(status, message = "") {
  if (!isStandingRefusal(status, message) || refusal) return false;
  refusal = `HTTP ${status}${message ? `: ${String(message).slice(0, 120)}` : ""}`;
  Sentry.withScope((scope) => {
    scope.setTag("service", "anthropic-gateway");
    Sentry.captureMessage(`Claude requests refused (${refusal}) — the demo line takes VOICE_PIPELINE until the voice server restarts (after a top-up or a raised cap: fly apps restart phondo-voice)`, "error");
  });
  return true;
}

/**
 * The standing refusal the demo line is avoiding, else null.
 * @returns {string | null}
 */
function gatewayRefusal() {
  return refusal ? `Claude requests refused (${refusal})` : null;
}

/**
 * The boot log's line about the gateway, or null on the default (straight to Anthropic).
 * @param {Record<string, string|undefined>} [env]
 * @returns {string | null}
 */
function describeGateway(env = process.env) {
  if (!env.ANTHROPIC_GATEWAY || env.ANTHROPIC_GATEWAY === "anthropic") return null;
  const problem = gatewayProblem(env);
  if (problem) return `⚠️ Anthropic requests: ${problem} — every one will fail`;
  const refused = ["FAST_LLM_MODEL", "VALIDATOR_MODEL", "CR_LLM_MODEL"].filter((name) => env[name] && gatewayModelProblem(env[name], env));
  const models = refused.length > 0 ? `; ⚠️ OpenRouter won't take ${refused.map((name) => `${name}=${env[name]}`).join(", ")}` : "";
  const classic = env.LLM_PROVIDER === "anthropic" ? "; the classic fallback (LLM_PROVIDER=anthropic) still calls Anthropic directly" : "";
  return `Anthropic requests: via OpenRouter, claude-haiku-5-5 only, pinned to Anthropic's servers${models}${classic}`;
}

module.exports = {
  anthropicGateway,
  gatewayKeyName,
  gatewayProblem,
  gatewayModelProblem,
  messagesRequest,
  isStandingRefusal,
  noteGatewayRefusal,
  gatewayRefusal,
  describeGateway,
  ANTHROPIC_MESSAGES_URL,
  OPENROUTER_MESSAGES_URL,
  _test: {
    resetRefusal() {
      refusal = "";
    },
  },
};
