import { describe, it, expect } from "vitest";
import { addDaysISO, describeNoSlotsForVoice } from "../tool-handlers";

// SCRUM-524: "no available appointments" on a day the business is CLOSED
// sounds fully booked — a caller hears a thriving practice with no room,
// not "don't come Sundays" — and nothing ever offered the next real opening.

const TZ = "Australia/Sydney";
// 2026-07-12 is a Sunday.
const SUNDAY = "2026-07-12";
const MONDAY = "2026-07-13";

describe("addDaysISO", () => {
  it("adds days across month and year boundaries, date-only", () => {
    expect(addDaysISO("2026-07-12", 1)).toBe("2026-07-13");
    expect(addDaysISO("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("is DST-safe on the AEST/AEDT transition (2026-10-04 spring-forward)", () => {
    expect(addDaysISO("2026-10-03", 1)).toBe("2026-10-04");
    expect(addDaysISO("2026-10-04", 1)).toBe("2026-10-05");
  });
});

describe("describeNoSlotsForVoice", () => {
  const nextOpen = { date: MONDAY, slots: [`${MONDAY}T09:00:00`, `${MONDAY}T14:00:00`] };

  it("a CLOSED day says closed — never 'no available appointments'", () => {
    const msg = describeNoSlotsForVoice({ date: SUNDAY, closed: true, timezone: TZ, nextOpen });
    expect(msg).toContain("We're closed on Sundays.");
    expect(msg).not.toContain("no available appointments");
  });

  it("rolls forward: the closed-day message carries the next open day's real slots", () => {
    const msg = describeNoSlotsForVoice({ date: SUNDAY, closed: true, timezone: TZ, nextOpen });
    expect(msg).toContain("Monday, July 13");
    expect(msg).toContain("2 available slots");
  });

  it("an OPEN day with zero slots says fully booked — the truthful version of the old copy", () => {
    const msg = describeNoSlotsForVoice({ date: MONDAY, closed: false, timezone: TZ, nextOpen: null });
    expect(msg).toContain("Monday is fully booked");
    expect(msg).not.toContain("closed");
  });

  it("with no opening found in the week, offers a message instead of a dead end", () => {
    const msg = describeNoSlotsForVoice({ date: SUNDAY, closed: true, timezone: TZ, nextOpen: null });
    expect(msg).toContain("take a message");
  });
});

// The orchestrator itself, on the zero-DB path: an all-closed schedule never
// reaches Supabase (hours-null short-circuits before any query, and the
// lookahead skips closed days with the same pure check), so THE WIRING —
// closed computed from the schedule, not assumed — is pinnable harness-free.
import { builtInAvailabilityMessage } from "../tool-handlers";

describe("builtInAvailabilityMessage — closed-day wiring (no DB)", () => {
  const allClosed = {
    timezone: TZ,
    businessHours: {},
    defaultAppointmentDuration: 30,
  };

  it("computes CLOSED from the schedule and says so, with the no-opening tail", async () => {
    const msg = await builtInAvailabilityMessage("org-1", SUNDAY, allClosed as never, 30);
    expect(msg).toContain("We're closed on Sundays.");
    expect(msg).toContain("take a message");
    expect(msg).not.toContain("no available appointments");
  });

  it("keeps the old generic copy when there is NO schedule row — we cannot say 'closed' truthfully", async () => {
    const msg = await builtInAvailabilityMessage("org-1", SUNDAY, null, 30);
    expect(msg).toContain("no available appointments");
  });
});
