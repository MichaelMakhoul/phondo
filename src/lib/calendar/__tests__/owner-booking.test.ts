import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-599: the receptionist's booking path run for the owner's assistant
// (internal.ownerBooking — set by the owner handler, never a model argument). Pins:
// only Phondo's own diary (a Cliniko or Cal.com org is refused, never booked there);
// the row is the owner's (metadata.source owner_voice, the owner call's id); neither
// automatic notice goes out — the owner's own choice of telling the customer runs
// after, in the owner handler; the receptionist's bookings are unchanged; and
// ownerDiaryProvider routes exactly as handleBookAppointment does.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({ rateLimitDistributed: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/notifications/notification-service", () => ({ sendAppointmentNotification: vi.fn(async () => {}) }));
vi.mock("@/lib/sms/caller-sms", () => ({ sendAppointmentConfirmationSMS: vi.fn(async () => ({ sent: true })), sendCancellationSMS: vi.fn() }));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn(async () => {}) }));
// After-response work runs at once, so a notice that would go out is seen here.
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn((work: () => Promise<unknown>) => void work()) }));
vi.mock("@/lib/calendar/cal-com", async (importOriginal) => ({ ...(await importOriginal<object>()), getCalComClient: vi.fn(async () => null) }));
vi.mock("@/lib/calendar/cliniko-booking", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveClinikoIntegration: vi.fn(async () => ({ kind: "none" })),
  clinikoBookAppointment: vi.fn(),
}));
vi.mock("@/lib/service-types", async (importOriginal) => ({ ...(await importOriginal<object>()), getActiveServiceTypes: vi.fn(async () => []) }));

import { createAdminClient } from "@/lib/supabase/admin";
import { sendAppointmentNotification } from "@/lib/notifications/notification-service";
import { sendAppointmentConfirmationSMS } from "@/lib/sms/caller-sms";
import { getCalComClient } from "@/lib/calendar/cal-com";
import { getActiveClinikoIntegration, clinikoBookAppointment } from "@/lib/calendar/cliniko-booking";
import { getActiveServiceTypes } from "@/lib/service-types";
import { handleBookAppointment, ownerDiaryProvider } from "@/lib/calendar/tool-handlers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = "11111111-2222-4333-a444-555555555555";
const OWNER_CALL = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const SLOT = "2027-07-07T10:00"; // a Wednesday, inside the hours below
const OPEN = { open: "09:00", close: "17:00" };
const HOURS = { monday: OPEN, tuesday: OPEN, wednesday: OPEN, thursday: OPEN, friday: OPEN, saturday: null, sunday: null };
const ARGS = { datetime: SLOT, first_name: "Jane", last_name: "Smith", phone: "+61412345678" };

