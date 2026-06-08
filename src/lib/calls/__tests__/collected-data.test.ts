import { describe, it, expect } from "vitest";
import { formatCollectedValue, isNonAnswer } from "../collected-data";

describe("formatCollectedValue (SCRUM-392)", () => {
  it("returns primitives as strings", () => {
    expect(formatCollectedValue("Michael Makhoul")).toBe("Michael Makhoul");
    expect(formatCollectedValue(42)).toBe("42");
    expect(formatCollectedValue(true)).toBe("true");
    expect(formatCollectedValue("  trim me  ")).toBe("trim me");
  });

  it("returns '' for null/undefined", () => {
    expect(formatCollectedValue(null)).toBe("");
    expect(formatCollectedValue(undefined)).toBe("");
  });

  it("formats an object's values (the [object Object] bug)", () => {
    expect(
      formatCollectedValue({ date: "Wednesday, June 17th", time: "9:00 AM", doctor: "Lisa Thompson" })
    ).toBe("Wednesday, June 17th · 9:00 AM · Lisa Thompson");
  });

  it("formats an array of objects (the exact reported case)", () => {
    const appointments = [
      { date: "Wednesday, June 17th", time: "9:00 AM", doctor: "Lisa Thompson" },
      { date: "Thursday, June 18th", time: "12:30 PM", doctor: "Dr Sarah Chen" },
    ];
    expect(formatCollectedValue(appointments)).toBe(
      "Wednesday, June 17th · 9:00 AM · Lisa Thompson; Thursday, June 18th · 12:30 PM · Dr Sarah Chen"
    );
  });

  it("skips empty members when joining", () => {
    expect(formatCollectedValue(["a", "", "b", null])).toBe("a; b");
    expect(formatCollectedValue({ a: "x", b: "", c: null })).toBe("x");
  });
});

describe("isNonAnswer (SCRUM-392)", () => {
  it("is true for non-answers (filtered from the panel)", () => {
    for (const v of ["", "  ", "not provided", "Not Provided", "unknown", "N/A", "none", null, undefined]) {
      expect(isNonAnswer(v)).toBe(true);
    }
  });

  it("is false for real answers", () => {
    expect(isNonAnswer("Michael Makhoul")).toBe(false);
    expect(isNonAnswer("+61414141883")).toBe(false);
    expect(isNonAnswer([{ date: "Wed", time: "9 AM" }])).toBe(false);
    expect(isNonAnswer(0)).toBe(false); // "0" is a real value, not a non-answer
  });
});
