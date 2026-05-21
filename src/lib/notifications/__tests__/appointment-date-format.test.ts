import { describe, it, expect } from "vitest";
import { formatAppointmentDate } from "../notification-service";

describe("formatAppointmentDate", () => {
  // The exact production bug: a 9:30am Sydney booking is stored as
  // 2026-06-04T23:30:00Z. Rendered in UTC + US locale it showed "6/4/2026"
  // (June 4, wrong day, ambiguous format). It must show June 5 in Sydney.
  const sydneyBooking = new Date("2026-06-04T23:30:00Z");

  it("renders the correct local day in the org timezone (not UTC)", () => {
    const out = formatAppointmentDate(sydneyBooking, "Australia/Sydney");
    expect(out).toContain("5 June 2026");
    expect(out).toContain("Friday");
    // Must NOT show the UTC day (the 4th).
    expect(out).not.toContain("4 June");
  });

  it("spells out the month so D/M/Y vs M/D/Y is unambiguous", () => {
    const out = formatAppointmentDate(sydneyBooking, "Australia/Sydney");
    // No purely-numeric date that could be misread.
    expect(out).not.toMatch(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
    expect(out).toMatch(/June/);
  });

  it("handles a US timezone correctly", () => {
    // 2026-06-05T01:30:00Z = June 4, 9:30pm America/New_York
    const out = formatAppointmentDate(new Date("2026-06-05T01:30:00Z"), "America/New_York");
    expect(out).toContain("4 June 2026");
  });

  it("falls back to a readable format when timezone is missing", () => {
    // No timezone → server zone, but month still spelled out (unambiguous).
    const out = formatAppointmentDate(sydneyBooking);
    expect(out).toMatch(/June 2026/);
    expect(out).not.toMatch(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
  });
});
