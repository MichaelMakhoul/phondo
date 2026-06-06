import { describe, it, expect } from "vitest";
import { ensureTimezoneOffset, toLocalIsoMinute, pickClosestAppointment } from "../tool-handlers";

describe("ensureTimezoneOffset", () => {
  // ── Already-offset datetimes should be returned unchanged ──────────────

  it("returns datetime with Z suffix unchanged", () => {
    expect(ensureTimezoneOffset("2026-02-18T10:00:00Z", "America/New_York")).toBe(
      "2026-02-18T10:00:00Z"
    );
  });

  it("returns datetime with positive offset unchanged", () => {
    expect(ensureTimezoneOffset("2026-02-18T10:00:00+11:00", "America/New_York")).toBe(
      "2026-02-18T10:00:00+11:00"
    );
  });

  it("returns datetime with negative offset unchanged", () => {
    expect(ensureTimezoneOffset("2026-02-18T10:00:00-05:00", "Australia/Sydney")).toBe(
      "2026-02-18T10:00:00-05:00"
    );
  });

  it("returns datetime with lowercase z unchanged", () => {
    expect(ensureTimezoneOffset("2026-02-18T10:00:00z", "America/New_York")).toBe(
      "2026-02-18T10:00:00z"
    );
  });

  // ── Naive datetimes get offset appended ────────────────────────────────

  it("appends UTC+0 offset for UTC timezone", () => {
    const result = ensureTimezoneOffset("2026-06-15T12:00:00", "UTC");
    expect(result).toBe("2026-06-15T12:00:00+00:00");
  });

  it("appends correct offset for America/New_York in winter (EST = -05:00)", () => {
    const result = ensureTimezoneOffset("2026-01-15T10:00:00", "America/New_York");
    expect(result).toBe("2026-01-15T10:00:00-05:00");
  });

  it("appends correct offset for America/New_York in summer (EDT = -04:00)", () => {
    const result = ensureTimezoneOffset("2026-07-15T10:00:00", "America/New_York");
    expect(result).toBe("2026-07-15T10:00:00-04:00");
  });

  it("appends correct offset for Australia/Sydney in winter (AEST = +10:00)", () => {
    // July is winter in Australia
    const result = ensureTimezoneOffset("2026-07-15T10:00:00", "Australia/Sydney");
    expect(result).toBe("2026-07-15T10:00:00+10:00");
  });

  it("appends correct offset for Australia/Sydney in summer (AEDT = +11:00)", () => {
    // February is summer in Australia
    const result = ensureTimezoneOffset("2026-02-18T10:00:00", "Australia/Sydney");
    expect(result).toBe("2026-02-18T10:00:00+11:00");
  });

  it("handles India (UTC+5:30) with half-hour offset", () => {
    const result = ensureTimezoneOffset("2026-06-15T14:00:00", "Asia/Kolkata");
    expect(result).toBe("2026-06-15T14:00:00+05:30");
  });

  it("handles Nepal (UTC+5:45) with 45-minute offset", () => {
    const result = ensureTimezoneOffset("2026-06-15T14:00:00", "Asia/Kathmandu");
    expect(result).toBe("2026-06-15T14:00:00+05:45");
  });

  // ── Month boundary crossing ────────────────────────────────────────────

  it("handles month boundary: UTC Jan 31 23:00 → Sydney Feb 1 (positive offset)", () => {
    // At 2026-01-31T23:00:00 UTC, Sydney is 2026-02-01T10:00:00 AEDT (+11)
    // So for a naive datetime of "2026-01-31T23:00:00" treated as UTC reference,
    // the offset for Sydney should be +11:00
    const result = ensureTimezoneOffset("2026-01-31T23:00:00", "Australia/Sydney");
    expect(result).toBe("2026-01-31T23:00:00+11:00");
  });

  it("handles month boundary: UTC Mar 1 01:00 → LA still Feb 28 (negative offset)", () => {
    // At 2026-03-01T01:00:00 UTC, LA is 2026-02-28T17:00:00 PST (-8)
    const result = ensureTimezoneOffset("2026-03-01T01:00:00", "America/Los_Angeles");
    expect(result).toBe("2026-03-01T01:00:00-08:00");
  });

  // ── Year boundary crossing ─────────────────────────────────────────────

  it("handles year boundary: UTC Dec 31 → Sydney Jan 1", () => {
    // At 2025-12-31T20:00:00 UTC, Sydney is 2026-01-01T07:00:00 AEDT (+11)
    const result = ensureTimezoneOffset("2025-12-31T20:00:00", "Australia/Sydney");
    expect(result).toBe("2025-12-31T20:00:00+11:00");
  });

  // ── Unparseable input ──────────────────────────────────────────────────

  it("returns unparseable datetime as-is", () => {
    expect(ensureTimezoneOffset("not-a-date", "America/New_York")).toBe("not-a-date");
  });

  it("returns empty string as-is", () => {
    expect(ensureTimezoneOffset("", "America/New_York")).toBe("");
  });

  // ── Invalid timezone ───────────────────────────────────────────────────

  it("throws RangeError for invalid IANA timezone", () => {
    expect(() =>
      ensureTimezoneOffset("2026-02-18T10:00:00", "Invalid/Timezone")
    ).toThrow(RangeError);
  });
});

