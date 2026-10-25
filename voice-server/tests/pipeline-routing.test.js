const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveTestPipeline,
  normNumber,
  KNOWN_TEST_PIPELINES,
  resolveOwnerPipeline,
  OWNER_PIPELINES,
  resolveCallPipeline,
  readDemoLinePipeline,
  DEMO_LINE_PIPELINES,
  fastPathKeysPresent,
  fastPathProblem,
} = require("../lib/pipeline-routing");
const { noteGatewayRefusal, _test: gatewayTest } = require("../lib/anthropic-gateway");

/** Sets env vars for one test (undefined deletes) and puts them back after. */
function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (o) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  apply(vars);
  t.after(() => apply(saved));
}
const NO_CLAUDE_ENV = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_GATEWAY: undefined, OPENROUTER_API_KEY: undefined, FAST_LLM_MODEL: undefined };

// SCRUM-378: per-number pipeline override (eval spike), must be inert in prod.
describe("resolveTestPipeline (SCRUM-378)", () => {
  const OV = "+61400000000:openai-realtime,+61400000001:conversationrelay";

  it("returns null when the env is unset (production unchanged)", () => {
    assert.equal(resolveTestPipeline("+61400000000", undefined), null);
    assert.equal(resolveTestPipeline("+61400000000", ""), null);
  });

  it("maps a listed number to its pipeline (format-insensitive)", () => {
    assert.equal(resolveTestPipeline("+61400000000", OV), "openai-realtime");
    assert.equal(resolveTestPipeline("61400000000", OV), "openai-realtime");
    assert.equal(resolveTestPipeline("+61 400 000 000", OV), "openai-realtime");
    assert.equal(resolveTestPipeline("+61400000001", OV), "conversationrelay");
  });

  it("returns null for a number NOT in the list (real calls untouched)", () => {
    assert.equal(resolveTestPipeline("+61414141883", OV), null);
  });

  it("returns null for empty/garbage called number", () => {
    assert.equal(resolveTestPipeline("", OV), null);
    assert.equal(resolveTestPipeline(null, OV), null);
    assert.equal(resolveTestPipeline("anonymous", OV), null);
  });

  it("normNumber strips to digits", () => {
    assert.equal(normNumber("+61 400-000-000"), "61400000000");
    assert.equal(normNumber(null), "");
  });
});

describe("resolveOwnerPipeline (SCRUM-587)", () => {
  it("falls back to the global pipeline when OWNER_PIPELINE is unset or blank", () => {
    assert.equal(resolveOwnerPipeline(undefined, "gemini-live"), "gemini-live");
    assert.equal(resolveOwnerPipeline("", "classic"), "classic");
    assert.equal(resolveOwnerPipeline("   ", "gemini-live"), "gemini-live");
  });
  it("honours the two real pipelines", () => {
    assert.equal(resolveOwnerPipeline("classic", "gemini-live"), "classic");
    assert.equal(resolveOwnerPipeline(" gemini-live ", "classic"), "gemini-live");
  });
  it("ignores a typo (with a warning) so owner calls never run nothing", () => {
    const warned = [];
    const orig = console.warn; console.warn = (m) => warned.push(String(m));
    try { assert.equal(resolveOwnerPipeline("gemini", "gemini-live"), "gemini-live"); } finally { console.warn = orig; }
    assert.ok(warned.some((m) => m.includes('OWNER_PIPELINE="gemini"')));
  });

  // Beyond the brief. Its cases always pass BOTH arguments, but Task 10 calls
  // resolveOwnerPipeline() with none, so the environment-default path is the one that
  // runs in production; these pin that path and the mutants the brief's cases let through.
  it("reads OWNER_PIPELINE and VOICE_PIPELINE from the environment at call time", () => {
    const prev = { owner: process.env.OWNER_PIPELINE, global: process.env.VOICE_PIPELINE };
    const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    try {
      delete process.env.OWNER_PIPELINE;
      delete process.env.VOICE_PIPELINE;
      assert.equal(resolveOwnerPipeline(), "classic", "nothing set: the server default");
      process.env.VOICE_PIPELINE = "gemini-live";
      assert.equal(resolveOwnerPipeline(), "gemini-live", "OWNER_PIPELINE unset: the global");
      process.env.OWNER_PIPELINE = "classic"; // a Fly secret flip + restart, no code change
      assert.equal(resolveOwnerPipeline(), "classic", "owner flipped away from the global");
      process.env.OWNER_PIPELINE = "gemini-live";
      process.env.VOICE_PIPELINE = "classic";
      assert.equal(resolveOwnerPipeline(), "gemini-live", "and the other way round");
    } finally {
      restore("OWNER_PIPELINE", prev.owner);
      restore("VOICE_PIPELINE", prev.global);
    }
  });
  it("falls back to whichever global it is given, never to a hard-coded pipeline", () => {
    const orig = console.warn; console.warn = () => {};
    try {
      assert.equal(resolveOwnerPipeline("gemni-live", "classic"), "classic");
      assert.equal(resolveOwnerPipeline("gemni-live", "gemini-live"), "gemini-live");
    } finally { console.warn = orig; }
  });
  it("only warns for a real typo, not for an unset or blank value", () => {
    const warned = [];
    const orig = console.warn; console.warn = (m) => warned.push(String(m));
    try {
      resolveOwnerPipeline(undefined, "classic");
      resolveOwnerPipeline("", "classic");
      resolveOwnerPipeline("   ", "classic");
      assert.deepEqual(warned, []);
      resolveOwnerPipeline("nope", "classic");
    } finally { console.warn = orig; }
    assert.equal(warned.length, 1);
  });
  it("refuses the eval-only pipelines: owner mode exists on classic and Gemini Live only", () => {
    assert.deepEqual([...OWNER_PIPELINES].sort(), ["classic", "gemini-live"]);
    const warned = [];
    const orig = console.warn; console.warn = (m) => warned.push(String(m));
    try {
      for (const p of KNOWN_TEST_PIPELINES) assert.equal(resolveOwnerPipeline(p, "classic"), "classic", p);
    } finally { console.warn = orig; }
    assert.equal(warned.length, KNOWN_TEST_PIPELINES.size);
  });
});

