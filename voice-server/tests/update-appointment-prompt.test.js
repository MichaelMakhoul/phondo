"use strict";

// SCRUM-558 — the correction tool must be DECLARED to the model and EXPLAINED
// in the prompt, in BOTH prompt paths, whenever scheduling is enabled.
// Without the prompt rule the model has no idea corrections have a sanctioned
// path and falls back to cancel+rebook or fabrication (the SCRUM-557 incident
// class). Functional: built through the public API, per the SCRUM-554 lesson
// (source regexes can't see a rule missing from one path).

const { test, describe } = require("node:test");
const assert = require("node:assert");

const { buildSystemPrompt } = require("../lib/prompt-builder");
const { calendarToolDefinitions } = require("../services/tool-executor");

const org = {
  name: "Acme Dental",
  industry: "dental",
  timezone: "Australia/Sydney",
  country: "AU",
  businessHours: {},
  defaultAppointmentDuration: 30,
};

describe("SCRUM-558 — update_appointment prompt + declaration", () => {
  const prompts = {
    structured: buildSystemPrompt(
      { language: "en", promptConfig: { tone: "friendly", fields: [], behaviors: {} } },
      org, "", { calendarEnabled: true }
    ),
    legacy: buildSystemPrompt(
      { language: "en", systemPrompt: "You are the receptionist for {business_name}." },
      org, "", { calendarEnabled: true }
    ),
  };

  for (const [name, prompt] of Object.entries(prompts)) {
    test(`${name} prompt: explains update_appointment and forbids cancel+rebook corrections`, () => {
      assert.ok(prompt.includes("update_appointment:"), `${name}: correction tool missing from the scheduling section`);
      assert.match(prompt, /NEVER cancel and re-book to fix a detail/i, `${name}: anti-cancel+rebook rule missing`);
      assert.match(prompt, /cannot change the TIME \(use reschedule_appointment\)/i, `${name}: time exclusion missing`);
    });
  }

  test("no scheduling → no correction-tool guidance", () => {
    const prompt = buildSystemPrompt(
      { language: "en", promptConfig: { tone: "friendly", fields: [], behaviors: {} } },
      org, "", { calendarEnabled: false }
    );
    assert.ok(!prompt.includes("update_appointment:"), "correction guidance must be scheduling-gated");
  });

  test("update_appointment is DECLARED to the model (unlike the guard-internal attendee variant)", () => {
    const names = calendarToolDefinitions.map((d) => d.function && d.function.name);
    assert.ok(names.includes("update_appointment"), "model-facing declaration missing");
    assert.ok(!names.includes("update_appointment_attendee"), "the guard-internal variant must NOT be declared");
    const def = calendarToolDefinitions.find((d) => d.function.name === "update_appointment");
    assert.match(def.function.description, /THIS SAME CALL/i, "declaration must scope corrections to the current call");
    assert.match(def.function.description, /reschedule_appointment/, "declaration must route time changes to reschedule");
  });
});
