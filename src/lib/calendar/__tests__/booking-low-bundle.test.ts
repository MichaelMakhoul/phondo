import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isAllowedStatusTransition } from "@/lib/calendar/appointment-lifecycle";

// SCRUM-431 (audit findings #49/#51/#52).

describe("isAllowedStatusTransition (finding #52)", () => {
  it("allows the dashboard's shipped affordances (Complete/No Show/Cancel/Revert)", () => {
    expect(isAllowedStatusTransition("pending", "confirmed")).toBe(true);
    expect(isAllowedStatusTransition("pending", "cancelled")).toBe(true);
    expect(isAllowedStatusTransition("pending", "completed")).toBe(true);
    expect(isAllowedStatusTransition("pending", "no_show")).toBe(true);
    expect(isAllowedStatusTransition("confirmed", "completed")).toBe(true);
    expect(isAllowedStatusTransition("confirmed", "cancelled")).toBe(true);
    expect(isAllowedStatusTransition("confirmed", "no_show")).toBe(true);
    // Human corrections — the "Revert to Confirmed" undo and the
    // attendance flip both ways:
    expect(isAllowedStatusTransition("completed", "confirmed")).toBe(true);
    expect(isAllowedStatusTransition("completed", "no_show")).toBe(true);
    expect(isAllowedStatusTransition("no_show", "completed")).toBe(true);
    expect(isAllowedStatusTransition("no_show", "confirmed")).toBe(true);
    // Mis-cancel undo — slot conflicts are re-checked by the DB exclusion
    // constraint (23P01 → clean 409 in the PATCH):
    expect(isAllowedStatusTransition("cancelled", "confirmed")).toBe(true);
  });

  it("treats same-status writes as no-ops", () => {
    for (const s of ["pending", "confirmed", "completed", "cancelled", "rescheduled", "no_show"]) {
      expect(isAllowedStatusTransition(s, s)).toBe(true);
    }
  });

  it("blocks time-travel and supersede-chain corruption (the audit's scenarios)", () => {
    expect(isAllowedStatusTransition("completed", "pending")).toBe(false);
    expect(isAllowedStatusTransition("cancelled", "pending")).toBe(false);
    expect(isAllowedStatusTransition("cancelled", "completed")).toBe(false);
    // rescheduled is the ONE hard-terminal status — its slot lives on in a
    // successor row; reviving it duplicates the booking (SCRUM-388):
    expect(isAllowedStatusTransition("rescheduled", "confirmed")).toBe(false);
    expect(isAllowedStatusTransition("rescheduled", "pending")).toBe(false);
    expect(isAllowedStatusTransition("rescheduled", "cancelled")).toBe(false);
  });

  it("fails closed for unknown statuses", () => {
    expect(isAllowedStatusTransition("garbage", "confirmed")).toBe(false);
  });
});

// ─── finding #49: confirmation-code collision retry (wiring) ────────────────

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { handleBookAppointment } from "@/lib/calendar/tool-handlers";

type Result = { data: unknown; error: { message?: string; code?: string } | null };

/** Table-queue fake whose appointments INSERTs consume a result queue. */
function fakeAdmin(tableQueues: Record<string, Result[]>, insertQueue: Result[], counts: { inserts: number }) {
  return {
    from: (table: string) => {
      const isInsertTarget = table === "appointments";
      let result: Result = tableQueues[table]?.shift() ?? { data: null, error: null };
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain, eq: chain, in: chain, is: chain, not: chain, gte: chain, lte: chain,
        lt: chain, gt: chain, order: chain, limit: chain,
        insert: () => {
          if (isInsertTarget) {
            counts.inserts++;
            result = insertQueue.shift() ?? { data: null, error: { message: "insert queue empty" } };
          }
          return b;
        },
        single: async () => result,
        maybeSingle: async () => result,
        then: (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(onF, onR),
      });
      return b;
    },
  };
}

