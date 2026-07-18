const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { applyRescheduleToLedger, RESCHEDULE_SUCCESS_SIGNAL } = require("../lib/reschedule-ledger");
const { bookingKey } = require("../lib/booking-key");

/**
 * SCRUM-563 — session.confirmedBookings is written by book_appointment and
 * cleared by cancel_appointment, but reschedule_appointment used to leave the
 * ledger untouched: after a time-move the OLD slot's entry kept vouching for a
 * freed slot, so RebookGuard refused a legitimate re-book at the old time with
 * "already booked... LOCKED" for the rest of the call.
 *
 * applyRescheduleToLedger MOVES the entry: delete the old-instant key, insert
 * one keyed on the new datetime, carrying the confirmation code and updating
 * datetime / name / practitioner_id from the reschedule args.
 */

/** Seed a ledger the way the server.js book site does. */
function seedLedger(bookArgs, extra = {}) {
  const map = new Map();
  map.set(bookingKey(bookArgs), {
    code: "123456",
    datetime: bookArgs.datetime,
    name: `${bookArgs.first_name || ""} ${bookArgs.last_name || ""}`.trim(),
    practitioner_id: bookArgs.practitioner_id,
    at: 1000,
    ...extra,
  });
  return map;
}

describe("applyRescheduleToLedger — the move", () => {
  it("moves the entry from the old instant to the new datetime", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John", last_name: "Smith" });
    const res = applyRescheduleToLedger(
      map,
      { current_datetime: "2026-07-20T09:00:00", new_datetime: "2026-07-20T10:00:00" },
      2000,
    );

    assert.equal(res.moved, true);
    assert.equal(map.size, 1);
    // Old key gone — RebookGuard no longer vouches for the freed slot.
    assert.equal(map.get(bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "John" })), undefined);
    // New key present — a true duplicate book at the NEW time still blocks.
    const entry = map.get(bookingKey({ datetime: "2026-07-20T10:00:00", first_name: "John" }));
    assert.ok(entry, "entry must be reachable under the new-slot key");
    assert.equal(entry.code, "123456");
    assert.equal(entry.datetime, "2026-07-20T10:00:00");
    assert.equal(entry.name, "John Smith");
    assert.equal(entry.at, 2000);
  });

  it("matches the old instant across datetime formattings (seconds / offset variants)", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John" });
    const res = applyRescheduleToLedger(map, {
      current_datetime: "2026-07-20T09:00",
      new_datetime: "2026-07-21T09:00:00",
    });
    assert.equal(res.moved, true);
    assert.ok(map.get(bookingKey({ datetime: "2026-07-21T09:00:00", first_name: "John" })));

    // Offset vs Z spellings of the SAME instant also fold to one key.
    const map2 = seedLedger({ datetime: "2026-07-20T09:00:00+10:00", first_name: "John" });
    const res2 = applyRescheduleToLedger(map2, {
      current_datetime: "2026-07-19T23:00:00Z",
      new_datetime: "2026-07-21T09:00:00+10:00",
    });
    assert.equal(res2.moved, true);
    assert.ok(map2.get(bookingKey({ datetime: "2026-07-21T09:00:00+10:00", first_name: "John" })));
  });

  it("reports fromKey and toKey for call-site logging", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John" });
    const res = applyRescheduleToLedger(map, {
      current_datetime: "2026-07-20T09:00:00",
      new_datetime: "2026-07-20T10:00:00",
    });
    assert.equal(res.fromKey, bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "John" }));
    assert.equal(res.toKey, bookingKey({ datetime: "2026-07-20T10:00:00", first_name: "John" }));
  });

  it("same-time practitioner change updates practitioner_id under the same key (SCRUM-561 flow)", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John", practitioner_id: "prac-1" });
    const key = bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "John" });

    const res = applyRescheduleToLedger(map, {
      current_datetime: "2026-07-20T09:00:00",
      new_datetime: "2026-07-20T09:00:00",
      practitioner_id: "prac-2",
    });

    assert.equal(res.moved, true);
    assert.equal(map.size, 1);
    assert.equal(map.get(key).practitioner_id, "prac-2");
    assert.equal(map.get(key).code, "123456");
  });

  it("keeps the existing practitioner_id when the reschedule omits it", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John", practitioner_id: "prac-1" });
    applyRescheduleToLedger(map, {
      current_datetime: "2026-07-20T09:00:00",
      new_datetime: "2026-07-20T11:00:00",
    });
    const entry = map.get(bookingKey({ datetime: "2026-07-20T11:00:00", first_name: "John" }));
    assert.equal(entry.practitioner_id, "prac-1");
  });

  it("moves the single instant-matched entry even when the model respells the given name", () => {
    // SCRUM-514's lesson: names lie, the instant is the anchor. "Jon" vs the
    // booked "John" must not strand a stale entry at the old time.
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John", last_name: "Smith" });
    const res = applyRescheduleToLedger(map, {
      current_datetime: "2026-07-20T09:00:00",
      new_datetime: "2026-07-20T10:00:00",
      first_name: "Jon",
      last_name: "Smith",
    });
    assert.equal(res.moved, true);
    // New key follows the args' spelling — that's what a future duplicate
    // book_appointment from the model would carry.
    const entry = map.get(bookingKey({ datetime: "2026-07-20T10:00:00", first_name: "Jon" }));
    assert.ok(entry);
    assert.equal(entry.name, "Jon Smith");
  });

  it("updates only the given first_name and keeps the entry's last name when last_name is omitted", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John", last_name: "Smith" });
    applyRescheduleToLedger(map, {
      current_datetime: "2026-07-20T09:00:00",
      new_datetime: "2026-07-20T10:00:00",
      first_name: "Johnny",
    });
    const entry = map.get(bookingKey({ datetime: "2026-07-20T10:00:00", first_name: "Johnny" }));
    assert.equal(entry.name, "Johnny Smith");
  });
});

