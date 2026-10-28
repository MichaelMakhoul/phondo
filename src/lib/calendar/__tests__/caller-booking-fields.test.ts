import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-617: a caller's booking needs what THIS business requires (Assistants → Caller Data
// Collection) — not only the name. On 28 Oct the owner turned on Address and Reason for
// Calling, then rang the demo line: the receptionist asked for a first and last name and
// booked, because the booking tool told it "first name, last name and the time" for every
// business and had nowhere to put anything else. The booking handler now refuses until every
// required field is in, names them all at once, and saves them in the job's note.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
// SCRUM-617: a fields read fault pages — the rest of Sentry stays real (uninitialised: no-ops).
vi.mock("@sentry/nextjs", async (importOriginal) => ({ ...(await importOriginal<object>()), captureMessage: vi.fn() }));
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
      "Can't book this yet: this business's bookings also need the address and the reason for calling. " +
        'Ask the caller for them in one question — use anything they\'ve already told you (like why they\'re calling) instead of asking again; if they have none (no insurer, say), "none" is an answer — ' +
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
// Uses the file's top-level fixtures (ORG, ARGS, CALL, COPPERLINE_FIELDS, withFields, inserts,
// fakeAdmin, createAdminClient, handleBookAppointment).
describe("SCRUM-617 test lens: what the caller's details carry, and the edges", () => {
  it("M01: the name given again in details under the business's own labels stays out of the note — it has its own parameters", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "First Name: Jane; Last Name: Smith; Address: 12 Smith St; Reason for Calling: leak" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Address: 12 Smith St\nReason for Calling: leak");
  });

  it("M02: a name or number under a key the business has no field for (Name, Surname, Phone) stays out of the note too", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Name: Jane Smith; Surname: Smith; Phone: 0412 345 678; Address: 12 Smith St; Reason for Calling: leak" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Address: 12 Smith St\nReason for Calling: leak");
  });

  it("M03: an email passed under its DATA COLLECTION label (\"Email Address: …\") counts — booked, saved as the booking's email, not as a note", async () => {
    withFields([{ id: "first_name", label: "First Name", required: true }, { id: "email_address", label: "Email Address", required: true }]);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Email Address: jane@example.com" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0]).toMatchObject({ attendee_email: "jane@example.com" });
    expect(inserts[0].notes ?? null).toBeNull();
  });

  it("M04: the email parameter wins over an email in details (details only fill an EMPTY parameter)", async () => {
    withFields([{ id: "first_name", label: "First Name", required: true }, { id: "email_address", label: "Email Address", required: true }]);
    const r = await handleBookAppointment(ORG, { ...ARGS, email: "jane@example.com", details: "Email: someone.else@example.com" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0]).toMatchObject({ attendee_email: "jane@example.com" });
  });

  it("M06: a field given twice keeps its first non-blank value", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Address: 12 Smith St; Reason for Calling: leak; address: 14 Jones Rd" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Address: 12 Smith St\nReason for Calling: leak");
  });

  it("M10: a fields-read fault never refuses on the details — even ones it can't read, it books (the check is off)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        const client = fakeAdmin().from(table);
        if (table === "assistants") client.maybeSingle = async () => ({ data: null, error: { code: "57014" } });
        return client;
      },
    } as never);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "12 Smith St" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts).toHaveLength(1);
    errSpy.mockRestore();
  });

  it("M11: a note plus details of exactly the diary's 500 characters fit — booked whole", async () => {
    withFields(COPPERLINE_FIELDS);
    // 454 + "\n" + "Address: 12 Smith St" (20) + "\n" + "Reason for Calling: leak" (24) = 500
    const r = await handleBookAppointment(ORG, { ...ARGS, notes: "n".repeat(454), details: "Address: 12 Smith St; Reason for Calling: leak" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toHaveLength(500);
    expect(inserts[0].notes.endsWith("\nAddress: 12 Smith St\nReason for Calling: leak")).toBe(true);
  });

  it("M12: an email AND another field missing — the email goes in email, the rest in details, said exactly", async () => {
    withFields([{ id: "first_name", label: "First Name", required: true }, { id: "email_address", label: "Email Address", required: true }, { id: "address", label: "Address", required: true }]);
    const r = await handleBookAppointment(ORG, ARGS, { callId: CALL });
    expect(r.success).toBe(false);
    expect(r.message).toBe(
      "Can't book this yet: this business's bookings also need the caller's email address and the address. " +
        'Ask the caller for them in one question — use anything they\'ve already told you (like why they\'re calling) instead of asking again; if they have none (no insurer, say), "none" is an answer — ' +
        'then call book_appointment again with the email in email and the rest in details ("Address: …").'
    );
    expect(r.data).toEqual({ missing_fields: [{ id: "email_address", label: "Email Address" }, { id: "address", label: "Address" }] });
    expect(inserts).toEqual([]);
  });

  it("M18: a label's punctuation doesn't matter — \"Child’s Age\" (curly apostrophe) and \"Emergency Y/N\" are the business's \"Child's Age\" and \"Emergency (Y/N)\"", async () => {
    withFields([
      { id: "first_name", label: "First Name", required: true },
      { id: "child_age", label: "Child's Age", required: true },
      { id: "emergency", label: "Emergency (Y/N)", required: true },
    ]);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Child’s Age: 7; Emergency Y/N: no" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Child's Age: 7\nEmergency (Y/N): no");
  });
});

