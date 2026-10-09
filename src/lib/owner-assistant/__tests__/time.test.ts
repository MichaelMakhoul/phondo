// src/lib/owner-assistant/__tests__/time.test.ts
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  OWNER_RANGES,
  todayISO,
  localDayRange,
  ownerRangeBounds,
  parseOwnerLocalDatetime,
  formatWhen,
  type OwnerRange,
} from "../time";

// SCRUM-586: owner-assistant date helpers. Sydney is AEDT (+11) in mid-October
// (DST started Sun 4 Oct 2026), so local midnight 2026-10-15 is 2026-10-14T13:00Z.
// Every clock-dependent case pins "now" (injected, or vi.setSystemTime), and every
// helper takes an explicit zone, so nothing here depends on the real date or on
// the machine's timezone.
const TZ = "Australia/Sydney";
const NOW = new Date("2026-10-15T03:00:00Z"); // 2026-10-15 14:00 AEDT
const HOUR_MS = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OWNER_RANGES", () => {
  it("lists the four ranges the owner tool accepts", () => {
    expect([...OWNER_RANGES]).toEqual(["today", "tomorrow", "this_week", "date"]);
  });
});

describe("todayISO", () => {
  it("returns the org-local calendar date", () => {
    // 2026-10-14T23:30Z is already 2026-10-15 10:30 in Sydney
    expect(todayISO(TZ, new Date("2026-10-14T23:30:00Z"))).toBe("2026-10-15");
    expect(todayISO("America/New_York", new Date("2026-10-14T23:30:00Z"))).toBe("2026-10-14");
  });
  it("flips at the org's local midnight, not UTC's", () => {
    // Sydney (+11) reaches 2026-10-15 00:00 at exactly 2026-10-14T13:00Z.
    expect(todayISO(TZ, new Date("2026-10-14T12:59:59Z"))).toBe("2026-10-14");
    expect(todayISO(TZ, new Date("2026-10-14T13:00:00Z"))).toBe("2026-10-15");
  });
  it("reads the current clock when no `now` is passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(todayISO(TZ)).toBe("2026-10-15");
    expect(todayISO("America/New_York")).toBe("2026-10-14");
  });
});

describe("localDayRange", () => {
  it("throws a RangeError for a day that does not exist, instead of rolling it into the next month", () => {
    expect(() => localDayRange("2026-02-30", TZ)).toThrow(RangeError);
    expect(() => localDayRange("2026-13-01", TZ)).toThrow(RangeError);
    expect(() => localDayRange("15/10/2026", TZ)).toThrow(RangeError);
  });

  it("brackets the local day as UTC instants", () => {
    expect(localDayRange("2026-10-15", TZ)).toEqual({
      start: "2026-10-14T13:00:00.000Z",
      end: "2026-10-15T13:00:00.000Z",
    });
  });
  it("is a 23-hour range on the Sydney spring-forward day (Sun 4 Oct 2026)", () => {
    // Midnight is still AEST (+10); the next midnight is AEDT (+11).
    const r = localDayRange("2026-10-04", TZ);
    expect(r).toEqual({
      start: "2026-10-03T14:00:00.000Z",
      end: "2026-10-04T13:00:00.000Z",
    });
    expect((Date.parse(r.end) - Date.parse(r.start)) / HOUR_MS).toBe(23);
  });
  it("is a 25-hour range on the Sydney fall-back day (Sun 4 Apr 2027)", () => {
    // Midnight is still AEDT (+11); the next midnight is AEST (+10).
    const r = localDayRange("2027-04-04", TZ);
    expect(r).toEqual({
      start: "2027-04-03T13:00:00.000Z",
      end: "2027-04-04T14:00:00.000Z",
    });
    expect((Date.parse(r.end) - Date.parse(r.start)) / HOUR_MS).toBe(25);
  });
  it("handles a US fall-back day too (Sun 1 Nov 2026, New York)", () => {
    expect(localDayRange("2026-11-01", "America/New_York")).toEqual({
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T05:00:00.000Z",
    });
  });
});

