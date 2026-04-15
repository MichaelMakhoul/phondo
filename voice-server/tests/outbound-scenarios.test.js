const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { getScenario, getAllScenarios, getScenarioForIndustry } = require("../lib/outbound-scenarios");

describe("outbound-scenarios", () => {
  it("returns a scenario by ID", () => {
    const s = getScenario("book-happy-path");
    assert.ok(s, "scenario should exist");
    assert.equal(s.id, "book-happy-path");
    assert.ok(s.name, "should have a name");
    assert.ok(s.persona, "should have a persona");
    assert.ok(s.prompt, "should have a prompt");
    assert.ok(Array.isArray(s.expectedOutcomes), "should have expectedOutcomes array");
  });

  it("returns null for unknown scenario ID", () => {
    assert.equal(getScenario("nonexistent"), null);
  });

  it("returns all scenarios with required fields", () => {
    const all = getAllScenarios();
    assert.equal(all.length, 49, `expected exactly 49 scenarios, got ${all.length}`);
    // Every scenario has required fields
    for (const s of all) {
      assert.ok(s.id, `missing id on scenario: ${JSON.stringify(s).slice(0, 50)}`);
      assert.ok(s.name, `missing name on: ${s.id}`);
      assert.ok(s.prompt, `missing prompt on: ${s.id}`);
      assert.ok(s.section, `missing section on: ${s.id}`);
      assert.ok(Array.isArray(s.expectedOutcomes), `missing expectedOutcomes on: ${s.id}`);
    }
  });

  it("has no duplicate IDs", () => {
    const all = getAllScenarios();
    const ids = all.map((s) => s.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `duplicate IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  });

  it("adapts scenario for different industry", () => {
    const base = getScenario("book-happy-path");
    const dental = getScenarioForIndustry("book-happy-path", "dental");
    const legal = getScenarioForIndustry("book-happy-path", "legal");
    // Dental null override should return base prompt unchanged
    assert.equal(dental.prompt, base.prompt, "dental null override should return base");
    // Legal override should differ
    assert.ok(dental.prompt !== legal.prompt, "prompts should differ by industry");
    assert.ok(legal.prompt.toLowerCase().includes("consult") || legal.prompt.toLowerCase().includes("legal") || legal.prompt.toLowerCase().includes("law"), "legal prompt should mention legal context");
  });

  it("falls back to base scenario for unknown industry", () => {
    const base = getScenario("book-happy-path");
    const unknown = getScenarioForIndustry("book-happy-path", "unknown_industry");
    assert.equal(unknown.prompt, base.prompt);
  });

  it("returns null for unknown scenario in getScenarioForIndustry", () => {
    assert.equal(getScenarioForIndustry("nonexistent", "dental"), null);
  });
});