describe("applyRescheduleToLedger — disambiguation and no-ops", () => {
  it("with two entries at the same instant, a provided name moves only the matching one", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John", last_name: "Smith" });
    map.set(bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "Sarah" }), {
      code: "654321",
      datetime: "2026-07-20T09:00:00",
      name: "Sarah Smith",
      practitioner_id: "prac-2",
      at: 1500,
    });

    const res = applyRescheduleToLedger(map, {
      current_datetime: "2026-07-20T09:00:00",
      new_datetime: "2026-07-20T14:00:00",
      first_name: "Sarah",
    });

    assert.equal(res.moved, true);
    assert.equal(map.size, 2);
    assert.ok(map.get(bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "John" })), "John stays at 9am");
    assert.ok(map.get(bookingKey({ datetime: "2026-07-20T14:00:00", first_name: "Sarah" })), "Sarah moved to 2pm");
  });

  it("with two entries at the same instant and no name, moves nothing and flags ambiguity", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John" });
    map.set(bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "Sarah" }), { code: "654321", datetime: "2026-07-20T09:00:00", name: "Sarah", at: 1500 });

    const res = applyRescheduleToLedger(map, {
      current_datetime: "2026-07-20T09:00:00",
      new_datetime: "2026-07-20T14:00:00",
    });

    assert.equal(res.moved, false);
    assert.equal(res.ambiguous, true);
    assert.equal(map.size, 2);
    assert.ok(map.get(bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "John" })));
    assert.ok(map.get(bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "Sarah" })));
  });

  it("leaves the ledger untouched when the old instant matches nothing (prior-call appointment)", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John" });
    const res = applyRescheduleToLedger(map, {
      current_datetime: "2026-07-22T09:00:00",
      new_datetime: "2026-07-23T09:00:00",
    });
    assert.equal(res.moved, false);
    assert.equal(map.size, 1);
    assert.ok(map.get(bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "John" })));
  });

  it("no-ops on a missing or empty ledger", () => {
    assert.deepEqual(
      applyRescheduleToLedger(undefined, { current_datetime: "2026-07-20T09:00:00", new_datetime: "2026-07-20T10:00:00" }),
      { moved: false },
    );
    assert.deepEqual(
      applyRescheduleToLedger(new Map(), { current_datetime: "2026-07-20T09:00:00", new_datetime: "2026-07-20T10:00:00" }),
      { moved: false },
    );
  });

  it("no-ops when new_datetime is missing", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John" });
    const res = applyRescheduleToLedger(map, { current_datetime: "2026-07-20T09:00:00" });
    assert.equal(res.moved, false);
    assert.equal(map.size, 1);
  });

  it("no-ops when neither current_datetime nor current_date is given", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John" });
    const res = applyRescheduleToLedger(map, { new_datetime: "2026-07-20T10:00:00" });
    assert.equal(res.moved, false);
    assert.equal(map.size, 1);
  });
});

