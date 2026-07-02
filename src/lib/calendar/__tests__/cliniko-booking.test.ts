import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn() }));
vi.mock("@/lib/sms/caller-sms", () => ({ sendAppointmentConfirmationSMS: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({
  sendAppointmentNotification: vi.fn(),
  getOrganizationOwnerEmail: vi.fn(async () => "owner@example.com"),
}));
vi.mock("@/lib/security/encryption", () => ({ safeDecrypt: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => true) }));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: unknown) => void) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() })
  ),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
const resendSend = vi.fn(async () => ({ data: { id: "email-1" }, error: null }));
vi.mock("resend", () => ({
  Resend: vi.fn(function Resend() {
    return { emails: { send: resendSend } };
  }),
}));
vi.mock("../cliniko-patients", () => ({
  findOrCreateClinikoPatient: vi.fn(async () => ({ patientId: "42", created: false })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { runAfterResponse } from "@/lib/utils/after-response";
import { safeDecrypt } from "@/lib/security/encryption";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { findOrCreateClinikoPatient } from "../cliniko-patients";
import { ClinikoAuthError, ClinikoUnavailableError, ClinikoRateLimitError, ClinikoValidationError } from "../cliniko";
import type { ClinikoClient } from "../cliniko";
import {
  getActiveClinikoIntegration,
  clinikoCheckAvailability,
  clinikoBookAppointment,
  clinikoCancelExternal,
  isClinikoOutage,
  type ClinikoContext,
} from "../cliniko-booking";

const ORG = "33333333-3333-4333-a333-333333333333";

interface DbCall {
  table: string;
  op: string | null;
  payload: unknown;
  filters: Record<string, unknown>;
  inArgs: Record<string, unknown[]>;
}
type Handler = (call: DbCall, seq?: DbCall[]) => { data?: unknown; error?: { message?: string; code?: string } | null };

function mockDb(handler: Handler) {
  const calls: DbCall[] = [];
  const from = vi.fn((table: string) => {
    const call: DbCall = { table, op: null, payload: null, filters: {}, inArgs: {} };
    calls.push(call);
    const resolveWith = () => {
      const res = handler(call, calls) || {};
      return { data: res.data ?? null, error: res.error ?? null };
    };
    const qb: Record<string, unknown> = {
      select: () => {
        if (!call.op) call.op = "select";
        return qb;
      },
      insert: (payload: unknown) => {
        call.op = "insert";
        call.payload = payload;
        return qb;
      },
      update: (payload: unknown) => {
        call.op = "update";
        call.payload = payload;
        return qb;
      },
      delete: () => {
        call.op = "delete";
        return qb;
      },
      eq: (k: string, v: unknown) => {
        call.filters[k] = v;
        return qb;
      },
      gte: () => qb,
      lt: () => qb,
      in: (k: string, v: unknown[]) => {
        call.inArgs[k] = v;
        return qb;
      },
      maybeSingle: async () => resolveWith(),
      single: async () => resolveWith(),
      then: (resolve: (v: unknown) => void) => resolve(resolveWith()),
    };
    return qb;
  });
  return { client: { from }, calls };
}

const SERVICE = { id: "st-1", name: "Check-up", duration_minutes: 30, external_id: "20", is_active: true };
const PRACTITIONERS = [
  { id: "lp-1", name: "Sue Smith", external_id: "10" },
  { id: "lp-2", name: "Ali Vu", external_id: "11" },
];

/** Default handler covering the booking/availability DB sequence. */
const baseHandler: Handler = (call) => {
  if (call.table === "service_types" && call.op === "select") {
    if (call.filters.id) return { data: SERVICE };
    return { data: [SERVICE] }; // linked-types listing
  }
  if (call.table === "organizations") return { data: { timezone: "Australia/Sydney" } };
  if (call.table === "practitioners") return { data: PRACTITIONERS };
  if (call.table === "appointments" && call.op === "select") return { data: [] }; // load query
  if (call.table === "appointments" && call.op === "insert") {
    return { data: { id: "appt-1", confirmation_code: "123456" } };
  }
  return { data: null };
};

function ctxWith(client: Partial<Record<keyof ClinikoClient, unknown>>): ClinikoContext {
  return {
    client: client as unknown as ClinikoClient,
    businessId: "b-1",
    integrationId: "int-1",
  };
}

// 9:00 AM and 9:30 AM on 2026-07-07 in Australia/Sydney (AEST, UTC+10)
const SLOT_9AM = "2026-07-06T23:00:00Z";
const SLOT_930AM = "2026-07-06T23:30:00Z";
const SLOT_2PM = "2026-07-07T04:00:00Z";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.mocked(hasFeatureAccess).mockResolvedValue(true);
  vi.mocked(findOrCreateClinikoPatient).mockResolvedValue({ patientId: "42", created: false });
});

describe("isClinikoOutage", () => {
  it("classifies cliniko error types as outage, others not", () => {
    expect(isClinikoOutage(new ClinikoUnavailableError("x"))).toBe(true);
    expect(isClinikoOutage(new ClinikoRateLimitError("x"))).toBe(true);
    expect(isClinikoOutage(new ClinikoAuthError("x"))).toBe(true);
    expect(isClinikoOutage(new Error("x"))).toBe(false);
  });
});

describe("getActiveClinikoIntegration", () => {
  it("resolves 'ok' with a context when active, entitled, businessId set, key decryptable", async () => {
    const db = mockDb((call) => {
      if (call.table === "calendar_integrations") {
        return { data: { id: "int-1", access_token: "enc", settings: { shard: "au2", businessId: "b-1" } } };
      }
      return { data: null };
    });
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    vi.mocked(safeDecrypt).mockReturnValue("MS0xLWl0c2Fu-au2");
    vi.mocked(hasFeatureAccess).mockResolvedValue(true);

    const res = await getActiveClinikoIntegration(ORG);
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.ctx.businessId).toBe("b-1");
      expect(res.ctx.integrationId).toBe("int-1");
    }
  });

  it("resolves 'none' when no row, no businessId, or the org lost entitlement", async () => {
    const cases: Array<{ row: Record<string, unknown> | null; entitled: boolean }> = [
      { row: null, entitled: true },
      { row: { id: "i", access_token: "enc", settings: { shard: "au2" } }, entitled: true }, // no businessId
      { row: { id: "i", access_token: "enc", settings: { shard: "au2", businessId: "b" } }, entitled: false }, // downgraded
    ];
    for (const { row, entitled } of cases) {
      const db = mockDb(() => ({ data: row }));
      vi.mocked(createAdminClient).mockReturnValue(db.client as never);
      vi.mocked(safeDecrypt).mockReturnValue("MS0xLWl0c2Fu-au2");
      vi.mocked(hasFeatureAccess).mockResolvedValue(entitled);
      expect((await getActiveClinikoIntegration(ORG)).kind).toBe("none");
    }
  });

  it("resolves 'error' (not 'none') on a lookup DB error or an undecryptable key", async () => {
    // DB error
    const dbErr = mockDb(() => ({ error: { message: "boom" } }));
    vi.mocked(createAdminClient).mockReturnValue(dbErr.client as never);
    expect((await getActiveClinikoIntegration(ORG)).kind).toBe("error");

    // Decrypt failure on a present, entitled row → operational fault, not "none"
    const db = mockDb(() => ({ data: { id: "i", access_token: "enc", settings: { shard: "au2", businessId: "b" } } }));
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    vi.mocked(hasFeatureAccess).mockResolvedValue(true);
    vi.mocked(safeDecrypt).mockReturnValue(null);
    expect((await getActiveClinikoIntegration(ORG)).kind).toBe("error");
  });
});

