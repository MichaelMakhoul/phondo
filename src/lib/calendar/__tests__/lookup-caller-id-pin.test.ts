import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-505: a verified inbound caller looking up their OWN appointment must
// succeed off the trusted caller ID (possession), tolerate an STT-mangled name,
// and never become an enumeration oracle. These exercise the NEW verified-
// caller-ID branch (the existing SCRUM-437 suite covers the legacy/test path,
// where no trusted caller ID exists).

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { handleLookupAppointment } from "@/lib/calendar/tool-handlers";

type Result = { data: unknown; error: { message?: string; code?: string } | null };
type Captured = {
  appointmentSelects: string[];
  ilikes: Array<{ column: string; pattern: string }>;
};

function fakeAdmin(tableQueues: Record<string, Result[]>, captured: Captured) {
  return {
    from: (table: string) => {
      const result: Result = tableQueues[table]?.shift() ?? { data: null, error: null };
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: (cols: string) => {
          if (table === "appointments") captured.appointmentSelects.push(cols);
          return b;
        },
        eq: () => b,
        in: () => b,
        gte: () => b,
        order: () => b,
        limit: () => b,
        ilike: (column: string, pattern: string) => {
          if (table === "appointments") captured.ilikes.push({ column, pattern });
          return b;
        },
        single: async () => result,
        then: (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(onF, onR),
      });
      return b;
    },
  };
}

const ORG = "org-1";
const CALLER = "+61414141883";
const APPT = {
  id: "appt-1",
  attendee_name: "Michael MAKHOUL",
  attendee_phone: "+61414141883",
  attendee_email: "m@example.com",
  start_time: "2027-08-14T04:00:00Z",
  end_time: "2027-08-14T04:30:00Z",
  duration_minutes: 30,
  status: "confirmed",
  service_type_id: null,
  practitioner_id: null,
};
const VERIFIED = { callerIdState: "verified" as const, verifiedCallerPhone: CALLER };

function orgResult(verification: unknown): Result {
  return { data: { appointment_verification_fields: verification, timezone: "Australia/Sydney" }, error: null };
}

describe("handleLookupAppointment — verified caller ID pin (SCRUM-505)", () => {
  let captured: Captured;
  beforeEach(() => {
    vi.clearAllMocks();
    captured = { appointmentSelects: [], ilikes: [] };
  });

  const withData = (verification: unknown, rows: unknown) =>
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ organizations: [orgResult(verification)], appointments: [{ data: rows, error: null }] }, captured) as never,
    );

  it("finds the caller's own appointment by verified caller ID + correct name", async () => {
    withData({ method: "details_only", fields: ["name", "phone"] }, [APPT]);
    const result = await handleLookupAppointment(ORG, { name: "Michael Makhoul" }, VERIFIED);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/I found your appointment/i);
  });

  it("still finds it when STT mangled the name (Macool ≈ Makhoul)", async () => {
    withData({ method: "details_only", fields: ["name", "phone"] }, [APPT]);
    const result = await handleLookupAppointment(ORG, { name: "Macool" }, VERIFIED);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/I found your appointment/i);
  });

  it("pins by the VERIFIED caller ID, ignoring a wrong model-supplied phone", async () => {
    withData({ method: "details_only", fields: ["name", "phone"] }, [APPT]);
    await handleLookupAppointment(ORG, { name: "Makhoul", phone: "+61999999999" }, VERIFIED);
    const phoneFilter = captured.ilikes.find((f) => f.column === "attendee_phone");
    // Suffix comes from the caller ID (414141883), never the model's 999999999.
    expect(phoneFilter).toEqual({ column: "attendee_phone", pattern: "%414141883" });
  });

  it("anti-enumeration: a wrong name returns the SAME line as genuine not-found", async () => {
    withData({ method: "details_only", fields: ["name", "phone"] }, [APPT]);
    const wrong = await handleLookupAppointment(ORG, { name: "Robert Johnson" }, VERIFIED);
    withData({ method: "details_only", fields: ["name", "phone"] }, []); // truly none
    const none = await handleLookupAppointment(ORG, { name: "Robert Johnson" }, VERIFIED);
    expect(wrong.message).toBe(none.message);
    expect(wrong.message).not.toMatch(/Makhoul|Michael/i); // never leaks the stored name
  });

  it("asks for the name (no query) when name is required but not yet given", async () => {
    withData({ method: "details_only", fields: ["name", "phone"] }, [APPT]);
    const result = await handleLookupAppointment(ORG, {}, VERIFIED);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/full name/i);
    expect(captured.appointmentSelects).toHaveLength(0);
  });

  it("phone-only org: returns logistics but never fetches attendee_name", async () => {
    withData({ method: "details_only", fields: ["phone"] }, [APPT]);
    const result = await handleLookupAppointment(ORG, {}, VERIFIED);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/I found your appointment/i);
    expect(captured.appointmentSelects[0]).not.toContain("attendee_name");
    expect(result.message).not.toContain("Makhoul");
  });

  it("possession gate: a prefiltered row whose number doesn't actually match is dropped", async () => {
    // The ilike suffix is a coarse prefilter; verifyPhonePossession is the precise
    // gate. A row under a DIFFERENT number must not be returned to the caller.
    withData({ method: "details_only", fields: ["phone"] }, [{ ...APPT, attendee_phone: "+61400000000" }]);
    const result = await handleLookupAppointment(ORG, {}, VERIFIED);
    expect(result.message).toBe(
      "I couldn't find any upcoming appointments matching your details. It's possible the appointment was booked under a different name or phone number. Would you like me to arrange a callback so someone from the team can help you?",
    );
  });
});
