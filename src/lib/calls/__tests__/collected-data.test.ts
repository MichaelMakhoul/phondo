import { describe, it, expect } from "vitest";
import {
  formatCollectedValue,
  isNonAnswer,
  isPrimitiveCollectedValue,
  toEditablePrimitives,
  mergeEditableCollectedData,
} from "../collected-data";

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
    for (const v of ["", "  ", "not provided", "Not Provided", "unknown", "N/A", "na", null, undefined]) {
      expect(isNonAnswer(v)).toBe(true);
    }
  });

  it("is false for real answers", () => {
    expect(isNonAnswer("Michael Makhoul")).toBe(false);
    expect(isNonAnswer("+61414141883")).toBe(false);
    expect(isNonAnswer([{ date: "Wed", time: "9 AM" }])).toBe(false);
    expect(isNonAnswer(0)).toBe(false); // "0" is a real value, not a non-answer
    // "none" is a real clinical answer (allergies: none), NOT filtered.
    expect(isNonAnswer("none")).toBe(false);
    expect(isNonAnswer("None")).toBe(false);
  });
});

describe("isPrimitiveCollectedValue (SCRUM-394)", () => {
  it("is true for scalars and nullish", () => {
    for (const v of ["hi", 42, 0, true, false, null, undefined]) {
      expect(isPrimitiveCollectedValue(v)).toBe(true);
    }
  });

  it("is false for arrays and objects (structured fields)", () => {
    expect(isPrimitiveCollectedValue([{ date: "Wed" }])).toBe(false);
    expect(isPrimitiveCollectedValue({ date: "Wed", time: "9 AM" })).toBe(false);
    expect(isPrimitiveCollectedValue([])).toBe(false);
    expect(isPrimitiveCollectedValue({})).toBe(false);
  });
});

describe("toEditablePrimitives (SCRUM-394)", () => {
  it("keeps only primitive fields, formatted as strings", () => {
    const collected = {
      name: "Michael Makhoul",
      phone: "+61414141883",
      visits: 3,
      appointments: [
        { date: "Wednesday, June 17th", time: "9:00 AM", doctor: "Lisa Thompson" },
      ],
    };
    expect(toEditablePrimitives(collected)).toEqual({
      name: "Michael Makhoul",
      phone: "+61414141883",
      visits: "3",
    });
  });

  it("returns {} for null/undefined/empty", () => {
    expect(toEditablePrimitives(null)).toEqual({});
    expect(toEditablePrimitives(undefined)).toEqual({});
    expect(toEditablePrimitives({})).toEqual({});
  });
});

describe("mergeEditableCollectedData (SCRUM-394)", () => {
  it("overlays edited primitives but PRESERVES structured fields (the bug)", () => {
    const existing = {
      name: "Mike",
      phone: "not provided",
      appointments: [
        { date: "Wednesday, June 17th", time: "9:00 AM", doctor: "Lisa Thompson" },
      ],
    };
    const edited = { name: "Michael Makhoul", phone: "+61414141883" };
    expect(mergeEditableCollectedData(existing, edited)).toEqual({
      name: "Michael Makhoul",
      phone: "+61414141883",
      // the array survives unflattened
      appointments: [
        { date: "Wednesday, June 17th", time: "9:00 AM", doctor: "Lisa Thompson" },
      ],
    });
  });

  it("never lets an edited string clobber a structured field", () => {
    const existing = { appointments: [{ date: "Wed" }] };
    // even if a caller somehow sends the structured key as a string, it's ignored
    const edited = { appointments: "Wed June 17 · 9 AM" } as Record<string, string>;
    expect(mergeEditableCollectedData(existing, edited)).toEqual({
      appointments: [{ date: "Wed" }],
    });
  });

  it("adds new primitive keys and handles null existing", () => {
    expect(mergeEditableCollectedData(null, { name: "Mike" })).toEqual({ name: "Mike" });
    expect(mergeEditableCollectedData({ a: "1" }, { b: "2" })).toEqual({ a: "1", b: "2" });
  });
});