let inserts: any[] = [];
/** The assistant's prompt_config, as handleBookAppointment reads it for the name rules. */
let assistantRow: unknown = null;
/** What the diary check reads (service types, a Cal.com account), per table — and a fault to return instead. */
let lists: Record<string, unknown[]> = {};
let faults: Record<string, { code: string }> = {};
/** The org's hours, an insert that fits, and nothing else in the diary. */
function fakeAdmin() {
  return {
    from: (table: string) => {
      const b: any = {};
      for (const m of ["select", "eq", "neq", "in", "is", "not", "gte", "lte", "lt", "gt", "order", "limit", "ilike", "update"]) b[m] = () => b;
      b.insert = (row: any) => { inserts.push(row); return b; };
      b.single = async () =>
        table === "organizations"
          ? { data: { business_hours: HOURS, timezone: "Australia/Sydney" }, error: null }
          : table === "appointments"
            ? { data: { id: "appt-new", confirmation_code: "654321" }, error: null }
            : table === "assistants"
              ? { data: assistantRow, error: null }
              : { data: null, error: null };
      b.maybeSingle = async () => (table === "assistants" ? { data: assistantRow, error: null } : { data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(faults[table] ? { data: null, error: faults[table] } : { data: lists[table] ?? [], error: null }).then(resolve, reject);
      return b;
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  inserts = [];
  assistantRow = null;
  lists = {};
  faults = {};
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin() as never);
  vi.mocked(getActiveClinikoIntegration).mockResolvedValue({ kind: "none" } as never);
  vi.mocked(getActiveServiceTypes).mockResolvedValue([]);
  vi.mocked(getCalComClient).mockResolvedValue(null as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("handleBookAppointment for the owner's assistant", () => {
  it("books in Phondo's diary as the OWNER's booking, on the owner's call, and sends neither automatic notice", async () => {
    const r = await handleBookAppointment(ORG, ARGS, { callId: OWNER_CALL, ownerBooking: true });
    await flush();
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ appointmentId: "appt-new", confirmationCode: inserts[0].confirmation_code });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ call_id: OWNER_CALL, metadata: { source: "owner_voice" }, attendee_name: "Jane Smith", attendee_phone: "+61412345678" });
    expect(sendAppointmentNotification).not.toHaveBeenCalled();
    expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
  });

  it("the receptionist's own booking is unchanged: marked as the AI receptionist's, and both notices go out", async () => {
    const r = await handleBookAppointment(ORG, ARGS, { callId: OWNER_CALL });
    await flush();
    expect(r.success).toBe(true);
    expect(inserts[0]).toMatchObject({ metadata: { source: "ai_receptionist" } });
    expect(sendAppointmentNotification).toHaveBeenCalledTimes(1);
    expect(sendAppointmentConfirmationSMS).toHaveBeenCalledTimes(1);
  });

  // SCRUM-602: each business decides what its bookings need (Caller Data Collection). The
  // rule applies to the owner's bookings as to the receptionist's — the owner handler asks
  // for the surname before its read-back; this is the backstop behind it.
  it("the business's required last name applies to owner bookings too; a business that doesn't require one books a first name alone", async () => {
    assistantRow = { prompt_config: { fields: [{ id: "first_name", required: true }, { id: "last_name", required: true }] } };
    const { last_name: _none, ...firstOnly } = ARGS;
    const refused = await handleBookAppointment(ORG, firstOnly, { callId: OWNER_CALL, ownerBooking: true });
    expect(refused).toMatchObject({ success: false, message: "I also need your last name to complete the booking. What is your last name?" });
    expect(inserts).toEqual([]);
    assistantRow = { prompt_config: { fields: [{ id: "first_name", required: true }, { id: "last_name", required: false }] } };
    const booked = await handleBookAppointment(ORG, firstOnly, { callId: OWNER_CALL, ownerBooking: true });
    expect(booked.success).toBe(true);
    expect(inserts[0]).toMatchObject({ attendee_name: "Jane", metadata: { source: "owner_voice" } });
  });

  it("an org on Cliniko is refused — never booked there, nothing written", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValue({ kind: "ok", ctx: {} } as never);
    const r = await handleBookAppointment(ORG, ARGS, { callId: OWNER_CALL, ownerBooking: true });
    expect(r).toEqual({ success: false, message: "Your diary is in Cliniko, so I haven't booked anything — please book it there.", data: { ownerRefusal: "external_calendar" } });
    expect(clinikoBookAppointment).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("an org on Cal.com (no service types) is refused — never booked there, nothing written", async () => {
    vi.mocked(getCalComClient).mockResolvedValue({ bookings: {} } as never);
    const r = await handleBookAppointment(ORG, ARGS, { callId: OWNER_CALL, ownerBooking: true });
    expect(r).toEqual({ success: false, message: "Your diary is in Cal.com, so I haven't booked anything — please book it there.", data: { ownerRefusal: "external_calendar" } });
    expect(inserts).toEqual([]);
  });
});

describe("ownerDiaryProvider routes as handleBookAppointment does — and a lookup fault is a fault (silent lens N3)", () => {
  it("Cliniko connected → Cliniko; a Cliniko lookup fault → error (never a guess)", async () => {
    vi.mocked(getActiveClinikoIntegration).mockResolvedValueOnce({ kind: "ok", ctx: {} } as never);
    expect(await ownerDiaryProvider(ORG)).toBe("Cliniko");
    vi.mocked(getActiveClinikoIntegration).mockResolvedValueOnce({ kind: "error" } as never);
    expect(await ownerDiaryProvider(ORG)).toBe("error");
  });

  it("service types set up → Phondo's diary, whatever Cal.com says", async () => {
    lists = { service_types: [{ id: "st-1" }], calendar_integrations: [{ id: "ci-1", access_token: "enc" }] };
    expect(await ownerDiaryProvider(ORG)).toBe("phondo");
  });

  it("no service types: Cal.com when an account with a key is connected, Phondo's diary when not", async () => {
    lists = { calendar_integrations: [{ id: "ci-1", access_token: "enc" }] };
    expect(await ownerDiaryProvider(ORG)).toBe("Cal.com");
    lists = { calendar_integrations: [{ id: "ci-1", access_token: null }] };
    expect(await ownerDiaryProvider(ORG)).toBe("phondo");
    lists = {};
    expect(await ownerDiaryProvider(ORG)).toBe("phondo");
  });

  it("a fault reading the service types or the Cal.com account is 'error' — never read as 'Phondo's own diary'", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const table of ["service_types", "calendar_integrations"]) {
      faults = { [table]: { code: "57014" } };
      lists = { calendar_integrations: [{ id: "ci-1", access_token: "enc" }] };
      expect(await ownerDiaryProvider(ORG), table).toBe("error");
    }
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
