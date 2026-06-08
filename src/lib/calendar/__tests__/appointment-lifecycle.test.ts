import { describe, it, expect } from "vitest";
import { assembleLifecycle, deriveChannel, pickName, describeChange } from "../appointment-lifecycle";
import type { LifecycleLeg } from "../appointment-lifecycle";

// LifecycleLeg factory for describeChange tests.
const leg = (over: Partial<LifecycleLeg> = {}): LifecycleLeg => ({
  id: "x", status: "confirmed",
  startTime: "2026-06-17T09:00:00Z", bookedAt: "2026-06-08T00:00:00Z",
  supersededAt: null, channel: "voice", practitioner: "Dr Chen",
  serviceType: "Check-up", isCurrent: false, ...over,
});

// Minimal appointment row factory (only the fields assembleLifecycle reads).
const row = (
  id: string,
  status: string,
  opts: { start?: string; created?: string; updated?: string; provider?: string; practitioner?: string } = {}
) => ({
  id,
  status,
  start_time: opts.start ?? `2026-06-1${id.length}T09:00:00Z`,
  created_at: opts.created ?? "2026-06-01T00:00:00Z",
  updated_at: opts.updated ?? "2026-06-02T00:00:00Z",
  provider: opts.provider ?? "internal",
  practitioners: opts.practitioner ? { name: opts.practitioner } : null,
  service_types: null,
});

describe("assembleLifecycle (SCRUM-389)", () => {
  it("returns null for a booking that was never moved (single leg)", () => {
    expect(assembleLifecycle([], row("A", "confirmed"), [])).toBeNull();
  });

  it("orders root → tip when the ROOT leg is opened", () => {
    // chain A(root) → B → C; opening A: ancestors=[], descendants walked child-first [B, C]
    const A = row("A", "rescheduled"), B = row("B", "rescheduled"), C = row("C", "confirmed");
    const legs = assembleLifecycle([], A, [B, C])!;
    expect(legs.map((l) => l.id)).toEqual(["A", "B", "C"]);
    expect(legs.find((l) => l.isCurrent)?.id).toBe("A");
  });

  it("orders root → tip when the TIP leg is opened (ancestors are parent-first, get reversed)", () => {
    // opening C: back-walk yields parent-first [B, A]; must render [A, B, C]
    const A = row("A", "rescheduled"), B = row("B", "rescheduled"), C = row("C", "confirmed");
    const legs = assembleLifecycle([B, A], C, [])!;
    expect(legs.map((l) => l.id)).toEqual(["A", "B", "C"]);
    expect(legs.find((l) => l.isCurrent)?.id).toBe("C");
  });

  it("orders root → tip when a MIDDLE leg is opened", () => {
    const A = row("A", "rescheduled"), B = row("B", "rescheduled"), C = row("C", "confirmed");
    const legs = assembleLifecycle([A], B, [C])!;
    expect(legs.map((l) => l.id)).toEqual(["A", "B", "C"]);
    expect(legs.find((l) => l.isCurrent)?.id).toBe("B");
    expect(legs.filter((l) => l.isCurrent)).toHaveLength(1); // exactly one current
  });

  it("sets supersededAt for moved/cancelled legs only, from updated_at", () => {
    const A = row("A", "rescheduled", { updated: "2026-06-05T00:00:00Z" });
    const C = row("C", "cancelled", { updated: "2026-06-07T00:00:00Z" });
    const mid = row("B", "confirmed", { updated: "2026-06-06T00:00:00Z" });
    const legs = assembleLifecycle([], A, [mid, C])!;
    expect(legs[0].supersededAt).toBe("2026-06-05T00:00:00Z"); // rescheduled → set
    expect(legs[1].supersededAt).toBeNull();                   // confirmed → null
    expect(legs[2].supersededAt).toBe("2026-06-07T00:00:00Z"); // cancelled → set
  });

  it("projects bookedAt from created_at and startTime from start_time", () => {
    const A = row("A", "rescheduled", { start: "2026-06-17T01:00:00Z", created: "2026-06-06T07:58:00Z" });
    const B = row("B", "confirmed");
    const [leg] = assembleLifecycle([], A, [B])!;
    expect(leg.startTime).toBe("2026-06-17T01:00:00Z");
    expect(leg.bookedAt).toBe("2026-06-06T07:58:00Z");
  });

  it("derives channel per leg", () => {
    const A = row("A", "rescheduled", { provider: "internal" });
    const B = row("B", "rescheduled", { provider: "manual" });
    const C = row("C", "confirmed", { provider: "cal_com" });
    const legs = assembleLifecycle([], A, [B, C])!;
    expect(legs.map((l) => l.channel)).toEqual(["voice", "dashboard", "cal_com"]);
  });

  it("projects practitioner per leg (so the UI can show a doctor change)", () => {
    // Same time, different doctor — the case the timeline must distinguish.
    const A = row("A", "rescheduled", { start: "2026-06-17T09:00:00Z", practitioner: "Dr Sarah Chen" });
    const B = row("B", "confirmed", { start: "2026-06-17T09:00:00Z", practitioner: "Lisa Thompson" });
    const legs = assembleLifecycle([], A, [B])!;
    expect(legs.map((l) => l.practitioner)).toEqual(["Dr Sarah Chen", "Lisa Thompson"]);
    expect(legs[0].startTime).toBe(legs[1].startTime); // same time, doctor differs
  });

  it("handles a missing practitioner relation as null", () => {
    const A = row("A", "rescheduled");
    const B = row("B", "confirmed");
    const legs = assembleLifecycle([], A, [B])!;
    expect(legs.every((l) => l.practitioner === null)).toBe(true);
  });
});

