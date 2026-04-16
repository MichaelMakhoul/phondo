/**
 * Tier 2 Turn Validator — Claude Haiku verifies Sophie's spoken response
 * matches the actual tool result.
 *
 * Catches: wrong dates, wrong times, wrong practitioner names, and any
 * fabricated details that the regex-based Tier 1 detector can't catch.
 *
 * Cost: ~$0.001 per validation. Only fires on turns after tool results
 * (typically 2-5 per call = ~$0.005 total per call).
 *
 * Latency: ~200-500ms. Runs AFTER the turn completes (audio already sent),
 * so no caller-facing latency. Correction is injected into Gemini's next turn.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VALIDATOR_MODEL = "claude-haiku-4-5-20251001";

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
        max_tokens: 150,
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

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() || "";

    // Parse the JSON response
    try {
      const result = JSON.parse(text);
      if (typeof result.accurate === "boolean") {
        if (!result.accurate) {
          console.warn(`[TurnValidator] Discrepancy detected for ${toolName}: ${result.discrepancy}`);
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
