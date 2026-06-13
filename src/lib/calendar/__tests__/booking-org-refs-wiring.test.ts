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
// The SCRUM-444-review reschedule test below runs to a full SUCCESS, so the
// post-booking side effects (notification, confirmation/cancellation SMS,
// voice-cache invalidation) must be hermetic stubs — they're not under test.
vi.mock("@/lib/notifications/notification-service", () => ({
  sendAppointmentNotification: vi.fn(async () => {}),
}));
vi.mock("@/lib/sms/caller-sms", () => ({
  sendAppointmentConfirmationSMS: vi.fn(async () => ({ sent: true })),
  sendCancellationSMS: vi.fn(async () => {}),
}));
vi.mock("@/lib/voice-cache/invalidate", () => ({
  invalidateVoiceScheduleCache: vi.fn(async () => {}),
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

type Touch = { table: string; method: string; op: "select" | "insert" | "update"; eqs: Array<[string, unknown]> };

function activeAwareAdmin(
  handlers: Record<string, (method: string, eqs: Array<[string, unknown]>, op: Touch["op"]) => Result>,
  log: { touches: Touch[]; inserted?: boolean },
) {
  return {
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      let op: Touch["op"] = "select";
      const b: Record<string, unknown> = {};
      const chain = () => b;
      const resolve = (method: string): Result => {
        log.touches.push({ table, method, op, eqs });
        return handlers[table]?.(method, eqs, op) ?? { data: null, error: null };
      };
      Object.assign(b, {
        select: chain, in: chain, is: chain, not: chain, gte: chain, lte: chain,
        lt: chain, gt: chain, order: chain, limit: chain,
        eq: (col: string, val: unknown) => {
          eqs.push([col, val]);
          return b;
        },
        insert: () => {
          op = "insert";
          if (table === "appointments") log.inserted = true;
          return b;
        },
        update: () => {
          op = "update";
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

  it("SECURITY: a carried_refs claim smuggled into args is INERT — the is_active gate still fires", async () => {
    // SCRUM-444 review (authorization-bypass finding): the carried-refs signal
    // lives in handleBookAppointment's dedicated `internal` param, NOT in `args`
    // (which is populated from the LLM tool-call payload). A model that injects
    // carried_refs into its book_appointment arguments to mark a freshly-chosen
    // deactivated practitioner as "carried" must NOT disable requireActive.
    vi.mocked(createAdminClient).mockReturnValue(
      activeAwareAdmin(
        {
          service_types: (method) => {
            if (method === "single") return { data: { id: SERVICE, name: "Checkup", duration_minutes: 30 }, error: null };
            if (method === "maybeSingle") return { data: { id: SERVICE }, error: null };
            return { data: [{ id: SERVICE, name: "Checkup", duration_minutes: 30 }], error: null };
          },
          practitioners: (method, eqs) => {
            if (method === "maybeSingle") {
              const activeFiltered = eqs.some(([c, v]) => c === "is_active" && v === true);
              return activeFiltered ? { data: null, error: null } : { data: { id: INACTIVE_PRAC }, error: null };
            }
            return { data: [], error: null };
          },
          organizations: () => ({ data: null, error: { message: "should never get here" } }),
        },
        log,
      ) as never,
    );

    // `carried_refs` is not in the args type — cast to smuggle it the way a
    // malicious tool-call payload would, and confirm the handler ignores it.
    const result = await handleBookAppointment(ORG, {
      ...BOOK_ARGS,
      service_type_id: SERVICE,
      practitioner_id: INACTIVE_PRAC,
      carried_refs: { practitioner: true, service_type: true },
    } as never);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/couldn't match/i);
    expect(log.inserted).toBeUndefined();
    // The is_active-filtered lookup still ran — the smuggled claim did nothing.
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

  it("rejects an org-owned but DEACTIVATED service type at bookInternal (two-step: getServiceType resolves it, the is_active-filtered validator rejects)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      activeAwareAdmin(
        {
          service_types: (method, eqs) => {
            // getServiceType (.single, NO is_active filter) RESOLVES the row …
            if (method === "single") return { data: { id: SERVICE, name: "Checkup", duration_minutes: 30 }, error: null };
            // … and bookInternal's is_active-filtered validator rejects it.
            if (method === "maybeSingle") {
              const activeFiltered = eqs.some(([c, v]) => c === "is_active" && v === true);
              return activeFiltered ? { data: null, error: null } : { data: { id: SERVICE }, error: null };
            }
            return { data: [{ id: "st-other", name: "Cleaning", duration_minutes: 30 }], error: null }; // active list
          },
          organizations: () => ({ data: null, error: { message: "should never get here" } }),
        },
        log,
      ) as never,
    );

    const result = await handleBookAppointment(ORG, { ...BOOK_ARGS, service_type_id: SERVICE });

    expect(result.success).toBe(false);
    // The bookInternal gate message — NOT the early "to this business" one,
    // proving the rejection happened at the validator, not at getServiceType.
    expect(result.message).toMatch(/what this business currently offers/i);
    expect(log.inserted).toBeUndefined();
    const validatorLookup = log.touches.find((t) => t.table === "service_types" && t.method === "maybeSingle");
    expect(validatorLookup).toBeDefined();
    expect(validatorLookup!.eqs).toContainEqual(["is_active", true]);
  });

  it("a REAL DB error on the service-type lookup says 'having trouble' — never 'that type doesn't exist'", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      activeAwareAdmin(
        {
          service_types: (method) => {
            // getServiceType hits a transient DB error (NOT PGRST116/not-found).
            if (method === "single") return { data: null, error: { message: "conn reset", code: "08006" } };
            return { data: [{ id: "st-other", name: "Cleaning", duration_minutes: 30 }], error: null };
          },
          organizations: () => ({ data: null, error: { message: "should never get here" } }),
        },
        log,
      ) as never,
    );

    const result = await handleBookAppointment(ORG, { ...BOOK_ARGS, service_type_id: SERVICE });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/having trouble/i);
    expect(result.message).not.toMatch(/couldn't match/i);
    expect(log.inserted).toBeUndefined();
  });
});

// ─── SCRUM-444 review: carried vs caller-supplied refs on a voice reschedule ─
//
// A reschedule books the new leg through bookInternal, carrying the existing
// appointment's service/practitioner unless the caller supplied new ones. A
// CARRIED ref must be validated org-scope-only (no is_active filter) — a
// time-only move of a booking whose service type was since deactivated must
// SUCCEED (before this fix it dead-ended unrecoverably: every retry re-carried
// the ref into the requireActive gate). A ref the caller EXPLICITLY picks
// still has to be active.

describe("voice reschedule with deactivated carried refs (SCRUM-444 review)", () => {
  const DEACTIVATED_SERVICE = "22222222-3333-4444-8555-666666666666";
  const OLD_APPT_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const NEW_APPT_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  // Naive local datetime ~14 days out — future, inside the 1-year horizon.
  const NEW_DT = new Date(Date.now() + 14 * 24 * 3600_000).toISOString().slice(0, 19);
  const log: { touches: Touch[]; inserted?: boolean } = { touches: [] };

  const existingRow = {
    id: OLD_APPT_ID,
    start_time: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
    attendee_name: "Jane Smith",
    attendee_phone: "+61412345678",
    attendee_email: null,
    service_type_id: DEACTIVATED_SERVICE, // since deactivated, carried on the row
    practitioner_id: null,
    notes: null,
    external_id: null,
    provider: "internal",
    metadata: {},
    confirmation_code: "123456",
    status: "confirmed",
    created_at: "2026-06-01T00:00:00Z",
  };

  function mockOrgWithDeactivatedService() {
    vi.mocked(createAdminClient).mockReturnValue(
      activeAwareAdmin(
        {
          appointments: (_method, _eqs, op) => {
            if (op === "insert") return { data: { id: NEW_APPT_ID, confirmation_code: "999999" }, error: null };
            if (op === "update") return { data: null, error: null }; // free old leg + link
            return { data: [existingRow], error: null }; // confirmation-code lookup
          },
          service_types: (method, eqs) => {
            // getServiceType (.single, no is_active filter): row exists, org-owned.
            if (method === "single") return { data: { id: DEACTIVATED_SERVICE, name: "Checkup", duration_minutes: 30 }, error: null };
            // bookInternal validator: the row is DEACTIVATED — it resolves ONLY
            // when the is_active filter was NOT applied.
            if (method === "maybeSingle") {
              const activeFiltered = eqs.some(([c, v]) => c === "is_active" && v === true);
              return activeFiltered ? { data: null, error: null } : { data: { id: DEACTIVATED_SERVICE }, error: null };
            }
            // getActiveServiceTypes — the deactivated service is absent, as in prod.
            return { data: [{ id: "st-active", name: "Cleaning", duration_minutes: 30 }], error: null };
          },
          // getOrgSchedule → no org row → null schedule (hours checks skipped).
          organizations: () => ({ data: null, error: null }),
          // practitioners / blocked_times / assistants fall through to { data: null }.
        },
        log,
      ) as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    log.touches = [];
    log.inserted = undefined;
  });

  it("time-only reschedule SUCCEEDS when the carried service type was since deactivated", async () => {
    mockOrgWithDeactivatedService();

    const result = await handleRescheduleAppointment(ORG, {
      confirmation_code: "123456",
      phone: "+61412345678",
      new_datetime: NEW_DT, // time-only — service carried from the existing booking
    });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/I've moved your appointment/i);
    expect(result.data?.oldCancelled).toBe(true);
    expect(log.inserted).toBe(true);
    // The carried service ref was validated ORG-SCOPE-ONLY (no is_active filter).
    const validatorLookup = log.touches.find((t) => t.table === "service_types" && t.method === "maybeSingle");
    expect(validatorLookup).toBeDefined();
    expect(validatorLookup!.eqs).not.toContainEqual(["is_active", true]);
  });

  it("rejects the reschedule when the caller EXPLICITLY picks the deactivated service", async () => {
    mockOrgWithDeactivatedService();

    const result = await handleRescheduleAppointment(ORG, {
      confirmation_code: "123456",
      phone: "+61412345678",
      new_datetime: NEW_DT,
      service_type_id: DEACTIVATED_SERVICE, // caller-supplied → must be active
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/couldn't match/i);
    expect(log.inserted).toBeUndefined();
    // Old appointment untouched (never freed) — the caller keeps their booking.
    expect(log.touches.filter((t) => t.table === "appointments" && t.op === "update")).toHaveLength(0);
    // The rejection came from the is_active-filtered validator lookup.
    const validatorLookup = log.touches.find((t) => t.table === "service_types" && t.method === "maybeSingle");
    expect(validatorLookup).toBeDefined();
    expect(validatorLookup!.eqs).toContainEqual(["is_active", true]);
  });
});
