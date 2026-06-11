import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-437: caller ID is spoofable, so a lookup matched ONLY by phone must
// never hand the stored attendee_name back to the model, and the last-9-digit
// phone match must be anchored (ends-with), not a floating %suffix% contains.
// Orgs that configured stronger verification (name/email factors) keep their
// existing behavior.

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

// Thenable builder serving call-ordered results per table. Captures the
// appointments SELECT column list and every ilike filter so the tests can
// assert exactly what leaves the database and how the match is anchored.
function fakeAdmin(tableQueues: Record<string, Result[]>, captured: Captured) {
  return {
    from: (table: string) => {
      const result: Result = tableQueues[table]?.shift() ?? { data: null, error: null };
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: (cols: string) => {
          if (table === "appointments") captured.appointmentSelects.push(cols);
          return b;
        },
        eq: chain,
        in: chain,
        gte: chain,
        order: chain,
        limit: chain,
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
const STORED_NAME = "Jane Smith";

// Even though the real query would no longer return attendee_name for a
// phone-only org, the fixture keeps it populated — proving the formatter
// never echoes it even if a row carried it.
const APPOINTMENT_ROW = {
  id: "appt-1",
  attendee_name: STORED_NAME,
  attendee_phone: "+61412345678",
  attendee_email: "jane@example.com",
  start_time: "2027-07-01T10:00:00Z",
  end_time: "2027-07-01T10:30:00Z",
  duration_minutes: 30,
  status: "confirmed",
  service_type_id: null,
  practitioner_id: null,
};

function orgResult(verification: unknown): Result {
  return {
    data: { appointment_verification_fields: verification, timezone: "Australia/Sydney" },
    error: null,
  };
}

describe("handleLookupAppointment verification strength (SCRUM-437)", () => {
  let captured: Captured;

  beforeEach(() => {
    vi.clearAllMocks();
    captured = { appointmentSelects: [], ilikes: [] };
  });

  it("phone-only org: succeeds with logistics but the row SELECT and message contain NO attendee_name", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgResult({ method: "details_only", fields: ["phone"] })],
          appointments: [{ data: [APPOINTMENT_ROW], error: null }],
        },
        captured,
      ) as never,
    );

    const result = await handleLookupAppointment(ORG, { phone: "+61412345678" });

    // Logistics still confirmed for phone-only orgs…
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/I found your appointment/i);
    // …but identity never leaves the database, and is never spoken.
    expect(captured.appointmentSelects).toHaveLength(1);
    expect(captured.appointmentSelects[0]).not.toContain("attendee_name");
    expect(result.message).not.toContain(STORED_NAME);
    expect(result.message).not.toContain("Jane");
  });

  it("phone-only org: phone match is anchored to the END of attendee_phone (no trailing %)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgResult({ method: "details_only", fields: ["phone"] })],
          appointments: [{ data: [APPOINTMENT_ROW], error: null }],
        },
        captured,
      ) as never,
    );

    await handleLookupAppointment(ORG, { phone: "+61412345678" });

    const phoneFilter = captured.ilikes.find((f) => f.column === "attendee_phone");
    // 11 digits → last 9, anchored ends-with.
    expect(phoneFilter).toEqual({ column: "attendee_phone", pattern: "%412345678" });
  });

  it("name+phone org with both provided: unchanged behavior — identity stays in the SELECT and the lookup succeeds", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgResult({ method: "details_only", fields: ["name", "phone"] })],
          appointments: [{ data: [APPOINTMENT_ROW], error: null }],
        },
        captured,
      ) as never,
    );

    const result = await handleLookupAppointment(ORG, {
      name: "Jane Smith",
      phone: "+61412345678",
    });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/I found your appointment/i);
    expect(captured.appointmentSelects[0]).toContain("attendee_name");
    // Both factors actually constrain the match.
    expect(captured.ilikes).toEqual([
      { column: "attendee_name", pattern: "%Jane Smith%" },
      { column: "attendee_phone", pattern: "%412345678" },
    ]);
  });

  it("name+phone org with phone only: asks for the name and never queries — caller-ID phone can't become the sole match key", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgResult({ method: "details_only", fields: ["name", "phone"] })],
        },
        captured,
      ) as never,
    );

    const result = await handleLookupAppointment(ORG, { phone: "+61412345678" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/full name/i);
    expect(captured.appointmentSelects).toHaveLength(0); // no appointments query at all
  });

  it("code_and_verify org: code + matching name still verifies and succeeds (stronger config untouched)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin(
        {
          organizations: [orgResult({ method: "code_and_verify", fields: ["name"] })],
          appointments: [
            { data: { ...APPOINTMENT_ROW, confirmation_code: "123456" }, error: null },
          ],
        },
        captured,
      ) as never,
    );

    const result = await handleLookupAppointment(ORG, {
      confirmation_code: "123456",
      name: "Jane",
    });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/I found your appointment/i);
  });
});
