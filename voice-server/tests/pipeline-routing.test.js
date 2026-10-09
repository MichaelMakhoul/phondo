const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveTestPipeline,
  normNumber,
  KNOWN_TEST_PIPELINES,
  resolveOwnerPipeline,
  OWNER_PIPELINES,
} = require("../lib/pipeline-routing");

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
