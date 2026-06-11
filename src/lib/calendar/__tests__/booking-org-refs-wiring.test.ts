import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-425 (audit finding #43) wiring guard: the AI booking path must reject
// LLM/caller-supplied service_type_id / practitioner_id that don't belong to
// the call's organization — BEFORE the appointments insert. The pure
// validator is unit-tested in validate-org-scoped-refs.test.ts; this guards
// the bookInternal choke point (which both booking and reschedule route
// through — the reschedule leg is pinned explicitly below so a future
// in-place-UPDATE refactor can't silently drop the gate).

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { handleBookAppointment, handleRescheduleAppointment } from "@/lib/calendar/tool-handlers";

type Result = { data: unknown; error: { message?: string; code?: string } | null };

// Thenable builder that serves call-ordered results per table. Tracks
// whether .insert() was ever reached.
function fakeAdmin(tableQueues: Record<string, Result[]>, calls: { inserted?: boolean; mutated?: boolean }) {
  return {
    from: (table: string) => {
      const result: Result = tableQueues[table]?.shift() ?? { data: null, error: null };
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain, eq: chain, in: chain, is: chain, not: chain, gte: chain, lte: chain,
        lt: chain, gt: chain, order: chain, limit: chain,
        single: async () => result,
        maybeSingle: async () => result,
        insert: () => {
          calls.inserted = true;
          return b;
        },
        update: () => {
          calls.mutated = true;
          return b;
        },
        delete: () => {
          calls.mutated = true;
          return b;
        },
        then: (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(onF, onR),
      });
      return b;
    },
  };
}

const ORG = "org-1";
const FOREIGN_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BOOK_ARGS = {
  datetime: "2027-07-01T10:00:00",
  first_name: "Jane",
  last_name: "Smith",
  phone: "+61412345678",
};

