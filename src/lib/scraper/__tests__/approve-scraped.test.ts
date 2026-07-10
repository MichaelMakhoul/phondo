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
    expect(rows).toHaveLength(3);
    const [mon, tue, sun] = rows;
    expect(mon).toMatchObject({ day: "monday", include: true, hours: { open: "09:00", close: "17:00" } });
    expect(tue.include).toBe(false);
    expect(tue.hours).toEqual({ open: "14:00", close: "18:00" });
    expect(tue.warning).toBeTruthy();
    expect(sun).toMatchObject({ day: "sunday", include: true, hours: null });
  });

  it("unparsed-with-day rows start unconfirmed and empty; day ranges expand", () => {
    const rows = readingsToDaySelections(parseBusinessHoursDetailed(["Mon-Wed: ring for times"]));
    expect(rows.map((r) => r.day)).toEqual(["monday", "tuesday", "wednesday"]);
    expect(rows.every((r) => !r.include && r.hours === null && r.warning)).toBe(true);
  });

  it("a later line for the same day replaces the earlier row", () => {
    const rows = readingsToDaySelections(
      parseBusinessHoursDetailed(["Monday: 9am - 5pm", "Monday: 10am - 4pm"])
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].include).toBe(false); // conflict → owner must look
    expect(rows[0].hours).toEqual({ open: "10:00", close: "16:00" });
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
