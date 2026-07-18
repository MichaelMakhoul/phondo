import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-560: call-authority possession — the call that CREATED a booking has
// full authority over it (the trust basis update_appointment already uses:
// the envelope callId, never model-reachable). Without it, a caller who
// corrects the contact phone on the booking they JUST made (update_appointment)
// gets not-found refusals on cancel/reschedule from their own number — the
// possession gate compares the verified caller ID against a phone that no
// longer matches it.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  handleCancelAppointment,
  handleRescheduleAppointment,
} from "@/lib/calendar/tool-handlers";
import {
  verifyPhonePossession,
  resolveCallerId,
} from "@/lib/calendar/appointment-verification";

type Result = { data: unknown; error: { message?: string; code?: string } | null };

type Captured = {
  ilikes: Array<{ column: string; pattern: string }>;
  ors: string[];
  updated: boolean;
  inserted: boolean;
};

// Thenable builder serving call-ordered results per table — the harness from
// cancel-reschedule-ownership.test.ts, extended with `.or()` capture (the
// call-authority candidate query widens phone-ilike to an OR with call_id).
function fakeAdmin(tableQueues: Record<string, Result[]>, captured: Captured) {
  return {
    from: (table: string) => {
      const result: Result = tableQueues[table]?.shift() ?? { data: null, error: null };
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain,
        eq: chain,
        in: chain,
        is: chain,
        not: chain,
        neq: chain,
        gte: chain,
        lte: chain,
        lt: chain,
        gt: chain,
        order: chain,
        limit: chain,
        ilike: (column: string, pattern: string) => {
          if (table === "appointments") captured.ilikes.push({ column, pattern });
          return b;
        },
        or: (expr: string) => {
          if (table === "appointments") captured.ors.push(expr);
          return b;
        },
        single: async () => result,
        maybeSingle: async () => result,
        update: () => {
          captured.updated = true;
          return b;
        },
        insert: () => {
          captured.inserted = true;
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
const CALLER_PHONE = "+61412345678";
const CORRECTED_PHONE = "+61477000111";
const CALL_ID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const OTHER_CALL_ID = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

const FUTURE_A = "2027-07-01T10:00:00Z";
const FUTURE_B = "2027-07-08T14:00:00Z";

function apptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "appt-1",
    start_time: FUTURE_A,
    attendee_name: "Jane Smith",
    attendee_phone: CALLER_PHONE,
    attendee_email: "jane@example.com",
    service_type_id: null,
    practitioner_id: null,
    notes: null,
    external_id: null,
    provider: "internal",
    metadata: {},
    confirmation_code: "111111",
    status: "confirmed",
    created_at: "2026-06-01T00:00:00Z",
    call_id: null,
    ...overrides,
  };
}

function orgVerification(value: unknown): Result {
  return { data: { appointment_verification_fields: value }, error: null };
}

describe("verifyPhonePossession call authority (SCRUM-560)", () => {
  const verified = resolveCallerId({ callerIdState: "verified", verifiedCallerPhone: CALLER_PHONE });

  it("accepts a row created by THIS call even when its phone was corrected away from the caller ID", () => {
    expect(
      verifyPhonePossession(
        { attendee_phone: CORRECTED_PHONE, call_id: CALL_ID },
        undefined,
        verified,
        CALL_ID,
      ),
    ).toBe("match");
  });

  it("a DIFFERENT call's row gets no authority — phone logic decides as before", () => {
    expect(
      verifyPhonePossession(
        { attendee_phone: CORRECTED_PHONE, call_id: OTHER_CALL_ID },
        undefined,
        verified,
        CALL_ID,
      ),
    ).toBe("mismatch");
  });

  it("without a trusted callId the behavior is unchanged (mismatch on corrected phone)", () => {
    expect(
      verifyPhonePossession({ attendee_phone: CORRECTED_PHONE, call_id: CALL_ID }, undefined, verified),
    ).toBe("mismatch");
  });

  it("empty-string ids never grant authority", () => {
    expect(
      verifyPhonePossession({ attendee_phone: CORRECTED_PHONE, call_id: "" }, undefined, verified, ""),
    ).toBe("mismatch");
  });

  it("call authority is phone-independent: it holds even for a withheld caller ID (handlers still refuse withheld earlier)", () => {
    const withheld = resolveCallerId({ callerIdState: "withheld" });
    expect(
      verifyPhonePossession({ attendee_phone: CORRECTED_PHONE, call_id: CALL_ID }, undefined, withheld, CALL_ID),
    ).toBe("match");
  });
});

describe("handleCancelAppointment call authority (SCRUM-560)", () => {
  let captured: Captured;
  beforeEach(() => {
    vi.clearAllMocks();
    captured = { ilikes: [], ors: [], updated: false, inserted: false };
  });

  it("code path: cancels this call's booking after the contact phone was corrected away from the caller ID", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            { data: apptRow({ attendee_phone: CORRECTED_PHONE, call_id: CALL_ID }), error: null }, // code .single()
            { data: null, error: null }, // status update
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { confirmation_code: "111111", phone: CALLER_PHONE },
      { callerIdState: "verified", verifiedCallerPhone: CALLER_PHONE },
      { callId: CALL_ID },
    );

    expect(result.success).toBe(true);
    expect(captured.updated).toBe(true);
  });

  it("phone path: the candidate query widens to call_id ownership and the corrected-phone row cancels", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            { data: [apptRow({ attendee_phone: CORRECTED_PHONE, call_id: CALL_ID })], error: null },
            { data: null, error: null }, // status update
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: CALLER_PHONE },
      { callerIdState: "verified", verifiedCallerPhone: CALLER_PHONE },
      { callId: CALL_ID },
    );

    expect(result.success).toBe(true);
    expect(captured.updated).toBe(true);
    // The query must include BOTH the phone suffix match and the call_id arm.
    expect(captured.ors.length).toBeGreaterThan(0);
    expect(captured.ors[0]).toContain("attendee_phone.ilike.");
    expect(captured.ors[0]).toContain(`call_id.eq.${CALL_ID}`);
  });

  it("phone path: another call's booking gains nothing — corrected phone + foreign call_id stays not-found", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            { data: [apptRow({ attendee_phone: CORRECTED_PHONE, call_id: OTHER_CALL_ID })], error: null },
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: CALLER_PHONE },
      { callerIdState: "verified", verifiedCallerPhone: CALLER_PHONE },
      { callId: CALL_ID },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/wasn't able to find/i);
    expect(captured.updated).toBe(false);
    // No identity leakage either.
    expect(result.message).not.toContain("Jane");
  });

  it("a malformed (non-uuid) callId never reaches the query — plain phone match still works", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            { data: [apptRow()], error: null },
            { data: null, error: null },
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: CALLER_PHONE },
      { callerIdState: "verified", verifiedCallerPhone: CALLER_PHONE },
      { callId: "not-a-uuid'); DROP TABLE appointments;--" },
    );

    expect(result.success).toBe(true);
    expect(captured.ors.length).toBe(0);
    expect(captured.ilikes.length).toBeGreaterThan(0);
  });
});

describe("handleRescheduleAppointment call authority (SCRUM-560)", () => {
  let captured: Captured;
  beforeEach(() => {
    vi.clearAllMocks();
    captured = { ilikes: [], ors: [], updated: false, inserted: false };
  });

  it("phone path: this call's corrected-phone booking joins the caller's own rows (disambiguation sees BOTH)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            {
              data: [
                apptRow(),
                apptRow({ id: "appt-2", start_time: FUTURE_B, attendee_phone: CORRECTED_PHONE, call_id: CALL_ID, confirmation_code: "222222" }),
              ],
              error: null,
            },
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { phone: CALLER_PHONE, new_datetime: "2027-07-15T10:00:00" },
      { callerIdState: "verified", verifiedCallerPhone: CALLER_PHONE },
      { callId: CALL_ID },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/more than one upcoming appointment/i);
    expect(captured.ors.length).toBeGreaterThan(0);
    expect(captured.ors[0]).toContain(`call_id.eq.${CALL_ID}`);
    // Disambiguation options must not leak identity (SCRUM-438 invariant).
    expect(result.message).not.toContain("Jane");
    expect(result.message).not.toContain("111111");
  });
});
