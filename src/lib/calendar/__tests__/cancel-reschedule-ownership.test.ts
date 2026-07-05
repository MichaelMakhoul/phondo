import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-438: cancel/reschedule ownership flows.
//
//  - POSSESSION: the verified inbound caller ID (threaded by the voice server
//    as a trusted field) outranks the model-controllable phone argument; the
//    model phone is only the fallback when there is no caller ID.
//  - KNOWLEDGE: orgs with explicit appointment_verification_fields get the
//    same name/email enforcement on mutations as lookup.
//  - NO ORACLE: "code exists but wrong phone" is indistinguishable from
//    "code doesn't exist".
//  - NO IDENTITY ECHO: phone-matched disambiguation options carry no
//    attendee_name and no confirmation_code.
//  - ANCHORED MATCHING: the phone lookup is an end-anchored last-9 suffix and
//    degenerate phones are rejected before any query.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true })),
}));
// Keep post-response side effects (cache invalidation, SMS) out of the tests.
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  handleCancelAppointment,
  handleRescheduleAppointment,
} from "@/lib/calendar/tool-handlers";

type Result = { data: unknown; error: { message?: string; code?: string } | null };

type Captured = {
  ilikes: Array<{ column: string; pattern: string }>;
  updated: boolean;
  inserted: boolean;
};

// Thenable builder serving call-ordered results per table (the pattern from
// lookup-verification-strength.test.ts) + mutation tracking and ilike capture.
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
const VICTIM_PHONE = "+61412345678";
const ATTACKER_PHONE = "+61499999999";

const FUTURE_A = "2027-07-01T10:00:00Z";
const FUTURE_B = "2027-07-08T14:00:00Z";

function apptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "appt-1",
    start_time: FUTURE_A,
    attendee_name: "Jane Smith",
    attendee_phone: VICTIM_PHONE,
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
    ...overrides,
  };
}

function orgVerification(value: unknown): Result {
  return { data: { appointment_verification_fields: value }, error: null };
}