const BOOK_ARGS = {
  datetime: "2027-01-15T10:00:00",
  first_name: "Jane",
  last_name: "Smith",
  phone: "+61412345678",
};

const CODE_COLLISION: Result = {
  data: null,
  error: { code: "23505", message: 'duplicate key value violates unique constraint "appointments_confirmation_code_key"' },
};

function baseTables(): Record<string, Result[]> {
  return {
    // getActiveServiceTypes → none, so no service-type plumbing needed; org
    // has none → falls through to built-in booking (no Cal.com client).
    service_types: [{ data: [], error: null }],
    calendar_integrations: [{ data: null, error: null }], // no Cal.com
    // getOrgSchedule — open all day on the booked Friday (2027-01-15)
    organizations: [
      {
        data: {
          business_hours: { friday: { open: "00:00", close: "23:59" } },
          timezone: "Australia/Sydney",
          default_appointment_duration: 30,
        },
        error: null,
      },
    ],
    // conflict / blocked-time lookups inside bookInternal resolve empty
    appointments: [],
    blocked_times: [],
  };
}

describe("confirmation-code collision retry (finding #49)", () => {
  const counts = { inserts: 0 };
  beforeEach(() => {
    vi.clearAllMocks();
    counts.inserts = 0;
    // Freeze time so the hard-coded Friday fixture (2027-01-15) never
    // becomes "the past" and the horizon test never expires.
    vi.useFakeTimers({ now: new Date("2026-06-12T00:00:00Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries with a fresh code on a 23505 naming the code constraint", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        baseTables(),
        [CODE_COLLISION, { data: { id: "appt-1", confirmation_code: "654321" }, error: null }],
        counts,
      ) as never,
    );

    const result = await handleBookAppointment("org-1", BOOK_ARGS);
    expect(result.success).toBe(true);
    expect(counts.inserts).toBe(2); // collision, then success
  });

  it("gives up gracefully after repeated collisions", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(baseTables(), [CODE_COLLISION, CODE_COLLISION, CODE_COLLISION], counts) as never,
    );

    const result = await handleBookAppointment("org-1", BOOK_ARGS);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/trouble completing the booking/i);
    // SCRUM-509: collision-exhausted is a GENUINE failure — must carry the flag
    // so the voice server emits [ALERT:error] (not a silent 200 + success:false).
    expect((result as { error?: boolean }).error).toBe(true);
    expect(counts.inserts).toBe(3);
  });

  it("does NOT retry a non-code 23505 or an overlap 23P01", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        baseTables(),
        [{ data: null, error: { code: "23P01", message: "conflicting key value violates exclusion constraint" } }],
        counts,
      ) as never,
    );

    const result = await handleBookAppointment("org-1", BOOK_ARGS);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no longer available/i);
    expect(counts.inserts).toBe(1);
  });

  it("flags a genuine insert failure (non-constraint DB error) with error:true", async () => {
    // SCRUM-509: a plain insert fault (e.g. connection drop) is the single most
    // likely real booking failure. It must return success:false + error:true so
    // the voice server alerts — NOT a silent graceful 200. Distinct from the
    // 23P01 overlap above, which is a business "slot taken" and stays unflagged.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        baseTables(),
        [{ data: null, error: { code: "08006", message: "connection failure" } }],
        counts,
      ) as never,
    );

    const result = await handleBookAppointment("org-1", BOOK_ARGS);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/trouble completing the booking/i);
    expect((result as { error?: boolean }).error).toBe(true);
    expect(counts.inserts).toBe(1); // no retry on a non-code error
  });
});

describe("booking horizon cap (finding #51)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-06-12T00:00:00Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a booking more than a year out", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(baseTables(), [], { inserts: 0 }) as never,
    );

    const result = await handleBookAppointment("org-1", {
      ...BOOK_ARGS,
      datetime: "2031-01-15T10:00:00", // years away
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/up to a year in advance/i);
  });
});