describe("toLocalIsoMinute (SCRUM-381 cancel disambiguation)", () => {
  // ── Renders the local wall-clock time, not UTC ─────────────────────────

  it("renders a 12:00 PM Sydney appointment (stored as UTC) as local noon", () => {
    // 2026-02-18 12:00 Sydney AEDT (+11) is stored as 01:00 UTC.
    const stored = new Date("2026-02-18T01:00:00Z");
    expect(toLocalIsoMinute(stored, "Australia/Sydney")).toBe("2026-02-18T12:00");
  });

  it("renders a 9:00 AM Sydney appointment distinctly from the 12:00 PM one", () => {
    // The exact bug scenario: a 9am and a 12pm same-day appointment must yield
    // two DIFFERENT datetime strings so the model can pin the right one.
    const nineAm = new Date("2026-02-17T22:00:00Z"); // 09:00 Sydney AEDT
    const twelvePm = new Date("2026-02-18T01:00:00Z"); // 12:00 Sydney AEDT
    expect(toLocalIsoMinute(nineAm, "Australia/Sydney")).toBe("2026-02-18T09:00");
    expect(toLocalIsoMinute(twelvePm, "Australia/Sydney")).toBe("2026-02-18T12:00");
    expect(toLocalIsoMinute(nineAm, "Australia/Sydney")).not.toBe(
      toLocalIsoMinute(twelvePm, "Australia/Sydney")
    );
  });

  it("normalises midnight to 00 (not 24) under 24-hour formatting", () => {
    // 2026-02-18 00:00 Sydney AEDT (+11) is stored as 2026-02-17 13:00 UTC.
    const midnight = new Date("2026-02-17T13:00:00Z");
    expect(toLocalIsoMinute(midnight, "Australia/Sydney")).toBe("2026-02-18T00:00");
  });

  it("handles a half-hour-offset timezone (India UTC+5:30)", () => {
    // 14:00 IST is 08:30 UTC.
    const stored = new Date("2026-06-15T08:30:00Z");
    expect(toLocalIsoMinute(stored, "Asia/Kolkata")).toBe("2026-06-15T14:00");
  });

  // ── Round-trip invariant: the value handed to the model re-pins the row ──

  it("round-trips with ensureTimezoneOffset (Sydney summer)", () => {
    // This is the property the fix relies on: the disambiguation message hands
    // the model toLocalIsoMinute(start_time); the model passes it back; the
    // cancel handler runs ensureTimezoneOffset on it and lands on the SAME
    // instant (within the ±15-min match window) — pinning exactly that row.
    const naive = "2026-02-18T12:00";
    const withOffset = ensureTimezoneOffset(`${naive}:00`, "Australia/Sydney");
    const instant = new Date(withOffset);
    expect(toLocalIsoMinute(instant, "Australia/Sydney")).toBe(naive);
  });

  it("round-trips with ensureTimezoneOffset (New York winter / DST-off)", () => {
    const naive = "2026-01-15T10:00";
    const withOffset = ensureTimezoneOffset(`${naive}:00`, "America/New_York");
    const instant = new Date(withOffset);
    expect(toLocalIsoMinute(instant, "America/New_York")).toBe(naive);
  });

  it("produces a string the cancel/reschedule datetime regex accepts", () => {
    // Tools gate datetime on /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ — the output must match.
    const out = toLocalIsoMinute(new Date("2026-02-18T01:00:00Z"), "Australia/Sydney");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe("pickClosestAppointment (SCRUM-381 disambiguation convergence)", () => {
  const a9 = { id: "a9", start_time: "2026-02-17T22:00:00Z" }; // 09:00 Sydney
  const a12 = { id: "a12", start_time: "2026-02-18T01:00:00Z" }; // 12:00 Sydney
  const a1210 = { id: "a1210", start_time: "2026-02-18T01:10:00Z" }; // 12:10 Sydney (10 min later)

  it("returns null for an empty list", () => {
    expect(pickClosestAppointment([], Date.now())).toBeNull();
  });

  it("picks the appointment nearest the target instant", () => {
    const target = new Date("2026-02-18T01:00:00Z").getTime();
    expect(pickClosestAppointment([a9, a12], target)?.id).toBe("a12");
  });

  it("resolves two appointments <15 min apart (the loop-forever case)", () => {
    const target = new Date("2026-02-18T01:09:00Z").getTime(); // closest to 12:10
    expect(pickClosestAppointment([a12, a1210], target)?.id).toBe("a1210");
  });

  it("end-to-end: each disambiguation option re-pins ITSELF (no cross-pinning)", () => {
    // The property guaranteeing convergence: the disambiguation message lists
    // toLocalIsoMinute(start_time) per appointment; whichever the model echoes
    // back, parsed via ensureTimezoneOffset, must select that SAME appointment.
    const tz = "Australia/Sydney";
    const set = [a9, a12, a1210];
    for (const appt of set) {
      const echoed = toLocalIsoMinute(new Date(appt.start_time), tz); // what the AI sends back
      const targetMs = new Date(ensureTimezoneOffset(echoed, tz)).getTime(); // handler parse
      expect(pickClosestAppointment(set, targetMs)?.id).toBe(appt.id);
    }
  });
});
