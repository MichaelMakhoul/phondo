/**
 * Tier 2 Turn Validator — Claude Haiku verifies Sophie's spoken response
 * matches the actual tool result.
 *
 * Catches: wrong dates, wrong times, wrong practitioner names, and any
 * fabricated details that the regex-based Tier 1 detector can't catch.
 *
 * Cost: ~$0.0001 per validation on Haiku 5.5. Only fires on turns after tool
 * results (typically 2-5 per call).
 *
 * Latency: ~0.6s for a clean verdict, ~1.3s when it writes a discrepancy note
 * (measured 2026-10-09). Runs AFTER the turn completes (audio already sent),
 * so no caller-facing latency. Correction is injected into Gemini's next turn.
 */

const { DEBUG_TRANSCRIPTS } = require("../lib/log-transcript");
const { claudeLatencyParams, claudeResponseText } = require("../lib/model-params");
const { Sentry } = require("../lib/sentry");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// SCRUM-588: Haiku 5.5 — 10× cheaper than Haiku 4.5 and, with thinking
// disabled, within ~70ms of its latency (probed). VALIDATOR_MODEL is the
// revert lever: "claude-haiku-4-5-20251001" accepts the same request.
const VALIDATOR_MODEL = process.env.VALIDATOR_MODEL || "claude-haiku-5-5";
// Haiku 5.5's tokenizer counts the same text as ~30% more tokens and its
// discrepancy notes run longer: a three-field mismatch used 120 of the old 150
// (Haiku 4.5: ~78). A truncated note would still flag the turn but reach
// Gemini as "Unknown discrepancy", so leave real headroom.
const VALIDATOR_MAX_TOKENS = 300;

/**
 * Statuses that fail EVERY validation the same way: a bad VALIDATOR_MODEL
 * (404), a request field the model rejects (400 — e.g. `thinking` on a tier
 * that refuses it), a bad or revoked key (401/403). One is enough to page.
 */
const CONFIG_FAILURE_STATUSES = new Set([400, 401, 403, 404]);
/** Unreadable verdicts in a row before anything else counts as "validation OFF". */
const UNREADABLE_ALERT_AFTER = 3;

// Validations in a row that produced no usable verdict (process-wide). Reset
// ONLY by a verdict the validator could actually read — a 2xx whose body is
// unreadable is exactly the failure being counted, so it never resets this.
let unreadableStreak = 0;

/**
 * The ONE exit for "no usable verdict". It still fails open — the validator
 * must never block a call — but never quietly: with lib/sentry.js, Grafana
 * pages only on [ALERT:*] lines, and every exit here used to be a bare
 * console.warn (or nothing at all), so the layer could be off fleet-wide
 * with nobody told.
 *
 * Config failures page at once ([ALERT:error]); anything else pages
 * ([ALERT:warning]) from the third unreadable verdict in a row. Both repeat
 * for every further failure, so the alert stays firing until it is fixed.
 *
 * @param {{ cause: string, config?: boolean, status?: number, stopReason?: string, errorType?: string, errorMessage?: string }} info
 *   Shape only — NEVER model output, tool results or caller words.
 * @returns {{ accurate: true }}
 */
function noVerdict(info) {
  unreadableStreak++;
  const details = {
    model: VALIDATOR_MODEL,
    cause: info.cause,
    status: info.status,
    stop_reason: info.stopReason,
    error_type: info.errorType,
    error_message: info.errorMessage,
    unreadable_in_a_row: unreadableStreak,
  };
  const level = info.config ? "error" : unreadableStreak >= UNREADABLE_ALERT_AFTER ? "warning" : null;
  if (level) {
    const what = info.config
      ? info.status !== undefined ? `HTTP ${info.status}` : info.cause
      : `${unreadableStreak} unreadable in a row`;
    Sentry.withScope((scope) => {
      scope.setTag("service", "tier2_validator");
      scope.setExtras(details);
      Sentry.captureMessage(`Tier-2 validator producing no verdicts (${what}) — validation OFF`, level);
    });
  } else {
    const shown = Object.entries(details)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.warn(`[TurnValidator] No usable verdict (${shown}) — failing open`);
  }
  return { accurate: true };
}

/**
 * Error type + message from an Anthropic error body — never anything else.
 * @param {{ json: () => Promise<unknown> }} res
 * @returns {Promise<{ errorType?: string, errorMessage?: string }>}
 */