// SCRUM-617 review round 1 (silent + code lenses).
describe("SCRUM-617 review round 1: refusals, the last name, faults, and the edges", () => {
  it("a refusal never reads as a booking: no 'booked', 'confirmed' or 'confirmation' in any of them (the voice server's older pipelines read those words as one)", async () => {
    withFields([...COPPERLINE_FIELDS, { id: "urgency_level", label: "Urgency Level", required: true, description: "Routine, Urgent, or Emergency" }]);
    const refusals = [
      await handleBookAppointment(ORG, ARGS, { callId: CALL }),
      await handleBookAppointment(ORG, { ...ARGS, details: `Address: ${"x".repeat(320)}` }, { callId: CALL }),
      await handleBookAppointment(ORG, { ...ARGS, details: `Address: ${"x".repeat(700)}` }, { callId: CALL }),
      await handleBookAppointment(ORG, { ...ARGS, details: "12 Smith St" }, { callId: CALL }),
    ];
    for (const r of refusals) {
      expect(r.success).toBe(false);
      expect(r.message).not.toMatch(/booked|confirmed|confirmation/);
    }
    expect(refusals[0].message).toContain("the urgency level (Routine, Urgent, or Emergency)");
    expect(inserts).toEqual([]);
  });

  it("a caller missing the last name AND the other details hears it all in one refusal, not two", async () => {
    withFields(COPPERLINE_FIELDS);
    const { last_name: _none, ...firstOnly } = ARGS;
    const r = await handleBookAppointment(ORG, firstOnly, { callId: CALL });
    expect(r.message).toMatch(/^Can't book this yet: this business's bookings also need the caller's last name, the address and the reason for calling\./);
    expect(r.message).toContain('again with the last name in last_name and the rest in details ("Address: …; Reason for Calling: …")');
    expect(r.data).toEqual({ missing_fields: [{ id: "last_name", label: "Last Name" }, { id: "address", label: "Address" }, { id: "reason_for_calling", label: "Reason for Calling" }] });
  });

  it("a detail too long for the booking is refused, naming it — never cut and booked", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: `Address: ${"x".repeat(320)}; Reason for Calling: leak` }, { callId: CALL });
    expect(r).toMatchObject({ success: false, message: "The address is too long for the booking. Keep it to a few words, then call book_appointment again." });
    expect(inserts).toEqual([]);
  });

  it("a custom required field that is an email ('Email') is filled by the email parameter — or a detail — never asked for forever", async () => {
    withFields([{ id: "first_name", label: "First Name", required: true }, { id: "custom_1730000000000", label: "Email", required: true }]);
    const byParam = await handleBookAppointment(ORG, { ...ARGS, email: "jane@example.com" }, { callId: CALL });
    expect(byParam.success).toBe(true);
    const byDetail = await handleBookAppointment(ORG, { ...ARGS, details: "Email: sam@example.com" }, { callId: CALL });
    expect(byDetail.success).toBe(true);
    expect(inserts[1]).toMatchObject({ attendee_email: "sam@example.com" });
  });

  it("'Email: not given' with an optional email is no email — booked, not refused as a bad address", async () => {
    withFields(COPPERLINE_FIELDS);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Email: not given; Address: 12 Smith St; Reason for Calling: leak" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(String(inserts[0].attendee_email ?? "")).not.toMatch(/not\s*given/i); // the placeholder isn't saved as the email
  });

  it("details passed as an object or a list (a model may, for a string parameter) are read, not thrown on", async () => {
    withFields(COPPERLINE_FIELDS);
    const asObject = await handleBookAppointment(ORG, { ...ARGS, details: { Address: "12 Smith St", "Reason for Calling": "leak" } as unknown as string }, { callId: CALL });
    expect(asObject.success).toBe(true);
    expect(inserts[0].notes).toBe("Address: 12 Smith St\nReason for Calling: leak");
    const asList = await handleBookAppointment(ORG, { ...ARGS, details: ["Address: 9 Hill Rd", "Reason for Calling: tap"] as unknown as string }, { callId: CALL });
    expect(asList.success).toBe(true);
    const odd = await handleBookAppointment(ORG, { ...ARGS, details: { toString: 1 } as unknown as string }, { callId: CALL });
    expect(odd.success).toBe(false); // no details at all: the address and reason are still asked for
  });

  it("a fields read fault books — paged, not just logged — and the caller's details still reach the note", async () => {
    const Sentry = await import("@sentry/nextjs");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        const client = fakeAdmin().from(table);
        if (table === "assistants") client.maybeSingle = async () => ({ data: null, error: { code: "57014" } });
        return client;
      },
    } as never);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Address: 12 Smith St" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Address: 12 Smith St");
    expect(Sentry.captureMessage).toHaveBeenCalledWith("Booking: caller fields read failed — required fields not applied", expect.objectContaining({ level: "warning", extra: { organizationId: ORG, code: "57014" } }));
  });
});

