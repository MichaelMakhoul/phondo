"use strict";

/**
 * SCRUM-559 — server wiring pins for the booking-state monitor.
 *
 * The detectors are unit-tested; what only server.js decides is (a) the tool
 * digest actually reaches the analysis call, and (b) a finalBookingClaimed /
 * zero-net-live mismatch fails the call LOUDLY with the registered reason.
 * Deleting either leaves every suite green while the monitor silently
 * disappears — the exact blindness this ticket exists to remove.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const { SENTRY_REASONS } = require("../lib/sentry-reasons");

describe("SCRUM-559 — booking-state monitor wiring", () => {
  it("the post-call analysis receives the tool-outcome digest", () => {
    assert.match(
      serverSrc,
      /toolDigest: buildToolOutcomeDigest\(s\.toolCallAudit \|\| \[\]\)/,
      "analysis no longer sees tool ground truth — summaries will trust the transcript's claims again"
    );
  });

  it("finalBookingClaimed with zero net live outcome fails the call with the registered reason", () => {
    assert.match(
      serverSrc,
      /analysis\.finalBookingClaimed === true && netLiveOutcome\(s\.toolCallAudit \|\| \[\]\) === 0/,
      "the language-agnostic mismatch check is gone"
    );
    assert.match(serverSrc, /SENTRY_REASONS\.BOOKING_STATE_MISMATCH/, "capture must use the registry constant");
    assert.equal(SENTRY_REASONS.BOOKING_STATE_MISMATCH, "booking-state-mismatch", "reason string is a Grafana alert contract");
    assert.match(serverSrc, /endedReason = "booking-state-mismatch"/, "the call record must carry the mismatch reason");
  });
});