describe("clinikoCheckAvailability", () => {
  it("merges, dedupes and sorts slots across practitioners and formats in org timezone", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const availableTimes = vi
      .fn()
      .mockResolvedValueOnce([SLOT_930AM, SLOT_9AM])
      .mockResolvedValueOnce([SLOT_9AM, SLOT_2PM]);
    const res = await clinikoCheckAvailability(ctxWith({ availableTimes }), ORG, {
      date: "2026-07-07",
      service_type_id: "st-1",
    });

    expect(res.success).toBe(true);
    expect(res.message).toContain("3 available slots");
    expect(res.message).toContain("9:00 AM");
    expect(res.message).toContain("2:00 PM");
    expect(availableTimes).toHaveBeenCalledTimes(2);
    expect(availableTimes).toHaveBeenCalledWith("b-1", "10", "20", "2026-07-07", "2026-07-07");
  });

  it("still answers when one practitioner's availability call fails", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const availableTimes = vi
      .fn()
      .mockRejectedValueOnce(new ClinikoUnavailableError("boom"))
      .mockResolvedValueOnce([SLOT_9AM]);
    const res = await clinikoCheckAvailability(ctxWith({ availableTimes }), ORG, {
      date: "2026-07-07",
      service_type_id: "st-1",
    });
    expect(res.success).toBe(true);
    expect(res.message).toContain("1 available slot");
  });

  it("prompts for a cliniko-linked service type when none supplied", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const res = await clinikoCheckAvailability(ctxWith({}), ORG, { date: "2026-07-07" });
    expect(res.success).toBe(true);
    expect(res.message).toContain("Check-up");
    expect(res.message).toContain("which type");
  });

  it("returns only the requested practitioner's times when practitioner_id is given", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const availableTimes = vi.fn(async () => [SLOT_9AM]);
    const res = await clinikoCheckAvailability(ctxWith({ availableTimes }), ORG, {
      date: "2026-07-07",
      service_type_id: "st-1",
      practitioner_id: "lp-2",
    });
    expect(res.success).toBe(true);
    // Only ONE practitioner queried (lp-2 → external 11), not the whole clinic.
    expect(availableTimes).toHaveBeenCalledTimes(1);
    expect(availableTimes).toHaveBeenCalledWith("b-1", "11", "20", "2026-07-07", "2026-07-07");
  });

  it("offers alternatives when the requested practitioner doesn't do that service", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const availableTimes = vi.fn(async () => [SLOT_9AM]);
    const res = await clinikoCheckAvailability(ctxWith({ availableTimes }), ORG, {
      date: "2026-07-07",
      service_type_id: "st-1",
      practitioner_id: "lp-does-not-do-this",
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("other available options");
    expect(availableTimes).not.toHaveBeenCalled();
  });

  it("returns the take-a-message copy and marks the integration on auth failure", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const availableTimes = vi.fn().mockRejectedValue(new ClinikoAuthError("bad key"));
    const res = await clinikoCheckAvailability(ctxWith({ availableTimes }), ORG, {
      date: "2026-07-07",
      service_type_id: "st-1",
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("take your information");
    const settingsUpdate = db.calls.find((c) => c.table === "calendar_integrations" && c.op === "update");
    expect(settingsUpdate).toBeTruthy();
    expect((settingsUpdate!.payload as Record<string, Record<string, unknown>>).settings.errorState).toBe("auth_failed");
  });
});