// SCRUM-617 review round 2 (silent + code lenses).
describe("SCRUM-617 review round 2: 'none', copied descriptions, the fault path, the line's own fields", () => {
  const EMAIL_REQUIRED = [{ id: "first_name", label: "First Name", required: true }, { id: "email_address", label: "Email Address", required: true }];

  it("a caller with no email books at a business that requires one: 'none' is an answer — in email or in details — and nothing is saved as the email", async () => {
    withFields(EMAIL_REQUIRED);
    const byParam = await handleBookAppointment(ORG, { ...ARGS, email: "none" }, { callId: CALL });
    expect(byParam.success).toBe(true);
    const byDetail = await handleBookAppointment(ORG, { ...ARGS, details: "Email: they don't have one" }, { callId: CALL });
    expect(byDetail.success).toBe(true);
    for (const row of inserts) expect(String(row.attendee_email ?? "")).not.toMatch(/none|have one/i);
    const stillAsked = await handleBookAppointment(ORG, { ...ARGS, details: "Email: maybe later" }, { callId: CALL });
    expect(stillAsked.success).toBe(false); // not an address, not a "none"
  });

  it("a label the model copied with its choices ('Urgency Level (Routine, Urgent, or Emergency)') is the field", async () => {
    withFields([{ id: "first_name", label: "First Name", required: true }, { id: "urgency_level", label: "Urgency Level", required: true, description: "Routine, Urgent, or Emergency" }]);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Urgency Level (Routine, Urgent, or Emergency): Urgent" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Urgency Level: Urgent");
  });

  it("a fields read fault keeps every readable detail — one it can't read, or an over-long one, is left out, never all of them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        const client = fakeAdmin().from(table);
        if (table === "assistants") client.maybeSingle = async () => ({ data: null, error: { code: "57014" } });
        return client;
      },
    } as never);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: `Address: 12 Smith St; just a loose phrase; Notes: ${"x".repeat(320)}; Reason for Calling: leak` }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Address: 12 Smith St\nReason for Calling: leak");
  });

  it("the call's assistant isn't the org's (or has gone): the org's oldest assistant's fields still apply — never 'nothing required'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    assistantRow = { prompt_config: { fields: COPPERLINE_FIELDS } };
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        const client = fakeAdmin().from(table);
        if (table === "assistants") {
          let byId = false;
          const eq = client.eq;
          client.eq = (col: string, val: unknown) => { if (col === "id") byId = val !== "asst-real"; return eq(col, val); };
          client.maybeSingle = async () => ({ data: byId ? null : assistantRow, error: null });
        }
        return client;
      },
    } as never);
    const r = await handleBookAppointment(ORG, ARGS, { callId: CALL, assistantId: "asst-other-org" });
    expect(r.success).toBe(false); // the oldest assistant requires the address and reason
    expect(r.data).toEqual({ missing_fields: [{ id: "address", label: "Address" }, { id: "reason_for_calling", label: "Reason for Calling" }] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the call's assistant isn't this org's"), expect.objectContaining({ assistantId: "asst-other-org" }));
  });
});

