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
 * Validate that Sophie's spoken response accurately reflects the tool result.
 *
 * @param {object} params
 * @param {string} params.toolName — which tool was called (e.g., "book_appointment")
 * @param {string} params.toolResult — the text result the tool returned
 * @param {string} params.spokenResponse — what Sophie said to the caller (from outputTranscription)
 * @returns {Promise<{ accurate: boolean, discrepancy?: string }>}
 */
async function validateToolResponse({ toolName, toolResult, spokenResponse }) {
  if (!ANTHROPIC_API_KEY) {
    console.warn("[TurnValidator] ANTHROPIC_API_KEY not set — skipping Tier 2 validation");
    return { accurate: true };
  }

  // Only validate action tools — skip get_current_datetime, check_availability, etc.
  const actionTools = new Set(["book_appointment", "cancel_appointment", "schedule_callback", "lookup_appointment"]);
  if (!actionTools.has(toolName)) {
    return { accurate: true };
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
      console.warn(`[TurnValidator] Anthropic API error ${res.status} — skipping validation`);
      return { accurate: true };
    }

    const data = /** @type {{ content?: unknown, stop_reason?: string }} */ (await res.json());
    // By block TYPE, never content[0]: on a model that thinks, content[0] is a
    // thinking block, and reading it as "no text" would pass EVERY turn as
    // accurate — this layer silently switched off (probed on Haiku 5.5).
    const text = claudeResponseText(data.content).trim();
    if (!text) {
      console.warn(`[TurnValidator] No text in ${VALIDATOR_MODEL} response (stop_reason=${data.stop_reason ?? "unknown"}) — skipping validation`);
      return { accurate: true };
    }

    // Parse the JSON response
    try {
      const result = JSON.parse(text);
      if (typeof result.accurate === "boolean") {
        if (!result.accurate) {
          // SCRUM-339: discrepancy is free text that can quote caller name /
          // appointment details — redact unless DEBUG_TRANSCRIPTS.
          console.warn(`[TurnValidator] Discrepancy detected for ${toolName}: ${DEBUG_TRANSCRIPTS ? result.discrepancy : "[redacted]"}`);
        }
        return result;
      }
    } catch {
      // If the model didn't return valid JSON, try to extract the answer
      if (text.includes('"accurate": false') || text.includes('"accurate":false')) {
        const match = text.match(/"discrepancy"\s*:\s*"([^"]+)"/);
        return { accurate: false, discrepancy: match?.[1] || "Unknown discrepancy" };
      }
    }

    return { accurate: true };
  } catch (err) {
    // Timeout or network error — don't block the call
    console.warn(`[TurnValidator] Validation failed (non-fatal): ${err.message}`);
    return { accurate: true };
  }
}

module.exports = { validateToolResponse };
