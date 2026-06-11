const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getBusinessDates,
  generateTimeSlots,
  loadScheduleSnapshot,
  _test: { getTimeComponents, localToUtcIso },
} = require("../lib/call-context");

// ─── getTimeComponents ──────────────────────────────────────────────────────

describe("getTimeComponents", () => {
  it("returns correct hours/minutes for a known UTC date in Australia/Sydney", () => {
    // 2026-04-12T00:00:00Z = 2026-04-12T10:00:00 AEST (UTC+10, no DST in April)
    const date = new Date("2026-04-12T00:00:00Z");
    const result = getTimeComponents(date, "Australia/Sydney");
    assert.equal(result.hours, 10);
    assert.equal(result.minutes, 0);
  });

  it("returns correct hours/minutes for America/New_York", () => {
    // 2026-07-15T18:30:00Z = 2026-07-15T14:30:00 EDT (UTC-4 in July)
    const date = new Date("2026-07-15T18:30:00Z");
    const result = getTimeComponents(date, "America/New_York");
    assert.equal(result.hours, 14);
    assert.equal(result.minutes, 30);
  });

  it("returns correct hours/minutes for UTC", () => {
    const date = new Date("2026-01-01T09:45:00Z");
    const result = getTimeComponents(date, "UTC");
    assert.equal(result.hours, 9);
    assert.equal(result.minutes, 45);
  });
});

// ─── getBusinessDates ───────────────────────────────────────────────────────

describe("getBusinessDates", () => {
  it("returns empty array when timezone is missing", () => {
    const result = getBusinessDates(null, { monday: { open: "09:00", close: "17:00" } });
    assert.deepEqual(result, []);
  });

  it("returns empty array when businessHours is missing", () => {
    const result = getBusinessDates("Australia/Sydney", null);
    assert.deepEqual(result, []);
  });

  it("returns empty array when businessHours is not an object", () => {
    const result = getBusinessDates("Australia/Sydney", "invalid");
    assert.deepEqual(result, []);
  });

  it("returns empty array when all days are closed", () => {
    const allClosed = {
      monday: { closed: true },
      tuesday: { closed: true },
      wednesday: { closed: true },
      thursday: { closed: true },
      friday: { closed: true },
      saturday: { closed: true },
      sunday: { closed: true },
    };
    const result = getBusinessDates("Australia/Sydney", allClosed, 7);
    assert.deepEqual(result, []);
  });

  it("skips days with closed: true", () => {
    // Only weekdays open
    const weekdaysOnly = {
      monday: { open: "09:00", close: "17:00" },
      tuesday: { open: "09:00", close: "17:00" },
      wednesday: { open: "09:00", close: "17:00" },
      thursday: { open: "09:00", close: "17:00" },
      friday: { open: "09:00", close: "17:00" },
      saturday: { closed: true },
      sunday: { closed: true },
    };
    const result = getBusinessDates("Australia/Sydney", weekdaysOnly, 5);
    assert.equal(result.length, 5);

    // Verify all dates are YYYY-MM-DD format
    for (const d of result) {
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("returns the correct count of business days", () => {
    const allDays = {
      monday: { open: "09:00", close: "17:00" },
      tuesday: { open: "09:00", close: "17:00" },
      wednesday: { open: "09:00", close: "17:00" },
      thursday: { open: "09:00", close: "17:00" },
      friday: { open: "09:00", close: "17:00" },
      saturday: { open: "10:00", close: "14:00" },
      sunday: { open: "10:00", close: "14:00" },
    };
    const result = getBusinessDates("America/New_York", allDays, 7);
    assert.equal(result.length, 7);
  });

  it("skips days with no open/close even if not marked closed", () => {
    const hours = {
      monday: { open: "09:00", close: "17:00" },
      tuesday: {}, // missing open/close
      wednesday: { open: "09:00", close: "17:00" },
    };
    const result = getBusinessDates("UTC", hours, 14);
    // Should never include a Tuesday
    for (const d of result) {
      const date = new Date(`${d}T12:00:00Z`);
      const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(date).toLowerCase();
      assert.notEqual(dayName, "tuesday");
    }
  });

  it("defaults to 7 business days when days param is omitted", () => {
    const allDays = {
      monday: { open: "09:00", close: "17:00" },
      tuesday: { open: "09:00", close: "17:00" },
      wednesday: { open: "09:00", close: "17:00" },
      thursday: { open: "09:00", close: "17:00" },
      friday: { open: "09:00", close: "17:00" },
      saturday: { open: "10:00", close: "14:00" },
      sunday: { open: "10:00", close: "14:00" },
    };
    const result = getBusinessDates("UTC", allDays);
    assert.equal(result.length, 7);
  });
});

// ─── generateTimeSlots ──────────────────────────────────────────────────────

describe("generateTimeSlots", () => {
  it("generates 30-min slots: 9:00-12:00 = 6 slots", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "12:00", 30);
    assert.equal(slots.length, 6);
    assert.deepEqual(slots, [
      "2026-04-12T09:00:00",
      "2026-04-12T09:30:00",
      "2026-04-12T10:00:00",
      "2026-04-12T10:30:00",
      "2026-04-12T11:00:00",
      "2026-04-12T11:30:00",
    ]);
  });

  it("generates 45-min slots: 9:00-12:00 = 4 slots", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "12:00", 45);
    assert.equal(slots.length, 4);
    assert.deepEqual(slots, [
      "2026-04-12T09:00:00",
      "2026-04-12T09:45:00",
      "2026-04-12T10:30:00",
      "2026-04-12T11:15:00",
    ]);
  });

  it("generates 60-min slots: 9:00-12:00 = 3 slots", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "12:00", 60);
    assert.equal(slots.length, 3);
    assert.deepEqual(slots, [
      "2026-04-12T09:00:00",
      "2026-04-12T10:00:00",
      "2026-04-12T11:00:00",
    ]);
  });

  it("returns empty for zero-width window (open === close)", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "09:00", 30);
    assert.deepEqual(slots, []);
  });

  it("returns empty when duration exceeds window", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "09:15", 30);
    assert.deepEqual(slots, []);
  });

  it("returns empty for missing params", () => {
    assert.deepEqual(generateTimeSlots(null, "09:00", "17:00"), []);
    assert.deepEqual(generateTimeSlots("2026-04-12", null, "17:00"), []);
    assert.deepEqual(generateTimeSlots("2026-04-12", "09:00", null), []);
  });

  it("returns empty for malformed time strings", () => {
    assert.deepEqual(generateTimeSlots("2026-04-12", "abc", "17:00"), []);
    assert.deepEqual(generateTimeSlots("2026-04-12", "09:00", "xyz"), []);
  });

  it("uses correct ISO format (YYYY-MM-DDThh:mm:00)", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "10:00", 30);
    for (const slot of slots) {
      assert.match(slot, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
    }
  });

  it("defaults to 30-min duration when not specified", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "10:00");
    assert.equal(slots.length, 2);
  });

  it("handles non-hour-aligned open time", () => {
    const slots = generateTimeSlots("2026-04-12", "09:15", "10:15", 30);
    assert.deepEqual(slots, [
      "2026-04-12T09:15:00",
      "2026-04-12T09:45:00",
    ]);
  });
});

