import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatOwnerLockTime } from "../lock-email-time";

// SCRUM-586: the PIN-lockout email is a "was this me?" alert, so the time it
// quotes is the ORG's local time written the Australian way
// ("Thursday 15 October at 3:04 pm") — never the server's clock, which on Vercel
// is UTC and would put a 3 pm Sydney call at 4 am.

// Thursday 15 October 2026, 04:04 UTC. Sydney has been on AEDT (UTC+11) since 4 Oct;
// Perth is UTC+8 all year.
const INSTANT = new Date("2026-10-15T04:04:00Z");

// The suite machine may itself run in Sydney time, which would hide a "fell back to
// server time" bug. Pin the process zone somewhere that matches no case below.
beforeEach(() => {
  vi.stubEnv("TZ", "Pacific/Honolulu");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("formatOwnerLockTime", () => {
  it("writes the org-local time the Australian way", () => {
    expect(formatOwnerLockTime(INSTANT, "Australia/Sydney")).toBe("Thursday 15 October at 3:04 pm");
  });

  it("the same instant reads differently in different org zones (Sydney vs Perth)", () => {
    const sydney = formatOwnerLockTime(INSTANT, "Australia/Sydney");
    const perth = formatOwnerLockTime(INSTANT, "Australia/Perth");
    expect(sydney).toBe("Thursday 15 October at 3:04 pm");
    expect(perth).toBe("Thursday 15 October at 12:04 pm");
    expect(perth).not.toBe(sydney);
  });

  it("follows the org's calendar day, not the server's: weekday and date roll over with the zone", () => {
    const late = new Date("2026-10-14T20:30:00Z"); // already Thursday in Sydney, still Wednesday in New York
    expect(formatOwnerLockTime(late, "Australia/Sydney")).toBe("Thursday 15 October at 7:30 am");
    expect(formatOwnerLockTime(late, "America/New_York")).toBe("Wednesday 14 October at 4:30 pm");
  });

  it("applies the zone's daylight saving: the same UTC time is an hour earlier on the clock in winter", () => {
    expect(formatOwnerLockTime(new Date("2026-07-15T04:04:00Z"), "Australia/Sydney")).toBe("Wednesday 15 July at 2:04 pm");
  });

  it("uses a 12-hour clock with 12 for midnight and noon", () => {
    expect(formatOwnerLockTime(new Date("2026-10-14T13:04:00Z"), "Australia/Sydney")).toBe("Thursday 15 October at 12:04 am");
    expect(formatOwnerLockTime(new Date("2026-10-15T01:00:00Z"), "Australia/Sydney")).toBe("Thursday 15 October at 12:00 pm");
  });

  it("is the same string on every runtime: lowercase am/pm and plain spaces only", () => {
    const text = formatOwnerLockTime(INSTANT, "Australia/Sydney");
    expect(text).toMatch(/ (am|pm)$/);
    expect(text).not.toMatch(/[  ]/);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("reads %s as Sydney (the owner tools' default) — never server time", (_label, zone) => {
    expect(formatOwnerLockTime(INSTANT, zone)).toBe(formatOwnerLockTime(INSTANT, "Australia/Sydney"));
    expect(formatOwnerLockTime(INSTANT, zone)).toBe("Thursday 15 October at 3:04 pm");
  });

  it("reads a zone Intl rejects as Sydney instead of throwing or using the server's clock, and logs it so the bad row is findable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(formatOwnerLockTime(INSTANT, "Not/AZone")).toBe("Thursday 15 October at 3:04 pm");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unusable org timezone"),
      expect.objectContaining({ timezone: "Not/AZone", fallback: "Australia/Sydney" }),
    );
    expect(formatOwnerLockTime(INSTANT, 42 as unknown as string)).toBe("Thursday 15 October at 3:04 pm");
  });

  it("does not log for the ordinary no-zone-stored case", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    formatOwnerLockTime(INSTANT, null);
    formatOwnerLockTime(INSTANT, "");
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws on an invalid instant rather than emailing garbage", () => {
    expect(() => formatOwnerLockTime(new Date(NaN), "Australia/Sydney")).toThrow(RangeError);
  });

  it("trims a stored zone before using it", () => {
    expect(formatOwnerLockTime(INSTANT, "  Australia/Perth ")).toBe("Thursday 15 October at 12:04 pm");
  });
});
