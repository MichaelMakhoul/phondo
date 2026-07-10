import { describe, it, expect } from "vitest";
import {
  formatTime12h,
  readingsToDaySelections,
  buildApprovedHoursLines,
  type HoursDaySelection,
} from "../approve-scraped";
import { parseBusinessHours, parseBusinessHoursDetailed } from "../parse-business-hours";

describe("formatTime12h", () => {
  it("renders 24h HH:MM as 12h with meridiem", () => {
    expect(formatTime12h("09:00")).toBe("9:00am");
    expect(formatTime12h("14:30")).toBe("2:30pm");
    expect(formatTime12h("00:15")).toBe("12:15am");
    expect(formatTime12h("12:00")).toBe("12:00pm");
  });

  it("refuses what is not a valid HH:MM", () => {
    expect(formatTime12h("9:00")).toBeNull();
    expect(formatTime12h("25:00")).toBeNull();
    expect(formatTime12h("")).toBeNull();
  });
});

describe("readingsToDaySelections", () => {
  it("parsed and closed lines arrive confirmed; ambiguous arrive UNCONFIRMED with their candidate", () => {
    const rows = readingsToDaySelections(
      parseBusinessHoursDetailed(["Monday: 9am - 5pm", "Tuesday: 2 - 6pm", "Sunday: closed"])
    );
    // SCRUM-540: the full week renders — unmentioned days as pre-ticked closed.
    expect(rows).toHaveLength(7);
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r]));
    expect(byDay.monday).toMatchObject({ include: true, hours: { open: "09:00", close: "17:00" } });
    expect(byDay.tuesday.include).toBe(false);
    expect(byDay.tuesday.hours).toEqual({ open: "14:00", close: "18:00" });
    expect(byDay.tuesday.warning).toBeTruthy();
    expect(byDay.sunday).toMatchObject({ include: true, hours: null });
    // An unmentioned day: pre-ticked closed, NO warning (stays valid as closed).
    expect(byDay.wednesday).toMatchObject({ include: true, hours: null });
    expect(byDay.wednesday.warning).toBeUndefined();
  });

  it("SCRUM-540: a weekend-only listing emits a full 7-line week that the strict parser ACCEPTS", () => {
    const rows = readingsToDaySelections(
      parseBusinessHoursDetailed(["Saturday: 9am - 2pm", "Sunday: 10am - 1pm"])
    );
    expect(rows).toHaveLength(7);
    const lines = buildApprovedHoursLines(rows);
    expect(lines).toHaveLength(7);
    const parsed = parseBusinessHours(lines);
    expect(parsed).not.toBeNull();
    expect(parsed!.hours.saturday).toEqual({ open: "09:00", close: "14:00" });
    expect(parsed!.hours.monday).toBeNull();
  });

  it("SCRUM-540 review (HIGH): an UNREADABLE line suspends the closed-fill — its days could be any of them", () => {
    // "Weekdays: 9am - 5pm" fails the day label entirely. Pre-ticking Mon-Fri
    // closed would turn callers away from days the site says are open — the
    // strict parser's own precondition for "unmentioned means closed" is that
    // every line was intelligible.
    const rows = readingsToDaySelections(
      parseBusinessHoursDetailed(["Saturday: 9am - 2pm", "Weekdays: 9am - 5pm"])
    );
    expect(rows).toHaveLength(7);
    const monday = rows.find((r) => r.day === "monday")!;
    expect(monday.include).toBe(false);
    expect(monday.warning).toBeTruthy();
    // And ticking it without setting times must be blocked, not read as closed.
    expect(validateHoursSelections([{ ...monday, include: true }])).toHaveLength(1);
    const saturday = rows.find((r) => r.day === "saturday")!;
    expect(saturday).toMatchObject({ include: true, hours: { open: "09:00", close: "14:00" } });
  });

  it("SCRUM-540: a single closed line fills to an all-closed week the strict parser REFUSES (panel notice territory)", () => {
    const rows = readingsToDaySelections(parseBusinessHoursDetailed(["Sunday: closed"]));
    const lines = buildApprovedHoursLines(rows);
    expect(lines).toHaveLength(7);
    expect(lines.every((l) => l.endsWith(": closed"))).toBe(true);
    expect(parseBusinessHours(lines)).toBeNull();
  });

  it("SCRUM-540: no days mentioned at all still hides the hours block ([])", () => {
    expect(readingsToDaySelections(parseBusinessHoursDetailed(["ring for times"]))).toEqual([]);
    expect(readingsToDaySelections([])).toEqual([]);
  });

  it("unparsed-with-day rows start unconfirmed and empty; day ranges expand; the rest fill closed", () => {
    const rows = readingsToDaySelections(parseBusinessHoursDetailed(["Mon-Wed: ring for times"]));
    expect(rows.map((r) => r.day)).toEqual([
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    ]);
    const mentioned = rows.slice(0, 3);
    expect(mentioned.every((r) => !r.include && r.hours === null && r.warning)).toBe(true);
    const filled = rows.slice(3);
    expect(filled.every((r) => r.include && r.hours === null && !r.warning)).toBe(true);
  });

  it("a later line for the same day replaces the earlier row", () => {
    const rows = readingsToDaySelections(
      parseBusinessHoursDetailed(["Monday: 9am - 5pm", "Monday: 10am - 4pm"])
    );
    const monday = rows.find((r) => r.day === "monday")!;
    expect(monday.include).toBe(false); // conflict → owner must look
    expect(monday.hours).toEqual({ open: "10:00", close: "16:00" });
  });
});

