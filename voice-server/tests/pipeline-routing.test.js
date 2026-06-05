const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveTestPipeline, normNumber } = require("../lib/pipeline-routing");

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
