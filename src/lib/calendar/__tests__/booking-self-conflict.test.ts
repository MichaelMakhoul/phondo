import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// SCRUM-514, from a real call to a customer's brand-new number.
//
// The AI booked an appointment, announced the confirmation code, then called
// book_appointment a second time for the same slot (it had respelled the
// caller's surname, so the in-memory guard missed). The insert hit
// `no_overlapping_appointments` — it conflicted with the booking the AI had
// just made — and the handler answered "that time slot is no longer
// available". The AI told the caller their booking had FAILED. The caller hung
// up believing they had no appointment. They did: row 27bb9bce, confirmed,
// code 241909.
//
// A caller must never be told a booking failed when it succeeded. These tests
// pin both directions: the caller's own duplicate returns their existing
// booking, and a *different* attendee colliding on the same slot must NOT be
// handed the first attendee's confirmation code.
// ──────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true })),
}));
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
vi.mock("@/lib/calendar/cal-com", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCalComClient: vi.fn(async () => null),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { getCalComClient } from "@/lib/calendar/cal-com";
import { handleBookAppointment, handleRescheduleAppointment } from "@/lib/calendar/tool-handlers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = "org-1";
// Real uuids: `appointments.call_id` is a uuid column, and the handler drops a
// malformed one rather than letting the INSERT fail and cost a real booking.
const CALL_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_CALL_ID = "99999999-8888-4777-8666-555555555555";
// Wednesday, inside the business hours below. The handler resolves this naive
// string in the ORG's timezone, never the host's — so the fixture below must be
// an absolute instant, not `new Date(SLOT)`. Otherwise these tests pass on a
// Sydney laptop and fail in CI, which runs UTC.
const SLOT = "2027-07-07T10:00:00";
const ORG_TIMEZONE = "Australia/Sydney";
/** 10:00 Sydney, in the shape PostgREST returns a timestamptz. */
const SLOT_INSTANT = "2027-07-07T00:00:00+00:00";

const OPEN_HOURS = {
  monday: { open: "09:00", close: "17:00" },
  tuesday: { open: "09:00", close: "17:00" },
  wednesday: { open: "09:00", close: "17:00" },
  thursday: { open: "09:00", close: "17:00" },
  friday: { open: "09:00", close: "17:00" },
  saturday: null,
  sunday: null,
};

const EXISTING = {
  id: "appt-existing",
  confirmation_code: "241909",
  // An offset and no milliseconds: exactly how PostgREST serialises a
  // timestamptz. Deliberately NOT `new Date(SLOT).toISOString()`, which yields
  // "….000Z" — a string comparison in the handler would then pass here and fail
  // against a real database, hiding the very bug this file exists to catch.
  start_time: SLOT_INSTANT,
  attendee_first_name: "Nick",
  attendee_name: "Nick Stamatopulos",
};

interface Recorder {
  insertRows: any[];
  updateRows: { table: string; row: any }[];
  selects: { table: string; filters: Record<string, unknown> }[];
}

/**
 * Supabase admin fake. `appointments` behaves specially: `.insert()` always
 * fails with the exclusion-constraint code (23P01), which is exactly what the
 * DB does when the slot is taken; a plain `.select()` chain resolves to
 * `selfConflictRows` (what the new self-conflict lookup will see).
 *
 * `opts.appointmentQueue` overrides those awaited results in order — the
 * reschedule path awaits the appointments table more than once (first to find
 * the booking by confirmation code, later for the self-conflict lookup).
 */
function fakeAdmin(
  selfConflictRows: any[],
  rec: Recorder,
  opts: {
    lookupError?: any;
    appointmentQueue?: any[];
    tableRows?: Record<string, any[]>;
    insertResult?: { id: string; confirmation_code: string };
  } = {}
) {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      const chain = (k?: string) => (col?: string, val?: unknown) => {
        if (k && col) filters[`${k}:${col}`] = val;
        return b;
      };
      Object.assign(b, {
        select: () => b,
        eq: chain("eq"),
        neq: chain("neq"),
        in: chain("in"),
        is: () => b,
        not: () => b,
        gte: () => b,
        lte: () => b,
        lt: chain("lt"),
        gt: chain("gt"),
        order: () => b,
        limit: () => {
          if (table === "appointments") rec.selects.push({ table, filters });
          return b;
        },
        insert: (row: any) => {
          rec.insertRows.push(row);
          return b;
        },
        update: (row: any) => {
          rec.updateRows.push({ table, row });
          return b;
        },
        single: async () => {
          if (table === "organizations") {
            return { data: { business_hours: OPEN_HOURS, timezone: ORG_TIMEZONE }, error: null };
          }
          // The appointments insert: a slot collision, unless the test says
          // the new leg genuinely fits (SCRUM-561 happy path).
          if (table === "appointments") {
            if (opts.insertResult) {
              return { data: opts.insertResult, error: null };
            }
            return { data: null, error: { code: "23P01", message: "conflicting key value" } };
          }
          if (opts.tableRows && table in opts.tableRows) {
            return { data: opts.tableRows[table][0] ?? null, error: null };
          }
          return { data: null, error: null };
        },
        maybeSingle: async () => {
          if (opts.tableRows && table in opts.tableRows) {
            return { data: opts.tableRows[table][0] ?? null, error: null };
          }
          return { data: null, error: null };
        },
        // Awaiting the builder (the self-conflict lookup, blocked_times, etc.)
        then: (onF: (v: any) => unknown, onR?: (e: unknown) => unknown) => {
          let value: any = { data: [], error: null };
          if (opts.tableRows && table in opts.tableRows) {
            return Promise.resolve({ data: opts.tableRows[table], error: null }).then(onF, onR);
          }
          if (table === "appointments" && opts.appointmentQueue?.length) {
            return Promise.resolve({ data: opts.appointmentQueue.shift(), error: null }).then(onF, onR);
          }
          if (table === "appointments") {
            value = opts.lookupError
              ? { data: null, error: opts.lookupError }
              : { data: selfConflictRows, error: null };
          }
          return Promise.resolve(value).then(onF, onR);
        },
      });
      return b;
    },
  };
}

