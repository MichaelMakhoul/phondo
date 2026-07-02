/**
 * SCRUM-378: non-destructive per-number voice-pipeline override for the
 * evaluation spike. Lets a DEDICATED test number run an alternate pipeline
 * (openai-realtime / conversationrelay / grok-realtime) while every production
 * number keeps the global VOICE_PIPELINE (gemini-live). Env-based, so there's
 * no DB change and it's fully reversible — unset the env and behavior is
 * exactly as before.
 *
 * TEST_PIPELINE_OVERRIDES = comma-separated "number:pipeline" pairs, e.g.
 *   "+61400000000:openai-realtime,+61400000001:conversationrelay,+61400000002:grok-realtime"
 */

/** Digits-only, so "+61400000000" / "61400000000" / formatted all compare equal. */
function normNumber(s) {
  return String(s || "").replace(/\D/g, "");
}

/** Pipelines the server actually implements. Anything else in the env is a
 *  typo — server.js warns so a mis-typed override can't silently run Gemini
 *  and corrupt the A/B comparison. */
const KNOWN_TEST_PIPELINES = new Set(["openai-realtime", "conversationrelay", "grok-realtime"]);

/**
 * @param {string} calledNumber - the number the caller dialed (the business line)
 * @param {string} [overridesRaw] - defaults to process.env.TEST_PIPELINE_OVERRIDES
 * @returns {string|null} the override pipeline for this number, or null to use the
 *   global default (production unchanged).
 */
function resolveTestPipeline(calledNumber, overridesRaw = process.env.TEST_PIPELINE_OVERRIDES) {
  if (!overridesRaw || !calledNumber) return null;
  const target = normNumber(calledNumber);
  if (!target) return null;
  for (const pair of String(overridesRaw).split(",")) {
    const idx = pair.indexOf(":");
    if (idx === -1) continue;
    const num = pair.slice(0, idx).trim();
    const pipe = pair.slice(idx + 1).trim();
    if (pipe && normNumber(num) === target) return pipe;
  }
  return null;
}

module.exports = { resolveTestPipeline, normNumber, KNOWN_TEST_PIPELINES };