describe("ownerRangeBounds", () => {
  it("today = the local day", () => {
    const b = ownerRangeBounds("today", TZ, undefined, NOW);
    expect(b).toEqual({
      start: "2026-10-14T13:00:00.000Z",
      end: "2026-10-15T13:00:00.000Z",
      label: "today",
      firstDate: "2026-10-15",
    });
  });
  it("today follows the org's calendar day when UTC is still on the previous date", () => {
    // 2026-10-14T20:00Z is 2026-10-15 07:00 in Sydney.
    const b = ownerRangeBounds("today", TZ, undefined, new Date("2026-10-14T20:00:00Z"));
    expect(b?.firstDate).toBe("2026-10-15");
    expect(b?.start).toBe("2026-10-14T13:00:00.000Z");
    expect(b?.end).toBe("2026-10-15T13:00:00.000Z");
  });
  it("tomorrow = the next local day", () => {
    const b = ownerRangeBounds("tomorrow", TZ, undefined, NOW);
    expect(b?.start).toBe("2026-10-15T13:00:00.000Z");
    expect(b?.end).toBe("2026-10-16T13:00:00.000Z");
    expect(b?.firstDate).toBe("2026-10-16");
  });
  it("this_week = today through the next 7 local days", () => {
    const b = ownerRangeBounds("this_week", TZ, undefined, NOW);
    expect(b?.start).toBe("2026-10-14T13:00:00.000Z");
    expect(b?.end).toBe("2026-10-21T13:00:00.000Z");
    expect(b?.label).toBe("over the next 7 days");
  });
  it("date = that local day, and refuses a missing or malformed date", () => {
    const b = ownerRangeBounds("date", TZ, "2026-11-02", NOW);
    expect(b?.start).toBe("2026-11-01T13:00:00.000Z");
    expect(b?.end).toBe("2026-11-02T13:00:00.000Z");
    expect(b?.label).toBe("on Monday, November 2");
    expect(ownerRangeBounds("date", TZ, undefined, NOW)).toBeNull();
    expect(ownerRangeBounds("date", TZ, "2/11/2026", NOW)).toBeNull();
  });
  it("date refuses a well-shaped but impossible calendar date instead of throwing", () => {
    expect(ownerRangeBounds("date", TZ, "2026-13-45", NOW)).toBeNull();
    // V8 would silently roll these over to March / May — never move the owner's day.
    expect(ownerRangeBounds("date", TZ, "2026-02-30", NOW)).toBeNull();
    expect(ownerRangeBounds("date", TZ, "2027-02-29", NOW)).toBeNull();
    expect(ownerRangeBounds("date", TZ, "2026-04-31", NOW)).toBeNull();
  });
  it("date refuses a non-string date (the model's args are untyped JSON)", () => {
    expect(ownerRangeBounds("date", TZ, 20261102 as unknown as string, NOW)).toBeNull();
    // String(["..."]) would pass the shape check — a one-element array must not slip through
    expect(ownerRangeBounds("date", TZ, ["2026-11-02"] as unknown as string, NOW)).toBeNull();
  });
  it("date accepts a real leap day", () => {
    const b = ownerRangeBounds("date", TZ, "2028-02-29", NOW);
    expect(b?.label).toBe("on Tuesday, February 29");
    expect(b?.firstDate).toBe("2028-02-29");
  });
  it("returns null for a range the model invented", () => {
    expect(ownerRangeBounds("next_month" as OwnerRange, TZ, undefined, NOW)).toBeNull();
  });
  it("reads the current clock when no `now` is passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(ownerRangeBounds("today", TZ)?.firstDate).toBe("2026-10-15");
    expect(ownerRangeBounds("tomorrow", TZ)?.firstDate).toBe("2026-10-16");
    expect(ownerRangeBounds("this_week", TZ)?.firstDate).toBe("2026-10-15");
  });

  describe("across a Sydney DST change", () => {
    it("this_week is 7 local days even when it spans spring-forward (not 168 hours)", () => {
      // Fri 2 Oct 2026 13:00 AEST; the clocks jump on Sun 4 Oct, inside the week.
      const b = ownerRangeBounds("this_week", TZ, undefined, new Date("2026-10-02T03:00:00Z"));
      expect(b).toEqual({
        start: "2026-10-01T14:00:00.000Z", // Fri 2 Oct 00:00 AEST (+10)
        end: "2026-10-08T13:00:00.000Z", // Fri 9 Oct 00:00 AEDT (+11)
        label: "over the next 7 days",
        firstDate: "2026-10-02",
      });
      expect((Date.parse(b!.end) - Date.parse(b!.start)) / HOUR_MS).toBe(167);
    });
    it("tomorrow on the spring-forward day is the 23-hour local day", () => {
      // Sat 3 Oct 2026 13:00 AEST -> tomorrow is Sun 4 Oct.
      const b = ownerRangeBounds("tomorrow", TZ, undefined, new Date("2026-10-03T03:00:00Z"));
      expect(b).toEqual({
        start: "2026-10-03T14:00:00.000Z",
        end: "2026-10-04T13:00:00.000Z",
        label: "tomorrow",
        firstDate: "2026-10-04",
      });
    });
    it("date on the fall-back day is the 25-hour local day", () => {
      const b = ownerRangeBounds("date", TZ, "2027-04-04", NOW);
      expect(b).toEqual({
        start: "2027-04-03T13:00:00.000Z",
        end: "2027-04-04T14:00:00.000Z",
        label: "on Sunday, April 4",
        firstDate: "2027-04-04",
      });
    });
  });
});

