const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildSystemPrompt } = require("../lib/prompt-builder");

// The plumber demo persona ships as a static legacy prompt, set by the NEWEST
// migration that writes the demo trades assistant's system_prompt; the voice
// server wraps it at call time. Pin the ASSEMBLED prompt for the demo org: its
// 00105 seed hours (Mon-Fri 9-5) make calendarEnabled true, so the calendar
// tools and the scheduling block (never guess availability, never promise a
// text, read back then "Is everything correct?", end_call on yes) ride along on
// every demo call, browser and phone. The persona must agree with them.
const migrationsDir = path.join(__dirname, "../../supabase/migrations");
const personaFile = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => {
    const sql = fs.readFileSync(path.join(migrationsDir, f), "utf8");
    return sql.includes("WHERE id = 'd0000000-0000-4000-a000-000000000030'") && sql.includes("system_prompt = $prompt$");
  })
  .pop();
const migration = fs.readFileSync(path.join(migrationsDir, personaFile), "utf8");
const persona = migration.match(/\$prompt\$([\s\S]*?)\$prompt\$/)[1];
const greeting = migration.match(/first_message = '((?:[^']|'')*)'/)[1].replace(/''/g, "'");
const hours = { open: "09:00", close: "17:00" };
const demoOrg = {
  name: "Phondo Demo",
  industry: "other",
  timezone: "Australia/Sydney",
  country: "AU",
  businessHours: { monday: hours, tuesday: hours, wednesday: hours, thursday: hours, friday: hours, saturday: null, sunday: null },
};
const assembled = buildSystemPrompt(
  { language: "en", systemPrompt: persona, promptConfig: null, settings: {} },
  demoOrg,
  "## Dental Practice FAQs\nQ: q\nA: a\n\n## Law Firm FAQs\nQ: q\nA: a",
  { calendarEnabled: true, transferRules: [], isAfterHours: false, afterHoursConfig: null, serviceTypes: [] }
);

describe("plumber demo persona, as assembled for the demo org", () => {
  it("keeps the photo ask, the no-transfer rule and the Phondo reveal", () => {
    assert.match(assembled, /Ask for a photo/);
    assert.match(assembled, /Never try to transfer the call/);
    assert.match(assembled, /this is a demo of Phondo/);
  });

  it("books through the attached calendar tools instead of scripting availability", () => {
    assert.match(assembled, /never guess availability/); // calendar tools are on for the demo org
    assert.match(persona, /scheduling tools/);
    assert.match(persona, /Only say it's booked once the booking has actually gone through/);
    assert.doesNotMatch(persona, /has a gap tomorrow|no real booking|7am/i);
  });

  it("quotes the same booking hours the appended scheduling block enforces", () => {
    assert.match(persona, /Monday to Friday, 9am to 5pm/);
  });

  it("never names the receptionist (the voice server forbids invented names)", () => {
    assert.doesNotMatch(greeting, /Chloe/);
    assert.doesNotMatch(persona, /Chloe/);
    assert.match(greeting, /virtual receptionist/);
  });

  it("pins the legacy prompt path: prompt_config is cleared", () => {
    assert.match(migration, /prompt_config = NULL/);
  });

  it("never promises a text: the appended block forbids it", () => {
    assert.match(assembled, /NEVER promise a confirmation text/);
    assert.doesNotMatch(persona, /will text/i);
  });

  it("asks for the last name book_appointment requires", () => {
    assert.match(persona, /first and last name/);
  });

  it("puts the Phondo reveal before 'Is everything correct?', so an end_call on yes can't swallow it", () => {
    const step6 = persona.slice(persona.indexOf("6. "));
    assert.ok(step6.indexOf("the demo line below") > -1, "step 6 must deliver the demo line");
    assert.ok(step6.indexOf("the demo line below") < step6.indexOf("Is everything correct?"));
  });
});