// ─── localToUtcIso (SCRUM-439, mirrors the SCRUM-416 ensureTimezoneOffset suite) ──
// All expected values are absolute UTC instants, so the suite pins correctness
// regardless of the TZ the test process runs under — the old code's answers
// changed with the server's local timezone (correct-by-accident when server TZ
// matched the org's, off by ±1h near DST transitions on UTC servers like Fly.io).

describe("localToUtcIso", () => {
  // ── Normal dates (no transition nearby) ────────────────────────────────

  it("converts UTC timezone with zero offset", () => {
    assert.equal(localToUtcIso("2026-06-15T12:00:00", "UTC"), "2026-06-15T12:00:00.000Z");
  });

  it("converts Australia/Sydney in winter (AEST +10)", () => {
    // July is winter in Australia
    assert.equal(localToUtcIso("2026-07-15T10:00:00", "Australia/Sydney"), "2026-07-15T00:00:00.000Z");
  });

  it("converts Australia/Sydney in summer (AEDT +11)", () => {
    // February is summer in Australia
    assert.equal(localToUtcIso("2026-02-18T10:00:00", "Australia/Sydney"), "2026-02-17T23:00:00.000Z");
  });

  it("converts America/New_York in winter (EST -5)", () => {
    assert.equal(localToUtcIso("2026-01-15T10:00:00", "America/New_York"), "2026-01-15T15:00:00.000Z");
  });

  it("converts America/New_York in summer (EDT -4)", () => {
    assert.equal(localToUtcIso("2026-07-15T10:00:00", "America/New_York"), "2026-07-15T14:00:00.000Z");
  });

  it("handles India (UTC+5:30) with half-hour offset", () => {
    assert.equal(localToUtcIso("2026-06-15T14:00:00", "Asia/Kolkata"), "2026-06-15T08:30:00.000Z");
  });

  // ── DST transitions (the SCRUM-439 regression cases) ───────────────────
  // The offset must reflect the TRUE local instant, not the naive-as-UTC instant
  // (which sits ~offset hours away and can fall on the wrong side of a DST jump).

  it("Sydney spring-forward: the evening BEFORE the jump is still +10 (old code: -1h on UTC servers)", () => {
    // Sydney DST starts 02:00 local Sun 4 Oct 2026 (+10 → +11), i.e. 16:00Z on
    // 3 Oct. A naive 8 PM the night before is pre-DST. The old code read the
    // offset at 2026-10-03T20:00Z (after the jump) and returned 09:00Z.
    assert.equal(localToUtcIso("2026-10-03T20:00:00", "Australia/Sydney"), "2026-10-03T10:00:00.000Z");
  });

  it("Sydney spring-forward: a time clearly AFTER the jump is +11", () => {
    assert.equal(localToUtcIso("2026-10-05T20:00:00", "Australia/Sydney"), "2026-10-05T09:00:00.000Z");
  });

  it("Sydney fall-back: the evening BEFORE the transition is still +11 (old code: +1h on UTC servers)", () => {
    // DST ends 03:00 local Sun 5 Apr 2026 (+11 → +10), i.e. 16:00Z on 4 Apr.
    // The old code read the offset at 2026-04-04T20:00Z (after) → 10:00Z.
    assert.equal(localToUtcIso("2026-04-04T20:00:00", "Australia/Sydney"), "2026-04-04T09:00:00.000Z");
  });

  it("Sydney fall-back: a time clearly AFTER the transition is +10", () => {
    assert.equal(localToUtcIso("2026-04-06T20:00:00", "Australia/Sydney"), "2026-04-06T10:00:00.000Z");
  });

  it("New York spring-forward: just AFTER the jump is -4 (genuine west-of-UTC near-transition guard)", () => {
    // DST starts 02:00 local Sun 8 Mar 2026 (-5 → -4), i.e. 07:00Z. 03:30 local
    // is just after the jump; the old code read the offset at 2026-03-08T03:30Z
    // (before 07:00Z) → -5 → 08:30Z.
    assert.equal(localToUtcIso("2026-03-08T03:30:00", "America/New_York"), "2026-03-08T07:30:00.000Z");
    assert.equal(localToUtcIso("2026-03-07T20:00:00", "America/New_York"), "2026-03-08T01:00:00.000Z");
  });

  it("New York fall-back: just AFTER the transition is -5", () => {
    // DST ends 02:00 local Sun 1 Nov 2026 (-4 → -5), i.e. 06:00Z. 02:30 local
    // is just after; the old code read the offset at 2026-11-01T02:30Z (before
    // 06:00Z) → -4 → 06:30Z.
    assert.equal(localToUtcIso("2026-11-01T02:30:00", "America/New_York"), "2026-11-01T07:30:00.000Z");
  });

  it("Lord Howe (the only half-hour DST): day before is +10:30, after is +11:00", () => {
    // Australia/Lord_Howe shifts +10:30 → +11:00 (spring-forward 02:00 Sun
    // 4 Oct 2026). Exercises the half-hour offset AND the DST iteration at once.
    assert.equal(localToUtcIso("2026-10-03T20:00:00", "Australia/Lord_Howe"), "2026-10-03T09:30:00.000Z");
    assert.equal(localToUtcIso("2026-10-05T20:00:00", "Australia/Lord_Howe"), "2026-10-05T09:00:00.000Z");
  });

  it("degenerate DST inputs resolve deterministically (gap → +11, overlap → +10)", () => {
    // Non-existent wall time (spring-forward GAP 02:00–03:00 Sydney): the
    // iteration oscillates and the 4-iteration cap lands on the post-jump offset.
    assert.equal(localToUtcIso("2026-10-04T02:30:00", "Australia/Sydney"), "2026-10-03T15:30:00.000Z");
    // Ambiguous wall time (fall-back OVERLAP 02:00–03:00 Sydney, occurs twice):
    // converges to the second (DST-off, +10) occurrence.
    assert.equal(localToUtcIso("2026-04-05T02:30:00", "Australia/Sydney"), "2026-04-04T16:30:00.000Z");
  });

  // ── Snapshot day boundaries (loadScheduleSnapshot's actual call shape) ──

  it("day boundaries on the Sydney spring-forward day span a 23-hour window", () => {
    // loadScheduleSnapshot queries [T00:00:00, T23:59:59]. On the transition
    // day, midnight is pre-jump (+10) and end-of-day post-jump (+11) — the old
    // code shifted the range start 1h early on UTC servers, leaking the prior
    // day's late appointments into the snapshot.
    assert.equal(localToUtcIso("2026-10-04T00:00:00", "Australia/Sydney"), "2026-10-03T14:00:00.000Z");
    assert.equal(localToUtcIso("2026-10-04T23:59:59", "Australia/Sydney"), "2026-10-04T12:59:59.000Z");
  });

  // ── Fallback and error behaviour ────────────────────────────────────────

  it("returns the current time for unparseable input (preserved fallback)", () => {
    const before = Date.now();
    const result = localToUtcIso("not-a-date", "Australia/Sydney");
    const after = Date.now();
    const ms = new Date(result).getTime();
    assert.ok(ms >= before && ms <= after, "fallback should be 'now'");
  });

  it("throws RangeError for an invalid IANA timezone", () => {
    assert.throws(() => localToUtcIso("2026-02-18T10:00:00", "Invalid/Timezone"), RangeError);
  });
});

// ─── loadScheduleSnapshot export ────────────────────────────────────────────

describe("loadScheduleSnapshot", () => {
  it("is exported as a function", () => {
    assert.equal(typeof loadScheduleSnapshot, "function");
  });
});
