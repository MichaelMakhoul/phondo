const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildSystemPrompt } = require("../lib/prompt-builder");

// SCRUM-319: flexibleBooking is read by buildPromptFromConfig as
// context.assistant?.settings?.flexibleBooking. buildSystemPrompt used to
// pass it under a flat `assistantSettings` key that nothing read, so the
// guided-prompt path ALWAYS emitted the STRICT booking instruction
// regardless of the setting. These tests pin the wiring end-to-end so the
// mismatch can't silently regress.

const FLEXIBLE_SNIPPET = "book them into the nearest available slot";
const STRICT_SNIPPET = "You can ONLY book into slots returned by check_availability";

function makeAssistant(flexibleBooking) {
  return {
    language: "en",
    settings: { flexibleBooking },
    // promptConfig present → buildSystemPrompt delegates to buildPromptFromConfig.
    promptConfig: { tone: "friendly", fields: [], behaviors: [] },
  };
}

const organization = {
  name: "Acme Dental",
  industry: "dental",
  timezone: "Australia/Sydney",
  businessHours: {},
  defaultAppointmentDuration: 30,
};

describe("buildSystemPrompt — flexibleBooking wiring (SCRUM-319)", () => {
  it("emits the FLEXIBLE booking instruction when assistant.settings.flexibleBooking is true", () => {
    const prompt = buildSystemPrompt(makeAssistant(true), organization, "", { calendarEnabled: true });
    assert.ok(prompt.includes(FLEXIBLE_SNIPPET), "should contain the flexible-booking instruction");
    assert.ok(!prompt.includes(STRICT_SNIPPET), "should NOT contain the strict instruction");
  });

  it("emits the STRICT booking instruction when flexibleBooking is false", () => {
    const prompt = buildSystemPrompt(makeAssistant(false), organization, "", { calendarEnabled: true });
    assert.ok(prompt.includes(STRICT_SNIPPET), "should contain the strict instruction");
    assert.ok(!prompt.includes(FLEXIBLE_SNIPPET), "should NOT contain the flexible instruction");
  });

  it("falls back to the STRICT instruction when settings is absent (fail-safe default)", () => {
    // The optional chain (context.assistant?.settings?.flexibleBooking) must
    // resolve undefined → strict, never throw — pins the fail-safe direction.
    const assistant = { language: "en", promptConfig: { tone: "friendly", fields: [], behaviors: [] } };
    const prompt = buildSystemPrompt(assistant, organization, "", { calendarEnabled: true });
    assert.ok(prompt.includes(STRICT_SNIPPET), "no settings → strict instruction");
    assert.ok(!prompt.includes(FLEXIBLE_SNIPPET), "no settings → not flexible");
  });
});
