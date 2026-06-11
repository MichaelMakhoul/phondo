import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-417 (audit finding #16): round-robin auto-assign must exclude a
// practitioner who has time off (a practitioner-specific blocked_times row)
// overlapping the requested slot — not just one with a conflicting appointment.
// The DB only enforces appointment overlaps, so this exclusion lives in code.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { pickPractitionerRoundRobin } from "@/lib/calendar/tool-handlers";

// A thenable query builder: every chained method returns itself, and awaiting
// it resolves to the configured { data, error } for that query.
function builder(resolve: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain, eq: chain, in: chain, lt: chain, gt: chain, gte: chain, not: chain, order: chain, limit: chain,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(resolve).then(onF, onR),
  });
  return b;
}

// appointments is queried twice (overlap conflicts, then upcoming counts);
// blocked_times once. Serve table-specific, call-ordered results.
function fakeAdmin(opts: {
  conflicting?: unknown[];
  blocks?: unknown[];
  upcoming?: unknown[];
  blockErr?: unknown;
}) {
  const apptResults = [
    { data: opts.conflicting ?? [], error: null },
    { data: opts.upcoming ?? [], error: null },
  ];
  let apptIdx = 0;
  return {
    from: (table: string) => {
      if (table === "appointments") return builder(apptResults[apptIdx++] ?? { data: [], error: null });
      if (table === "blocked_times") return builder({ data: opts.blocks ?? [], error: opts.blockErr ?? null });
      return builder({ data: [], error: null });
    },
  };
}

const SLOT_START = new Date("2026-07-15T02:00:00Z");
const SLOT_END = new Date("2026-07-15T02:30:00Z");

describe("pickPractitionerRoundRobin blocked_times exclusion (SCRUM-417)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("excludes a practitioner whose time off overlaps the slot", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        blocks: [{ practitioner_id: "p1" }], // p1 is on time off
      }) as never,
    );

    const picked = await pickPractitionerRoundRobin("org-1", ["p1", "p2"], SLOT_START, SLOT_END);
    expect(picked).toBe("p2");
  });

  it("excludes practitioners busy via appointment OR via blocked time", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        conflicting: [{ practitioner_id: "p1" }], // p1 already booked
        blocks: [{ practitioner_id: "p2" }],       // p2 on time off
      }) as never,
    );

    const picked = await pickPractitionerRoundRobin("org-1", ["p1", "p2", "p3"], SLOT_START, SLOT_END);
    expect(picked).toBe("p3");
  });

  it("returns null when every practitioner is blocked", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        blocks: [{ practitioner_id: "p1" }, { practitioner_id: "p2" }],
      }) as never,
    );

    const picked = await pickPractitionerRoundRobin("org-1", ["p1", "p2"], SLOT_START, SLOT_END);
    expect(picked).toBeNull();
  });

  it("fails CLOSED (declines auto-assign) when the blocked_times query errors", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        blocks: [],
        blockErr: { message: "db down" },
      }) as never,
    );

    // Multiple candidates, no appointment conflict — but the block check errored,
    // so time off is unverifiable. blocked_times has no DB backstop, so we must
    // NOT book over a possible block: return null → caller picks another time.
    const picked = await pickPractitionerRoundRobin("org-1", ["p1", "p2"], SLOT_START, SLOT_END);
    expect(picked).toBeNull();
  });

  it("breaks ties by fewest upcoming appointments among the unblocked", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        blocks: [{ practitioner_id: "p1" }],          // p1 out → p2 vs p3 by count
        upcoming: [{ practitioner_id: "p2" }, { practitioner_id: "p2" }], // p2 busier
      }) as never,
    );

    const picked = await pickPractitionerRoundRobin("org-1", ["p1", "p2", "p3"], SLOT_START, SLOT_END);
    expect(picked).toBe("p3");
  });
});