function bookAs(firstName: string, lastName: string, callId?: string) {
  return handleBookAppointment(
    ORG,
    { datetime: SLOT, first_name: firstName, last_name: lastName, phone: "+61412345678" },
    callId ? { callId } : undefined
  );
}

describe("book_appointment self-conflict (SCRUM-514)", () => {
  let rec: Recorder;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rec = { insertRows: [], updateRows: [], selects: [] };
  });

  it("returns the caller's own booking instead of claiming the slot is gone", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin([EXISTING], rec) as never);

    // Same call, same person, surname respelled — exactly the production bug.
    const result = await bookAs("Nick", "STAMATOPOULOS", CALL_ID);

    expect(result.success).toBe(true);
    expect(result.message).not.toMatch(/no longer available/i);
    expect(result.message).toMatch(/already confirmed/i);
    expect((result.data as any)?.confirmationCode).toBe("241909");
    expect((result.data as any)?.appointmentId).toBe("appt-existing");
    // The caller must not be notified twice about one appointment.
    expect((result.data as any)?.duplicate).toBe(true);
  });

  it("stamps call_id on the insert so a booking is traceable to its call", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin([EXISTING], rec) as never);

    await bookAs("Nick", "Stamatopulos", CALL_ID);

    expect(rec.insertRows).toHaveLength(1);
    expect(rec.insertRows[0].call_id).toBe(CALL_ID);
  });

  it("scopes the self-conflict lookup to this call", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin([EXISTING], rec) as never);

    await bookAs("Nick", "Stamatopulos", CALL_ID);

    const lookup = rec.selects.find((s) => s.filters["eq:call_id"] !== undefined);
    expect(lookup).toBeDefined();
    expect(lookup!.filters["eq:call_id"]).toBe(CALL_ID);
    expect(lookup!.filters["eq:organization_id"]).toBe(ORG);
  });

  it("explains a self-overlap at a different time instead of blaming the slot", async () => {
    // Their 10:00 appointment runs to 10:30, so 10:15 collides — with nobody
    // but themselves. "That time is no longer available" would be baffling.
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin([EXISTING], rec) as never);

    const result = await handleBookAppointment(
      ORG,
      { datetime: "2027-07-07T10:15:00", first_name: "Nick", last_name: "Stamatopulos", phone: "+61412345678" },
      { callId: CALL_ID }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already have an appointment/i);
    expect(result.message).not.toMatch(/no longer available/i);
    // Still not a confirmation — they have not booked the time they asked for.
    expect(JSON.stringify(result)).not.toContain("241909");
  });

  it("does NOT hand a second attendee the first attendee's confirmation code", async () => {
    // "...and book my husband in at the same time." The org-wide overlap
    // constraint means his booking genuinely cannot exist; telling him it's
    // confirmed — with her code — would be far worse than the honest refusal.
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin([EXISTING], rec) as never);

    const result = await bookAs("Maria", "Stamatopulos", CALL_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no longer available/i);
    expect(JSON.stringify(result)).not.toContain("241909");
  });

  it("does NOT return a booking made by a different call", async () => {
    // The row exists, but it belongs to someone else's call. A caller who can
    // guess an attendee and a time must never be read their code.
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin([], rec) as never);

    const result = await bookAs("Nick", "Stamatopulos", OTHER_CALL_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no longer available/i);
  });

  it("reports the slot as taken when there is no call context (browser test call)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin([EXISTING], rec) as never);

    const result = await bookAs("Nick", "Stamatopulos", undefined);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no longer available/i);
    // No callId: the lookup must not run at all.
    expect(rec.selects.find((s) => s.filters["eq:call_id"] !== undefined)).toBeUndefined();
  });

  it("drops a malformed callId rather than failing the insert", async () => {
    // `call_id` is a uuid column: a bad value would fail the INSERT (22P02) and
    // cost the caller a real booking. Losing the linkage is the cheaper loss.
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin([EXISTING], rec) as never);

    const result = await bookAs("Nick", "Stamatopulos", "not-a-uuid");

    expect(rec.insertRows).toHaveLength(1);
    expect(rec.insertRows[0]).not.toHaveProperty("call_id");
    // ...and with no usable call context, we cannot claim their booking exists.
    expect(result.success).toBe(false);
    expect(rec.selects.find((s) => s.filters["eq:call_id"] !== undefined)).toBeUndefined();
  });

  it("links a rescheduled booking to its call, and does not tell the caller to move it", async () => {
    // The reschedule leg books the new slot through the same code path. Without
    // the linkage its row carries call_id NULL, and a later book_appointment
    // colliding with the slot we just moved into is unrecognisable as the
    // caller's own — the same P0, one step downstream.
    const OLD_APPT = {
      id: "appt-old",
      start_time: SLOT_INSTANT,
      attendee_name: "Nick Stamatopulos",
      attendee_first_name: "Nick",
      attendee_phone: "+61412345678",
      attendee_email: null,
      service_type_id: null,
      practitioner_id: null,
      notes: null,
      external_id: null,
      provider: "internal",
      metadata: {},
      confirmation_code: "241909",
      status: "confirmed",
      created_at: "2027-06-01T00:00:00+00:00",
    };
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin([], rec, {
        // 1) find-by-code, 2) the self-conflict lookup after the 23P01.
        appointmentQueue: [[OLD_APPT], [OLD_APPT]],
      }) as never
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { confirmation_code: "241909", phone: "+61412345678", new_datetime: "2027-07-07T10:15:00" },
      undefined,
      { callId: CALL_ID }
    );

    expect(rec.insertRows).toHaveLength(1);
    expect(rec.insertRows[0].call_id).toBe(CALL_ID);
    // They asked to move it. Offering to move it would loop the model.
    expect(result.message).not.toMatch(/move it instead/i);
  });

  it("fails toward 'slot taken' when the self-conflict lookup errors", async () => {
    // Never invent a confirmation we could not read back.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin([EXISTING], rec, { lookupError: { code: "XX000", message: "db down" } }) as never
    );

    const result = await bookAs("Nick", "Stamatopulos", CALL_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no longer available/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// SCRUM-561: the reschedule leg vs the appointment it is moving.
//
// Real call 2026-07-17: "I'd like a different doctor" was improvised as
// cancel+rebook. The prompt fix routes it through reschedule_appointment with
// new_datetime = the appointment's CURRENT time — which made two silent
// handler bugs reachable: (a) a structural no-op reschedule collided with the
// row being moved and the SCRUM-514 duplicate recovery vouched for THAT row
// as the "new" leg, so step 3 cancelled it — the caller's only appointment
// destroyed while the tool reported success; (b) the requested-practitioner
// pre-check counted the row being moved as the conflict and told callers
// their own practitioner was "already booked at this time".
// ──────────────────────────────────────────────────────────────────────────

describe("reschedule leg vs the appointment being moved (SCRUM-561)", () => {
  const PRAC_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const SVC_UUID = "12121212-3434-4565-8787-909090909090";
  const OLD_APPT = {
    id: "appt-old",
    start_time: SLOT_INSTANT,
    attendee_name: "Nick Stamatopulos",
    attendee_first_name: "Nick",
    attendee_phone: "+61412345678",
    attendee_email: null,
    service_type_id: null,
    practitioner_id: null,
    notes: null,
    external_id: null,
    provider: "internal",
    metadata: {},
    confirmation_code: "241909",
    status: "confirmed",
    created_at: "2027-06-01T00:00:00+00:00",
  };
  let rec: Recorder;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rec = { insertRows: [], updateRows: [], selects: [] };
  });

  it("refuses a structural no-op reschedule BEFORE booking (the destroyed-booking incident path)", async () => {
    // Same instant, same (absent) practitioner, same (absent) service: nothing
    // changes. Booking first would 23P01 against the row being moved, the
    // duplicate recovery would vouch for it, and the cancel would destroy it.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin([], rec, { appointmentQueue: [[OLD_APPT]] }) as never
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { confirmation_code: "241909", phone: "+61412345678", new_datetime: SLOT },
      undefined,
      { callId: CALL_ID }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/nothing needed to change/i);
    expect(result.message).toMatch(/it is unchanged/i);
    // Steers, in one message, to every sanctioned change path.
    expect(result.message).toMatch(/practitioner_id/);
    expect(result.message).toMatch(/update_appointment/);
    // The load-bearing assertion: no booking was even attempted, so no
    // recovery could vouch for the old row and nothing can cancel it.
    expect(rec.insertRows).toHaveLength(0);
    // Must not read as an availability rejection (those reset the voice
    // server's reschedule loop cap instead of counting toward it).
    expect(result.message).not.toMatch(
      /no longer available|already booked|currently blocked|not available for this service|fully booked|no available slot|unavailable at this time/i
    );
  });

  it("same-instant collision with ANOTHER same-call booking is refused honestly, never vouched for", async () => {
    // The caller moves their 11:00 appointment onto their OTHER same-call
    // 10:00 booking. Pre-561 the recovery returned success:true "already
    // confirmed" pointing at the 10:00 row — which the reschedule then took as
    // its new leg and cancelled the 11:00 original... while the model told the
    // caller the move succeeded.
    const ELEVEN = "2027-07-07T01:00:00+00:00"; // 11:00 Sydney
    const MOVING = { ...OLD_APPT, id: "appt-moving", start_time: ELEVEN, confirmation_code: "111111" };
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin([], rec, { appointmentQueue: [[MOVING], [EXISTING]] }) as never
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { confirmation_code: "111111", phone: "+61412345678", new_datetime: SLOT },
      undefined,
      { callId: CALL_ID }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/another appointment made in this call/i);
    expect(result.message).not.toMatch(/already confirmed/i);
    // Neither booking's code may leak into a refusal.
    expect(JSON.stringify(result)).not.toContain("241909");
    expect(JSON.stringify(result)).not.toContain("111111");
  });

  it("same-time SERVICE change collides with the row being moved and is refused, not destroyed", async () => {
    // A ref change the pre-flight no-op check deliberately lets through: the
    // insert still collides with the live old row (both practitioner-less at
    // the same instant). The recovery must refuse — success:true here is what
    // cancelled the caller's only appointment.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin([], rec, {
        appointmentQueue: [[OLD_APPT], [OLD_APPT]],
        tableRows: {
          service_types: [{ id: SVC_UUID, name: "Checkup", duration_minutes: 30, is_active: true }],
        },
      }) as never
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { confirmation_code: "241909", phone: "+61412345678", new_datetime: SLOT, service_type_id: SVC_UUID },
      undefined,
      { callId: CALL_ID }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/nothing to re-book|exactly when this appointment already is/i);
    expect(result.message).not.toMatch(/already confirmed/i);
  });

  it("a same-time DIFFERENT-practitioner reschedule books normally and frees the old row", async () => {
    // The core SCRUM-561 promise: the split overlap constraints allow the
    // same-instant swap, so the leg must book (not be refused as a no-op)
    // and the old row must be marked rescheduled — a future refactor turning
    // this into a spurious refusal would resurrect the incident behavior.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin([], rec, {
        appointmentQueue: [[OLD_APPT]],
        tableRows: { practitioners: [{ id: PRAC_UUID }] },
        insertResult: { id: "appt-new", confirmation_code: "654321" },
      }) as never
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { confirmation_code: "241909", phone: "+61412345678", new_datetime: SLOT, practitioner_id: PRAC_UUID },
      undefined,
      { callId: CALL_ID }
    );

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/moved your appointment/i);
    expect((result.data as any)?.newAppointmentId).toBe("appt-new");
    expect((result.data as any)?.newAppointmentId).not.toBe(OLD_APPT.id);
    // The new leg carries the requested practitioner and this call's id.
    expect(rec.insertRows).toHaveLength(1);
    expect(rec.insertRows[0].practitioner_id).toBe(PRAC_UUID);
    expect(rec.insertRows[0].call_id).toBe(CALL_ID);
    // The old row was freed as `rescheduled`, and the new row linked back.
    const statusUpdate = rec.updateRows.find((u) => u.table === "appointments" && u.row.status === "rescheduled");
    expect(statusUpdate).toBeDefined();
    const link = rec.updateRows.find((u) => u.table === "appointments" && u.row.rescheduled_from_id === OLD_APPT.id);
    expect(link).toBeDefined();
  });

  it("the practitioner conflict pre-check excludes the appointment being moved", async () => {
    // Same-time practitioner change: the old row must not count as "that
    // practitioner is already booked" — its slot is about to be freed.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin([], rec, {
        tableRows: { practitioners: [{ id: PRAC_UUID }] },
      }) as never
    );

    await handleBookAppointment(
      ORG,
      { datetime: SLOT, first_name: "Nick", last_name: "Stamatopulos", phone: "+61412345678", practitioner_id: PRAC_UUID },
      { callId: CALL_ID, rescheduleLeg: true, rescheduleFromId: "appt-old" }
    );

    const conflictCheck = rec.selects.find((s) => s.filters["eq:practitioner_id"] === PRAC_UUID);
    expect(conflictCheck).toBeDefined();
    expect(conflictCheck!.filters["neq:id"]).toBe("appt-old");
  });

  it("a plain booking's practitioner conflict check has NO exclusion", async () => {
    // The exclusion is reschedule-leg-only — a fresh booking colliding with
    // ANY live appointment (including one from this call) is a real conflict.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin([], rec, {
        tableRows: { practitioners: [{ id: PRAC_UUID }] },
      }) as never
    );

    await handleBookAppointment(
      ORG,
      { datetime: SLOT, first_name: "Nick", last_name: "Stamatopulos", phone: "+61412345678", practitioner_id: PRAC_UUID },
      { callId: CALL_ID }
    );

    const conflictCheck = rec.selects.find((s) => s.filters["eq:practitioner_id"] === PRAC_UUID);
    expect(conflictCheck).toBeDefined();
    expect(conflictCheck!.filters["neq:id"]).toBeUndefined();
  });

  it("refuses a practitioner request on the Cal.com fork instead of silently dropping it", async () => {
    // bookViaCal has no practitioner concept. Confirming "with Dr X" while
    // booking nobody in particular is a silent lie; refuse honestly.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin([], rec, { tableRows: { practitioners: [{ id: PRAC_UUID }] } }) as never
    );
    vi.mocked(getCalComClient).mockResolvedValueOnce({} as never);

    const result = await handleBookAppointment(
      ORG,
      { datetime: SLOT, first_name: "Nick", last_name: "Stamatopulos", phone: "+61412345678", practitioner_id: PRAC_UUID },
      { callId: CALL_ID }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/practitioner selection isn't supported/i);
    expect(rec.insertRows).toHaveLength(0);
  });
});