describe("buildApprovedHoursLines — THE round-trip invariant", () => {
  it("whatever the approve screen emits, the STRICT parser accepts, windows intact", () => {
    const selections: HoursDaySelection[] = [
      { day: "monday", include: true, hours: { open: "09:00", close: "17:00" } },
      { day: "tuesday", include: true, hours: { open: "14:00", close: "18:00" } }, // a confirmed ambiguous candidate
      { day: "wednesday", include: true, hours: { open: "09:00", close: "17:00" } },
      { day: "thursday", include: true, hours: { open: "09:00", close: "17:00" } },
      { day: "friday", include: true, hours: { open: "07:30", close: "21:15" } },
      { day: "sunday", include: true, hours: null }, // closed
    ];
    const lines = buildApprovedHoursLines(selections);
    const parsed = parseBusinessHours(lines);
    expect(parsed).not.toBeNull();
    expect(parsed!.hours.monday).toEqual({ open: "09:00", close: "17:00" });
    expect(parsed!.hours.tuesday).toEqual({ open: "14:00", close: "18:00" });
    expect(parsed!.hours.friday).toEqual({ open: "07:30", close: "21:15" });
    expect(parsed!.hours.sunday).toBeNull();
    expect(parsed!.hours.saturday).toBeNull(); // never mentioned → closed
  });

  it("unconfirmed rows are omitted — falling back to the default is the safe direction", () => {
    const lines = buildApprovedHoursLines([
      { day: "monday", include: false, hours: { open: "09:00", close: "17:00" } },
      { day: "tuesday", include: true, hours: { open: "09:00", close: "17:00" } },
    ]);
    expect(lines).toEqual(["Tuesday: 9:00am - 5:00pm"]);
  });

  it("malformed and inverted windows are dropped, never emitted looking authoritative", () => {
    const lines = buildApprovedHoursLines([
      { day: "monday", include: true, hours: { open: "17:00", close: "09:00" } },
      { day: "tuesday", include: true, hours: { open: "junk", close: "17:00" } },
      { day: "wednesday", include: true, hours: { open: "09:00", close: "09:00" } },
    ]);
    expect(lines).toEqual([]);
  });

  it("end to end: detailed readings → owner confirms the ambiguous candidate → strict parse succeeds", () => {
    const rows = readingsToDaySelections(
      parseBusinessHoursDetailed([
        "Mon-Thu: 9am - 5pm",
        "Friday: 2 - 6pm", // ambiguous; owner will confirm the 2pm candidate
        "Sat-Sun: closed",
      ])
    );
    const confirmed = rows.map((r) => ({ ...r, include: true }));
    const parsed = parseBusinessHours(buildApprovedHoursLines(confirmed));
    expect(parsed).not.toBeNull();
    expect(parsed!.hours.friday).toEqual({ open: "14:00", close: "18:00" });
    expect(parsed!.hours.saturday).toBeNull();
  });
});

// ── Review-round pins (SCRUM-534 gate) ──────────────────────────────────

import { validateHoursSelections } from "../approve-scraped";
import { parseTimeRangesDetailed } from "../parse-business-hours";

