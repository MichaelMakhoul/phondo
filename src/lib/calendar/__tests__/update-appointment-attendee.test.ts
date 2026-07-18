import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-557: handleUpdateAppointmentAttendee — the RebookGuard-internal
// name-correction handler. Never in the model's tool list; the voice server
// invokes it when a "duplicate" book_appointment carries a DIFFERENT surname
// (booking-key drops surnames by design, SCRUM-514, so a surname correction
// maps to the duplicate key).
//
// Contract pins that matter here:
//  - ANCHORING: only an appointment created by THIS call (call_id from the
//    request envelope, never from model args) can be renamed.
//  - PREFIX CONTRACT: voice-server/server.js keys success on
//    message.startsWith("NAME CORRECTED") — the ledger refresh and the
//    Sentry failure alarm both hang off that prefix. The voice suite pins the
//    test-mode SIMULATOR's prefix (tool-executor-testmode.test.js); this file
//    pins the REAL handler's, so the two cannot drift apart silently.
//  - FAILURE POSTURE: every failure message must carry the "the appointment
//    still exists under the PREVIOUS details — do NOT cancel" instruction. The
//    real 2026-07-17 incident was a cancel issued on the back of a
//    misunderstood guard reply; the tail is the fix.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true })),
}));
// Keep post-response side effects (cache invalidation, SMS) out of the tests.
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));
// Pin the audit emit as a call, not via fake insert plumbing.
vi.mock("@/lib/appointments/events", () => ({
  recordAppointmentEvent: vi.fn(async () => {}),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { recordAppointmentEvent } from "@/lib/appointments/events";
import { handleUpdateAppointmentAttendee } from "@/lib/calendar/tool-handlers";

type Result = { data: unknown; error: { message?: string; code?: string } | null };

type Captured = {
  // eq/in filters, tagged with whether they were applied to the select or the update
  filters: Array<{ phase: "select" | "update"; op: string; column: string; value: unknown }>;
  updatePayload: Record<string, unknown> | null;
};

// Thenable builder serving call-ordered results per table (the pattern from
// cancel-reschedule-ownership.test.ts) + update-payload and filter capture.
function fakeAdmin(tableQueues: Record<string, Result[]>, captured: Captured) {
  return {
    from: (table: string) => {
      const result: Result = tableQueues[table]?.shift() ?? { data: null, error: null };
      let phase: "select" | "update" = "select";
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain,
        eq: (column: string, value: unknown) => {
          captured.filters.push({ phase, op: "eq", column, value });
          return b;
        },
        in: (column: string, value: unknown) => {
          captured.filters.push({ phase, op: "in", column, value });
          return b;
        },
        update: (payload: Record<string, unknown>) => {
          phase = "update";
          captured.updatePayload = payload;
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

const ORG = "org-1";
const CALL = "call-uuid-1";

function apptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "appt-a",
    start_time: "2027-07-01T10:00:00Z",
    attendee_name: "Michael PL",
    status: "confirmed",
    ...overrides,
  };
}

const CORRECT_ARGS = { first_name: "Michael", last_name: "Makhoul" };

describe("handleUpdateAppointmentAttendee (SCRUM-557)", () => {
  let captured: Captured;
  beforeEach(() => {
    vi.clearAllMocks();
    captured = { filters: [], updatePayload: null };
  });

  it("no callId anchor: refuses without touching the DB, and forbids a cancel", async () => {
    const result = await handleUpdateAppointmentAttendee(ORG, CORRECT_ARGS, undefined);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/^CORRECTION UNAVAILABLE/);
    expect(result.message).toMatch(/still exists under the PREVIOUS details/);
    expect(result.message).toMatch(/do NOT cancel it/);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(recordAppointmentEvent).not.toHaveBeenCalled();
  });

  it("missing or whitespace-only last name: fails before any DB call", async () => {
    for (const args of [
      { first_name: "Michael" },
      { first_name: "Michael", last_name: "   " },
      { last_name: "Makhoul" },
    ]) {
      const result = await handleUpdateAppointmentAttendee(ORG, args, { callId: CALL });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/provide BOTH the corrected first and last name/);
      expect(result.message).toMatch(/do NOT cancel it/);
    }
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("happy path: one appointment from this call → attendee fields updated, 'edited' event recorded, NAME CORRECTED prefix", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            { data: [apptRow()], error: null }, // anchored lookup
            { data: [{ id: "appt-a" }], error: null }, // update (returns the updated row)
          ],
        },
        captured
      ) as never
    );

    const result = await handleUpdateAppointmentAttendee(ORG, CORRECT_ARGS, { callId: CALL });

    expect(result.success).toBe(true);
    // THE PREFIX CONTRACT: voice-server keys ledger refresh + failure alarm on
    // startsWith("NAME CORRECTED"); the simulator pin lives in
    // voice-server/tests/tool-executor-testmode.test.js. Do not reword one
    // side without the other.
    expect(result.message).toMatch(/^NAME CORRECTED: /);
    expect(result.message).toContain('"Michael Makhoul"');
    expect(result.message).toMatch(/do NOT call book_appointment again and do NOT cancel/);

    // The lookup is anchored on the CALL and the org — the SCRUM-514 principle
    // (identity never comes from model arguments).
    const selectEqs = captured.filters.filter((f) => f.phase === "select" && f.op === "eq");
    expect(selectEqs).toContainEqual({ phase: "select", op: "eq", column: "organization_id", value: ORG });
    expect(selectEqs).toContainEqual({ phase: "select", op: "eq", column: "call_id", value: CALL });
    const statusIn = captured.filters.find((f) => f.phase === "select" && f.op === "in");
    expect(statusIn?.column).toBe("status");
    expect(statusIn?.value).toEqual(["confirmed", "pending"]);

    // All three attendee columns move together.
    expect(captured.updatePayload).toMatchObject({
      attendee_first_name: "Michael",
      attendee_last_name: "Makhoul",
      attendee_name: "Michael Makhoul",
    });
    const updateEqs = captured.filters.filter((f) => f.phase === "update" && f.op === "eq");
    expect(updateEqs).toContainEqual({ phase: "update", op: "eq", column: "id", value: "appt-a" });
    expect(updateEqs).toContainEqual({ phase: "update", op: "eq", column: "organization_id", value: ORG });

    expect(recordAppointmentEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordAppointmentEvent).mock.calls[0][1]).toMatchObject({
      appointmentId: "appt-a",
      organizationId: ORG,
      eventType: "edited",
      actorType: "ai",
      channel: "voice",
      changedFields: [{ field: "name", from: "Michael PL", to: "Michael Makhoul" }],
      callId: CALL,
    });
  });

  it("two appointments from this call + datetime: the ±15min match is renamed, not the other", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            {
              data: [
                apptRow(), // 10:00
                apptRow({ id: "appt-b", start_time: "2027-07-01T14:00:00Z", attendee_name: "Sarah PL" }),
              ],
              error: null,
            },
            { data: [{ id: "appt-a" }], error: null }, // update (returns the updated row)
          ],
        },
        captured
      ) as never
    );

    const result = await handleUpdateAppointmentAttendee(
      ORG,
      { ...CORRECT_ARGS, datetime: "2027-07-01T10:05:00Z" },
      { callId: CALL }
    );

    expect(result.success).toBe(true);
    const updateEqs = captured.filters.filter((f) => f.phase === "update" && f.op === "eq");
    expect(updateEqs).toContainEqual({ phase: "update", op: "eq", column: "id", value: "appt-a" });
    expect(vi.mocked(recordAppointmentEvent).mock.calls[0][1]).toMatchObject({ appointmentId: "appt-a" });
  });

  it("two appointments, no datetime: refuses to guess — no update, no event, retry instruction", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            {
              data: [apptRow(), apptRow({ id: "appt-b", start_time: "2027-07-01T14:00:00Z" })],
              error: null,
            },
          ],
        },
        captured
      ) as never
    );

    const result = await handleUpdateAppointmentAttendee(ORG, CORRECT_ARGS, { callId: CALL });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/multiple found — retry with the exact datetime/);
    expect(result.message).toMatch(/do NOT cancel it/);
    expect(captured.updatePayload).toBeNull();
    expect(recordAppointmentEvent).not.toHaveBeenCalled();
  });

  it("two appointments and a datetime matching NEITHER within 15min: still refuses to guess", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            {
              data: [apptRow(), apptRow({ id: "appt-b", start_time: "2027-07-01T14:00:00Z" })],
              error: null,
            },
          ],
        },
        captured
      ) as never
    );

    const result = await handleUpdateAppointmentAttendee(
      ORG,
      { ...CORRECT_ARGS, datetime: "2027-07-02T10:00:00Z" },
      { callId: CALL }
    );

    expect(result.success).toBe(false);
    expect(captured.updatePayload).toBeNull();
    expect(recordAppointmentEvent).not.toHaveBeenCalled();
  });

  it("no appointment from this call: steers to lookup/reschedule/callback, never fabricates an appointment or a team promise", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ appointments: [{ data: [], error: null }] }, captured) as never
    );

    const result = await handleUpdateAppointmentAttendee(ORG, CORRECT_ARGS, { callId: CALL });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no appointment was booked in THIS call/);
    expect(result.message).toMatch(/NOTHING was changed/);
    expect(result.message).toMatch(/lookup_appointment/);
    expect(result.message).toMatch(/schedule_callback/);
    expect(result.message).toMatch(/Do NOT claim anything was fixed/);
    // The everyday case (fixing last week's booking) must not assert a
    // nonexistent appointment "still exists" or promise unrecorded team action.
    expect(result.message).not.toMatch(/still exists under the PREVIOUS details/);
    expect(result.message).not.toMatch(/team will correct it/);
    expect(captured.updatePayload).toBeNull();
  });

  it("lookup error: fails closed with the PREVIOUS-name instruction, nothing written", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ appointments: [{ data: null, error: { message: "boom" } }] }, captured) as never
    );

    const result = await handleUpdateAppointmentAttendee(ORG, CORRECT_ARGS, { callId: CALL });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/CORRECTION FAILED \(lookup error\)/);
    expect(result.error).toBe(true); // genuine fault — must carry the SCRUM-509 alert flag
    expect(result.message).toMatch(/still exists under the PREVIOUS details/);
    expect(captured.updatePayload).toBeNull();
    expect(recordAppointmentEvent).not.toHaveBeenCalled();
  });

  it("non-Latin correction is rejected (SCRUM-367 parity with the booking gate)", async () => {
    const result = await handleUpdateAppointmentAttendee(
      ORG,
      { first_name: "Michael", last_name: "مكحول" },
      { callId: CALL }
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/ENGLISH spelling/);
    expect(result.message).toMatch(/do NOT cancel it/);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("naive org-local datetime disambiguates correctly for a non-UTC org (Sydney)", async () => {
    // 10:00 naive + Australia/Sydney (+10 in July) = 00:00Z — matches appt-a.
    // Without ensureTimezoneOffset the naive parse lands 10h off and the
    // disambiguation is inert for every AU org.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            {
              data: [
                apptRow({ start_time: "2027-07-01T00:00:00Z" }),
                apptRow({ id: "appt-b", start_time: "2027-07-01T04:00:00Z" }),
              ],
              error: null,
            },
            { data: [{ id: "appt-a" }], error: null }, // update
          ],
          organizations: [{ data: { timezone: "Australia/Sydney" }, error: null }],
        },
        captured
      ) as never
    );

    const result = await handleUpdateAppointmentAttendee(
      ORG,
      { ...CORRECT_ARGS, datetime: "2027-07-01T10:00:00" },
      { callId: CALL }
    );

    expect(result.success).toBe(true);
    const updateEqs = captured.filters.filter((f) => f.phase === "update" && f.op === "eq");
    expect(updateEqs).toContainEqual({ phase: "update", op: "eq", column: "id", value: "appt-a" });
  });

  it("raced away: the update matches zero rows (staff cancelled mid-call) — NO false NAME CORRECTED", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            { data: [apptRow()], error: null },
            { data: [], error: null }, // update touched nothing — row cancelled/deleted between SELECT and UPDATE
          ],
        },
        captured
      ) as never
    );

    const result = await handleUpdateAppointmentAttendee(ORG, CORRECT_ARGS, { callId: CALL });

    expect(result.success).toBe(false);
    expect(result.message).not.toMatch(/^NAME CORRECTED: /);
    expect(result.message).toMatch(/may have just been changed or cancelled/);
    expect(result.message).toMatch(/Do NOT cancel anything and do NOT claim it was fixed/);
    expect(recordAppointmentEvent).not.toHaveBeenCalled();
  });

  for (const [args, column, field, from] of [
    [{ phone: "+61400000999" }, "attendee_phone", "phone", "+61400000001"],
    [{ email: "new@example.com" }, "attendee_email", "email", "old@example.com"],
    [{ notes: "gate code 4321" }, "notes", "notes", null],
  ] as const) {
    it(`${field}-only correction: updates ${column}, DETAILS prefix, audited as ${field} change`, async () => {
      vi.mocked(createAdminClient).mockReturnValue(
        fakeAdmin(
          {
            appointments: [
              { data: [apptRow({ attendee_phone: "+61400000001", attendee_email: "old@example.com", notes: null })], error: null },
              { data: [{ id: "appt-a" }], error: null },
            ],
          },
          captured
        ) as never
      );
      const to = Object.values(args)[0];
      const result = await handleUpdateAppointmentAttendee(ORG, args as never, { callId: CALL });
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/^APPOINTMENT DETAILS UPDATED: /);
      // the summary naming the field is what kills a dropped-write mutation
      expect(result.message).toContain(`${field} is now "${to}"`);
      expect(captured.updatePayload).toMatchObject({ [column]: to });
      expect(captured.updatePayload).not.toHaveProperty("attendee_name");
      expect(vi.mocked(recordAppointmentEvent).mock.calls[0][1]).toMatchObject({
        changedFields: [{ field, from, to }],
      });
    });
  }

  it("phone corrected AWAY from the verified caller ID: success carries the possession warning", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            { data: [apptRow({ attendee_phone: "+61400000001" })], error: null },
            { data: [{ id: "appt-a" }], error: null },
          ],
        },
        captured
      ) as never
    );
    const result = await handleUpdateAppointmentAttendee(
      ORG,
      { phone: "+61498765432" } as never,
      { callId: CALL, verifiedCallerPhone: "+61400000001" } as never
    );
    expect(result.success).toBe(true);
    // SCRUM-560 reword: same-call changes now WORK via call authority — the
    // warning must say so, and scope the new-number caveat to FUTURE calls.
    expect(result.message).toMatch(/still cancel or reschedule this booking normally during THIS call/i);
    expect(result.message).toMatch(/For LATER calls, security goes by the NEW number/i);
  });

  it("phone corrected but still matching caller ID (formatting fix): NO possession warning", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            { data: [apptRow({ attendee_phone: "0400 000 001" })], error: null },
            { data: [{ id: "appt-a" }], error: null },
          ],
        },
        captured
      ) as never
    );
    const result = await handleUpdateAppointmentAttendee(
      ORG,
      { phone: "+61400000001" } as never,
      { callId: CALL, verifiedCallerPhone: "+61400000001" } as never
    );
    expect(result.success).toBe(true);
    expect(result.message).not.toMatch(/security checks/);
  });

  it("invalid phone / invalid email are rejected before any DB call", async () => {
    for (const [args, pattern] of [
      [{ phone: "12" }, /phone number doesn't look valid/],
      [{ email: "not-an-email" }, /email doesn't look valid/],
    ] as const) {
      const result = await handleUpdateAppointmentAttendee(ORG, args as never, { callId: CALL });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(pattern);
    }
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("no corrected fields at all: refused, with the reschedule redirect for time changes", async () => {
    const result = await handleUpdateAppointmentAttendee(ORG, {} as never, { callId: CALL });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no corrected details were provided/);
    expect(result.message).toMatch(/reschedule_appointment/);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("name + phone together: NAME CORRECTED prefix wins, both fields updated and audited", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            { data: [apptRow({ attendee_phone: "+61400000001" })], error: null },
            { data: [{ id: "appt-a" }], error: null },
          ],
        },
        captured
      ) as never
    );
    const result = await handleUpdateAppointmentAttendee(
      ORG,
      { ...CORRECT_ARGS, phone: "+61400000999" } as never,
      { callId: CALL }
    );
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/^NAME CORRECTED: /);
    expect(captured.updatePayload).toMatchObject({
      attendee_name: "Michael Makhoul",
      attendee_phone: "+61400000999",
    });
    const fields = (vi.mocked(recordAppointmentEvent).mock.calls[0][1] as { changedFields: { field: string }[] }).changedFields.map((c) => c.field);
    expect(fields).toEqual(["name", "phone"]);
  });

  it("update error: old name persists — message says so, forbids cancel, records no event", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          appointments: [
            { data: [apptRow()], error: null },
            { data: null, error: { message: "boom" } }, // update fails
          ],
        },
        captured
      ) as never
    );

    const result = await handleUpdateAppointmentAttendee(ORG, CORRECT_ARGS, { callId: CALL });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/CORRECTION FAILED \(update error\)/);
    expect(result.error).toBe(true); // genuine fault — must carry the SCRUM-509 alert flag
    expect(result.message).toMatch(/still exists under the PREVIOUS details — do NOT cancel it/);
    expect(result.message).not.toMatch(/^NAME CORRECTED: /);
    expect(recordAppointmentEvent).not.toHaveBeenCalled();
  });
});
