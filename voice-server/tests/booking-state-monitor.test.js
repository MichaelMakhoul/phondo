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
      /analysis\.finalBookingClaimed === true && netLiveOutcome\(s\.toolCallAudit \|\| \[\]\) === 0 && callStatus !== "failed"/,
      "the mismatch check is gone — or lost its guard and now double-fires/clobbers hallucinated_* reasons"
    );
    assert.match(
      serverSrc,
      /callStatus = "failed";\s*\n\s*endedReason = "booking-state-mismatch";/,
      "a mismatch must fail the call record (the human-review queue keys on status), not just tag the reason"
    );
    // SCRUM-559 review: the classic pipeline needs audit parity or every
    // successful classic booking false-pages (empty audit = net-live 0).
    const auditPushes = (serverSrc.match(/session\.toolCallAudit\.push\(auditEntry\)/g) || []).length;
    assert.ok(auditPushes >= 2, `expected the identity-carrying audit push in BOTH pipelines (got ${auditPushes})`);
    assert.match(serverSrc, /negated\s*\n?\s*\? `CRITICAL ERROR: The appointment you booked earlier in this call was CANCELLED/,
      "the negated-booking nudge must state the truth (cancelled), not the false 'you did NOT call it' premise");
    assert.match(serverSrc, /SENTRY_REASONS\.BOOKING_STATE_MISMATCH/, "capture must use the registry constant");
    assert.equal(SENTRY_REASONS.BOOKING_STATE_MISMATCH, "booking-state-mismatch", "reason string is a Grafana alert contract");
    assert.match(serverSrc, /endedReason = "booking-state-mismatch"/, "the call record must carry the mismatch reason");
  });
});