// SCRUM-594: the demo-line switch. Only the published demo line can be moved
// off VOICE_PIPELINE; every other call (and every owner call) must route
// exactly as before, whatever DEMO_LINE_PIPELINE says.
describe("resolveCallPipeline / readDemoLinePipeline (SCRUM-594)", () => {
  // Hermetic: an explicit undefined falls back to the environment, so the
  // developer's shell must not leak in (the env test below sets it itself).
  delete process.env.DEMO_LINE_PIPELINE;
  const DEMO = "+61238205672";
  const CUSTOMER_LINE = "+61255550000";
  const isDemo = (n) => n === DEMO;
  /** Every console line the resolver writes during fn. */
  function quiet(t, fn) {
    const lines = [];
    for (const m of ["log", "warn", "error"]) t.mock.method(console, m, (...a) => lines.push(`${m}| ${a.join(" ")}`));
    const value = fn();
    return { value, lines };
  }
  // The fast variant's keys are set here: their absence is tested on its own (R12c, below).
  const call = (o) => resolveCallPipeline({ calledNumber: DEMO, ownerMode: false, language: "en", globalPipeline: "gemini-live", demoLinePipeline: "classic-fast", isDemoLine: isDemo, hasFastPathKeys: () => true, ...o });

  it("accepts exactly the three pipelines the server runs", () => {
    assert.deepEqual([...DEMO_LINE_PIPELINES].sort(), ["classic", "classic-fast", "gemini-live"]);
  });

  it("the demo line, an English assistant and a recognised value: the switch applies", (t) => {
    const { value, lines } = quiet(t, () => [
      call({ demoLinePipeline: "classic-fast" }),
      call({ demoLinePipeline: "classic" }),
      call({ demoLinePipeline: "gemini-live", globalPipeline: "classic" }),
      call({ demoLinePipeline: "  classic-fast  " }),
    ]);
    assert.deepEqual(value, ["classic-fast", "classic", "gemini-live", "classic-fast"]);
    assert.deepEqual(lines, [], "an applied switch is not a warning");
  });

  it("unset or blank: the demo line follows VOICE_PIPELINE, silently", (t) => {
    const { value, lines } = quiet(t, () => [
      call({ demoLinePipeline: undefined, globalPipeline: "gemini-live" }),
      call({ demoLinePipeline: null, globalPipeline: "classic" }),
      call({ demoLinePipeline: "", globalPipeline: "gemini-live" }),
      call({ demoLinePipeline: "   ", globalPipeline: "classic" }),
    ]);
    assert.deepEqual(value, ["gemini-live", "classic", "gemini-live", "classic"]);
    assert.deepEqual(lines, []);
  });

  it("every other number ignores the switch — and never even reads it", (t) => {
    const seen = [];
    const { value, lines } = quiet(t, () => [
      call({ calledNumber: CUSTOMER_LINE, isDemoLine: (n) => { seen.push(n); return false; } }),
      call({ calledNumber: CUSTOMER_LINE, demoLinePipeline: "not-a-pipeline", isDemoLine: () => false }),
      call({ calledNumber: null, globalPipeline: "classic" }),
    ]);
    assert.deepEqual(value, ["gemini-live", "gemini-live", "classic"]);
    assert.deepEqual(seen, [CUSTOMER_LINE], "the predicate is asked about the dialled number");
    assert.deepEqual(lines, [], "a typo is only reported when the demo line would have used it");
  });

  it("no predicate: no call is ever switched (the fail-safe default)", (t) => {
    const { value } = quiet(t, () => resolveCallPipeline({ calledNumber: DEMO, language: "en", globalPipeline: "gemini-live", demoLinePipeline: "classic-fast" }));
    assert.equal(value, "gemini-live");
  });

  it("an owner call is never switched, even on the demo line (owner calls are routed by resolveOwnerPipeline)", (t) => {
    const { value, lines } = quiet(t, () => [
      call({ ownerMode: true }),
      call({ ownerMode: true, globalPipeline: "classic", demoLinePipeline: "gemini-live" }),
    ]);
    assert.deepEqual(value, ["gemini-live", "classic"]);
    assert.deepEqual(lines, []);
  });

  it("a non-English assistant ignores the switch (Flux is English-only) and says so on every call", (t) => {
    const { value, lines } = quiet(t, () => [
      call({ language: "es" }),
      call({ language: "es", demoLinePipeline: "classic", globalPipeline: "gemini-live" }),
      call({ language: "ar", globalPipeline: "classic" }),
    ]);
    assert.deepEqual(value, ["gemini-live", "gemini-live", "classic"]);
    assert.equal(lines.length, 3, lines.join("\n"));
    assert.match(lines[0], /^log\| \[PipelineRouting\] DEMO_LINE_PIPELINE=classic-fast ignored — the assistant's language is "es"/);
    assert.match(lines[0], /uses gemini-live/);
    assert.match(lines[2], /language is "ar".*uses classic/);
  });

  it("a missing language is the server's default, English", (t) => {
    const { value } = quiet(t, () => [call({ language: undefined }), call({ language: null }), call({ language: "" })]);
    assert.deepEqual(value, ["classic-fast", "classic-fast", "classic-fast"]);
  });

  it("an unrecognised value warns ONCE per value and is ignored", (t) => {
    const { value, lines } = quiet(t, () => [
      call({ demoLinePipeline: "classic_fast" }),
      call({ demoLinePipeline: "classic_fast", globalPipeline: "classic" }),
      call({ demoLinePipeline: "fast" }),
    ]);
    assert.deepEqual(value, ["gemini-live", "classic", "gemini-live"]);
    assert.deepEqual(lines.map((l) => l.replace(/ \(expected .*$/, "")), [
      'warn| [PipelineRouting] DEMO_LINE_PIPELINE "classic_fast" not recognised — ignoring',
      'warn| [PipelineRouting] DEMO_LINE_PIPELINE "fast" not recognised — ignoring',
    ]);
  });

  it("the global is normalised: anything but gemini-live runs classic, as server.js always has", (t) => {
    const { value } = quiet(t, () => [
      call({ calledNumber: CUSTOMER_LINE, globalPipeline: "gemini-live" }),
      call({ calledNumber: CUSTOMER_LINE, globalPipeline: "classic" }),
      call({ calledNumber: CUSTOMER_LINE, globalPipeline: "openai-realtime" }),
      call({ calledNumber: CUSTOMER_LINE, globalPipeline: "classic-fast" }),
      call({ calledNumber: CUSTOMER_LINE, globalPipeline: " gemini-live" }),
    ]);
    assert.deepEqual(value, ["gemini-live", "classic", "classic", "classic", "classic"],
      "the fast variant is reachable through the demo-line switch only, never VOICE_PIPELINE");
  });

  it("reads DEMO_LINE_PIPELINE and VOICE_PIPELINE from the environment at CALL time", (t) => {
    const prev = { demo: process.env.DEMO_LINE_PIPELINE, global: process.env.VOICE_PIPELINE, anthropic: process.env.ANTHROPIC_API_KEY, deepgram: process.env.DEEPGRAM_API_KEY };
    const restore = (key, v) => { if (v === undefined) delete process.env[key]; else process.env[key] = v; };
    try {
      // The fast variant's keys are set (their absence is tested on its own, R12c).
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.DEEPGRAM_API_KEY = "dg-test";
      const { value } = quiet(t, () => {
        const out = [];
        delete process.env.DEMO_LINE_PIPELINE;
        delete process.env.VOICE_PIPELINE;
        out.push(resolveCallPipeline({ calledNumber: DEMO, language: "en", isDemoLine: isDemo }), readDemoLinePipeline());
        process.env.VOICE_PIPELINE = "gemini-live";
        out.push(resolveCallPipeline({ calledNumber: DEMO, language: "en", isDemoLine: isDemo }));
        process.env.DEMO_LINE_PIPELINE = "classic-fast"; // a `fly secrets set` + restart, no code change
        out.push(resolveCallPipeline({ calledNumber: DEMO, language: "en", isDemoLine: isDemo }), readDemoLinePipeline());
        return out;
      });
      assert.deepEqual(value, ["classic", null, "gemini-live", "classic-fast", "classic-fast"]);
    } finally {
      restore("DEMO_LINE_PIPELINE", prev.demo);
      restore("VOICE_PIPELINE", prev.global);
      restore("ANTHROPIC_API_KEY", prev.anthropic);
      restore("DEEPGRAM_API_KEY", prev.deepgram);
    }
  });

  it("readDemoLinePipeline: trims, accepts the three, and maps anything else to null", (t) => {
    const { value } = quiet(t, () => [
      readDemoLinePipeline(" gemini-live "), readDemoLinePipeline("classic"), readDemoLinePipeline("classic-fast"),
      readDemoLinePipeline(""), readDemoLinePipeline(null), readDemoLinePipeline("CLASSIC-FAST"), readDemoLinePipeline("conversationrelay"),
    ]);
    assert.deepEqual(value, ["gemini-live", "classic", "classic-fast", null, null, null, null]);
  });

  it("only ever returns one of the three pipelines", (t) => {
    const out = new Set();
    quiet(t, () => {
      for (const calledNumber of [DEMO, CUSTOMER_LINE, null]) {
        for (const ownerMode of [false, true]) {
          for (const language of ["en", "es", undefined]) {
            for (const globalPipeline of ["gemini-live", "classic", "grok-realtime", ""]) {
              for (const demoLinePipeline of [undefined, "classic-fast", "classic", "gemini-live", "bogus"]) {
                out.add(resolveCallPipeline({ calledNumber, ownerMode, language, globalPipeline, demoLinePipeline, isDemoLine: isDemo, hasFastPathKeys: () => true }));
              }
            }
          }
        }
      }
    });
    assert.deepEqual([...out].sort(), ["classic", "classic-fast", "gemini-live"]);
  });
});

// SCRUM-594 R12c: the fast variant cannot run without Claude (ANTHROPIC_API_KEY) and
// Deepgram (DEEPGRAM_API_KEY). Without them the demo line takes the global pipeline,
// instead of apologising on every turn. Logged once per process; the resolver never
// reports to Sentry.
describe("resolveCallPipeline: classic-fast without its keys (SCRUM-594 R12c)", () => {
  const DEMO = "+61238205672";
  const isDemo = (n) => n === DEMO;
  function quiet(t, fn) {
    const lines = [];
    for (const m of ["log", "warn", "error"]) t.mock.method(console, m, (...a) => lines.push(`${m}| ${a.join(" ")}`));
    const value = fn();
    return { value, lines };
  }
  const fast = (o) => resolveCallPipeline({ calledNumber: DEMO, language: "en", globalPipeline: "gemini-live", demoLinePipeline: "classic-fast", isDemoLine: isDemo, ...o });

  it("both keys present: the switch applies, silently", (t) => {
    let asked = 0;
    const { value, lines } = quiet(t, () => fast({ hasFastPathKeys: () => { asked += 1; return true; } }));
    assert.equal(value, "classic-fast");
    assert.equal(asked, 1);
    assert.deepEqual(lines, []);
  });

  it("a key missing: the call takes the global pipeline, and it is logged once per process, with why", (t) => {
    withEnv(t, NO_CLAUDE_ENV);
    const { value, lines } = quiet(t, () => [
      fast({ hasFastPathKeys: () => false }),
      fast({ hasFastPathKeys: () => false, globalPipeline: "classic" }),
      fast({ hasFastPathKeys: () => false, globalPipeline: "openai-realtime" }),
    ]);
    assert.deepEqual(value, ["gemini-live", "classic", "classic"], "the global, normalised as always");
    assert.deepEqual(lines, ["warn| [PipelineRouting] classic-fast can't run (ANTHROPIC_API_KEY not set) — using gemini-live"]);
  });

  it("with ANTHROPIC_GATEWAY=openrouter, the line names the OpenRouter key (SCRUM-594)", (t) => {
    withEnv(t, { ...NO_CLAUDE_ENV, ANTHROPIC_GATEWAY: "openrouter", ANTHROPIC_API_KEY: "sk-test" });
    // A fresh module: its once-per-process line hasn't been logged yet.
    const p = require.resolve("../lib/pipeline-routing");
    delete require.cache[p];
    const fresh = require(p);
    const { value, lines } = quiet(t, () => fresh.resolveCallPipeline({ calledNumber: DEMO, language: "en", globalPipeline: "gemini-live", demoLinePipeline: "classic-fast", isDemoLine: isDemo, hasFastPathKeys: () => false }));
    assert.equal(value, "gemini-live");
    assert.deepEqual(lines, ["warn| [PipelineRouting] classic-fast can't run (OPENROUTER_API_KEY not set (ANTHROPIC_GATEWAY=openrouter)) — using gemini-live"]);
  });

  it("the keys are asked about only when the call would run classic-fast", (t) => {
    let asked = 0;
    const hasFastPathKeys = () => { asked += 1; return false; };
    const { value } = quiet(t, () => [
      fast({ hasFastPathKeys, demoLinePipeline: "classic" }),
      fast({ hasFastPathKeys, demoLinePipeline: "gemini-live", globalPipeline: "classic" }),
      fast({ hasFastPathKeys, calledNumber: "+61255550000" }),
      fast({ hasFastPathKeys, ownerMode: true }),
      fast({ hasFastPathKeys, language: "es" }),
      fast({ hasFastPathKeys, demoLinePipeline: "bogus-r12c" }),
    ]);
    assert.deepEqual(value, ["classic", "gemini-live", "gemini-live", "gemini-live", "gemini-live", "gemini-live"]);
    assert.equal(asked, 0);
  });

  it("by default the keys are read from the environment at CALL time: each one missing, empty, or both present", (t) => {
    const prev = { anthropic: process.env.ANTHROPIC_API_KEY, deepgram: process.env.DEEPGRAM_API_KEY };
    const restore = (key, v) => { if (v === undefined) delete process.env[key]; else process.env[key] = v; };
    try {
      const { value } = quiet(t, () => {
        const out = [];
        process.env.ANTHROPIC_API_KEY = "sk-test";
        process.env.DEEPGRAM_API_KEY = "dg-test";
        out.push(fast());
        delete process.env.ANTHROPIC_API_KEY;
        out.push(fast());
        process.env.ANTHROPIC_API_KEY = "sk-test";
        delete process.env.DEEPGRAM_API_KEY;
        out.push(fast({ globalPipeline: "classic" }));
        process.env.DEEPGRAM_API_KEY = "";
        out.push(fast());
        process.env.DEEPGRAM_API_KEY = "dg-test"; // set again: no restart needed
        out.push(fast());
        return out;
      });
      assert.deepEqual(value, ["classic-fast", "gemini-live", "classic", "gemini-live", "classic-fast"]);
    } finally {
      restore("ANTHROPIC_API_KEY", prev.anthropic);
      restore("DEEPGRAM_API_KEY", prev.deepgram);
    }
  });

  it("fastPathKeysPresent: both keys, neither empty", () => {
    assert.equal(fastPathKeysPresent({ ANTHROPIC_API_KEY: "sk", DEEPGRAM_API_KEY: "dg" }), true);
    assert.equal(fastPathKeysPresent({ ANTHROPIC_API_KEY: "sk" }), false);
    assert.equal(fastPathKeysPresent({ DEEPGRAM_API_KEY: "dg" }), false);
    assert.equal(fastPathKeysPresent({ ANTHROPIC_API_KEY: "", DEEPGRAM_API_KEY: "dg" }), false);
    assert.equal(fastPathKeysPresent({ ANTHROPIC_API_KEY: "sk", DEEPGRAM_API_KEY: "" }), false);
    assert.equal(fastPathKeysPresent({}), false);
  });

  it("fastPathKeysPresent: with ANTHROPIC_GATEWAY=openrouter, the OpenRouter key stands in for the Anthropic one (SCRUM-594)", () => {
    assert.equal(fastPathKeysPresent({ ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or", DEEPGRAM_API_KEY: "dg" }), true);
    assert.equal(fastPathKeysPresent({ ANTHROPIC_GATEWAY: "openrouter", ANTHROPIC_API_KEY: "sk", DEEPGRAM_API_KEY: "dg" }), false, "the empty Anthropic account is no stand-in");
    assert.equal(fastPathKeysPresent({ ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or" }), false);
    assert.equal(fastPathKeysPresent({ ANTHROPIC_GATEWAY: "open-router", OPENROUTER_API_KEY: "or", ANTHROPIC_API_KEY: "sk", DEEPGRAM_API_KEY: "dg" }), false, "a value it doesn't know");
  });

  it("fastPathProblem names the first thing missing: Claude's gateway key, a model it won't take, a refusal, Deepgram's key", () => {
    const OR = { ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "or", DEEPGRAM_API_KEY: "dg" };
    assert.equal(fastPathProblem({}), "ANTHROPIC_API_KEY not set");
    assert.equal(fastPathProblem({ ANTHROPIC_API_KEY: "sk" }), "DEEPGRAM_API_KEY not set");
    assert.equal(fastPathProblem({ ANTHROPIC_API_KEY: "sk", DEEPGRAM_API_KEY: "dg" }), null);
    assert.equal(fastPathProblem(OR), null, "Haiku 5.5 by default, as server.js's FAST_LLM_MODEL");
    assert.equal(fastPathProblem({ ...OR, FAST_LLM_MODEL: "claude-haiku-4-5-20251001" }), "claude-haiku-4-5-20251001 may not be sent through OpenRouter (claude-haiku-5-5 only)", "the documented revert lever");
    assert.equal(fastPathProblem(OR, "claude-sonnet-5-5"), "claude-sonnet-5-5 may not be sent through OpenRouter (claude-haiku-5-5 only)");
    assert.equal(fastPathProblem({ ANTHROPIC_API_KEY: "sk", DEEPGRAM_API_KEY: "dg" }, "claude-haiku-4-5-20251001"), null, "straight to Anthropic, any model");
    assert.equal(fastPathKeysPresent({ ...OR, FAST_LLM_MODEL: "claude-haiku-4-5-20251001" }), false);
    assert.equal(fastPathKeysPresent(OR, "claude-opus-5-5"), false);
  });

  it("a standing refusal (no credit, a spent cap) sends new demo calls to the global pipeline until a request succeeds (phone test F10)", (t) => {
    const env = { ANTHROPIC_API_KEY: "sk", DEEPGRAM_API_KEY: "dg" };
    t.after(() => gatewayTest.resetRefusal());
    t.mock.method(console, "error", () => {});
    assert.equal(fastPathProblem(env), null);
    noteGatewayRefusal(400, "Your credit balance is too low to access the Anthropic API.");
    assert.equal(fastPathProblem(env), "Claude requests refused (HTTP 400: Your credit balance is too low to access the Anthropic API.)");
    assert.equal(fastPathKeysPresent(env), false);
    const { value } = quiet(t, () => fast({ hasFastPathKeys: () => fastPathKeysPresent(env) }));
    assert.equal(value, "gemini-live");
    gatewayTest.resetRefusal();
    assert.equal(fastPathKeysPresent(env), true);
  });
});
