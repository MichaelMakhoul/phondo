import { describe, it, expect } from "vitest";
import { validateBusinessHoursMap } from "../validate-hours-map";

// SCRUM-541: {open: "", close: "17:00"} saved from the settings form reads
// as CLOSED on calls while the dashboard shows the day OPEN.

describe("validateBusinessHoursMap", () => {
  it("accepts a normal week, closed days included", () => {
    expect(
      validateBusinessHoursMap({
        monday: { open: "09:00", close: "17:00" },
        saturday: null,
        sunday: undefined,
      })
    ).toEqual([]);
  });

  it("flags the exact shipping shape: an empty time on an open day", () => {
    expect(validateBusinessHoursMap({ tuesday: { open: "", close: "17:00" } })).toEqual([
      { day: "tuesday", error: "Set both an opening and a closing time" },
    ]);
    expect(validateBusinessHoursMap({ tuesday: { open: "09:00", close: "" } })).toHaveLength(1);
  });

  it("flags inverted and zero-length windows", () => {
    expect(validateBusinessHoursMap({ monday: { open: "17:00", close: "09:00" } })).toEqual([
      { day: "monday", error: "Closing time must be after opening time" },
    ]);
    expect(validateBusinessHoursMap({ monday: { open: "09:00", close: "09:00" } })).toHaveLength(1);
  });

  it("flags out-of-range and non-HH:MM values", () => {
    expect(validateBusinessHoursMap({ monday: { open: "25:00", close: "17:00" } })).toHaveLength(1);
    expect(validateBusinessHoursMap({ monday: { open: "09:75", close: "17:00" } })).toHaveLength(1);
    expect(validateBusinessHoursMap({ monday: { open: "9:00", close: "17:00" } })).toHaveLength(1);
  });

  it("reports every broken day, not just the first", () => {
    const errors = validateBusinessHoursMap({
      monday: { open: "", close: "17:00" },
      tuesday: { open: "17:00", close: "09:00" },
      wednesday: { open: "09:00", close: "17:00" },
    });
    expect(errors.map((e) => e.day)).toEqual(["monday", "tuesday"]);
  });

  it("tolerates null/undefined input maps", () => {
    expect(validateBusinessHoursMap(null as never)).toEqual([]);
    expect(validateBusinessHoursMap(undefined as never)).toEqual([]);
  });
});

  it("skips non-canonical keys — legacy dead data must not block the save unfixably", () => {
    expect(validateBusinessHoursMap({ Monday: { open: "", close: "17:00" } } as never)).toEqual([]);
    expect(validateBusinessHoursMap({ monday: { open: "", close: "17:00" } })).toHaveLength(1);
  });
