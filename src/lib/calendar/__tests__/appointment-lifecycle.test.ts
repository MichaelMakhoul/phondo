import { describe, it, expect } from "vitest";
import { assembleLifecycle, deriveChannel } from "../appointment-lifecycle";

// Minimal appointment row factory (only the fields assembleLifecycle reads).
const row = (
  id: string,
  status: string,
  opts: { start?: string; created?: string; updated?: string; provider?: string } = {}
) => ({
  id,
  status,
  start_time: opts.start ?? `2026-06-1${id.length}T09:00:00Z`,
  created_at: opts.created ?? "2026-06-01T00:00:00Z",
  updated_at: opts.updated ?? "2026-06-02T00:00:00Z",
  provider: opts.provider ?? "internal",
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
