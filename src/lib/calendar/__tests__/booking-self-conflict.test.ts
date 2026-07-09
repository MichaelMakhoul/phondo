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

import { createAdminClient } from "@/lib/supabase/admin";
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
  opts: { lookupError?: any; appointmentQueue?: any[] } = {}
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
        single: async () => {
          if (table === "organizations") {
            return { data: { business_hours: OPEN_HOURS, timezone: ORG_TIMEZONE }, error: null };
          }
          // The appointments insert: always a slot collision.
          if (table === "appointments") {
            return { data: null, error: { code: "23P01", message: "conflicting key value" } };
          }
          return { data: null, error: null };
        },
        maybeSingle: async () => ({ data: null, error: null }),
        // Awaiting the builder (the self-conflict lookup, blocked_times, etc.)
        then: (onF: (v: any) => unknown, onR?: (e: unknown) => unknown) => {
          let value: any = { data: [], error: null };
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
    rec = { insertRows: [], selects: [] };
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
