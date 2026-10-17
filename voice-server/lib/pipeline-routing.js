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

/** SCRUM-587: the pipelines the server actually implements for INBOUND owner calls. */
const OWNER_PIPELINES = new Set(["classic", "gemini-live"]);

/**
 * SCRUM-587: pipeline for OWNER calls only. Unset → the global VOICE_PIPELINE;
 * a known value is honoured; a typo warns and falls back, so a bad secret can
 * never leave owner calls without a pipeline. Read at CALL time.
 * @param {string} [ownerRaw]
 * @param {string} [globalPipeline]
 * @returns {string}
 */
function resolveOwnerPipeline(ownerRaw = process.env.OWNER_PIPELINE, globalPipeline = process.env.VOICE_PIPELINE || "classic") {
  const v = String(ownerRaw || "").trim();
  if (!v) return globalPipeline;
  if (OWNER_PIPELINES.has(v)) return v;
  console.warn(`[Pipeline] OWNER_PIPELINE="${v}" is not a known pipeline (${[...OWNER_PIPELINES].join(", ")}) — owner calls use ${globalPipeline}`);
  return globalPipeline;
}

/**
 * SCRUM-594: the values DEMO_LINE_PIPELINE accepts. "classic-fast" is the fast
 * classic variant (Flux STT, Claude, streaming Aura TTS); "classic" and
 * "gemini-live" pin the demo line to either existing pipeline.
 */
const DEMO_LINE_PIPELINES = new Set(["classic-fast", "classic", "gemini-live"]);

/** Unrecognised DEMO_LINE_PIPELINE values already reported: one warning per value, not one per call. */
const warnedDemoLinePipelines = new Set();

/**
 * SCRUM-594 (R12c): the keys "classic-fast" cannot run without: Claude
 * (ANTHROPIC_API_KEY) and Deepgram (DEEPGRAM_API_KEY, for Flux and Aura). An
 * empty value counts as missing.
 * @param {Record<string, string|undefined>} [env] - defaults to process.env, read now
 * @returns {boolean}
 */
function fastPathKeysPresent(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY && env.DEEPGRAM_API_KEY);
}

/** The missing-key fallback is logged once per process, not once per call. */
let fastPathKeysWarned = false;

/**
 * SCRUM-594: DEMO_LINE_PIPELINE, validated. Read at CALL time (the default
 * reads the environment on every call), so tests can vary it, and setting the
 * Fly secret (which restarts the machine) needs no code change.
 * @param {string|null} [raw] - defaults to process.env.DEMO_LINE_PIPELINE
 * @returns {"classic-fast"|"classic"|"gemini-live"|null} null when unset, blank or unrecognised: the demo line follows VOICE_PIPELINE
 */
function readDemoLinePipeline(raw = process.env.DEMO_LINE_PIPELINE) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (DEMO_LINE_PIPELINES.has(value)) return /** @type {"classic-fast"|"classic"|"gemini-live"} */ (value);
  if (!warnedDemoLinePipelines.has(value)) {
    warnedDemoLinePipelines.add(value);
    console.warn(`[PipelineRouting] DEMO_LINE_PIPELINE "${value.slice(0, 40)}" not recognised — ignoring (expected one of: ${[...DEMO_LINE_PIPELINES].join(", ")})`);
  }
  return null;
}

/**
 * SCRUM-594: the pipeline for one inbound customer call. Only the published
 * demo line can be switched (DEMO_LINE_PIPELINE), and only for an English
 * assistant (Flux STT is English-only). Every other call follows the global
 * pipeline exactly as before. Owner calls are routed by resolveOwnerPipeline()
 * and never reach this; one that does gets the global, never the switch.
 *
 * @param {{ calledNumber?: string|null, ownerMode?: boolean, language?: string|null, globalPipeline?: string, demoLinePipeline?: string|null, isDemoLine?: (calledNumber: string|null|undefined) => boolean, hasFastPathKeys?: () => boolean }} [opts]
 *   calledNumber - the business line the caller dialled;
 *   ownerMode - a PIN-verified owner session;
 *   language - the assistant's language (missing means "en", the server default);
 *   globalPipeline - VOICE_PIPELINE (default: the environment's, else "classic"); any value but "gemini-live" runs classic;
 *   demoLinePipeline - DEMO_LINE_PIPELINE (default: the environment's, read at call time);
 *   isDemoLine - whether a number is the published demo line (server.js passes lib/demo-line's isDemoLineNumber; default: never);
 *   hasFastPathKeys - whether "classic-fast" has its keys, asked only when the call would run it (default: fastPathKeysPresent() on the environment, read at call time).
 *     Without them the call takes the global pipeline (R12c): the fast variant would apologise on every turn. Logged once per process; never reported to Sentry here.
 * @returns {"gemini-live"|"classic"|"classic-fast"}
 */
function resolveCallPipeline({
  calledNumber = null,
  ownerMode = false,
  language = "en",
  globalPipeline = process.env.VOICE_PIPELINE || "classic",
  demoLinePipeline = process.env.DEMO_LINE_PIPELINE,
  isDemoLine = () => false,
  hasFastPathKeys = () => fastPathKeysPresent(),
} = {}) {
  const global = globalPipeline === "gemini-live" ? "gemini-live" : "classic";
  if (ownerMode || !isDemoLine(calledNumber)) return global;
  const override = readDemoLinePipeline(demoLinePipeline);
  if (!override) return global;
  const lang = language || "en";
  if (lang !== "en") {
    console.log(`[PipelineRouting] DEMO_LINE_PIPELINE=${override} ignored — the assistant's language is "${lang}" and the switch is English-only. The demo line uses ${global}.`);
    return global;
  }
  if (override === "classic-fast" && !hasFastPathKeys()) {
    if (!fastPathKeysWarned) {
      fastPathKeysWarned = true;
      console.warn(`[PipelineRouting] classic-fast needs ANTHROPIC_API_KEY and DEEPGRAM_API_KEY — using ${global}`);
    }
    return global;
  }
  return override;
}

module.exports = {
  resolveTestPipeline,
  normNumber,
  KNOWN_TEST_PIPELINES,
  resolveOwnerPipeline,
  OWNER_PIPELINES,
  resolveCallPipeline,
  readDemoLinePipeline,
  DEMO_LINE_PIPELINES,
  fastPathKeysPresent,
};
