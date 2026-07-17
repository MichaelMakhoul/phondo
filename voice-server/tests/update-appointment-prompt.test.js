"use strict";

// SCRUM-558 — the correction tool must be DECLARED to the model and EXPLAINED
// in the prompt, in BOTH prompt paths, whenever scheduling is enabled.
// Without the prompt rule the model has no idea corrections have a sanctioned
// path and falls back to cancel+rebook or fabrication (the SCRUM-557 incident
// class). Functional: built through the public API, per the SCRUM-554 lesson
// (source regexes can't see a rule missing from one path).
//
// SCRUM-561 — a real call improvised cancel+rebook to change the doctor and
// round-robin re-assigned the SAME practitioner. The server machinery already
// supported practitioner changes (reschedule_appointment + practitioner_id);
// only the instructions were wrong, in THREE places: the read-back rule
// ("If wrong, cancel and rebook"), the pre-SCRUM-425 staff rules (forbade
// specific-practitioner engagement), and — loudest of all — the live-schedule
// CRITICAL section, which commanded "you must cancel and rebook". Each surface
// is pinned here, per prompt path, plus negations against the stale text.

const { test, describe } = require("node:test");
const assert = require("node:assert");

const { buildSystemPrompt, buildLiveScheduleSection } = require("../lib/prompt-builder");
const { calendarToolDefinitions } = require("../services/tool-executor");

const org = {
  name: "Acme Dental",
  industry: "dental",
  timezone: "Australia/Sydney",
  country: "AU",
  businessHours: {},
  defaultAppointmentDuration: 30,
};

const SERVICE_TYPES = [{ id: "st-1", name: "Consultation", duration_minutes: 30 }];

function buildBoth(options) {
  return {
    structured: buildSystemPrompt(
      { language: "en", promptConfig: { tone: "friendly", fields: [], behaviors: {} } },
      org, "", options
    ),
    legacy: buildSystemPrompt(
      { language: "en", systemPrompt: "You are the receptionist for {business_name}." },
      org, "", options
    ),
  };
}

describe("SCRUM-558 — update_appointment prompt + declaration", () => {
  const prompts = buildBoth({ calendarEnabled: true });

  for (const [name, prompt] of Object.entries(prompts)) {
    test(`${name} prompt: explains update_appointment and forbids cancel+rebook corrections`, () => {
      assert.ok(prompt.includes("update_appointment:"), `${name}: correction tool missing from the scheduling section`);
      assert.match(prompt, /NEVER cancel and re-book to fix a detail/i, `${name}: anti-cancel+rebook rule missing`);
      assert.match(prompt, /cannot change the TIME or the PRACTITIONER \(use reschedule_appointment for both\)/i, `${name}: time+practitioner exclusion missing`);
    });

    // SCRUM-561: the read-back rule was the first incident driver — it told
    // the model to cancel+rebook whenever the caller flagged a mistake.
    test(`${name} prompt: read-back routes corrections to the right tool, never cancel+rebook`, () => {
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
    // SCRUM-561: the practitioner exclusion must survive on the declaration
    // too — losing it routes practitioner changes to the wrong tool.
    assert.match(
      def.function.description,
      /CANNOT change the appointment time or the practitioner \(use reschedule_appointment for both\)/i,
      "declaration must route practitioner changes to reschedule"
    );
  });
});

describe("SCRUM-561 — practitioner-change rules (service-types branch)", () => {
  const prompts = buildBoth({ calendarEnabled: true, serviceTypes: SERVICE_TYPES });

  for (const [name, prompt] of Object.entries(prompts)) {
    test(`${name} prompt: practitioner changes route to reschedule_appointment, never cancel+rebook`, () => {
      assert.match(prompt, /CHANGING THE PRACTITIONER \/ DOCTOR on an existing appointment: use reschedule_appointment with the new practitioner_id/, `${name}: practitioner-change rule missing`);
      assert.match(prompt, /set new_datetime to the appointment's CURRENT time if only the practitioner changes/, `${name}: same-time practitioner change instruction missing`);
      assert.match(prompt, /NEVER cancel and re-book to change who the caller sees/, `${name}: anti-cancel+rebook rule for practitioner changes missing`);
    });

    // The pre-SCRUM-425 staff rules forbade engaging with specific-practitioner
    // requests at all — contradicting the tool schemas and the snapshot section.
    test(`${name} prompt: staff rules match the real named-practitioner capability`, () => {
      assert.match(prompt, /pass that practitioner's ID as practitioner_id to check_availability .*AND to book_appointment/, `${name}: named-practitioner booking instruction missing`);
      assert.ok(!/do NOT promise to book with that person/.test(prompt), `${name}: the stale never-promise-a-practitioner rule is back`);
      assert.match(prompt, /NEVER guess or make up practitioner names or IDs/, `${name}: anti-fabrication staff rule missing`);
    });
  }

  test("no service types → no practitioner-change rule, honest plan limitation instead", () => {
    const prompts = buildBoth({ calendarEnabled: true });
    for (const [name, prompt] of Object.entries(prompts)) {
      assert.ok(!prompt.includes("CHANGING THE PRACTITIONER"), `${name}: practitioner-change rule must be service-types-gated (contradicts the plan-limitation line otherwise)`);
      assert.match(prompt, /specific practitioner booking is not available on this plan/, `${name}: plan-limitation staff line missing`);
    }
  });
});

describe("SCRUM-561 — live-schedule CRITICAL section routes changes atomically", () => {
  // The loudest incident driver: this section is appended AFTER the base rules
  // for exactly the orgs with practitioners, and commanded "lookup → cancel →
  // book … you must cancel and rebook" for reschedules AND practitioner
  // changes. Built through the public API with a minimal snapshot.
  const section = buildLiveScheduleSection(
    { timezone: "Australia/Sydney", slots: { "2026-07-17": ["2026-07-17T09:00:00"] } },
    "2026-07-17"
  );

  test("reschedules and practitioner changes go through reschedule_appointment", () => {
    assert.ok(section.length > 0, "minimal snapshot must produce the section");
    assert.match(section, /Rescheduling = reschedule_appointment/, "atomic reschedule routing missing from the live section");
    assert.match(section, /Changing the practitioner on an existing booking = reschedule_appointment with the new practitioner_id/, "practitioner-change routing missing from the live section");
    assert.match(section, /set new_datetime to the appointment's CURRENT time if only the practitioner changes/, "same-time instruction missing from the live section");
  });

  test("the cancel+rebook commands that caused the incident are gone", () => {
    assert.ok(!/you must cancel and rebook/.test(section), "the incident-causing command is back");
    assert.ok(!/lookup_appointment THEN cancel_appointment THEN book_appointment/.test(section), "the three-step cancel+book reschedule flow is back");
    assert.match(section, /NEVER move an appointment with cancel_appointment \+ book_appointment/, "anti-cancel+book rule missing");
    assert.match(section, /NEVER cancel and rebook — a fresh booking auto-assigns and can land on the SAME practitioner again/, "practitioner-change anti-cancel+rebook rationale missing");
  });
});