// Uses the file's top-level fixtures (ORG, ARGS, CALL, COPPERLINE_FIELDS, withFields, inserts,
// fakeAdmin, createAdminClient, handleBookAppointment).
describe("SCRUM-617 test lens round 2: the edges of round 1", () => {
  it("R01: a detail of exactly 300 characters is the most one holds — booked whole, not refused", async () => {
    withFields(COPPERLINE_FIELDS);
    const address = "x".repeat(300);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: `Address: ${address}; Reason for Calling: leak` }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe(`Address: ${address}\nReason for Calling: leak`);
  });

  it("R03: a custom required 'Email' field answered 'none' is an answer — booked, kept in the note, never taken as the email", async () => {
    withFields([{ id: "first_name", label: "First Name", required: true }, { id: "custom_1730000000000", label: "Email", required: true }]);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Email: none" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Email: none");
    expect(String(inserts[0].attendee_email ?? "")).not.toMatch(/none/i); // "none" isn't an address: never saved as the email
  });

  it("R10: a caller's booking is checked against the line that answered (the envelope's assistantId), not the org's oldest", async () => {
    const LINE_2 = "22222222-3333-4444-a555-666666666666";
    const rows: Record<string, unknown> = {
      oldest: { prompt_config: { fields: [{ id: "first_name", label: "First Name", required: true }] } },
      [LINE_2]: { prompt_config: { fields: [{ id: "first_name", label: "First Name", required: true }, { id: "address", label: "Address", required: true }] } },
    };
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        const client = fakeAdmin().from(table);
        if (table !== "assistants") return client;
        let id: string | null = null;
        client.eq = (column: string, value: string) => {
          if (column === "id") id = value;
          return client;
        };
        client.maybeSingle = async () => ({ data: rows[id ?? "oldest"] ?? null, error: null });
        return client;
      },
    } as never);
    const r = await handleBookAppointment(ORG, ARGS, { callId: CALL, assistantId: LINE_2 });
    expect(r.success).toBe(false);
    expect(r.data).toEqual({ missing_fields: [{ id: "address", label: "Address" }] });
    expect(inserts).toEqual([]);
  });
});

// SCRUM-617 review round 3 (code + silent lenses): stripping a copied description broke labels that
// themselves end in brackets — the vet preset "Emergency (Y/N)" could never be filled.
describe("SCRUM-617 review round 3: a label that ends in brackets is matched whole", () => {
  it("'Emergency (Y/N)' (the vet preset) and 'Budget (AUD)' fill as given — and a copied description still matches its field", async () => {
    withFields([
      { id: "first_name", label: "First Name", required: true },
      { id: "emergency_yn", label: "Emergency (Y/N)", required: true },
      { id: "budget", label: "Budget (AUD)", required: true },
      { id: "urgency_level", label: "Urgency Level", required: true, description: "Routine, Urgent, or Emergency" },
    ]);
    const r = await handleBookAppointment(ORG, { ...ARGS, details: "Emergency (Y/N): Yes; Budget (AUD): 500; Urgency Level (Routine, Urgent, or Emergency): Urgent" }, { callId: CALL });
    expect(r.success).toBe(true);
    expect(inserts[0].notes).toBe("Emergency (Y/N): Yes\nBudget (AUD): 500\nUrgency Level: Urgent");
  });
});

