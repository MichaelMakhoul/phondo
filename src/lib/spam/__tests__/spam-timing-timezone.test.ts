import { describe, it, expect } from "vitest";
import { analyzeCallTiming } from "@/lib/spam/spam-detector";

// SCRUM-418 (audit finding #20): the "unusual hours" spam signal must be
// computed in the ORG's timezone, not server-local/UTC. On Vercel (UTC) a
// 10am Sydney call is 00:00 UTC — previously scored +15 as a late-night call,
// while a genuine 3am Sydney call (17:00 UTC) scored 0.

describe("analyzeCallTiming org-timezone scoring (SCRUM-418)", () => {
  it("scores 0 for a 10am Sydney call (which is midnight UTC)", () => {
    // 2026-06-15T00:00:00Z == 10:00 AEST (winter, UTC+10)
    const r = analyzeCallTiming(new Date("2026-06-15T00:00:00Z"), "Australia/Sydney");
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("flags a genuine 3am Sydney call (which is 5pm UTC)", () => {
    // 2026-06-15T17:00:00Z == 03:00 AEST next day
    const r = analyzeCallTiming(new Date("2026-06-15T17:00:00Z"), "Australia/Sydney");
    expect(r.score).toBe(15);
    expect(r.reasons[0]).toMatch(/unusual hours/i);
  });

  it("flags a late-evening (10pm) Sydney call with the lower score", () => {
    // 2026-06-15T12:00:00Z == 22:00 AEST
    const r = analyzeCallTiming(new Date("2026-06-15T12:00:00Z"), "Australia/Sydney");
    expect(r.score).toBe(10);
    expect(r.reasons[0]).toMatch(/late evening/i);
  });

  it("scores a US org in its own zone (2pm New York business call = 0)", () => {
    // 2026-06-15T18:00:00Z == 14:00 EDT (summer, UTC-4)
    const r = analyzeCallTiming(new Date("2026-06-15T18:00:00Z"), "America/New_York");
    expect(r.score).toBe(0);
  });

  it("flags a 2am New York call", () => {
    // 2026-06-15T06:00:00Z == 02:00 EDT
    const r = analyzeCallTiming(new Date("2026-06-15T06:00:00Z"), "America/New_York");
    expect(r.score).toBe(15);
  });

  it("drops the signal entirely when no timezone is provided (never scores UTC)", () => {
    // Midnight UTC — would have scored +15 under the old behavior.
    const r = analyzeCallTiming(new Date("2026-06-15T00:00:00Z"), undefined);
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("drops the signal for an invalid timezone identifier", () => {
    const r = analyzeCallTiming(new Date("2026-06-15T00:00:00Z"), "Not/AZone");
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("handles midnight in-zone correctly (ICU h23 guard)", () => {
    // 2026-06-15T14:00:00Z == 00:00 AEST — must parse as hour 0, not 24.
    const r = analyzeCallTiming(new Date("2026-06-15T14:00:00Z"), "Australia/Sydney");
    expect(r.score).toBe(15); // midnight IS unusual hours
    expect(r.reasons[0]).toMatch(/unusual hours/i);
  });
});