describe("handleCancelAppointment ownership (SCRUM-438)", () => {
  let captured: Captured;
  beforeEach(() => {
    vi.clearAllMocks();
    captured = { ilikes: [], updated: false, inserted: false };
  });

  it("phone path: a model echoing the victim's number is blocked when the verified caller ID differs — and learns nothing", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [{ data: [apptRow()], error: null }],
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: VICTIM_PHONE },
      { verifiedCallerPhone: ATTACKER_PHONE },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/wasn't able to find/i);
    expect(captured.updated).toBe(false);
    // No schedule/identity leakage to a non-owner.
    expect(result.message).not.toContain("Jane");
    expect(result.message).not.toContain("111111");
  });

  it("phone path: matching verified caller ID cancels (the happy path still works)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            { data: [apptRow()], error: null }, // phone lookup
            { data: null, error: null },        // status update
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: VICTIM_PHONE },
      { verifiedCallerPhone: VICTIM_PHONE },
    );

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/has been cancelled/i);
    expect(captured.updated).toBe(true);
  });

  it("phone path: a GENUINE test call (no callId, no caller-ID state) still falls back to the model phone", async () => {
    // The route forwards NO trusted context for a browser/test session, so the
    // model-supplied phone is the only possession candidate — and it works.
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

    const result = await handleCancelAppointment(ORG, { phone: "0412 345 678" });

    expect(result.success).toBe(true);
    expect(captured.updated).toBe(true);
  });

  it("phone path: a PRODUCTION call with a WITHHELD caller ID refuses outright — the model phone is NEVER a fallback", async () => {
    // The attacker dials with caller ID suppressed (#31#) and the model echoes
    // the victim's own number. The route forwards { callerIdState: 'withheld' };
    // possession is unverifiable and the handler must refuse BEFORE any lookup —
    // never substituting the model-controlled phone for the hidden caller ID.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ organizations: [orgVerification(null)] }, captured) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: VICTIM_PHONE },
      { callerIdState: "withheld" },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/private or blocked number/i);
    expect(captured.updated).toBe(false);
    expect(captured.ilikes).toHaveLength(0); // refused before any appointments query
  });

  it("phone path: the lookup is an END-anchored last-9 suffix (PR #346 form)", async () => {
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

    await handleCancelAppointment(ORG, { phone: VICTIM_PHONE }, { verifiedCallerPhone: VICTIM_PHONE });

    expect(captured.ilikes).toEqual([{ column: "attendee_phone", pattern: "%412345678" }]);
  });

  it("phone path: a degenerate phone ('anonymous') is rejected before any appointments query", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ organizations: [orgVerification(null)] }, captured) as never,
    );

    const result = await handleCancelAppointment(ORG, { phone: "anonymous" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/full phone number/i);
    expect(captured.ilikes).toHaveLength(0);
    expect(captured.updated).toBe(false);
  });

  it("code path: 'valid code + wrong caller' is INDISTINGUISHABLE from 'wrong code' (no enumeration oracle)", async () => {
    // Scenario 1: the code matches the victim's booking, but the verified
    // caller ID is the attacker's.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            { data: apptRow(), error: null }, // code lookup hit
            { data: [], error: null },        // fall-through phone lookup: nothing
          ],
        },
        captured,
      ) as never,
    );
    const validCodeWrongCaller = await handleCancelAppointment(
      ORG,
      { confirmation_code: "111111", phone: ATTACKER_PHONE },
      { verifiedCallerPhone: ATTACKER_PHONE },
    );

    // Scenario 2: the code matches nothing.
    const captured2: Captured = { ilikes: [], updated: false, inserted: false };
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            { data: null, error: { code: "PGRST116" } }, // code lookup miss
            { data: [], error: null },                   // phone lookup: nothing
          ],
        },
        captured2,
      ) as never,
    );
    const wrongCode = await handleCancelAppointment(
      ORG,
      { confirmation_code: "654321", phone: ATTACKER_PHONE },
      { verifiedCallerPhone: ATTACKER_PHONE },
    );

    expect(validCodeWrongCaller.success).toBe(false);
    expect(wrongCode.success).toBe(false);
    expect(validCodeWrongCaller.message).toBe(wrongCode.message); // the oracle is closed
    expect(captured.updated).toBe(false);
  });

  it("code path with NO phone at all: identical generic ask whether the code matched or not", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [{ data: apptRow({ attendee_phone: VICTIM_PHONE }), error: null }],
        },
        captured,
      ) as never,
    );
    const codeMatched = await handleCancelAppointment(ORG, { confirmation_code: "111111" });

    const captured2: Captured = { ilikes: [], updated: false, inserted: false };
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [{ data: null, error: { code: "PGRST116" } }],
        },
        captured2,
      ) as never,
    );
    const codeMissed = await handleCancelAppointment(ORG, { confirmation_code: "111111" });

    expect(codeMatched.success).toBe(false);
    expect(codeMatched.message).toBe(codeMissed.message);
    expect(captured.updated).toBe(false);
  });

  it("code path: org with explicit name verification asks for the name, then cancels when it matches", async () => {
    const queues = () => ({
      organizations: [orgVerification({ method: "code_and_verify", fields: ["name"] })],
      appointments: [
        { data: apptRow(), error: null }, // code lookup
        { data: null, error: null },      // status update (only reached on success)
      ],
    });

    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(queues(), captured) as never);
    const askName = await handleCancelAppointment(
      ORG,
      { confirmation_code: "111111" },
      { verifiedCallerPhone: VICTIM_PHONE },
    );
    expect(askName.success).toBe(false);
    expect(askName.message).toMatch(/confirm the name/i);
    expect(captured.updated).toBe(false);

    const captured2: Captured = { ilikes: [], updated: false, inserted: false };
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(queues(), captured2) as never);
    const cancelled = await handleCancelAppointment(
      ORG,
      { confirmation_code: "111111", name: "jane" },
      { verifiedCallerPhone: VICTIM_PHONE },
    );
    expect(cancelled.success).toBe(true);
    expect(captured2.updated).toBe(true);
  });

  it("code path: a wrong name is refused generically — never echoing the stored name", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification({ method: "code_and_verify", fields: ["name"] })],
          appointments: [{ data: apptRow(), error: null }],
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { confirmation_code: "111111", name: "Robert Brown" },
      { verifiedCallerPhone: VICTIM_PHONE },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/don't match/i);
    expect(result.message).not.toContain("Jane");
    expect(captured.updated).toBe(false);
  });

  it("disambiguation lines carry NO attendee_name and NO confirmation_code (identity-echo suppressed)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            {
              data: [
                apptRow({ id: "appt-1", start_time: FUTURE_A, confirmation_code: "111111" }),
                apptRow({ id: "appt-2", start_time: FUTURE_B, confirmation_code: "222222" }),
              ],
              error: null,
            },
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: VICTIM_PHONE },
      { verifiedCallerPhone: VICTIM_PHONE },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("datetime:"); // the model can still pin a row
    expect(result.message).not.toContain("Jane");
    expect(result.message).not.toContain("111111");
    expect(result.message).not.toContain("222222");
    // Same-minute ties are resolved by asking the CALLER for their code.
    expect(result.message).toMatch(/ask the caller/i);
    expect(captured.updated).toBe(false);
  });

  it("datetime pin still cancels the closest OWNED appointment", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            {
              data: [
                apptRow({ id: "appt-1", start_time: "2027-07-01T10:00:00Z" }),
                apptRow({ id: "appt-2", start_time: "2027-07-08T14:00:00Z" }),
              ],
              error: null,
            },
            { data: null, error: null }, // status update
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: VICTIM_PHONE, datetime: "2027-07-01T10:00" },
      { verifiedCallerPhone: VICTIM_PHONE },
    );

    expect(result.success).toBe(true);
    expect(captured.updated).toBe(true);
  });
});

