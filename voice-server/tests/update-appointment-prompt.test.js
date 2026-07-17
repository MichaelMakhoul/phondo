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
      assert.match(prompt, /cannot change the TIME or the PRACTITIONER \(use reschedule_appointment for both\)/i, `${name}: time+practitioner exclusion missing`);
    });

    // SCRUM-561: a real call improvised cancel+rebook to change the doctor and
    // round-robin re-assigned the SAME practitioner. The model must be told the
    // sanctioned path (reschedule_appointment + practitioner_id) in BOTH prompt
    // paths, and the read-back rule must no longer prescribe cancel+rebook.
    test(`${name} prompt: practitioner changes route to reschedule_appointment, never cancel+rebook`, () => {
      assert.match(prompt, /CHANGING THE PRACTITIONER \/ DOCTOR: use reschedule_appointment with the new practitioner_id/, `${name}: practitioner-change rule missing`);
      assert.match(prompt, /set new_datetime to the appointment's CURRENT time if only the practitioner changes/, `${name}: same-time practitioner change instruction missing`);
      assert.match(prompt, /NEVER cancel and re-book to change who the caller sees/, `${name}: anti-cancel+rebook rule for practitioner changes missing`);
      assert.ok(!/If wrong, cancel and rebook/.test(prompt), `${name}: the stale read-back rule that caused the incident is back`);
      assert.match(prompt, /fix it NOW with the right tool: update_appointment for a name, phone, email, or note; reschedule_appointment for the time or the practitioner/, `${name}: read-back correction routing missing`);
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