describe("clinikoBookAppointment", () => {
  const bookArgs = {
    startDate: new Date(SLOT_9AM),
    sanitizedName: "Jo Bloggs",
    firstName: "Jo",
    lastName: "Bloggs",
    phone: "+61412345678",
    email: undefined as string | undefined,
    sanitizedNotes: "Sore tooth",
    serviceTypeId: "st-1",
    requestedPractitionerId: undefined as string | undefined,
  };

  function bookingClient(overrides: Partial<Record<keyof ClinikoClient, unknown>> = {}) {
    return ctxWith({
      availableTimes: vi.fn(async () => [SLOT_9AM, SLOT_930AM]),
      createAppointment: vi.fn(async () => ({
        id: "ck-555",
        starts_at: SLOT_9AM,
        ends_at: SLOT_930AM,
        cancelled_at: null,
      })),
      ...overrides,
    });
  }

  it("happy path: verifies slot, mirror-inserts BEFORE cliniko create, patches external_id, schedules SMS", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const ctx = bookingClient();

    const res = await clinikoBookAppointment(ctx, ORG, bookArgs);

    expect(res.success).toBe(true);
    expect(res.data?.confirmationCode).toBe("123456");
    expect(res.message).toContain("booked your appointment");

    const insertIdx = db.calls.findIndex((c) => c.table === "appointments" && c.op === "insert");
    expect(insertIdx).toBeGreaterThan(-1);
    const insertPayload = db.calls[insertIdx].payload as Record<string, unknown>;
    expect(insertPayload).toMatchObject({
      organization_id: ORG,
      provider: "cliniko",
      attendee_name: "Jo Bloggs",
      attendee_phone: "+61412345678",
      status: "confirmed",
      service_type_id: "st-1",
    });

    const createMock = ctx.client.createAppointment as ReturnType<typeof vi.fn>;
    expect(createMock).toHaveBeenCalledTimes(1);
    const createArg = createMock.mock.calls[0][0];
    expect(createArg).toMatchObject({
      businessId: "b-1",
      appointmentTypeId: "20",
      patientId: "42",
      startsAtIso: new Date(SLOT_9AM).toISOString(),
    });
    expect(createArg.notes).toContain("Sore tooth");
    expect(createArg.notes).toContain("Booked by Phondo AI receptionist");

    const patch = db.calls.find((c) => c.table === "appointments" && c.op === "update");
    expect(patch).toBeTruthy();
    expect((patch!.payload as Record<string, unknown>).external_id).toBe("ck-555");
    expect((patch!.payload as Record<string, Record<string, unknown>>).metadata).toMatchObject({
      clinikoPatientId: "42",
      clinikoBusinessId: "b-1",
    });

    // SMS/notification/cache-invalidation are scheduled post-response
    expect(vi.mocked(runAfterResponse).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("references a possible duplicate by id only (never the other patient's name) in the note", async () => {
    vi.mocked(findOrCreateClinikoPatient).mockResolvedValue({
      patientId: "900",
      created: true,
      duplicatePatientId: "1",
    });
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const ctx = bookingClient();

    await clinikoBookAppointment(ctx, ORG, bookArgs);
    const createArg = (ctx.client.createAppointment as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArg.notes).toContain("Possible duplicate of patient #1");
    // The old phrasing embedded the OTHER patient's name — it must be gone.
    expect(createArg.notes).not.toContain("May duplicate existing patient");
  });

  it("deletes the mirror row and returns take-a-message copy when the cliniko create fails", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const ctx = bookingClient({
      createAppointment: vi.fn(async () => {
        throw new ClinikoUnavailableError("cliniko down");
      }),
    });

    const res = await clinikoBookAppointment(ctx, ORG, bookArgs);
    expect(res.success).toBe(false);
    expect(res.message).toContain("take your information");
    const del = db.calls.find((c) => c.table === "appointments" && c.op === "delete");
    expect(del).toBeTruthy();
    expect(del!.filters.id).toBe("appt-1");
  });

  it("offers alternatives when the requested slot is not in cliniko availability (no patient, no mirror)", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const ctx = bookingClient({ availableTimes: vi.fn(async () => [SLOT_2PM]) });

    const res = await clinikoBookAppointment(ctx, ORG, bookArgs);
    expect(res.success).toBe(false);
    expect(res.message).toContain("no longer available");
    expect(findOrCreateClinikoPatient).not.toHaveBeenCalled();
    expect(db.calls.some((c) => c.table === "appointments" && c.op === "insert")).toBe(false);
  });

  it("honors a requested practitioner and only books them", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const availableTimes = vi.fn(async () => [SLOT_9AM]);
    const ctx = bookingClient({ availableTimes });

    const res = await clinikoBookAppointment(ctx, ORG, { ...bookArgs, requestedPractitionerId: "lp-2" });
    expect(res.success).toBe(true);
    // Slot check went to the requested practitioner's external id only
    expect(availableTimes).toHaveBeenCalledTimes(1);
    expect(availableTimes).toHaveBeenCalledWith("b-1", "11", "20", expect.any(String), expect.any(String));
    const createArg = (ctx.client.createAppointment as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArg.practitionerId).toBe("11");
    expect(res.data?.practitionerName).toBe("Ali Vu");
  });

  it("treats a 23P01 exclusion violation on the mirror insert as slot-taken and never calls cliniko", async () => {
    const handler: Handler = (call) => {
      if (call.table === "appointments" && call.op === "insert") {
        return { error: { code: "23P01", message: "overlap" } };
      }
      return baseHandler(call);
    };
    const db = mockDb(handler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const ctx = bookingClient();

    const res = await clinikoBookAppointment(ctx, ORG, bookArgs);
    expect(res.success).toBe(false);
    expect(res.message).toContain("no longer available");
    expect(ctx.client.createAppointment).not.toHaveBeenCalled();
  });

  it("sends the auth-failure email only once (errorState dedupe)", async () => {
    let errorState: string | null = null;
    const handler: Handler = (call) => {
      if (call.table === "calendar_integrations" && call.op === "select") {
        return { data: { settings: errorState ? { errorState } : {} } };
      }
      if (call.table === "calendar_integrations" && call.op === "update") {
        errorState = "auth_failed";
        return { data: null };
      }
      return baseHandler(call);
    };
    const db = mockDb(handler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const failing = { availableTimes: vi.fn().mockRejectedValue(new ClinikoAuthError("bad")) };

    await clinikoBookAppointment(ctxWith(failing), ORG, bookArgs);
    await clinikoBookAppointment(ctxWith(failing), ORG, bookArgs);
    expect(resendSend).toHaveBeenCalledTimes(1);
  });
});

describe("clinikoCancelExternal", () => {
  it("cancels via external_id and swallows nothing on success", async () => {
    const cancelAppointment = vi.fn(async () => undefined);
    await clinikoCancelExternal(
      ctxWith({ cancelAppointment }),
      ORG,
      { id: "appt-1", external_id: "ck-555" },
      "Cancelled by caller via Phondo"
    );
    expect(cancelAppointment).toHaveBeenCalledWith("ck-555", "Cancelled by caller via Phondo");
  });

  it("propagates cliniko failures (caller decides the fallback copy)", async () => {
    const cancelAppointment = vi.fn(async () => {
      throw new ClinikoUnavailableError("down");
    });
    await expect(
      clinikoCancelExternal(ctxWith({ cancelAppointment }), ORG, { id: "a", external_id: "ck" }, "x")
    ).rejects.toBeInstanceOf(ClinikoUnavailableError);
  });

  it("THROWS on a cliniko row with no external_id (lost link — appointment stranded, not 'nothing to cancel')", async () => {
    const cancelAppointment = vi.fn();
    await expect(
      clinikoCancelExternal(ctxWith({ cancelAppointment }), ORG, { id: "a", external_id: null }, "x")
    ).rejects.toBeInstanceOf(ClinikoUnavailableError);
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it("flags auth failure + emails owner once when the cliniko cancel returns 401", async () => {
    const db = mockDb((call) => {
      if (call.table === "calendar_integrations" && call.op === "select") return { data: { settings: {} } };
      return { data: null };
    });
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const cancelAppointment = vi.fn(async () => {
      throw new ClinikoAuthError("bad key");
    });
    await expect(
      clinikoCancelExternal(ctxWith({ cancelAppointment }), ORG, { id: "a", external_id: "ck" }, "x")
    ).rejects.toBeInstanceOf(ClinikoAuthError);
    expect(resendSend).toHaveBeenCalledTimes(1);
  });
});

describe("validation error on cliniko create", () => {
  it("maps a 422 (slot race) to the slot-taken copy and cleans up the mirror", async () => {
    const db = mockDb(baseHandler);
    vi.mocked(createAdminClient).mockReturnValue(db.client as never);
    const ctx = ctxWith({
      availableTimes: vi.fn(async () => [SLOT_9AM]),
      createAppointment: vi.fn(async () => {
        throw new ClinikoValidationError("rejected");
      }),
    });

    const res = await clinikoBookAppointment(ctx, ORG, {
      startDate: new Date(SLOT_9AM),
      sanitizedName: "Jo Bloggs",
      firstName: "Jo",
      lastName: "Bloggs",
      phone: "+61412345678",
      email: undefined,
      sanitizedNotes: undefined,
      serviceTypeId: "st-1",
      requestedPractitionerId: undefined,
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("no longer available");
    expect(db.calls.some((c) => c.table === "appointments" && c.op === "delete")).toBe(true);
  });
});