describe("handleRescheduleAppointment ownership (SCRUM-438)", () => {
  let captured: Captured;
  beforeEach(() => {
    vi.clearAllMocks();
    captured = { ilikes: [], updated: false, inserted: false };
  });

  it("code path with no phone: identical generic ask whether the code matched (possession unverifiable) or not", async () => {
    // Code matches but there's no phone anywhere to verify possession.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [{ data: [apptRow()], error: null }], // code lookup (limit 2)
        },
        captured,
      ) as never,
    );
    const codeMatched = await handleRescheduleAppointment(ORG, {
      confirmation_code: "111111",
      new_datetime: "2027-07-02T10:00:00",
    });

    // Code matches nothing, also no phone.
    const captured2: Captured = { ilikes: [], updated: false, inserted: false };
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [{ data: [], error: null }],
        },
        captured2,
      ) as never,
    );
    const codeMissed = await handleRescheduleAppointment(ORG, {
      confirmation_code: "654321",
      new_datetime: "2027-07-02T10:00:00",
    });

    expect(codeMatched.success).toBe(false);
    expect(codeMatched.message).toBe(codeMissed.message);
    expect(captured.updated).toBe(false);
    expect(captured.inserted).toBe(false);
  });

  it("code path: valid code + mismatching verified caller falls through and never books/frees anything", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            { data: [apptRow()], error: null }, // code lookup hit
            { data: [], error: null },          // fall-through phone lookup: nothing owned
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { confirmation_code: "111111", phone: ATTACKER_PHONE, new_datetime: "2027-07-02T10:00:00" },
      { verifiedCallerPhone: ATTACKER_PHONE },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/couldn't find an upcoming appointment/i);
    expect(captured.updated).toBe(false);
    expect(captured.inserted).toBe(false);
  });

  it("phone path: a model echoing the victim's number is blocked when the verified caller ID differs", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [{ data: [apptRow()], error: null }],
        },
        captured,
      ) as never,
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { phone: VICTIM_PHONE, new_datetime: "2027-07-02T10:00:00" },
      { verifiedCallerPhone: ATTACKER_PHONE },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/couldn't find an upcoming appointment/i);
    expect(result.message).not.toContain("Jane");
    expect(captured.updated).toBe(false);
    expect(captured.inserted).toBe(false);
  });

  it("a PRODUCTION call with a WITHHELD caller ID refuses outright — never books/frees and never trusts the model phone", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ organizations: [orgVerification(null)] }, captured) as never,
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { phone: VICTIM_PHONE, new_datetime: "2027-07-02T10:00:00" },
      { callerIdState: "withheld" },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/private or blocked number/i);
    expect(captured.updated).toBe(false);
    expect(captured.inserted).toBe(false);
    expect(captured.ilikes).toHaveLength(0); // refused before any appointments query
  });

  it("phone path: a degenerate phone is rejected before any appointments query", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ organizations: [orgVerification(null)] }, captured) as never,
    );

    const result = await handleRescheduleAppointment(ORG, {
      phone: "8",
      new_datetime: "2027-07-02T10:00:00",
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/full phone number/i);
    expect(captured.ilikes).toHaveLength(0);
  });

  it("org with explicit name verification demands the name BEFORE booking the new slot", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification({ method: "details_only", fields: ["name", "phone"] })],
          appointments: [{ data: [apptRow()], error: null }], // code lookup
        },
        captured,
      ) as never,
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { confirmation_code: "111111", new_datetime: "2027-07-02T10:00:00" },
      { verifiedCallerPhone: VICTIM_PHONE },
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/confirm the name/i);
    expect(captured.inserted).toBe(false); // new slot never booked
    expect(captured.updated).toBe(false);  // old appointment untouched
  });

  it("reschedule disambiguation lines carry NO attendee_name and NO confirmation_code", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [
            {
              data: [
                apptRow({ id: "appt-1", start_time: FUTURE_A, confirmation_code: "111111" }),
                apptRow({ id: "appt-2", start_time: FUTURE_B, confirmation_code: "222222" }),
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
      { phone: VICTIM_PHONE, new_datetime: "2027-08-01T10:00:00" },
      { verifiedCallerPhone: VICTIM_PHONE },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("datetime:");
    expect(result.message).not.toContain("Jane");
    expect(result.message).not.toContain("111111");
    expect(result.message).not.toContain("222222");
    expect(captured.updated).toBe(false);
    expect(captured.inserted).toBe(false);
  });
});

