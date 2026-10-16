"use strict";

// SCRUM-593 — one "now" wording for get_current_datetime, the Tier-2 checker
// and the booking pre-check, so all three resolve "today"/"tomorrow" alike.

// services/tool-executor captures its env (INTERNAL_API_URL/SECRET) at load, so
// set it before ANY require — as every other suite that loads it does.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";
process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { nowLine, safeNowLine } = require("../lib/now-line");
const { _test } = require("../services/tool-executor");

// Depending on the ICU build (CI runs Node 20) the space before AM/PM is U+0020, U+202F
// (narrow no-break) or U+00A0. The production line is whatever Intl gives; the tests compare
// it after normalising that one character.
const norm = (/** @type {string} */ s) => s.replace(/[\u202f\u00a0]/g, " ");

describe("nowLine", () => {
  it("words the business's local date and time like get_current_datetime", () => {
    // 2026-10-14T10:56Z = Wednesday 9:56 PM in Sydney (AEDT, UTC+11).
    assert.equal(
      norm(nowLine("Australia/Sydney", new Date("2026-10-14T10:56:00Z"))),
      "Current date and time: Wednesday, October 14, 2026, 09:56 PM (Australia/Sydney). Today's date in YYYY-MM-DD format: 2026-10-14."
    );
  });

  it("follows the zone, not the server clock", () => {
    assert.equal(
      norm(nowLine("America/New_York", new Date("2026-10-14T10:56:00Z"))),
      "Current date and time: Wednesday, October 14, 2026, 06:56 AM (America/New_York). Today's date in YYYY-MM-DD format: 2026-10-14."
    );
  });

  it("is what get_current_datetime returns", () => {
    const { message } = _test.resolveCurrentDatetime("Australia/Sydney");
    assert.match(
      message,
      /^Current date and time: [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}, \d{2}:\d{2}\s(AM|PM) \(Australia\/Sydney\)\. Today's date in YYYY-MM-DD format: \d{4}-\d{2}-\d{2}\.$/
    );
  });
});

describe("nowLine across midnight — the date follows the business, not the server", () => {
  // The cases above land on the same calendar date in UTC, Sydney and New York,
  // so they cannot tell a date taken from the zone from one taken from the
  // server clock (UTC on Fly). These straddle midnight on purpose.
  it("is already Thursday in Sydney while UTC and New York are still on Wednesday", () => {
    // 2026-10-14T21:30Z = Thursday 15 Oct 8:30 AM in Sydney (AEDT, UTC+11).
    assert.equal(
      norm(nowLine("Australia/Sydney", new Date("2026-10-14T21:30:00Z"))),
      "Current date and time: Thursday, October 15, 2026, 08:30 AM (Australia/Sydney). Today's date in YYYY-MM-DD format: 2026-10-15."
    );
  });

  it("is still Tuesday in New York while UTC and Sydney are already on Wednesday", () => {
    // 2026-10-14T02:00Z = Tuesday 13 Oct 10:00 PM in New York (EDT, UTC-4).
    assert.equal(
      norm(nowLine("America/New_York", new Date("2026-10-14T02:00:00Z"))),
      "Current date and time: Tuesday, October 13, 2026, 10:00 PM (America/New_York). Today's date in YYYY-MM-DD format: 2026-10-13."
    );
  });
});

describe("safeNowLine", () => {
  const AT = new Date("2026-10-14T10:56:00Z");
  const SYDNEY_LINE = nowLine("Australia/Sydney", AT);
  // A bad zone now warns (SF-L1, below); keep this suite's output clean.
  const realWarn = console.warn;
  beforeEach(() => { console.warn = () => {}; });
  afterEach(() => { console.warn = realWarn; });

  for (const [what, zone] of [
    ["a malformed zone", "Not/AZone"],
    ["an abbreviation that is not an IANA zone", "AEST"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
  ]) {
    it(`gives the Sydney line for ${what}, instead of throwing`, () => {
      assert.equal(safeNowLine(zone, AT), SYDNEY_LINE);
    });
  }

  it("passes a valid zone straight through", () => {
    assert.equal(safeNowLine("America/New_York", AT), nowLine("America/New_York", AT));
    assert.match(safeNowLine("America/New_York", AT), /\(America\/New_York\)/);
  });
});

// SF-L1: a malformed org timezone used to fall back to Sydney in silence, so an org whose data was broken
// got "today"/"tomorrow" judged against Sydney's date with nothing in the logs. It warns once per distinct
// bad value (not per check), echoed JSON-quoted, bracket-stripped and capped.
describe("safeNowLine warns about a bad org timezone", () => {
  const AT = new Date("2026-10-14T10:56:00Z");
  let warnings = [];
  const realWarn = console.warn;
  /** A fresh module: the "already warned" memory is per process. */
  const fresh = () => {
    delete require.cache[require.resolve("../lib/now-line")];
    return require("../lib/now-line");
  };
  beforeEach(() => {
    warnings = [];
    console.warn = (...a) => warnings.push(a.join(" "));
  });
  afterEach(() => {
    console.warn = realWarn;
  });

  it("once for a repeated bad zone, then once more for a second one", () => {
    const { safeNowLine: safe } = fresh();
    for (let i = 0; i < 3; i++) safe("Not/AZone", AT);
    assert.deepEqual(warnings, ['[NowLine] org timezone "Not/AZone" is not a valid IANA zone — using Australia/Sydney']);
    safe("AEST", AT);
    safe("Not/AZone", AT);
    assert.deepEqual(warnings, [
      '[NowLine] org timezone "Not/AZone" is not a valid IANA zone — using Australia/Sydney',
      '[NowLine] org timezone "AEST" is not a valid IANA zone — using Australia/Sydney',
    ]);
  });

  it("never for a valid or a missing zone", () => {
    const { safeNowLine: safe } = fresh();
    for (const zone of ["America/New_York", "Australia/Sydney", "", null, undefined]) safe(zone, AT);
    assert.deepEqual(warnings, []);
  });

  it("echoes the value on one line, bracket-stripped and capped at 60 characters", () => {
    const { safeNowLine: safe } = fresh();
    safe("[ALERT:error]\nBad/Zone" + "x".repeat(80), AT);
    assert.equal(warnings.length, 1);
    const shown = /org timezone (.*) is not a valid IANA zone/.exec(warnings[0])[1];
    assert.equal(shown.length, 60);
    assert.ok(shown.startsWith('"ALERT:error\\nBad/Zone'), shown);
    assert.doesNotMatch(shown, /[[\]\n]/, "no bracket or line break in the echo");
  });
});
