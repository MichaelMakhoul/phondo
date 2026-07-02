import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-12 wiring guard: prove the three dispatch sites actually route to the
// Cliniko module when an integration is connected, and stay out of the way
// when it isn't.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true })),
  withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })),
}));
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));
vi.mock("@/lib/sms/caller-sms", () => ({
  sendAppointmentConfirmationSMS: vi.fn(),
  sendCancellationSMS: vi.fn(),
}));
vi.mock("@/lib/notifications/notification-service", () => ({
  sendAppointmentNotification: vi.fn(),
  getOrganizationOwnerEmail: vi.fn(async () => null),
}));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn() }));
vi.mock("@/lib/calendar/cliniko-booking", () => ({
  getActiveClinikoIntegration: vi.fn(async () => ({ kind: "none" })),
  clinikoCheckAvailability: vi.fn(async () => ({ success: true, message: "CLINIKO AVAILABILITY" })),
  clinikoBookAppointment: vi.fn(async () => ({ success: true, message: "CLINIKO BOOKED", data: {} })),
  clinikoCancelExternal: vi.fn(async () => undefined),
}));
vi.mock("@/lib/calendar/cliniko-reconcile", () => ({
  reconcileClinikoOrg: vi.fn(async () => ({ ran: true, cancelled: 0, moved: 0, scanned: 0 })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  getActiveClinikoIntegration,
  clinikoCheckAvailability,
  clinikoBookAppointment,
  clinikoCancelExternal,
} from "@/lib/calendar/cliniko-booking";
import { reconcileClinikoOrg } from "@/lib/calendar/cliniko-reconcile";
import {
  handleCheckAvailability,
  handleBookAppointment,
  handleCancelAppointment,
  handleLookupAppointment,
} from "@/lib/calendar/tool-handlers";

const ORG = "44444444-4444-4444-a444-444444444444";
const CTX = { client: {}, businessId: "b-1", integrationId: "int-1" };
const OK = { kind: "ok", ctx: CTX } as never;
const NONE = { kind: "none" } as never;

/** Permissive table-aware admin mock: singles resolve per-table rows, lists resolve []. */
function fakeAdmin(rows: Record<string, Record<string, unknown> | null> = {}) {
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      update: () => builder,
      delete: () => builder,
      insert: () => builder,
      eq: () => builder,
      neq: () => builder,
      in: () => builder,
      ilike: () => builder,
      gte: () => builder,
      gt: () => builder,
      lt: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      single: async () => ({ data: rows[table] ?? null, error: null }),
      maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
    });
    return builder;
  };
  return { from };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin() as never);
});

describe("check_availability dispatch", () => {
  it("routes to clinikoCheckAvailability when an integration is connected", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(OK);
    const res = await handleCheckAvailability(ORG, { date: "2026-07-07" });
    expect(res.message).toBe("CLINIKO AVAILABILITY");
    expect(clinikoCheckAvailability).toHaveBeenCalledWith(CTX, ORG, {
      date: "2026-07-07",
      service_type_id: undefined,
    });
  });

  it("falls through to the existing flow when not connected", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(NONE);
    const res = await handleCheckAvailability(ORG, {});
    expect(clinikoCheckAvailability).not.toHaveBeenCalled();
    // Built-in path: no service types, no date -> asks for the date.
    expect(res.message).toContain("What date");
  });
});

describe("book_appointment dispatch", () => {
  const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  it("routes to clinikoBookAppointment with parsed startDate and sanitized fields", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(OK);
    const res = await handleBookAppointment(ORG, {
      datetime: FUTURE,
      first_name: "Jo",
      last_name: "Bloggs",
      phone: "+61412345678",
    });
    expect(res.message).toBe("CLINIKO BOOKED");
    expect(clinikoBookAppointment).toHaveBeenCalledTimes(1);
    const [ctxArg, orgArg, bookArgs] = vi.mocked(clinikoBookAppointment).mock.calls[0];
    expect(ctxArg).toBe(CTX);
    expect(orgArg).toBe(ORG);
    expect(bookArgs.startDate).toBeInstanceOf(Date);
    expect(bookArgs.sanitizedName).toBe("Jo Bloggs");
    expect(bookArgs.requestedPractitionerId).toBeUndefined();
  });

  it("rejects a past datetime BEFORE dispatching to Cliniko", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(OK);
    const res = await handleBookAppointment(ORG, {
      datetime: "2020-01-01T10:00:00Z",
      first_name: "Jo",
      last_name: "Bloggs",
      phone: "+61412345678",
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("already passed");
    expect(clinikoBookAppointment).not.toHaveBeenCalled();
  });

  it("validates name BEFORE any Cliniko dispatch (ordering guard)", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(OK);
    const res = await handleBookAppointment(ORG, { datetime: FUTURE });
    expect(res.success).toBe(false);
    expect(clinikoBookAppointment).not.toHaveBeenCalled();
  });
});

describe("cancel dispatch (cliniko rows propagate to the practice diary)", () => {
  const CLINIKO_ROW = {
    id: "appt-1",
    provider: "cliniko",
    external_id: "ck-555",
    attendee_phone: "+61412345678",
    attendee_name: "Jo Bloggs",
    start_time: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    status: "confirmed",
    confirmation_code: "123456",
    metadata: {},
  };

  it("cancels in Cliniko before freeing the local row", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(OK);
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ appointments: CLINIKO_ROW }) as never);

    const res = await handleCancelAppointment(ORG, {
      confirmation_code: "123456",
      phone: "+61412345678",
    });
    expect(clinikoCancelExternal).toHaveBeenCalledTimes(1);
    const [, , rowArg, reasonArg] = vi.mocked(clinikoCancelExternal).mock.calls[0];
    expect((rowArg as unknown as Record<string, unknown>).external_id).toBe("ck-555");
    expect(reasonArg).toContain("Cancelled by caller");
    expect(res.success).toBe(true);
  });

  it("fails the cancellation (both sides intact) when the Cliniko cancel fails", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(OK);
    vi.mocked(clinikoCancelExternal).mockRejectedValue(new Error("cliniko down"));
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ appointments: CLINIKO_ROW }) as never);

    const res = await handleCancelAppointment(ORG, {
      confirmation_code: "123456",
      phone: "+61412345678",
    });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/trouble cancelling/i);
  });

  it("does not touch Cliniko for internal rows", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(OK);
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ appointments: { ...CLINIKO_ROW, provider: "internal", external_id: null } }) as never
    );

    const res = await handleCancelAppointment(ORG, {
      confirmation_code: "123456",
      phone: "+61412345678",
    });
    expect(clinikoCancelExternal).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
  });
});

describe("lookup_appointment reconcile (SCRUM-482)", () => {
  const ORG_ROW = { organizations: { appointment_verification_fields: null, timezone: "Australia/Sydney" } };

  it("reconciles the mirror before reading it when Cliniko is connected", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(OK);
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(ORG_ROW) as never);
    await handleLookupAppointment(ORG, { confirmation_code: "123456" });
    expect(vi.mocked(reconcileClinikoOrg)).toHaveBeenCalledWith(CTX, ORG);
  });

  it("does not reconcile for a non-Cliniko org", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue(NONE);
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(ORG_ROW) as never);
    await handleLookupAppointment(ORG, { confirmation_code: "123456" });
    expect(vi.mocked(reconcileClinikoOrg)).not.toHaveBeenCalled();
  });
});