describe("hours-then-closed conflicts (review F3 — was a real bug)", () => {
  it("hours then closed for the same day marks the closed line ambiguous, and the row arrives UNCONFIRMED", () => {
    const readings = parseBusinessHoursDetailed(["Monday: 9am - 5pm", "Monday: closed"]);
    expect(readings[1].status).toBe("ambiguous");
    expect(readings[1].warning).toContain("listed twice");
    const rows = readingsToDaySelections(readings);
    expect(rows[0].include).toBe(false);
  });

  it("closed then hours (the direction that already worked) stays ambiguous", () => {
    const readings = parseBusinessHoursDetailed(["Monday: closed", "Monday: 9am - 5pm"]);
    expect(readings[1].status).toBe("ambiguous");
  });

  it("the realistic scrape shape: header hours plus a Mondays-closed notice cannot arrive pre-confirmed", () => {
    const rows = readingsToDaySelections(
      parseBusinessHoursDetailed(["Mon-Fri: 9am - 5pm", "Monday: closed"])
    );
    const monday = rows.find((r) => r.day === "monday")!;
    expect(monday.include).toBe(false);
  });
});

describe("mixed multi-window specs (review — the only new seam in the strict loop)", () => {
  it("one ambiguous window poisons the whole spec: detailed says ambiguous, strict refuses the week", () => {
    const r = parseTimeRangesDetailed("5 - 11, 2pm - 6pm");
    expect(r.status).toBe("ambiguous");
    expect(r.hours).toEqual({ open: "05:00", close: "18:00" });
    expect(r.warning).toContain("5am-11am"); // first ambiguity explains the candidate
    expect(parseBusinessHours(["Mon-Thu: 9am - 5pm", "Friday: 5 - 11, 2pm - 6pm"])).toBeNull();
  });

  it("with TWO ambiguous windows, the FIRST ambiguity explains the candidate", () => {
    // "5 - 11" is both-ways ambiguous; "2 - 6pm" is bare-open ambiguous.
    // The candidate envelope embeds window 1's literal reading, so window 2's
    // warning overwriting window 1's would explain the wrong number.
    const r = parseTimeRangesDetailed("5 - 11, 2 - 6pm");
    expect(r.status).toBe("ambiguous");
    expect(r.warning).toContain("5am-11am");
    expect(r.warning).not.toContain("starting 2pm");

    // And with two BOTH-WAYS windows, still the first:
    const r2 = parseTimeRangesDetailed("5 - 11, 3 - 7");
    expect(r2.warning).toContain("5am-11am");
    expect(r2.warning).not.toContain("3am-7am");
  });
});

describe("validateHoursSelections (review F1 — HIGH: silent drops became CLOSED days)", () => {
  it("flags a confirmed row missing either time, and one with close before open", () => {
    const errors = validateHoursSelections([
      { day: "monday", include: true, hours: { open: "", close: "17:00" } },
      { day: "tuesday", include: true, hours: { open: "17:00", close: "09:00" } },
      { day: "wednesday", include: true, hours: { open: "09:00", close: "17:00" } },
    ]);
    expect(errors.map((e) => e.day)).toEqual(["monday", "tuesday"]);
  });

  it("unconfirmed and closed rows are never errors", () => {
    expect(
      validateHoursSelections([
        { day: "monday", include: false, hours: { open: "", close: "" } },
        { day: "tuesday", include: true, hours: null },
      ])
    ).toEqual([]);
  });
});

describe("MIN_DAYS_NAMED interaction (review F2 — pinned as a conscious decision)", () => {
  it("four confirmed days emit four lines the strict parser REFUSES — the default stands", () => {
    // The panel detects this via the same round-trip and emits [] with an
    // inline notice instead of letting org creation blame the website.
    const lines = buildApprovedHoursLines(
      ["monday", "tuesday", "wednesday", "thursday"].map((day) => ({
        day,
        include: true,
        hours: { open: "09:00", close: "17:00" },
      }))
    );
    expect(lines).toHaveLength(4);
    expect(parseBusinessHours(lines)).toBeNull();
  });
});

describe("re-verify residuals (SCRUM-534)", () => {
  it("an unparsed row ticked with empty times is an ERROR, not a silent closed day", () => {
    const errors = validateHoursSelections([
      { day: "monday", include: true, hours: null, warning: "We couldn't read this line" },
    ]);
    expect(errors).toEqual([{ day: "monday", error: "Set the hours, or untick this day" }]);
  });

  it("a genuine closed row (no warning) stays valid", () => {
    expect(validateHoursSelections([{ day: "sunday", include: true, hours: null }])).toEqual([]);
  });
});