// SCRUM-509: genuine tool failures must carry `error:true` so the voice server
// emits an [ALERT:error] line (the reschedule failure was invisible to alerting
// because it fell back to a friendly message with HTTP 200). Business
// non-success (not found, wrong owner) must NOT be flagged, or the alert floods.
describe("tool error flagging (SCRUM-509)", () => {
  let captured: Captured;
  beforeEach(() => {
    vi.clearAllMocks();
    captured = { ilikes: [], updated: false, inserted: false };
  });

  it("reschedule flags a genuine DB error with error:true", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [{ data: null, error: { message: "db boom" } }], // existing-appointment lookup fails
        },
        captured,
      ) as never,
    );

    const result = await handleRescheduleAppointment(
      ORG,
      { phone: VICTIM_PHONE, new_datetime: FUTURE_B },
      { verifiedCallerPhone: VICTIM_PHONE },
    );

    expect(result.success).toBe(false);
    expect((result as { error?: boolean }).error).toBe(true);
    expect(result.message).toMatch(/trouble/i);
    expect(captured.inserted).toBe(false);
  });

  it("cancel flags a genuine DB error with error:true", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [{ data: null, error: { message: "db boom" } }], // phone lookup fails
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: VICTIM_PHONE },
      { verifiedCallerPhone: VICTIM_PHONE },
    );

    expect(result.success).toBe(false);
    expect((result as { error?: boolean }).error).toBe(true);
    expect(result.message).toMatch(/trouble/i);
    expect(captured.updated).toBe(false);
  });

  it("does NOT flag a business non-success (no matching appointment)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgVerification(null)],
          appointments: [{ data: [], error: null }], // clean query, nothing found
        },
        captured,
      ) as never,
    );

    const result = await handleCancelAppointment(
      ORG,
      { phone: VICTIM_PHONE },
      { verifiedCallerPhone: VICTIM_PHONE },
    );

    expect(result.success).toBe(false);
    expect((result as { error?: boolean }).error).toBeUndefined();
  });
});
