const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getBusinessDates,
  generateTimeSlots,
  loadScheduleSnapshot,
  _test: { getTimeComponents },
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

// ─── loadScheduleSnapshot export ────────────────────────────────────────────

describe("loadScheduleSnapshot", () => {
  it("is exported as a function", () => {
    assert.equal(typeof loadScheduleSnapshot, "function");
  });
});
