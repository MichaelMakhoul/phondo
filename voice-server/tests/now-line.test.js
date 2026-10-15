"use strict";

// SCRUM-593 — one "now" wording for get_current_datetime, the Tier-2 checker
// and the booking pre-check, so all three resolve "today"/"tomorrow" alike.

// services/tool-executor captures its env (INTERNAL_API_URL/SECRET) at load, so
// set it before ANY require — as every other suite that loads it does.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";
process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { nowLine } = require("../lib/now-line");
const { _test } = require("../services/tool-executor");

describe("nowLine", () => {
  it("words the business's local date and time like get_current_datetime", () => {
    // 2026-10-14T10:56Z = Wednesday 9:56 PM in Sydney (AEDT, UTC+11).
    assert.equal(
      nowLine("Australia/Sydney", new Date("2026-10-14T10:56:00Z")),
      "Current date and time: Wednesday, October 14, 2026, 09:56 PM (Australia/Sydney). Today's date in YYYY-MM-DD format: 2026-10-14."
    );
  });

  it("follows the zone, not the server clock", () => {
    assert.equal(
      nowLine("America/New_York", new Date("2026-10-14T10:56:00Z")),
      "Current date and time: Wednesday, October 14, 2026, 06:56 AM (America/New_York). Today's date in YYYY-MM-DD format: 2026-10-14."
    );
  });

  it("is what get_current_datetime returns", () => {
    const { message } = _test.resolveCurrentDatetime("Australia/Sydney");
    assert.match(
      message,
      /^Current date and time: [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}, \d{2}:\d{2} (AM|PM) \(Australia\/Sydney\)\. Today's date in YYYY-MM-DD format: \d{4}-\d{2}-\d{2}\.$/
    );
  });
});
