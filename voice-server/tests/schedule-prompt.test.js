const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildLiveScheduleSection } = require("../lib/prompt-builder");

function makeSnapshot(overrides = {}) {
  return {
    appointments: [],
    blockedTimes: [],
    practitioners: [{ id: "p1", name: "Dr Smith", serviceTypeIds: ["st1"] }],
    slots: {
      "2026-04-12": [
        "2026-04-12T09:00:00",
        "2026-04-12T09:30:00",
        "2026-04-12T10:00:00",
      ],
      "2026-04-13": [
        "2026-04-13T14:00:00",
        "2026-04-13T14:30:00",
      ],
      "2026-04-14": [
        "2026-04-14T08:00:00",
        "2026-04-14T08:30:00",
        "2026-04-14T09:00:00",
        "2026-04-14T09:30:00",
        "2026-04-14T10:00:00",
        "2026-04-14T10:30:00",
        "2026-04-14T11:00:00",
        "2026-04-14T11:30:00",
        "2026-04-14T13:00:00",
        "2026-04-14T13:30:00",
        "2026-04-14T14:00:00",
        "2026-04-14T14:30:00",
      ],
      "2026-04-15": [
        "2026-04-15T08:00:00",
        "2026-04-15T08:30:00",
        "2026-04-15T09:00:00",
        "2026-04-15T09:30:00",
        "2026-04-15T10:00:00",
        "2026-04-15T10:30:00",
        "2026-04-15T11:00:00",
        "2026-04-15T11:30:00",
      ],
      "2026-04-16": [],
    },
    serviceTypes: [{ id: "st1", name: "General Checkup", duration_minutes: 30 }],
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "09:00", close: "17:00" },
      tuesday: { open: "09:00", close: "17:00" },
    },
    defaultDuration: 30,
    ...overrides,
  };
}

describe("buildLiveScheduleSection", () => {
  it("is exported as a function", () => {
    assert.equal(typeof buildLiveScheduleSection, "function");
  });

  it("returns empty string for null snapshot", () => {
    assert.equal(buildLiveScheduleSection(null, "2026-04-12"), "");
  });

  it("returns empty string for snapshot with null slots", () => {
    assert.equal(buildLiveScheduleSection({ slots: null }, "2026-04-12"), "");
  });

  it("returns empty string for snapshot with empty slots object", () => {
    assert.equal(buildLiveScheduleSection({ slots: {} }, "2026-04-12"), "");
  });

  it("includes LIVE SCHEDULE header", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(result.includes("LIVE SCHEDULE"), "should contain LIVE SCHEDULE header");
  });

  it("includes current date in output", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(result.includes("2026-04-12"), "should contain todayStr");
    assert.ok(result.includes("Current date:"), "should have Current date label");
  });

  it("includes timezone in output", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(result.includes("Australia/Sydney"), "should contain timezone");
  });

  it("labels first date as Today when it matches todayStr", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(result.includes("Today ("), "should label first date as Today");
  });

  it("labels second date as Tomorrow", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(result.includes("Tomorrow ("), "should label second date as Tomorrow");
  });

  it("lists today slots in readable time format", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(result.includes("9 AM"), "should contain 9 AM");
    assert.ok(result.includes("9:30 AM"), "should contain 9:30 AM");
    assert.ok(result.includes("10 AM"), "should contain 10 AM");
  });

  it("lists tomorrow slots in readable time format", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(result.includes("2 PM"), "should contain 2 PM");
    assert.ok(result.includes("2:30 PM"), "should contain 2:30 PM");
  });

  it("shows slot count for today and tomorrow", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(result.includes("(3 slots)"), "should show 3 slots for today");
    assert.ok(result.includes("(2 slots)"), "should show 2 slots for tomorrow");
  });

  it("shows Fully booked when no slots for a day", () => {
    const snapshot = makeSnapshot({
      slots: {
        "2026-04-12": [],
        "2026-04-13": ["2026-04-13T10:00:00"],
      },
    });
    const result = buildLiveScheduleSection(snapshot, "2026-04-12");
    assert.ok(result.includes("Fully booked"), "should show Fully booked for empty day");
  });

  it("shows summary-only slot counts for dates beyond first 2", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(result.includes("12 slots available"), "should show 12 slots for Apr 14");
    assert.ok(result.includes("8 slots available"), "should show 8 slots for Apr 15");
  });

  it("shows Fully booked in summary section for days with no slots", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    // Apr 16 has empty slots array
    assert.ok(
      result.includes("Fully booked"),
      "should show Fully booked in summary for empty day"
    );
  });

  it("includes check_availability in usage rules", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(
      result.includes("check_availability"),
      "should mention check_availability in rules"
    );
  });

  it("includes book_appointment in usage rules", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(
      result.includes("book_appointment"),
      "should mention book_appointment in rules"
    );
  });

  it("includes upcoming days header when there are summary dates", () => {
    const result = buildLiveScheduleSection(makeSnapshot(), "2026-04-12");
    assert.ok(
      result.includes("Upcoming days (slot count only"),
      "should have upcoming days header"
    );
  });

  it("handles snapshot with only one date", () => {
    const snapshot = makeSnapshot({
      slots: {
        "2026-04-12": ["2026-04-12T09:00:00"],
      },
    });
    const result = buildLiveScheduleSection(snapshot, "2026-04-12");
    assert.ok(result.includes("LIVE SCHEDULE"), "should still produce output");
    assert.ok(result.includes("9 AM"), "should show the one slot");
    assert.ok(result.includes("(1 slot)"), "should use singular 'slot'");
    // Should NOT have upcoming days section since there's only 1 date
    assert.ok(
      !result.includes("Upcoming days"),
      "should not have upcoming days with only 1 date"
    );
  });

  it("handles exactly two dates with no summary section", () => {
    const snapshot = makeSnapshot({
      slots: {
        "2026-04-12": ["2026-04-12T09:00:00"],
        "2026-04-13": ["2026-04-13T14:00:00"],
      },
    });
    const result = buildLiveScheduleSection(snapshot, "2026-04-12");
    assert.ok(result.includes("Today"), "should have Today");
    assert.ok(result.includes("Tomorrow"), "should have Tomorrow");
    assert.ok(
      !result.includes("Upcoming days"),
      "should not have upcoming days with exactly 2 dates"
    );
  });
});
