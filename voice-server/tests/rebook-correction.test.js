// SCRUM-557 — RebookGuard name-correction tests.
//
// Real call 2026-07-17: caller corrected a mis-heard surname, the guard
// blocked the corrected re-book as a "duplicate" (booking-key drops surnames
// by design, SCRUM-514), the model believed the guard's "already booked"
// reply meant the fix was done, and a follow-up cancel left the caller with
// ZERO appointments while being told "you're booked for 9am tomorrow".

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  classifyRebookAttempt,
  surnameFromLedgerName,
  DUPLICATE_REBOOK_MESSAGE,
  CORRECTION_ERROR_MESSAGE,
  CANCEL_NUDGE,
} = require("../lib/rebook-correction");

describe("SCRUM-557 — rebook classification", () => {
  test("the exact real-call sequence: 'Michael PL' → 'Michael Makhoul' is a NAME CORRECTION, never a duplicate", () => {
    const existing = { name: "Michael PL", datetime: "2026-07-18T09:00:00", code: "unknown" };
    const verdict = classifyRebookAttempt(existing, { first_name: "Michael", last_name: "Makhoul" });
    assert.strictEqual(verdict.kind, "name-correction");
  });

  test("SCRUM-514 stays protected: the SAME surname respelled (case/punctuation) is still a duplicate", () => {
    const existing = { name: "Sarah O'Neill", datetime: "2026-07-18T09:00:00" };
    for (const respelled of ["ONeill", "o'neill", "O NEILL"]) {
      assert.strictEqual(
        classifyRebookAttempt(existing, { first_name: "Sarah", last_name: respelled }).kind,
        "duplicate",
        `respelling "${respelled}" must not defeat the duplicate guard`
      );
    }
  });

  test("no surname supplied on the re-book = duplicate (the model second-guessing itself)", () => {
    const existing = { name: "Michael Makhoul" };
    assert.strictEqual(classifyRebookAttempt(existing, { first_name: "Michael" }).kind, "duplicate");
    assert.strictEqual(classifyRebookAttempt(existing, { first_name: "Michael", last_name: "" }).kind, "duplicate");
  });

  test("ledger entry had NO surname: a re-book that ADDS one is a correction (enrichment)", () => {
    const existing = { name: "Michael" };
    assert.strictEqual(
      classifyRebookAttempt(existing, { first_name: "Michael", last_name: "Makhoul" }).kind,
      "name-correction"
    );
  });

  test("multi-word surnames compare as a unit", () => {
    assert.strictEqual(surnameFromLedgerName("Maria de la Cruz"), "delacruz");
    const existing = { name: "Maria de la Cruz" };
    assert.strictEqual(
      classifyRebookAttempt(existing, { first_name: "Maria", last_name: "De La Cruz" }).kind,
      "duplicate"
    );
    assert.strictEqual(
      classifyRebookAttempt(existing, { first_name: "Maria", last_name: "Delgado" }).kind,
      "name-correction"
    );
  });

  test("message constants carry the load-bearing instructions", () => {
    assert.match(DUPLICATE_REBOOK_MESSAGE, /DO NOT call book_appointment again/);
    assert.match(CORRECTION_ERROR_MESSAGE, /do NOT cancel/i);
    assert.match(CORRECTION_ERROR_MESSAGE, /do NOT claim it was fixed/i);
    assert.match(CANCEL_NUDGE, /NO appointment from this call/);
    assert.match(CANCEL_NUDGE, /do NOT tell them anything is booked until it returns success/i);
  });
});

describe("SCRUM-557 — wiring pins (server.js + tool-executor)", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const executorSrc = fs.readFileSync(path.join(__dirname, "..", "services", "tool-executor.js"), "utf8");

  test("BOTH pipelines classify rebooks and run the in-place correction", () => {
    const classifyCalls = (serverSrc.match(/classifyRebookAttempt\(/g) || []).length;
    assert.ok(classifyCalls >= 2, `expected classification in both pipelines (got ${classifyCalls})`);
    const corrections = (serverSrc.match(/executeToolCall\("update_appointment_attendee"/g) || []).length;
    assert.ok(corrections >= 2, `expected the correction call in both pipelines (got ${corrections})`);
  });

  test("BOTH pipelines append the cancel nudge when clearing the booking ledger", () => {
    const nudges = (serverSrc.match(/\+= CANCEL_NUDGE/g) || []).length;
    assert.ok(nudges >= 2, `expected the cancel nudge in both pipelines (got ${nudges})`);
  });

  test("the ledger name is refreshed after a successful correction — in BOTH pipelines", () => {
    const ledgerSets = (serverSrc.match(/confirmedBookings\.set\(reqKey, \{\s*\.\.\.existing,/g) || []).length;
    assert.ok(ledgerSets >= 2, `ledger refresh must exist in both pipelines (got ${ledgerSets})`);
  });

  test("the correction only fires on the name-correction verdict — in BOTH pipelines", () => {
    const cmp = (serverSrc.match(/verdict\.kind === "name-correction"/g) || []).length;
    assert.ok(cmp >= 2, `expected the verdict comparison in both pipelines (got ${cmp})`);
  });

  test("BOTH pipelines key success on the NAME CORRECTED prefix (the real-handler contract)", () => {
    // Three parties share this contract: the real handler and the test-mode
    // simulator PRODUCE the prefix (pinned in their own suites), server.js
    // CONSUMES it. If the consumer key drifts, every real success counts as
    // failure: stale ledger + false Sentry alarms while the model relays success.
    const keys = (serverSrc.match(/startsWith\("NAME CORRECTED"\)/g) || []).length;
    assert.ok(keys >= 2, `expected the success-prefix key in both pipelines (got ${keys})`);
  });

  test("update_appointment_attendee routes to the internal API AND is simulated in test mode", () => {
    assert.match(executorSrc, /CALENDAR_FUNCTIONS = \[[^\]]*"update_appointment_attendee"/s, "missing from CALENDAR_FUNCTIONS");
    assert.match(executorSrc, /CALENDAR_WRITE_FUNCTIONS = \[[^\]]*"update_appointment_attendee"/s, "missing from CALENDAR_WRITE_FUNCTIONS — test calls would mutate REAL appointments");
    assert.match(executorSrc, /functionName === "update_appointment_attendee"/, "missing test-mode simulation branch");
  });

  test("the correction tool is NEVER exposed in the model's tool declarations", () => {
    // Tool definitions in the executor use `name: "<tool>"` — the correction
    // tool must not be declared there (only routed).
    assert.ok(
      !/name: "update_appointment_attendee"/.test(executorSrc),
      "update_appointment_attendee must not appear as a model-visible tool definition"
    );
  });
});
