const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * SCRUM-563 — source-pin tests for the reschedule→ledger wiring (same idiom
 * as server-sentry-sites.test.js: the pipelines live inside a 4000-line
 * monolith that can't be required without live env, so we pin source text).
 *
 * What these guard against: the ledger move must run at BOTH server.js
 * pipeline sites (Gemini + classic) and in the ConversationRelay eval
 * pipeline. Dropping any one site silently reintroduces the bug this ticket
 * fixes — a stale confirmedBookings entry at the old time false-blocks a
 * legitimate re-book with "already booked... LOCKED" — and nothing else
 * would surface the drift (the guard "working" looks identical to it lying).
 */

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const crSrc = fs.readFileSync(path.join(__dirname, "..", "services", "conversationrelay.js"), "utf8");

describe("SCRUM-563: reschedule ledger-move wiring", () => {
  it("server.js imports applyRescheduleToLedger", () => {
    assert.match(src, /require\("\.\/lib\/reschedule-ledger"\)/);
  });

  it("both server.js pipelines (Gemini + classic) move the ledger", () => {
    const hits = src.match(/applyRescheduleToLedger\(session\.confirmedBookings/g) || [];
    assert.ok(hits.length >= 2, `expected ≥2 call sites (Gemini + classic), got ${hits.length}`);
  });

  it("every server.js move is gated on the reschedule succeeding", () => {
    // Each call site must sit directly inside an `if (rescheduleOk)` — a
    // failed reschedule changed nothing, so the ledger must not move.
    const gated = src.match(/if \(rescheduleOk\) \{[^]{0,400}?applyRescheduleToLedger\(session\.confirmedBookings/g) || [];
    assert.ok(gated.length >= 2, `expected ≥2 success-gated sites, got ${gated.length}`);
  });

  it("a successful reschedule also invalidates the schedule snapshot cache at both sites", () => {
    // book applies a cache delta and cancel invalidates, but reschedule used
    // to leave the pre-loaded availability stale on BOTH slots (old shown
    // taken, new shown free).
    const sites = src.match(/applyRescheduleToLedger\(session\.confirmedBookings[^]{0,1200}?scheduleCache\.invalidate\(session\.organizationId\)/g) || [];
    assert.ok(sites.length >= 2, `expected cache invalidation next to ≥2 ledger-move sites, got ${sites.length}`);
  });

  it("conversationrelay pipeline moves the ledger on a successful reschedule", () => {
    assert.match(crSrc, /require\("\.\.\/lib\/reschedule-ledger"\)/);
    assert.match(crSrc, /name === "reschedule_appointment" && successful[^]{0,300}?applyRescheduleToLedger\(session\.confirmedBookings/);
  });
});
