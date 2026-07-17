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

  test("same slot booked to a DIFFERENT practitioner: a second same-first-name PERSON is never renamed", () => {
    // "John Smith with Dr A" then "John Baker with Dr B" at the same instant —
    // the one legitimate two-people shape of the duplicate key. Renaming would
    // destroy attendee #1; the recoverable false-block is the accepted cost.
    const existing = { name: "John Smith", practitioner_id: "prac-a" };
    assert.strictEqual(
      classifyRebookAttempt(existing, { first_name: "John", last_name: "Baker", practitioner_id: "prac-b" }).kind,
      "duplicate"
    );
    // Same practitioner + different surname stays a correction.
    assert.strictEqual(
      classifyRebookAttempt(existing, { first_name: "John", last_name: "Baker", practitioner_id: "prac-a" }).kind,
      "name-correction"
    );
    // Missing practitioner ids fall back to the surname logic (older ledger entries).
    assert.strictEqual(
      classifyRebookAttempt({ name: "John Smith" }, { first_name: "John", last_name: "Baker" }).kind,
      "name-correction"
    );
  });

  test("message constants carry the load-bearing instructions", () => {
    assert.match(DUPLICATE_REBOOK_MESSAGE, /DO NOT call book_appointment again/);
    // SCRUM-561: this message is the guard's live steering at exactly the
    // incident moment (the model just improvised cancel+rebook to change the
    // doctor). It must route practitioner changes to reschedule_appointment,
    // not only time changes.
    assert.match(DUPLICATE_REBOOK_MESSAGE, /To change the TIME or the PRACTITIONER, call reschedule_appointment/);
    assert.match(DUPLICATE_REBOOK_MESSAGE, /pass practitioner_id for a practitioner change/);
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

  test("the cancel gate keys on the handler's SUCCESS FLAG, not message text — in BOTH pipelines", () => {
    // The old text heuristic matched every failure message ("I'm having
    // trouble cancelling…" contains neither "error" nor "not found"), so a
    // FAILED cancel cleared the ledger and told the model nothing was booked.
    const flagGates = (serverSrc.match(/typeof (result|toolResult)\.success === "boolean"/g) || []).length;
    assert.ok(flagGates >= 2, `expected the success-flag gate in both pipelines (got ${flagGates})`);
    const gatedNudges = (serverSrc.match(/&& cancelOk\)/g) || []).length;
    assert.ok(gatedNudges >= 2, `the nudge/clear must be guarded by cancelOk in both pipelines (got ${gatedNudges})`);
  });

  test("BOTH ledger entries record practitioner_id (the correction-vs-second-person discriminator)", () => {
    const fields = (serverSrc.match(/practitioner_id: (toolCall\.args|fnArgs)\.practitioner_id/g) || []).length;
    assert.ok(fields >= 2, `expected practitioner_id in both ledger set sites (got ${fields})`);
  });

  test("BOTH pipelines audit the correction outcome (post-call detectors + completion payloads)", () => {
    const audits = (serverSrc.match(/name: "book_appointment_corrected"/g) || []).length;
    assert.ok(audits >= 2, `expected the corrected-audit push in both pipelines (got ${audits})`);
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