async function readApiError(res) {
  try {
    const body = /** @type {any} */ (await res.json());
    return {
      errorType: typeof body?.error?.type === "string" ? body.error.type : undefined,
      errorMessage: typeof body?.error?.message === "string" ? body.error.message.slice(0, 200) : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * The model's verdict, or why there is none. A string "true"/"false" is not
 * a verdict: the prompt asks for a JSON boolean, and anything else is drift.
 * @param {string} text - the reply's text block
 * @returns {{ verdict: { accurate: true } | { accurate: false, discrepancy: string } } | { unreadable: "not-json" | "no-boolean-verdict" }}
 */
function parseVerdict(text) {
  // Haiku 4.5 (the revert model) often wraps the JSON in a ```json fence.
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let result;
  try {
    result = JSON.parse(unfenced);
  } catch {
    // Truncated or garbled JSON that still plainly says false: flag the turn.
    if (/"accurate"\s*:\s*false\b/.test(unfenced)) {
      const match = unfenced.match(/"discrepancy"\s*:\s*"([^"]+)"/);
      return { verdict: { accurate: false, discrepancy: match?.[1] || "Unknown discrepancy" } };
    }
    return { unreadable: "not-json" };
  }
  if (result && typeof result === "object" && typeof result.accurate === "boolean") {
    if (result.accurate) return { verdict: { accurate: true } };
    const note = typeof result.discrepancy === "string" && result.discrepancy ? result.discrepancy : "Unknown discrepancy";
    return { verdict: { accurate: false, discrepancy: note } };
  }
  return { unreadable: "no-boolean-verdict" };
}

/**
 * Validate that Sophie's spoken response accurately reflects the tool result.
 *
 * @param {object} params
 * @param {string} params.toolName — which tool was called (e.g., "book_appointment")
 * @param {string} params.toolResult — the text result the tool returned
 * @param {string} params.spokenResponse — what Sophie said to the caller (from outputTranscription)
 * @returns {Promise<{ accurate: boolean, discrepancy?: string }>}
 */
async function validateToolResponse({ toolName, toolResult, spokenResponse }) {
  // Only validate action tools — skip get_current_datetime, check_availability, etc.
  // (Not a failure: there is nothing to check, so it neither counts nor resets.)
  const actionTools = new Set(["book_appointment", "cancel_appointment", "schedule_callback", "lookup_appointment"]);
  if (!actionTools.has(toolName)) {
    return { accurate: true };
  }

  if (!ANTHROPIC_API_KEY) {
    return noVerdict({ cause: "ANTHROPIC_API_KEY not set", config: true });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: VALIDATOR_MODEL,
        max_tokens: VALIDATOR_MAX_TOKENS,
        // Thinking off: with Haiku 5.5's default (adaptive) thinking the reply
        // can START with a thinking block and spend the token cap on it.
        ...claudeLatencyParams(VALIDATOR_MODEL),
        messages: [{
          role: "user",
          content: `You are a quality checker for an AI receptionist. Compare the tool result against what the AI told the caller. Report ONLY factual mismatches — ignore phrasing differences.

TOOL CALLED: ${toolName}
TOOL RESULT: "${toolResult}"
AI SPOKE TO CALLER: "${spokenResponse}"

Check for:
1. Date mismatch (tool says one date, AI says different date)
2. Time mismatch (tool says 10:15, AI says 10:00)
3. Practitioner/doctor name mismatch
4. Status mismatch (tool returned error but AI said success, or vice versa)
5. Any details the AI stated that are NOT in the tool result (fabricated info)

Respond with ONLY this JSON (no markdown, no explanation):
{"accurate": true}
OR
{"accurate": false, "discrepancy": "brief description of the mismatch"}`,
        }],
      }),
      signal: AbortSignal.timeout(5000), // 5s hard timeout
    });

    if (!res.ok) {
      const { errorType, errorMessage } = await readApiError(res);
      return noVerdict({
        cause: "http-error",
        status: res.status,
        config: CONFIG_FAILURE_STATUSES.has(res.status),
        errorType,
        errorMessage,
      });
    }

    const data = /** @type {{ content?: unknown, stop_reason?: string }} */ (await res.json());
    // By block TYPE, never content[0]: on a model that thinks, content[0] is a
    // thinking block, and reading it as "no text" would pass EVERY turn as
    // accurate — this layer silently switched off (probed on Haiku 5.5).
    // Thinking-only replies, a cap spent on thinking and refusals land here.
    const text = claudeResponseText(data.content).trim();
    if (!text) {
      return noVerdict({ cause: "no-text", stopReason: data.stop_reason ?? "unknown" });
    }

    const parsed = parseVerdict(text);
    if ("unreadable" in parsed) {
      return noVerdict({ cause: parsed.unreadable, stopReason: data.stop_reason ?? "unknown" });
    }
    unreadableStreak = 0; // a readable verdict — the validator is working
    const { verdict } = parsed;
    if (verdict.accurate === false) {
      // SCRUM-339: discrepancy is free text that can quote caller name /
      // appointment details — redact unless DEBUG_TRANSCRIPTS.
      console.warn(`[TurnValidator] Discrepancy detected for ${toolName}: ${DEBUG_TRANSCRIPTS ? verdict.discrepancy : "[redacted]"}`);
    }
    return verdict;
  } catch (err) {
    // Timeout or network error — don't block the call. A body that isn't JSON
    // surfaces as a SyntaxError whose message quotes the body: never log it.
    const name = err && err.name ? err.name : "Error";
    return noVerdict({
      cause: "request-failed",
      errorType: name,
      errorMessage: name === "SyntaxError" ? "response body is not JSON" : String(err && err.message).slice(0, 200),
    });
  }
}

module.exports = {
  validateToolResponse,
  // Exposed for unit tests only.
  _test: { parseVerdict, UNREADABLE_ALERT_AFTER },
};
