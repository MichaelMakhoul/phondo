const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { bookingKey, normalizeName, normalizeDatetime } = require("../lib/booking-key");

// SCRUM-514. This key decides whether the model is re-booking a slot it already
// booked. Get it wrong in one direction and the caller is told their booking
// failed while it sits confirmed in the database (the bug that motivated this
// file). Get it wrong in the other and a second person on the same call is
// silently handed the first person's appointment.

describe("bookingKey — the same booking, however the model phrases it", () => {
  it("ignores a respelled surname (the real-call regression)", () => {
    const first = bookingKey({ datetime: "2026-06-10T14:00", first_name: "Nick", last_name: "Stamatopulos" });
    const retry = bookingKey({ datetime: "2026-06-10T14:00", first_name: "Nick", last_name: "STAMATOPOULOS" });
    assert.equal(first, retry);
  });

  it("ignores case and punctuation in the given name", () => {
    assert.equal(
      bookingKey({ datetime: "2026-06-10T14:00", first_name: "MARY-JANE" }),
      bookingKey({ datetime: "2026-06-10T14:00", first_name: "  mary jane " })
    );
  });

  it("collapses datetime spellings that mean the same instant", () => {
    const a = bookingKey({ datetime: "2026-06-10T04:00:00Z", first_name: "Nick" });
    const b = bookingKey({ datetime: "2026-06-10T14:00:00+10:00", first_name: "Nick" });
    assert.equal(a, b, "the same moment expressed in two zones is one slot");
  });

  it("ignores seconds", () => {
    assert.equal(
      bookingKey({ datetime: "2026-06-10T14:00:00Z", first_name: "Nick" }),
      bookingKey({ datetime: "2026-06-10T14:00:45Z", first_name: "Nick" })
    );
  });

  it("falls back to the literal when the datetime is unparseable", () => {
    // A bad key only costs a redundant round-trip; the DB constraint is the
    // real backstop. Throwing here would drop the call.
    const key = bookingKey({ datetime: "next tuesday-ish", first_name: "Nick" });
    assert.ok(key.startsWith("next tuesday-ish|"));
    assert.equal(key, bookingKey({ datetime: "Next Tuesday-ish", first_name: "nick" }));
  });

  it("reads the given name out of a legacy combined `name`", () => {
    assert.equal(
      bookingKey({ datetime: "2026-06-10T14:00", name: "Nick Stamatopulos" }),
      bookingKey({ datetime: "2026-06-10T14:00", first_name: "Nick", last_name: "Different" })
    );
  });
});

describe("bookingKey — genuinely different bookings stay different", () => {
  it("separates a second attendee at the same time", () => {
    assert.notEqual(
      bookingKey({ datetime: "2026-06-10T14:00", first_name: "Nick" }),
      bookingKey({ datetime: "2026-06-10T14:00", first_name: "Maria" })
    );
  });

  it("separates different times", () => {
    assert.notEqual(
      bookingKey({ datetime: "2026-06-10T14:00Z", first_name: "Nick" }),
      bookingKey({ datetime: "2026-06-10T14:30Z", first_name: "Nick" })
    );
  });

  it("does NOT split on practitioner, because the database cannot back that up", () => {
    // Tempting to key on practitioner (two practitioners really can be booked
    // at one time). But the overlap constraints live in two partial indexes
    // split on `practitioner_id IS NULL`, so a row with a practitioner and a
    // row without NEVER conflict. If the model named a practitioner on the
    // first call and omitted it on the re-book, a practitioner-keyed guard
    // would miss, no 23P01 would fire, and a silent duplicate appointment
    // would land in a real diary. This guard is the only defence there.
    assert.equal(
      bookingKey({ datetime: "2026-06-10T14:00", first_name: "Nick", practitioner_id: "p1" }),
      bookingKey({ datetime: "2026-06-10T14:00", first_name: "Nick" })
    );
    assert.equal(
      bookingKey({ datetime: "2026-06-10T14:00", first_name: "Nick", practitioner_id: "p1" }),
      bookingKey({ datetime: "2026-06-10T14:00", first_name: "Nick", practitioner_id: "p2" })
    );
  });
});

describe("bookingKey — degenerate input cannot throw", () => {
  it("survives no arguments at all", () => {
    assert.equal(typeof bookingKey(), "string");
    assert.equal(typeof bookingKey({}), "string");
  });

  it("survives null and non-string fields", () => {
    assert.equal(typeof bookingKey({ datetime: null, first_name: 42, name: undefined }), "string");
  });

  it("normalizes accented Latin names without stripping the letters", () => {
    assert.equal(normalizeName("José"), "josé");
    assert.equal(normalizeName("Müller-Schmidt"), "müllerschmidt");
  });

  it("normalizeDatetime returns an empty string for empty input", () => {
    assert.equal(normalizeDatetime(""), "");
    assert.equal(normalizeDatetime(undefined), "");
  });
});