describe("voice booking org-ref enforcement (SCRUM-425)", () => {
  const calls: { inserted?: boolean; mutated?: boolean } = {};
  beforeEach(() => {
    vi.clearAllMocks();
    calls.inserted = undefined;
    calls.mutated = undefined;
  });

  it("rejects a cross-org practitioner_id and never inserts", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          // getActiveServiceTypes → org HAS service types, so the built-in
          // booking path (bookInternal) is taken.
          service_types: [{ data: [{ id: "st-1", name: "Checkup", duration_minutes: 30 }], error: null }],
          // validateOrgScopedRefs: practitioner lookup scoped to org-1 → no row.
          practitioners: [{ data: null, error: null }],
        },
        calls,
      ) as never,
    );

    const result = await handleBookAppointment(ORG, {
      ...BOOK_ARGS,
      practitioner_id: FOREIGN_UUID, // another org's practitioner
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/couldn't match/i);
    expect(calls.inserted).toBeUndefined();
  });

  it("rejects a cross-org service_type_id and never inserts", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          service_types: [
            // getActiveServiceTypes (org's list)
            { data: [{ id: "st-1", name: "Checkup", duration_minutes: 30 }], error: null },
            // getServiceType for the foreign id, org-scoped → no row
            { data: null, error: { message: "no rows", code: "PGRST116" } },
            // validateOrgScopedRefs lookup, org-scoped → no row
            { data: null, error: null },
          ],
        },
        calls,
      ) as never,
    );

    const result = await handleBookAppointment(ORG, {
      ...BOOK_ARGS,
      service_type_id: FOREIGN_UUID, // another org's service type
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/couldn't match/i);
    expect(calls.inserted).toBeUndefined();
  });

  it("fails CLOSED (graceful message, no insert) when the ref validation query errors", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          service_types: [{ data: [{ id: "st-1", name: "Checkup", duration_minutes: 30 }], error: null }],
          practitioners: [{ data: null, error: { message: "db down" } }],
        },
        calls,
      ) as never,
    );

    const result = await handleBookAppointment(ORG, {
      ...BOOK_ARGS,
      practitioner_id: FOREIGN_UUID,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/trouble verifying/i);
    expect(calls.inserted).toBeUndefined();
  });

  it("rejects a malformed practitioner_id before any DB lookup", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({}, calls) as never);

    const result = await handleBookAppointment(ORG, {
      ...BOOK_ARGS,
      practitioner_id: "robert'); DROP TABLE practitioners;--",
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/which practitioner/i);
    expect(calls.inserted).toBeUndefined();
  });

  it("valid org-owned refs proceed PAST the ref gate (blocked later by schedule, not by validation)", async () => {
    const OWNED_UUID = "11111111-2222-4333-8444-555555555555";
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          service_types: [
            { data: [{ id: OWNED_UUID, name: "Checkup", duration_minutes: 30 }], error: null }, // active list
            { data: { id: OWNED_UUID, name: "Checkup", duration_minutes: 30 }, error: null },   // getServiceType
            { data: { id: OWNED_UUID }, error: null },                                          // validator: owned ✓
          ],
          // getOrgSchedule then fails — proving we got PAST the ref gate.
          organizations: [{ data: null, error: { message: "schedule unavailable" } }],
        },
        calls,
      ) as never,
    );

    const result = await handleBookAppointment(ORG, {
      ...BOOK_ARGS,
      service_type_id: OWNED_UUID,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/trouble accessing our schedule/i); // NOT the ref-rejection message
    expect(calls.inserted).toBeUndefined();
  });

  it("RESCHEDULE leg: a cross-org practitioner_id is rejected, nothing inserted, old appointment untouched", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          // getOrgSchedule → error is fine (caught, falls back to default tz)
          organizations: [{ data: null, error: { message: "no schedule" } }],
          // confirmation-code lookup finds exactly one upcoming appointment
          appointments: [
            {
              data: [{
                id: "appt-1",
                start_time: "2027-07-01T00:00:00Z",
                attendee_name: "Jane Smith",
                attendee_phone: "+61412345678",
                attendee_email: null,
                service_type_id: null,
                practitioner_id: null,
                notes: null,
                external_id: null,
                provider: "internal",
                metadata: {},
                confirmation_code: "123456",
                status: "confirmed",
                created_at: "2026-06-01T00:00:00Z",
              }],
              error: null,
            },
          ],
          // handleBookAppointment: org has service types → built-in path
          service_types: [{ data: [{ id: "st-1", name: "Checkup", duration_minutes: 30 }], error: null }],
          // step-0 gate: practitioner not in this org
          practitioners: [{ data: null, error: null }],
        },
        calls,
      ) as never,
    );

    const result = await handleRescheduleAppointment(ORG, {
      confirmation_code: "123456",
      phone: "+61412345678",
      new_datetime: "2027-07-02T10:00:00",
      practitioner_id: FOREIGN_UUID, // another org's practitioner carried into the new leg
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/couldn't match/i);
    expect(calls.inserted).toBeUndefined(); // new leg never booked
    expect(calls.mutated).toBeUndefined();  // old appointment never cancelled/updated
  });
});

// ─── SCRUM-444: inactive refs + null service type ───────────────────────────
//
// A filter-AWARE fake: results depend on which .eq() filters the code applied,
// so a regression that drops `requireActive` (the is_active filter) makes the
// "deactivated" practitioner resolvable again and the test fails on the
// downstream canary (organizations errors → a different message). Touches are
// logged per (table, method) so early rejection can be proven, not assumed.

type Touch = { table: string; method: string; eqs: Array<[string, unknown]> };

function activeAwareAdmin(
  handlers: Record<string, (method: string, eqs: Array<[string, unknown]>) => Result>,
  log: { touches: Touch[]; inserted?: boolean },
) {
  return {
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      const chain = () => b;
      const resolve = (method: string): Result => {
        log.touches.push({ table, method, eqs });
        return handlers[table]?.(method, eqs) ?? { data: null, error: null };
      };
      Object.assign(b, {
        select: chain, in: chain, is: chain, not: chain, gte: chain, lte: chain,
        lt: chain, gt: chain, order: chain, limit: chain,
        eq: (col: string, val: unknown) => {
          eqs.push([col, val]);
          return b;
        },
        insert: () => {
          if (table === "appointments") log.inserted = true;
          return b;
        },
        single: async () => resolve("single"),
        maybeSingle: async () => resolve("maybeSingle"),
        then: (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(resolve("then")).then(onF, onR),
      });
      return b;
    },
  };
}