describe("parseOwnerLocalDatetime", () => {
  it("reads a naive wall time in the org zone", () => {
    expect(parseOwnerLocalDatetime("2026-10-15T09:00", TZ)?.toISOString()).toBe("2026-10-14T22:00:00.000Z");
    expect(parseOwnerLocalDatetime("2026-10-15T09:00:00", TZ)?.toISOString()).toBe("2026-10-14T22:00:00.000Z");
  });
  it("keeps an explicit offset", () => {
    expect(parseOwnerLocalDatetime("2026-10-15T09:00:00Z", TZ)?.toISOString()).toBe("2026-10-15T09:00:00.000Z");
    expect(parseOwnerLocalDatetime("2026-10-15T09:00:00+10:00", TZ)?.toISOString()).toBe("2026-10-14T23:00:00.000Z");
    // seconds are optional with an offset too
    expect(parseOwnerLocalDatetime("2026-10-15T09:00+10:00", TZ)?.toISOString()).toBe("2026-10-14T23:00:00.000Z");
  });
  it("rejects anything that is not an ISO datetime", () => {
    expect(parseOwnerLocalDatetime(undefined, TZ)).toBeNull();
    expect(parseOwnerLocalDatetime("tomorrow 9am", TZ)).toBeNull();
    expect(parseOwnerLocalDatetime("2026-10-15", TZ)).toBeNull();
    expect(parseOwnerLocalDatetime("2026-13-45T09:00", TZ)).toBeNull();
  });
  it("rejects non-string input (the model's args are untyped JSON)", () => {
    expect(parseOwnerLocalDatetime(20261015 as unknown as string, TZ)).toBeNull();
    // String(["..."]) would pass the shape check — a one-element array must not slip through
    expect(parseOwnerLocalDatetime(["2026-10-15T09:00"] as unknown as string, TZ)).toBeNull();
  });
  it("rejects out-of-range clock fields", () => {
    expect(parseOwnerLocalDatetime("2026-10-15T25:00", TZ)).toBeNull();
    expect(parseOwnerLocalDatetime("2026-10-15T09:60", TZ)).toBeNull();
  });
  it("rejects an impossible calendar date instead of rolling it into the next month", () => {
    expect(parseOwnerLocalDatetime("2026-02-30T09:00", TZ)).toBeNull();
    expect(parseOwnerLocalDatetime("2027-02-29T09:00", TZ)).toBeNull();
    expect(parseOwnerLocalDatetime("2026-04-31T09:00:00+11:00", TZ)).toBeNull();
  });
  it("accepts a real leap day", () => {
    // 2028-02-29 09:00 AEDT (+11)
    expect(parseOwnerLocalDatetime("2028-02-29T09:00", TZ)?.toISOString()).toBe("2028-02-28T22:00:00.000Z");
  });
  it("applies the offset in force at that wall time across a Sydney DST change", () => {
    // Spring-forward Sun 4 Oct 2026: 02:00 AEST -> 03:00 AEDT.
    expect(parseOwnerLocalDatetime("2026-10-04T01:59", TZ)?.toISOString()).toBe("2026-10-03T15:59:00.000Z"); // +10
    expect(parseOwnerLocalDatetime("2026-10-04T03:00", TZ)?.toISOString()).toBe("2026-10-03T16:00:00.000Z"); // +11
    // Fall-back Sun 4 Apr 2027: 03:00 AEDT -> 02:00 AEST (unambiguous wall times either side).
    expect(parseOwnerLocalDatetime("2027-04-04T01:59", TZ)?.toISOString()).toBe("2027-04-03T14:59:00.000Z"); // +11
    expect(parseOwnerLocalDatetime("2027-04-04T03:30", TZ)?.toISOString()).toBe("2027-04-03T17:30:00.000Z"); // +10
  });
});

describe("formatWhen", () => {
  it("formats an instant as the org-local weekday, date and time", () => {
    expect(formatWhen(new Date("2026-10-15T03:00:00Z"), TZ)).toBe("Thursday, October 15 at 2:00 PM");
  });
  it("uses the org's zone, not the machine's", () => {
    // 2026-10-15T03:00Z is the previous evening in New York (EDT).
    expect(formatWhen(new Date("2026-10-15T03:00:00Z"), "America/New_York")).toBe("Wednesday, October 14 at 11:00 PM");
  });
  it("reads local midnight as 12:00 AM", () => {
    expect(formatWhen(new Date("2026-10-14T13:00:00Z"), TZ)).toBe("Thursday, October 15 at 12:00 AM");
  });
  it("skips the hour that does not exist on the Sydney spring-forward night", () => {
    expect(formatWhen(new Date("2026-10-03T15:59:00Z"), TZ)).toBe("Sunday, October 4 at 1:59 AM");
    expect(formatWhen(new Date("2026-10-03T16:00:00Z"), TZ)).toBe("Sunday, October 4 at 3:00 AM");
  });
  it("normalises the narrow no-break space newer ICU builds put before AM/PM", () => {
    // Node 20 / some ICU builds emit U+202F here; the owner-facing string must be plain ASCII spacing.
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockReturnValue("2:00\u202fPM");
    expect(formatWhen(new Date("2026-10-15T03:00:00Z"), TZ)).toBe("Thursday, October 15 at 2:00 PM");
  });
});
