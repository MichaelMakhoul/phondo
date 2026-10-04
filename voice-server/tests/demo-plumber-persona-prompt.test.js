const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildSystemPrompt } = require("../lib/prompt-builder");

// The plumber demo persona ships as a static legacy prompt (migration 00164);
// the voice server wraps it at call time. Pin the ASSEMBLED prompt for the demo
// org: its 00105 seed hours (Mon-Fri 9-5) make calendarEnabled true, so the
// calendar tools and their "never guess availability" rules ride along on every
// demo call, and the persona must agree with them rather than script fake slots.
const migration = fs.readFileSync(
  path.join(__dirname, "../../supabase/migrations/00164_demo_plumber_persona_fits_platform.sql"),
  "utf8"
);
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
});