describe("describeChange (SCRUM-391)", () => {
  it("labels the root leg 'Booked', dated by bookedAt", () => {
    const l = leg({ bookedAt: "2026-06-01T00:00:00Z" });
    expect(describeChange(l, null)).toEqual({ label: "Booked", at: "2026-06-01T00:00:00Z" });
  });

  it("detects a time-only change", () => {
    const prev = leg({ startTime: "2026-06-18T01:00:00Z" });
    const cur = leg({ startTime: "2026-06-18T02:30:00Z", bookedAt: "2026-06-08T10:00:00Z" });
    expect(describeChange(cur, prev)).toEqual({ label: "Time changed", at: "2026-06-08T10:00:00Z" });
  });

  it("detects a doctor-only change at the same time (the reported case)", () => {
    const prev = leg({ practitioner: "Dr Sarah Chen" });
    const cur = leg({ practitioner: "Lisa Thompson" }); // same startTime
    expect(describeChange(cur, prev).label).toBe("Doctor changed");
  });

  it("detects a service-only change", () => {
    const prev = leg({ serviceType: "Check-up" });
    const cur = leg({ serviceType: "Filling" });
    expect(describeChange(cur, prev).label).toBe("Service changed");
  });

  it("combines multiple changes", () => {
    const prev = leg({ startTime: "2026-06-18T01:00:00Z", practitioner: "Dr Chen" });
    const cur = leg({ startTime: "2026-06-18T02:30:00Z", practitioner: "Lisa Thompson" });
    expect(describeChange(cur, prev).label).toBe("Time & Doctor changed");
  });

  it("labels a cancelled leg 'Cancelled', dated by supersededAt", () => {
    const prev = leg();
    const cur = leg({ status: "cancelled", supersededAt: "2026-06-09T00:00:00Z" });
    expect(describeChange(cur, prev)).toEqual({ label: "Cancelled", at: "2026-06-09T00:00:00Z" });
  });

  it("falls back to 'Updated' when nothing tracked changed", () => {
    const prev = leg();
    const cur = leg(); // identical time/doctor/service
    expect(describeChange(cur, prev).label).toBe("Updated");
  });
});

describe("pickName (SCRUM-391)", () => {
  it("reads .name from an object, a one-element array, or null", () => {
    expect(pickName({ name: "Dr Chen" })).toBe("Dr Chen");
    expect(pickName([{ name: "Lisa Thompson" }])).toBe("Lisa Thompson");
    expect(pickName(null)).toBeNull();
    expect(pickName(undefined)).toBeNull();
    expect(pickName([])).toBeNull();
  });
});

describe("deriveChannel (SCRUM-389)", () => {
  it("maps providers to channels", () => {
    expect(deriveChannel({ provider: "internal" })).toBe("voice");
    expect(deriveChannel({ provider: "manual" })).toBe("dashboard");
    expect(deriveChannel({ provider: "cal_com" })).toBe("cal_com");
    expect(deriveChannel({ provider: "google_calendar" })).toBe("google_calendar");
    expect(deriveChannel({ provider: null })).toBe("voice");
    expect(deriveChannel({})).toBe("voice");
  });
});
