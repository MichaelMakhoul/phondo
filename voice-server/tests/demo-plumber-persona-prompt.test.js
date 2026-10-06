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
    return sql.includes("'d0000000-0000-4000-a000-000000000030'") && /system_prompt\s*=/.test(sql);
  })
  .pop();
const migration = fs.readFileSync(path.join(migrationsDir, personaFile), "utf8");
// Every persona migration must quote the prompt with $prompt$, or the match
// below would silently pin stale text from an older file.
assert.ok(migration.includes("system_prompt = $prompt$"), `${personaFile} must quote the persona with $prompt$`);
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

  it("gives the published phone line's assistant the IDENTICAL persona in the same statement", () => {
    // (02) 3820 5672 answers via its own org's assistant (41537e3b…); one UPDATE
    // for both rows means the phone and browser demos can never drift apart.
    assert.match(
      migration,
      /WHERE id IN \('d0000000-0000-4000-a000-000000000030', '41537e3b-6ff2-40c0-b2ff-2da327467d68'\)/
    );
    assert.equal((migration.match(/\$prompt\$/g) || []).length, 2, "exactly one persona text in the migration");
  });

  it("pins the legacy prompt path: prompt_config is cleared", () => {
    assert.match(migration, /prompt_config = NULL/);
  });

  it("never mentions texting: the appended block forbids promising one, and Tier-2 flags unbacked claims", () => {
    assert.match(assembled, /NEVER promise a confirmation text/);
    assert.doesNotMatch(persona, /\btext\b/i);
  });

  it("a message-only call never claims a booking", () => {
    // On the phone path a "yes" to "Is everything correct?" becomes "You're all
    // set!" + end_call(booking_complete); without a booking that's a phantom.
    assert.match(persona, /If you took a message with schedule_callback instead/);
    assert.match(persona, /Never say "you're all set", or that anything is booked or confirmed, unless book_appointment succeeded/);
  });

  it("asks for the last name book_appointment requires", () => {
    assert.match(persona, /first and last name/);
  });

  it("gives the Phondo reveal mid-call: before any tool call, never in the end_call reply", () => {
    // Phone path: the closing reply is goodbye + end_call in one response, with
    // a drain sized for one brief phrase, so a reveal there gets cut off and the
    // caller can't ask about Phondo. The turn right after a booking/callback
    // result is audited by Tier-2. The reveal goes between the photo ask and
    // booking, as its own reply ending on a question.
    const reveal = persona.indexOf("Then give the demo line below as its own reply");
    assert.ok(reveal > -1, "step 5 must deliver the demo line");
    assert.ok(reveal < persona.indexOf("6. Book the visit"), "reveal before any tool call");
    const close = persona.slice(persona.indexOf("7. Close the call"), persona.indexOf("THE DEMO LINE"));
    assert.doesNotMatch(close, /demo line/, "the closing reply must not carry the reveal");
    assert.match(persona, /Want me to find you a time\?/);
  });

  it("ends a message-only call as a message, never as booking_complete", () => {
    // call-session.js hasUnfinishedBooking blocks end_call(reason 'booking_complete')
    // when no booking resolved; the appended blocks default every goodbye to it.
    assert.match(persona, /end the call with reason "message taken" \(never "booking_complete"\)/);
    assert.match(persona, /An urgent job is a message for Dave, not a booking/);
    assert.match(persona, /don't go on to book a visit unless they ask/);
  });
});
