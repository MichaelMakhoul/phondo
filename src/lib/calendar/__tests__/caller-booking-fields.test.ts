import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-617: a caller's booking needs what THIS business requires (Assistants → Caller Data
// Collection) — not only the name. On 28 Oct the owner turned on Address and Reason for
// Calling, then rang the demo line: the receptionist asked for a first and last name and
// booked, because the booking tool told it "first name, last name and the time" for every
// business and had nowhere to put anything else. The booking handler now refuses until every
// required field is in, names them all at once, and saves them in the job's note.

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


/** Copperline's fields on 28 Oct, as saved by the dashboard. */
const COPPERLINE_FIELDS = [
  { id: "first_name", type: "text", label: "First Name", category: "universal", required: true, verification: "repeat-confirm" },
  { id: "last_name", type: "text", label: "Last Name", category: "universal", required: true, verification: "repeat-confirm" },
  { id: "phone_number", type: "phone", label: "Phone Number", category: "universal", required: true, verification: "read-back-digits" },
  { id: "email_address", type: "email", label: "Email Address", category: "universal", required: false, verification: "spell-out" },
  { id: "address", type: "address", label: "Address", category: "other", required: true, verification: "repeat-confirm" },
  { id: "company_name", type: "text", label: "Company Name", category: "other", required: false, verification: "repeat-confirm" },
  { id: "reason_for_calling", type: "text", label: "Reason for Calling", category: "other", required: true, verification: "none" },
];
const CALL = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const withFields = (fields: unknown[]) => { assistantRow = { prompt_config: { fields } }; };

describe("a caller's booking follows the business's own required fields (SCRUM-617)", () => {
  it("the 28 Oct call: name and number but no address or reason — not booked, both named at once, nothing written", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, ARGS, { callId: CALL });
    expect(r.success).toBe(false);
    expect(r.message).toBe(
      "Not booked yet: this business's bookings also need the address and the reason for calling. " +
        "Ask the caller for them in one question — use anything they've already told you (like why they're calling) instead of asking again — " +
        'then call book_appointment again with them in details ("Address: …; Reason for Calling: …").'
    );
    expect(r.data).toEqual({ missing_fields: [{ id: "address", label: "Address" }, { id: "reason_for_calling", label: "Reason for Calling" }] });
    expect(inserts).toEqual([]);
  });

  it("with them in details: booked, and the job's note holds each on its own line in the business's order", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Reason for Calling: shower installation; Address: 12 Smith St, Wyong" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].notes).toBe("Address: 12 Smith St, Wyong\nReason for Calling: shower installation");
  });

  it("a field matches by id or label, any case or spacing; = works like a colon; a line break separates like a semicolon", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "address=12 Smith St\nREASON FOR CALLING = leaking tap" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Address: 12 Smith St\nReason for Calling: leaking tap");
  });

  it("the caller's own note comes first, then the details in the business's order; an optional field given is saved; one it doesn't have is kept last", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(
      ORG,
      { ...ARGS, notes: "Side gate code 1234", details: "Address: 12 Smith St; Reason for Calling: blocked drain; Company Name: Smith Builds; Pets: dog in the yard" },
      { callId: CALL }
    );
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Side gate code 1234\nAddress: 12 Smith St\nCompany Name: Smith Builds\nReason for Calling: blocked drain\nPets: dog in the yard");
  });

  it("a blank required value is no value — still asked for", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Address: ; Reason for Calling: leak" }, { callId: CALL });
    expect(r.success).toBe(false);
    expect(r.data).toEqual({ missing_fields: [{ id: "address", label: "Address" }] });
    expect(r.message).toContain("also need the address.");
    expect(r.message).toContain('again with them in details ("Address: …")');
  });

  it("a business that requires an email: no email is not booked; one passed as a detail counts and is saved as the booking's email", async () => {
    withFields([{ id: "first_name", label: "First Name", required: true }, { id: "email_address", label: "Email Address", required: true }]);
    const refused = await handleBookAppointment(ORG, ARGS, { callId: CALL });
    expect(refused.message).toContain("also need the caller's email address.");
    expect(refused.message).toContain("again with the email in email.");
    const booked = await handleBookAppointment(ORG, { ...ARGS, details: "Email: jane@example.com" }, { callId: CALL });
    expect(booked.success).toBe(true);
    expect(inserts[0]).toMatchObject({ attendee_email: "jane@example.com" });
  });

  it("only what the business requires: a business with no extra fields books a name and number as before", async () => {
    withFields([{ id: "first_name", label: "First Name", required: true }, { id: "last_name", label: "Last Name", required: false }, { id: "address", label: "Address", required: false }]);
    const { last_name: _none, ...firstOnly } = ARGS;
    const r = await handleBookAppointment(ORG, firstOnly, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes ?? null).toBeNull();
  });

  it("the owner's bookings (checked before their read-back, SCRUM-602) and a reschedule's new leg (carrying the original) aren't held to it", async () => {
    withFields(COPPERLINE_FIELDS);
    expect((await handleBookAppointment(ORG, ARGS, { callId: CALL, ownerBooking: true })).success).toBe(true);
    expect((await handleBookAppointment(ORG, ARGS, { callId: CALL, rescheduleLeg: true })).success).toBe(true);
    expect(inserts).toHaveLength(2);
  });

  it("a fault reading the fields books without the check, as the name rules do — said, not swallowed", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        const client = fakeAdmin().from(table);
        if (table === "assistants") client.maybeSingle = async () => ({ data: null, error: { code: "57014" } });
        return client;
      },
    } as never);
    const r = await handleBookAppointment(ORG, ARGS, { callId: CALL });
    expect(r.success).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("caller fields read failed"), expect.objectContaining({ code: "57014" }));
  });

  it("too much is refused, never cut: details over the cap, and a note plus details over the diary's 500 characters", async () => {
    withFields(COPPERLINE_FIELDS);
    const huge = await handleBookAppointment(ORG, { ...ARGS, details: `Address: ${"x".repeat(700)}` }, { callId: CALL });
    expect(huge).toMatchObject({ success: false, message: "That's too much detail for one booking. Keep each detail to a few words, then call book_appointment again." });
    // 460 + "\n" + "Address: 12 Smith St" (20) + "\n" + "Reason for Calling: a long story about the shower" (49) = 531
    const long = await handleBookAppointment(ORG, { ...ARGS, notes: "n".repeat(460), details: "Address: 12 Smith St; Reason for Calling: a long story about the shower" }, { callId: CALL });
    expect(long).toMatchObject({ success: false, message: "That's too much detail for one booking's note. Keep the note and each detail to a few words, then call book_appointment again." });
    expect(inserts).toEqual([]);
  });

  it("details it can't read (no label) are refused with how to pass them", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "12 Smith St" }, { callId: CALL });
    expect(r).toMatchObject({ success: false, message: 'I couldn\'t read the details. Pass them as "Label: value; Label: value", using the labels in DATA COLLECTION, then call book_appointment again.' });
  });
});