describe("applyRescheduleToLedger — current_date fallback", () => {
  it("matches by the entry's literal date when only current_date is given", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John" });
    const res = applyRescheduleToLedger(map, {
      current_date: "2026-07-20",
      new_datetime: "2026-07-21T10:00:00",
    });
    assert.equal(res.moved, true);
    assert.ok(map.get(bookingKey({ datetime: "2026-07-21T10:00:00", first_name: "John" })));
  });

  it("matches an offset datetime whose UTC date differs from the literal date (AU morning)", () => {
    // The key's date is UTC-shifted (2026-07-19T23:00) but current_date is
    // the org-local literal — the fallback must compare against the LITERAL
    // datetime the booking was made with, never the key. Under TZ=UTC (CI,
    // Fly) a key-based comparison passes every naive-datetime test and only
    // breaks for real AU callers.
    const booked = "2026-07-20T09:00:00+10:00";
    const map = new Map();
    map.set(bookingKey({ datetime: booked, first_name: "John" }), {
      code: "123456", datetime: booked, name: "John Smith", at: 1000,
    });

    const res = applyRescheduleToLedger(map, {
      current_date: "2026-07-20",
      new_datetime: "2026-07-21T10:00:00+10:00",
    });

    assert.equal(res.moved, true);
    assert.equal(map.size, 1);
    assert.ok(map.get(bookingKey({ datetime: "2026-07-21T10:00:00+10:00", first_name: "John" })));
  });

  it("with two same-day entries and no name, moves nothing", () => {
    const map = seedLedger({ datetime: "2026-07-20T09:00:00", first_name: "John" });
    map.set(bookingKey({ datetime: "2026-07-20T11:00:00", first_name: "John" }), { code: "654321", datetime: "2026-07-20T11:00:00", name: "John", at: 1500 });

    const res = applyRescheduleToLedger(map, { current_date: "2026-07-20", new_datetime: "2026-07-21T10:00:00" });
    assert.equal(res.moved, false);
    assert.equal(res.ambiguous, true);
    assert.equal(map.size, 2);
  });
});

describe("RESCHEDULE_SUCCESS_SIGNAL — the structured-less success gate", () => {
  it("admits the only structured-less success: the test-mode simulated message", () => {
    assert.ok(RESCHEDULE_SUCCESS_SIGNAL.test("Done — I've moved your appointment from 2026-07-20T09:00:00 to 2026-07-20T10:00:00."));
    assert.ok(RESCHEDULE_SUCCESS_SIGNAL.test("Done — I've moved your appointment to the new time."));
  });

  it("rejects every tool-executor infra-failure message (each audits as successful)", () => {
    // Verbatim from services/tool-executor.js — the three bare {message}
    // returns with no success/error field: missing config, internal-API
    // non-OK, fetch throw/timeout. If any of these ever matches, a failed
    // reschedule moves the ledger again.
    const infraFailures = [
      "I'm sorry, I'm unable to access the calendar system right now. Would you like me to take your information instead?",
      "I'm having trouble with that right now. Would you like me to take your information instead?",
      "I'm having a little trouble right now. Could you give me a moment?",
    ];
    for (const message of infraFailures) {
      assert.ok(!RESCHEDULE_SUCCESS_SIGNAL.test(message), `must reject: "${message}"`);
    }
  });
});

describe("applyRescheduleToLedger — ConversationRelay-shaped entries", () => {
  it("moves lean {code, at} entries via the key alone and preserves the given-name segment", () => {
    // conversationrelay.js stores entries without datetime/name; the key is
    // the only carrier of the instant + given name.
    const map = new Map();
    const fromKey = bookingKey({ datetime: "2026-07-20T09:00:00", first_name: "John" });
    map.set(fromKey, { code: "123456", at: 1000 });

    const res = applyRescheduleToLedger(map, {
      current_datetime: "2026-07-20T09:00:00",
      new_datetime: "2026-07-20T10:00:00",
    }, 2000);

    assert.equal(res.moved, true);
    const entry = map.get(bookingKey({ datetime: "2026-07-20T10:00:00", first_name: "John" }));
    assert.ok(entry, "moved entry keeps the original given-name key segment");
    assert.equal(entry.code, "123456");
    assert.equal(entry.at, 2000);
  });
});