describe("voice booking inactive-ref enforcement (SCRUM-444)", () => {
  const SERVICE = "22222222-3333-4444-8555-666666666666";
  const INACTIVE_PRAC = "33333333-4444-4555-8666-777777777777";
  const log: { touches: Touch[]; inserted?: boolean } = { touches: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    log.touches = [];
    log.inserted = undefined;
  });

  it("rejects an org-owned but DEACTIVATED practitioner on the empty-practitioner-list branch", async () => {
    // Service type is valid+active but has NO practitioner associations, so the
    // per-service membership check is skipped — before SCRUM-444 nothing on
    // this branch verified is_active and the deactivated practitioner booked.
    vi.mocked(createAdminClient).mockReturnValue(
      activeAwareAdmin(
        {
          service_types: (method) => {
            if (method === "single") return { data: { id: SERVICE, name: "Checkup", duration_minutes: 30 }, error: null }; // getServiceType
            if (method === "maybeSingle") return { data: { id: SERVICE }, error: null }; // validator (service is active)
            return { data: [{ id: SERVICE, name: "Checkup", duration_minutes: 30 }], error: null }; // getActiveServiceTypes
          },
          practitioners: (method, eqs) => {
            if (method === "maybeSingle") {
              // The row EXISTS and is org-owned, but is_active=false — found
              // only when the validator does NOT filter on is_active.
              const activeFiltered = eqs.some(([c, v]) => c === "is_active" && v === true);
              return activeFiltered ? { data: null, error: null } : { data: { id: INACTIVE_PRAC }, error: null };
            }
            return { data: [], error: null }; // getPractitionersForService → empty list
          },
          // Canary: if the gate wrongly passes, getOrgSchedule errors and the
          // caller sees "trouble accessing our schedule" — failing the message
          // assertion below instead of silently passing.
          organizations: () => ({ data: null, error: { message: "should never get here" } }),
        },
        log,
      ) as never,
    );

    const result = await handleBookAppointment(ORG, {
      ...BOOK_ARGS,
      service_type_id: SERVICE,
      practitioner_id: INACTIVE_PRAC,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/couldn't match/i);
    expect(log.inserted).toBeUndefined();
    // The rejection came from the is_active-filtered validator lookup.
    const validatorLookup = log.touches.find((t) => t.table === "practitioners" && t.method === "maybeSingle");
    expect(validatorLookup).toBeDefined();
    expect(validatorLookup!.eqs).toContainEqual(["is_active", true]);
  });

  it("rejects EARLY with a clean message when getServiceType resolves null (unknown/cross-org id)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      activeAwareAdmin(
        {
          service_types: (method) => {
            if (method === "single") return { data: null, error: { message: "no rows", code: "PGRST116" } }; // getServiceType → null
            if (method === "maybeSingle") return { data: { id: SERVICE }, error: null }; // validator (must NOT be reached)
            return { data: [{ id: "st-other", name: "Cleaning", duration_minutes: 30 }], error: null };
          },
          organizations: () => ({ data: null, error: { message: "should never get here" } }),
        },
        log,
      ) as never,
    );

    const result = await handleBookAppointment(ORG, {
      ...BOOK_ARGS,
      service_type_id: SERVICE,
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/couldn't match that appointment type/i);
    expect(log.inserted).toBeUndefined();
    // EARLY: rejected in handleBookAppointment — bookInternal's validator
    // (service_types maybeSingle) and schedule lookup were never reached.
    expect(log.touches.filter((t) => t.table === "service_types" && t.method === "maybeSingle")).toHaveLength(0);
    expect(log.touches.filter((t) => t.table === "organizations")).toHaveLength(0);
  });
});
