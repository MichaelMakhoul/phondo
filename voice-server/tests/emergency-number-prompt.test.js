const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildSystemPrompt } = require("../lib/prompt-builder");

// The emergency number is caller-safety wording: telling an Australian caller to
// dial 911 during a medical emergency (or an American to dial 000) is the worst
// regression this file can ship. Before the country-aware change the legacy
// dental path hardcoded 000 for EVERYONE, and the guided path hardcoded 911 in
// its industry guidelines. Pin BOTH paths and BOTH countries so a stray
// hardcode can never come back silently.
//
// This is the JS port that the voice server actually builds prompts from at call
// time — its TS twin (src/lib/prompt-builder/generate-prompt.ts) is pinned by
// generate-prompt.test.ts. The two must not drift.

function makeOrganization(country) {
  return {
    name: "Acme Medical",
    industry: "medical",
    timezone: "Australia/Sydney",
    businessHours: {},
    defaultAppointmentDuration: 30,
    ...(country !== undefined && { country }),
  };
}

/** promptConfig present → buildSystemPrompt delegates to buildPromptFromConfig. */
function guidedAssistant() {
  return {
    language: "en",
    promptConfig: {
      tone: "friendly",
      fields: [],
      behaviors: { handleEmergencies: true },
    },
  };
}

/**
 * No promptConfig → buildSystemPrompt takes the legacy path, which appends the
 * hardcoded CRITICAL SAFETY RULES (including the emergency number) to the
 * assistant's stored systemPrompt.
 */
function legacyAssistant() {
  return { language: "en", systemPrompt: "You are the receptionist for {business_name}." };
}

describe("emergency number is country-aware (guided prompt path)", () => {
  it("uses 000 for an AU organization", () => {
    const prompt = buildSystemPrompt(guidedAssistant(), makeOrganization("AU"), "");
    assert.ok(prompt.includes("000"), "AU prompt should reference 000");
    assert.ok(!prompt.includes("911"), "AU prompt must never reference 911");
  });

  it("uses 911 for a US organization", () => {
    const prompt = buildSystemPrompt(guidedAssistant(), makeOrganization("US"), "");
    assert.ok(prompt.includes("911"), "US prompt should reference 911");
    assert.ok(!prompt.includes("000"), "US prompt must never reference 000");
  });

  it("defaults to 911 when the organization has no country", () => {
    const prompt = buildSystemPrompt(guidedAssistant(), makeOrganization(undefined), "");
    assert.ok(prompt.includes("911"), "missing country should fall back to 911");
    assert.ok(!prompt.includes("000"), "missing country must not emit 000");
  });

  it("is case-insensitive for the country code", () => {
    const prompt = buildSystemPrompt(guidedAssistant(), makeOrganization("au"), "");
    assert.ok(prompt.includes("000"), "lowercase 'au' should still resolve to 000");
    assert.ok(!prompt.includes("911"), "lowercase 'au' must not emit 911");
  });
});

describe("emergency number is country-aware (legacy prompt path)", () => {
  it("uses 000 for an AU organization", () => {
    const prompt = buildSystemPrompt(legacyAssistant(), makeOrganization("AU"), "");
    assert.ok(prompt.includes("000"), "AU legacy prompt should reference 000");
    assert.ok(!prompt.includes("911"), "AU legacy prompt must never reference 911");
  });

  it("uses 911 for a US organization (regression: legacy path hardcoded 000)", () => {
    const prompt = buildSystemPrompt(legacyAssistant(), makeOrganization("US"), "");
    assert.ok(prompt.includes("911"), "US legacy prompt should reference 911");
    assert.ok(!prompt.includes("000"), "US legacy prompt must never reference 000");
  });

  it("defaults to 911 when the organization has no country", () => {
    const prompt = buildSystemPrompt(legacyAssistant(), makeOrganization(undefined), "");
    assert.ok(prompt.includes("911"), "missing country should fall back to 911");
    assert.ok(!prompt.includes("000"), "missing country must not emit 000");
  });
});
