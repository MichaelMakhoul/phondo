import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-599: the owner's assistant books new jobs, blocks out time and marks callbacks
// done. Pins: the same two calls as a change (nothing happens without the JSON boolean
// true), only Phondo's own diary, the owner-write rate limit, the receptionist's own
// booking path run as the OWNER's booking (no automatic notices; the owner's choice of
// telling the customer — a text or nothing, never a call — runs after), the audit row
// and the call links the recap email is built from, and every refusal worded for the
// owner, never as a customer fallback.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({ rateLimitDistributed: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn() }));
vi.mock("@/lib/appointments/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/appointments/events")>();
  return { ...actual, recordAppointmentEvent: vi.fn(async () => true) };
});
vi.mock("@/lib/calendar/tool-handlers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/tool-handlers")>();
  return { ...actual, handleBookAppointment: vi.fn(), ownerDiaryProvider: vi.fn(async () => "phondo") };
});
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), withScope: vi.fn() }));
vi.mock("@/lib/sms/caller-sms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/caller-sms")>();
  return { confirmationIdempotencyKey: actual.confirmationIdempotencyKey, sendCancellationSMS: vi.fn(), sendAppointmentConfirmationSMS: vi.fn() };
});
vi.mock("@/lib/observability/page-sentry", () => ({ pageSentry: vi.fn() }));
vi.mock("../customer-call", async (importOriginal) => {
  const real = await importOriginal<typeof import("../customer-call")>();
  return { ...real, checkCustomerCall: vi.fn(), placeCustomerCall: vi.fn() };
});

import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimitDistributed } from "@/lib/security/rate-limiter";
import { runAfterResponse } from "@/lib/utils/after-response";
import { recordAppointmentEvent } from "@/lib/appointments/events";
import { handleBookAppointment, ownerDiaryProvider } from "@/lib/calendar/tool-handlers";
import { sendAppointmentConfirmationSMS, sendCancellationSMS } from "@/lib/sms/caller-sms";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { checkCustomerCall, placeCustomerCall } from "../customer-call";
import { handleOwnerBookAppointment, handleOwnerBlockTime, handleOwnerMarkCallbackDone } from "../tool-handlers";

type Res = { data: unknown; error: { message?: string; code?: string } | null };
type Op = { table: string; filters: Array<{ name: string; args: unknown[] }>; insert?: Record<string, unknown>; update?: Record<string, unknown> };
const db = { log: [] as Op[], queues: {} as Record<string, Res[]> };
function fakeAdmin() {
  return {
    from: (table: string) => {
      const op: Op = { table, filters: [] };
      const res = () => db.queues[table]?.shift() ?? { data: null, error: null };
      const b: any = {};
      for (const name of ["select", "eq", "in", "order", "limit", "lt", "gt"]) {
        b[name] = (...args: unknown[]) => { op.filters.push({ name, args }); return b; };
      }
      b.insert = (payload: Record<string, unknown>) => { op.insert = payload; return b; };
      b.update = (payload: Record<string, unknown>) => { op.update = payload; return b; };
      b.maybeSingle = async () => { db.log.push(op); return res(); };
      b.single = b.maybeSingle;
      b.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) => {
        db.log.push(op);
        return Promise.resolve(res()).then(resolve, reject);
      };
      return b;
    },
  };
}
const opsOn = (table: string) => db.log.filter((o) => o.table === table);
const filters = (op: Op | undefined, name: string) => (op?.filters ?? []).filter((f) => f.name === name).map((f) => f.args);
const silence = (level: "error" | "warn") => vi.spyOn(console, level).mockImplementation(() => {});

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const NEW_ID = "55555555-6666-4777-8888-999999999999";
const SERVICE = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const CALLBACK = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";
const OWNER_USER = "88888888-9999-4aaa-bbbb-cccccccccccc";
const TZ = "Australia/Sydney";
const NOW = new Date("2026-10-15T03:00:00Z"); // Thu 2026-10-15 14:00 AEDT
const ctx = { callId: CALL };
const AU_ORG = { data: { timezone: TZ, country: "AU" }, error: null };
const START = "2026-10-16T10:00"; // Fri 16 Oct 10:00 AEDT = 2026-10-15T23:00Z
const WHEN = "Friday, October 16 at 10:00 AM";
const BOOK = { customer_name: "Jane Smith", customer_phone: "0412 345 678", start: START };
const BOOKED = {
  success: true,
  message: "I've booked your appointment for Friday, October 16 at 10:00 AM with Alex. The appointment is confirmed. Is there anything else I can help you with?",
  data: { appointmentId: NEW_ID, confirmationCode: "654321", startTime: "2026-10-15T23:00:00.000Z", endTime: "2026-10-16T00:00:00.000Z", practitionerId: "p-1", practitionerName: "Alex" },
};
const TROUBLE = "I'm having trouble reaching the calendar right now. Try again in a moment.";

beforeEach(() => {
  db.log = [];
  db.queues = { organizations: [AU_ORG] };
  // Reset (not clear): a queued mockResolvedValueOnce never leaks into the next test.
  vi.resetAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin() as any);
  vi.mocked(rateLimitDistributed).mockResolvedValue({ allowed: true } as any);
  vi.mocked(ownerDiaryProvider).mockResolvedValue("phondo");
  vi.mocked(handleBookAppointment).mockResolvedValue(BOOKED as any);
  vi.mocked(recordAppointmentEvent).mockResolvedValue(true);
  vi.mocked(sendAppointmentConfirmationSMS).mockResolvedValue({ sent: true, status: "sent" } as any);
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  delete process.env.CALLER_SMS_ENABLED;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── owner_book_appointment ───────────────────────────────────────────────────
describe("owner_book_appointment", () => {
  it("without confirmed=true reads the booking back and books NOTHING — the question offers a text or nothing, never a call", async () => {
    process.env.CALLER_SMS_ENABLED = "true";
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, notes: "Hot water unit\nleaking" }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.message).toContain(`Read this back and get a clear yes before changing anything: book Jane Smith (0412 345 678) for ${WHEN} — notes: "Hot water unit leaking".`);
    expect(r.message).toContain("In the same question, ask whether to let Jane Smith know: by text, or not tell them.");
    expect(r.message).toContain('call owner_book_appointment again with confirmed=true and notify_customer set to their answer: "text", "none"');
    expect(r.data).toEqual({ outcome: "needs_confirmation", customer_name: "Jane Smith", customer_phone: "0412 345 678", when: WHEN, contact_options: ["text", "none"], customer_notified: false });
    expect(checkCustomerCall).not.toHaveBeenCalled(); // a call about a new booking isn't offered
    expect(handleBookAppointment).not.toHaveBeenCalled();
    expect(rateLimitDistributed).not.toHaveBeenCalled(); // a read-back is free
  });

  it("only the JSON boolean true confirms: \"true\", 1 and \"yes\" read back", async () => {
    for (const confirmed of ["true", 1, "yes", null]) {
      db.queues.organizations = [AU_ORG];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed, notify_customer: "none" }, ctx);
      expect(r.data, String(confirmed)).toMatchObject({ outcome: "needs_confirmation" });
    }
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("texts off: the read-back says the customer can't be told from here, and a bare yes books with no question", async () => {
    const r = await handleOwnerBookAppointment(ORG, BOOK, ctx);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation", contact_options: ["none"], contact_note: "Texting customers isn't available yet." });
    expect(r.message).toContain("Telling Jane Smith isn't possible from here (Texting customers isn't available yet)");
    db.queues.organizations = [AU_ORG];
    const yes = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true }, ctx);
    expect(yes.data).toMatchObject({ outcome: "booked", customer_contact: { method: "none", status: "not_requested" }, customer_notified: false });
    // Clients lens T2: never an offer to read back the number the owner just gave.
    expect(yes.message).toBe(`Booked Jane Smith for ${WHEN} with Alex. I haven't let Jane Smith know.`);
    expect(r.message).not.toContain("offer to read out their number");
  });

  it("with a choice, a yes without the owner's answer — or with 'call' — books NOTHING and asks the question", async () => {
    process.env.CALLER_SMS_ENABLED = "true";
    for (const notify_customer of [undefined, "", "call", "sms", "Text"]) {
      db.queues.organizations = [AU_ORG];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer }, ctx);
      expect(r.data, String(notify_customer)).toMatchObject({ outcome: "needs_confirmation", contact_options: ["text", "none"] });
      expect(r.message).toContain("Nothing has changed yet: the owner said yes but not whether to let Jane Smith know. Ask them now: should Jane Smith get a text, or not be told?");
    }
    expect(handleBookAppointment).not.toHaveBeenCalled();
    expect(rateLimitDistributed).not.toHaveBeenCalled();
    expect(placeCustomerCall).not.toHaveBeenCalled();
  });

  it("confirmed with 'text': books through the receptionist's path as the OWNER's booking, audits it on this call, then texts the plain confirmation", async () => {
    process.env.CALLER_SMS_ENABLED = "true";
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, notes: "Leaking tap", confirmed: true, notify_customer: "text" }, ctx);
    expect(rateLimitDistributed).toHaveBeenCalledWith(expect.anything(), `${ORG}:owner`, "appt-mutate", "auth");
    expect(handleBookAppointment).toHaveBeenCalledWith(
      ORG,
      { first_name: "Jane", last_name: "Smith", phone: "+61412345678", datetime: START, notes: "Leaking tap" },
      { callId: CALL, ownerBooking: true }
    );
    expect(recordAppointmentEvent).toHaveBeenCalledWith(expect.anything(), {
      appointmentId: NEW_ID, organizationId: ORG, eventType: "created", actorType: "staff", actorId: null, channel: "voice", callId: CALL,
    });
    // A new booking's text is the plain confirmation — never the "new time" one, never a cancellation.
    expect(sendAppointmentConfirmationSMS).toHaveBeenCalledWith(ORG, "+61412345678", new Date("2026-10-15T23:00:00.000Z"), TZ, undefined, NEW_ID, { ownerRequested: true });
    expect(sendCancellationSMS).not.toHaveBeenCalled();
    expect(vi.mocked(handleBookAppointment).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sendAppointmentConfirmationSMS).mock.invocationCallOrder[0]);
    expect(r).toEqual({
      success: true,
      message: `Booked Jane Smith for ${WHEN} with Alex. I've texted Jane Smith to let them know.`,
      data: {
        outcome: "booked", customer_name: "Jane Smith", customer_phone: "0412 345 678", when: WHEN, practitioner: "Alex",
        appointment_id: NEW_ID, confirmation_code: "654321", customer_contact: { method: "text", status: "sent" }, customer_notified: true,
      },
    });
  });

  it("confirmed with 'none': booked, nobody texted, and the result says so", async () => {
    process.env.CALLER_SMS_ENABLED = "true";
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
    expect(r.data).toMatchObject({ outcome: "booked", customer_contact: { method: "none", status: "not_requested" }, customer_notified: false });
    expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
  });

  it("a one-word name books as a first name only; a booking with no staff named says no 'with'", async () => {
    vi.mocked(handleBookAppointment).mockResolvedValueOnce({ ...BOOKED, data: { ...BOOKED.data, practitionerName: undefined } } as any);
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_name: "Bob", confirmed: true, notify_customer: "none" }, ctx);
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toEqual({ first_name: "Bob", phone: "+61412345678", datetime: START });
    expect(r.message).toBe(`Booked Bob for ${WHEN}. I haven't let Bob know.`);
    expect(r.data).not.toHaveProperty("practitioner");
  });

  it("the number is booked in E.164 when it parses in the org's country, and as said otherwise", async () => {
    await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "+61 412 345 678", confirmed: true, notify_customer: "none" }, ctx);
    db.queues.organizations = [{ data: { timezone: "America/New_York", country: "US" }, error: null }];
    await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "(415) 555-1234", confirmed: true, notify_customer: "none" }, ctx);
    db.queues.organizations = [AU_ORG];
    await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "+44 20 7946 0958", confirmed: true, notify_customer: "none" }, ctx);
    expect(vi.mocked(handleBookAppointment).mock.calls.map((c) => c[1].phone)).toEqual(["+61412345678", "+14155551234", "+44 20 7946 0958"]);
  });

  it("a service type is read org-scoped and active, and named in the read-back; an unknown one is refused before anything is booked", async () => {
    db.queues.service_types = [{ data: { id: SERVICE, name: "Hot water service" }, error: null }];
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, service_type_id: SERVICE }, ctx);
    expect(r.message).toContain(`book Jane Smith (0412 345 678) for Hot water service on ${WHEN}.`);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation", service: "Hot water service" });
    expect(filters(opsOn("service_types")[0], "eq")).toEqual([["id", SERVICE], ["organization_id", ORG], ["is_active", true]]);

    db.queues.organizations = [AU_ORG];
    db.queues.service_types = [{ data: null, error: null }];
    const unknown = await handleOwnerBookAppointment(ORG, { ...BOOK, service_type_id: SERVICE, confirmed: true, notify_customer: "none" }, ctx);
    expect(unknown).toMatchObject({ success: false, data: { outcome: "invalid_details" } });
    expect(unknown.message).toBe("I couldn't find that service type. Check the SERVICE TYPES list, or leave it out.");

    db.queues.organizations = [AU_ORG];
    const malformed = await handleOwnerBookAppointment(ORG, { ...BOOK, service_type_id: "Hot water" }, ctx);
    expect(malformed.data).toMatchObject({ outcome: "invalid_details" });
    expect(opsOn("service_types")).toHaveLength(2); // a non-id is refused without a read

    db.queues.organizations = [AU_ORG];
    db.queues.service_types = [{ data: null, error: { code: "57014" } }];
    silence("error");
    const fault = await handleOwnerBookAppointment(ORG, { ...BOOK, service_type_id: SERVICE }, ctx);
    expect(fault).toEqual({ success: false, error: true, message: TROUBLE });
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("the confirmed booking carries the service type to the booking path", async () => {
    db.queues.service_types = [{ data: { id: SERVICE, name: "Hot water service" }, error: null }];
    await handleOwnerBookAppointment(ORG, { ...BOOK, service_type_id: SERVICE, confirmed: true, notify_customer: "none" }, ctx);
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ service_type_id: SERVICE });
  });

  it.each([
    ["no name", { customer_name: "  " }, "invalid_details", "I need the customer's name for the booking. Who's it for?"],
    ["no number", { customer_phone: "" }, "invalid_details", "I need a phone number for Jane Smith that the booking can go under. What's their number?"],
    ["a number too short", { customer_phone: "12345" }, "invalid_details", "I need a phone number for Jane Smith that the booking can go under. What's their number?"],
    ["no time", { start: undefined }, "invalid_time", "I need the time as a date and time, like 2026-10-29T14:00."],
    ["a time that isn't one", { start: "Friday 10am" }, "invalid_time", "I need the time as a date and time, like 2026-10-29T14:00."],
    ["a date that doesn't exist", { start: "2026-02-30T10:00" }, "invalid_time", "I need the time as a date and time, like 2026-10-29T14:00."],
    ["a time already gone", { start: "2026-10-15T09:00" }, "invalid_time", "That time has already passed. When should the job be?"],
    ["more than a year out", { start: "2027-11-01T09:00" }, "invalid_time", "That's more than a year away. When should the job be?"],
  ])("%s is refused before the diary is touched", async (_label, change, outcome, message) => {
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, ...change, confirmed: true, notify_customer: "none" } as any, ctx);
    expect(r).toEqual({ success: false, message, data: { outcome, customer_notified: false } });
    expect(ownerDiaryProvider).not.toHaveBeenCalled();
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("an org on Cliniko or Cal.com is refused — never booked there — and a failed diary check is a fault", async () => {
    for (const diary of ["Cliniko", "Cal.com"] as const) {
      db.queues.organizations = [AU_ORG];
      vi.mocked(ownerDiaryProvider).mockResolvedValueOnce(diary);
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
      expect(r).toEqual({ success: false, message: `Your diary is in ${diary}, so I haven't booked anything — please do it there.`, data: { outcome: "external_calendar", customer_notified: false } });
    }
    db.queues.organizations = [AU_ORG];
    vi.mocked(ownerDiaryProvider).mockResolvedValueOnce("error");
    expect(await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx)).toEqual({ success: false, error: true, message: TROUBLE });
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("an unreadable org is a fault, never a guess at the zone", async () => {
    silence("error");
    db.queues.organizations = [{ data: null, error: { code: "57014" } }];
    expect(await handleOwnerBookAppointment(ORG, BOOK, ctx)).toEqual({ success: false, error: true, message: TROUBLE });
  });

  it("rate limited: nothing is booked", async () => {
    vi.mocked(rateLimitDistributed).mockResolvedValueOnce({ allowed: false } as any);
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
    expect(r).toMatchObject({ success: false, data: { outcome: "rate_limited", customer_notified: false } });
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("the diary refusing it (hours, a block, a clash) is not_booked with the diary's reason for the model to say in its own words", async () => {
    process.env.CALLER_SMS_ENABLED = "true";
    vi.mocked(handleBookAppointment).mockResolvedValueOnce({ success: false, message: "I'm sorry, that time slot is no longer available. Would you like me to check for other available times?" } as any);
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "text" }, ctx);
    expect(r).toEqual({
      success: false,
      message:
        'Nothing was booked. The diary said: "I\'m sorry, that time slot is no longer available. Would you like me to check for other available times?" Tell the owner in a few words, and offer another time if it\'s about the time.' +
        " Outside opening hours or in blocked-out time, the owner can still book it themselves in Appointments.",
      data: { outcome: "not_booked", customer_name: "Jane Smith", customer_phone: "0412 345 678", when: WHEN, customer_notified: false },
    });
    expect(recordAppointmentEvent).not.toHaveBeenCalled();
    expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
  });

  it("the booking path's own fault is the owner's fault line (never 'someone will call you back'), with nothing audited or sent", async () => {
    process.env.CALLER_SMS_ENABLED = "true";
    vi.mocked(handleBookAppointment).mockResolvedValueOnce({ success: false, error: true, message: "I'm having trouble completing the booking right now. Let me take your information and have someone call you back to confirm the appointment." } as any);
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "text" }, ctx);
    expect(r).toEqual({ success: false, error: true, message: "I couldn't book that just now — something went wrong on our side. Please check Appointments before trying again." });
    expect(recordAppointmentEvent).not.toHaveBeenCalled();
    expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
  });

  it("a Cliniko connection made between the check and the booking is still refused (the booking path's own refusal)", async () => {
    vi.mocked(handleBookAppointment).mockResolvedValueOnce({
      success: false, message: "Your diary is in Cliniko, so I haven't booked anything — please book it there.", data: { ownerRefusal: "external_calendar" },
    } as any);
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
    expect(r).toMatchObject({ success: false, message: "Your diary is in Cliniko, so I haven't booked anything — please book it there.", data: { outcome: "external_calendar" } });
    expect(recordAppointmentEvent).not.toHaveBeenCalled();
  });

  it("a success without a booking id is a fault, not 'booked'", async () => {
    silence("error");
    vi.mocked(handleBookAppointment).mockResolvedValueOnce({ success: true, message: "ok", data: {} } as any);
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
    expect(r).toEqual({ success: false, error: true, message: "I booked Jane Smith but couldn't read the booking back — please check Appointments." });
  });

  it("an audit row that won't write is paged (the recap would miss it) — the booking still stands and is reported", async () => {
    vi.mocked(recordAppointmentEvent).mockResolvedValueOnce(false);
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
    expect(r.data).toMatchObject({ outcome: "booked" });
    expect(pageSentry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pageSentry).mock.calls[0][0]).toMatchObject({
      reason: SENTRY_REASONS.OWNER_CHANGE_NOT_AUDITED,
      extras: { organizationId: ORG, callId: CALL, appointmentId: NEW_ID, change: "created" },
    });
  });

  describe("the same booking asked for again on this call (its result never came back)", () => {
    const EARLIER = { id: NEW_ID, attendee_name: "Jane Smith", attendee_phone: "+61412345678", confirmation_code: "654321", practitioners: { name: "Alex" } };

    it("this customer at this time already booked on this call: handed back — never booked twice (two staff would take a second), before the rate limit", async () => {
      db.queues.appointments = [{ data: [EARLIER], error: null }];
      db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
      db.queues.appointment_confirmations = [{ data: { status: "sent" }, error: null }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "text" }, ctx);
      expect(handleBookAppointment).not.toHaveBeenCalled();
      expect(rateLimitDistributed).not.toHaveBeenCalled();
      expect(recordAppointmentEvent).not.toHaveBeenCalled();
      const pre = opsOn("appointments")[0];
      expect(filters(pre, "eq")).toEqual([["organization_id", ORG], ["call_id", CALL], ["start_time", "2026-10-15T23:00:00.000Z"]]);
      expect(filters(pre, "in")).toEqual([["status", ["confirmed", "pending"]]]);
      expect(r).toEqual({
        success: true,
        message: `Jane Smith is already booked for ${WHEN} with Alex — that's the booking from a moment ago. I've texted Jane Smith to let them know.`,
        data: {
          outcome: "booked", customer_name: "Jane Smith", customer_phone: "0412 345 678", when: WHEN, practitioner: "Alex",
          appointment_id: NEW_ID, confirmation_code: "654321", customer_contact: { method: "text", status: "sent" }, customer_notified: true,
        },
      });
    });

    it("what the customer was told came with the first: a text that went out — or may have (a 'failed' is also a Twilio timeout) — is reported and never sent twice", async () => {
      process.env.CALLER_SMS_ENABLED = "true";
      for (const [status, contact] of [
        ["delivered", { method: "text", status: "sent" }],
        ["undelivered", { method: "text", status: "not_sent", reason: "undelivered" }],
        ["failed", { method: "text", status: "not_sent", reason: "failed" }],
      ] as const) {
        db.queues.organizations = [AU_ORG];
        db.queues.appointments = [{ data: [EARLIER], error: null }];
        db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
        db.queues.appointment_confirmations = [{ data: { status }, error: null }];
        const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "text" }, ctx);
        expect(r.data, status).toMatchObject({ customer_contact: contact });
      }
      expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
      const log = opsOn("appointment_confirmations")[0];
      expect(filters(log, "eq")).toEqual([["organization_id", ORG], ["idempotency_key", `${NEW_ID}:sms:confirmation:2026-10-15T23:00:00.000Z`]]);
    });

    it("silent lens r2 F5: a first text that was held back never went out — the owner's choice is carried out now", async () => {
      process.env.CALLER_SMS_ENABLED = "true";
      for (const status of ["skipped_db_error", "skipped_cap"]) {
        db.queues.organizations = [AU_ORG];
        db.queues.appointments = [{ data: [EARLIER], error: null }];
        db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
        db.queues.appointment_confirmations = [{ data: { status }, error: null }];
        const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "text" }, ctx);
        expect(r.data, status).toMatchObject({ customer_contact: { method: "text", status: "sent" }, customer_notified: true });
      }
      expect(sendAppointmentConfirmationSMS).toHaveBeenCalledTimes(2);
    });

    it("a text log row left at its 'pending' default (caller-sms never writes it) is never sent again, and never claimed either way", async () => {
      process.env.CALLER_SMS_ENABLED = "true";
      db.queues.appointments = [{ data: [EARLIER], error: null }];
      db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
      db.queues.appointment_confirmations = [{ data: { status: "pending" }, error: null }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "text" }, ctx);
      expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
      expect(r.data).not.toHaveProperty("customer_contact");
      expect(r.message).toContain("I couldn't check whether Jane Smith was texted about it");
    });

    it("no text was ever attempted (the first stopped before it): the owner's choice is carried out now", async () => {
      process.env.CALLER_SMS_ENABLED = "true";
      db.queues.appointments = [{ data: [EARLIER], error: null }];
      db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "text" }, ctx);
      expect(sendAppointmentConfirmationSMS).toHaveBeenCalledWith(ORG, "+61412345678", new Date("2026-10-15T23:00:00.000Z"), TZ, undefined, NEW_ID, { ownerRequested: true });
      expect(r.data).toMatchObject({ outcome: "booked", customer_contact: { method: "text", status: "sent" } });
      db.queues.organizations = [AU_ORG];
      db.queues.appointments = [{ data: [EARLIER], error: null }];
      db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
      const none = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
      expect(none.data).toMatchObject({ customer_contact: { method: "none", status: "not_requested" } });
      expect(sendAppointmentConfirmationSMS).toHaveBeenCalledTimes(1);
    });

    it("an unreadable text log: nothing claimed about the customer either way, and nothing sent (silent lens r2 F2)", async () => {
      silence("error");
      process.env.CALLER_SMS_ENABLED = "true";
      db.queues.appointments = [{ data: [EARLIER], error: null }];
      db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
      db.queues.appointment_confirmations = [{ data: null, error: { code: "57014" } }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "text" }, ctx);
      expect(r.message).toBe(
        `Jane Smith is already booked for ${WHEN} with Alex — that's the booking from a moment ago. I couldn't check whether Jane Smith was texted about it — check the booking in Appointments before texting them yourself.`
      );
      expect(r.data).not.toHaveProperty("customer_contact");
      expect(r.data).toMatchObject({ customer_notified: false });
      expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
    });

    it("silent lens r2 F1: a retry with another service or note is handed back AS BOOKED — the result never claims details the diary doesn't have", async () => {
      const SERVICE_ID = "66666666-7777-4888-9999-aaaaaaaaaaaa";
      db.queues.service_types = [{ data: { id: SERVICE_ID, name: "Blocked drain" }, error: null }];
      db.queues.appointments = [{ data: [{ ...EARLIER, service_type_id: null, notes: "Hot water", service_types: null }], error: null }];
      db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, service_type_id: SERVICE_ID, notes: "Blocked drain out the back", confirmed: true, notify_customer: "none" }, ctx);
      expect(handleBookAppointment).not.toHaveBeenCalled();
      expect(r.message).toContain("It keeps the service and note it was booked with — the new ones weren't added; they can be changed in Appointments.");
      expect(r.data).not.toHaveProperty("service");
      // The same details again: no such sentence.
      db.queues.organizations = [AU_ORG];
      db.queues.appointments = [{ data: [{ ...EARLIER, notes: null }], error: null }];
      db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
      const same = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
      expect(same.message).not.toContain("It keeps the service");
    });

    it("silent lens r2 F3: a first attempt cut off before its audit row — the repeat writes it (the recap email is built from it)", async () => {
      db.queues.appointments = [{ data: [EARLIER], error: null }];
      db.queues.appointment_events = [{ data: [], error: null }];
      await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
      expect(filters(opsOn("appointment_events")[0], "eq")).toEqual([["organization_id", ORG], ["appointment_id", NEW_ID], ["event_type", "created"], ["call_id", CALL]]);
      expect(recordAppointmentEvent).toHaveBeenCalledWith(expect.anything(), {
        appointmentId: NEW_ID, organizationId: ORG, eventType: "created", actorType: "staff", actorId: null, channel: "voice", callId: CALL,
      });
      expect(handleBookAppointment).not.toHaveBeenCalled();
    });

    it("the same name written another way (case, spaces, punctuation) is still this customer", async () => {
      db.queues.appointments = [{ data: [{ ...EARLIER, attendee_name: "Jane  O'Smith" }], error: null }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_name: "jane osmith", confirmed: true, notify_customer: "none" }, ctx);
      expect(handleBookAppointment).not.toHaveBeenCalled();
      expect(r.message).toContain("that's the booking from a moment ago");
    });

    it("code lens r2 (SCRUM-514's rule): a surname respelled on the retry is still this customer — never a second booking", async () => {
      db.queues.appointments = [{ data: [{ ...EARLIER, attendee_first_name: "Jane" }], error: null }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_name: "Jane Smyth", confirmed: true, notify_customer: "none" }, ctx);
      expect(handleBookAppointment).not.toHaveBeenCalled();
      expect(r.message).toContain("that's the booking from a moment ago");
      expect(r.data).toMatchObject({ appointment_id: NEW_ID });
    });

    it("security lens r2: another name on the same number at that time (two children, two staff) is no repeat — it's booked", async () => {
      db.queues.appointments = [{ data: [EARLIER], error: null }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_name: "Tom Smith", confirmed: true, notify_customer: "none" }, ctx);
      expect(handleBookAppointment).toHaveBeenCalledTimes(1);
      expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ first_name: "Tom", last_name: "Smith" });
      expect(r.message).toMatch(/^Booked Tom Smith for /);
    });

    it("someone else booked at that time on this call (another number) is no repeat: this booking goes ahead", async () => {
      db.queues.appointments = [{ data: [{ ...EARLIER, attendee_phone: "+61498765432" }], error: null }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_name: "Jane Brown", confirmed: true, notify_customer: "none" }, ctx);
      expect(handleBookAppointment).toHaveBeenCalledTimes(1);
      expect(r.data).toMatchObject({ outcome: "booked", appointment_id: NEW_ID });
      expect(recordAppointmentEvent).toHaveBeenCalledTimes(1);
    });

    it("an unreadable diary before booking is a fault, and nothing is booked", async () => {
      silence("error");
      db.queues.appointments = [{ data: null, error: { code: "57014" } }];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
      expect(r).toEqual({ success: false, error: true, message: "I couldn't check the diary just now — please check Appointments before trying again." });
      expect(handleBookAppointment).not.toHaveBeenCalled();
    });

    describe("the diary's own same-call net (it matches by first name only)", () => {
      const DUPLICATE = { success: true, message: "Your appointment is already confirmed…", data: { appointmentId: NEW_ID, confirmationCode: "654321", duplicate: true } };

      it("with this customer's number it's the booking from a moment ago: handed back, no second audit row", async () => {
        vi.mocked(handleBookAppointment).mockResolvedValueOnce(DUPLICATE as any);
        db.queues.appointments = [{ data: [], error: null }, { data: EARLIER, error: null }];
        db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
        db.queues.appointment_confirmations = [{ data: { status: "delivered" }, error: null }];
        const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "text" }, ctx);
        expect(r.message).toBe(`Jane Smith is already booked for ${WHEN} with Alex — that's the booking from a moment ago. I've texted Jane Smith to let them know.`);
        expect(filters(opsOn("appointments")[1], "eq")).toEqual([["id", NEW_ID], ["organization_id", ORG]]);
        expect(recordAppointmentEvent).not.toHaveBeenCalled();
        expect(sendAppointmentConfirmationSMS).not.toHaveBeenCalled();
      });

      it("another customer with the same first name booked then on this call is a clash: nothing booked, never 'already booked'", async () => {
        vi.mocked(handleBookAppointment).mockResolvedValueOnce(DUPLICATE as any);
        db.queues.appointments = [{ data: [], error: null }, { data: { ...EARLIER, attendee_phone: "+61498765432" }, error: null }];
        const r = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_name: "Jane Brown", confirmed: true, notify_customer: "none" }, ctx);
        expect(r).toMatchObject({ success: false, message: "Nothing was booked: that time is taken by another booking made on this call. Offer the owner another time.", data: { outcome: "not_booked" } });
        expect(recordAppointmentEvent).not.toHaveBeenCalled();
      });

      it("an unreadable earlier booking is a fault, never 'already booked'", async () => {
        silence("error");
        vi.mocked(handleBookAppointment).mockResolvedValueOnce(DUPLICATE as any);
        db.queues.appointments = [{ data: [], error: null }, { data: null, error: { code: "57014" } }];
        const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
        expect(r).toEqual({ success: false, error: true, message: "I couldn't check the diary just now — please check Appointments before trying again." });
      });
    });
  });
});

// ─── owner_block_time ─────────────────────────────────────────────────────────
describe("owner_block_time", () => {
  const BLOCK = { start: "2026-10-16T13:00", end: "2026-10-16T17:00", reason: "Quote visit" };
  const SPAN = "Friday, October 16 from 1:00 PM to 5:00 PM";
  const JOBS = [
    { attendee_name: "Bob Lee", start_time: "2026-10-16T02:30:00+00:00" },
    { attendee_name: "Ann\nKay", start_time: "2026-10-16T04:00:00+00:00" },
  ];

  it("without confirmed=true reads the block back — naming the jobs already booked then, which stay booked — and changes NOTHING", async () => {
    db.queues.appointments = [{ data: JOBS, error: null }];
    const r = await handleOwnerBlockTime(ORG, BLOCK, ctx);
    expect(r).toEqual({
      success: false,
      message:
        `Read this back and get a clear yes before changing anything: block out ${SPAN} for everyone ("Quote visit"). ` +
        "2 jobs are already booked then and will stay booked unless the owner moves or cancels them: Bob Lee on Friday, October 16 at 1:30 PM; Ann Kay on Friday, October 16 at 3:00 PM. Say so in the read-back." +
        " If the owner confirms, call owner_block_time again with confirmed=true and the same start, end and reason.",
      data: { outcome: "needs_confirmation", when: SPAN, title: "Quote visit", jobs_in_the_way: 2 },
    });
    // The live jobs overlapping the block, org-scoped.
    const jobs = opsOn("appointments")[0];
    expect(filters(jobs, "eq")).toEqual([["organization_id", ORG]]);
    expect(filters(jobs, "in")).toEqual([["status", ["confirmed", "pending"]]]);
    expect(filters(jobs, "lt")).toEqual([["start_time", "2026-10-16T06:00:00.000Z"]]);
    expect(filters(jobs, "gt")).toEqual([["end_time", "2026-10-16T02:00:00.000Z"]]);
    expect(opsOn("blocked_times")).toEqual([]);
    expect(rateLimitDistributed).not.toHaveBeenCalled();
  });

  it("one job in the way reads in the singular; more than five are counted, not all named", async () => {
    db.queues.appointments = [{ data: JOBS.slice(0, 1), error: null }];
    expect((await handleOwnerBlockTime(ORG, BLOCK, ctx)).message).toContain("One job is already booked then and will stay booked unless the owner moves or cancels it: Bob Lee on Friday, October 16 at 1:30 PM. Say so");
    db.queues.organizations = [AU_ORG];
    db.queues.appointments = [{ data: Array.from({ length: 7 }, (_, i) => ({ attendee_name: `C${i}`, start_time: "2026-10-16T02:30:00+00:00" })), error: null }];
    const many = await handleOwnerBlockTime(ORG, BLOCK, ctx);
    expect(many.message).toContain("7 jobs are already booked then");
    expect(many.message).toContain("C4 on Friday, October 16 at 1:30 PM, and 2 more. Say so");
    expect(many.message).not.toContain("C5 on");
  });

  it("no jobs in the way: no jobs line; no reason: the default title, left out of the read-back", async () => {
    const r = await handleOwnerBlockTime(ORG, { start: BLOCK.start, end: BLOCK.end }, ctx);
    expect(r.message).toBe(`Read this back and get a clear yes before changing anything: block out ${SPAN} for everyone. If the owner confirms, call owner_block_time again with confirmed=true and the same start, end and reason.`);
    expect(r.data).toEqual({ outcome: "needs_confirmation", when: SPAN, title: "Time off", jobs_in_the_way: 0 });
  });

  it("confirmed: the dashboard's own row — for everyone, by the org's owner, linked to this call — then the voice server's cache refresh", async () => {
    db.queues.appointments = [{ data: JOBS, error: null }];
    db.queues.org_members = [{ data: { user_id: OWNER_USER }, error: null }];
    db.queues.blocked_times = [{ data: [], error: null }, { data: { id: "block-1" }, error: null }];
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx);
    expect(rateLimitDistributed).toHaveBeenCalledWith(expect.anything(), `${ORG}:owner`, "appt-mutate", "auth");
    expect(opsOn("blocked_times")[1].insert).toEqual({
      organization_id: ORG,
      title: "Quote visit",
      start_time: "2026-10-16T02:00:00.000Z",
      end_time: "2026-10-16T06:00:00.000Z",
      all_day: false,
      reason: "Added by your assistant",
      practitioner_id: null,
      created_by: OWNER_USER,
      created_on_call_id: CALL,
    });
    expect(filters(opsOn("org_members")[0], "eq")).toEqual([["organization_id", ORG], ["role", "owner"]]);
    expect(runAfterResponse).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      success: true,
      message: `Blocked out ${SPAN} for everyone. The 2 jobs already booked then are still booked.`,
      data: { outcome: "blocked", when: SPAN, title: "Quote visit", jobs_in_the_way: 2, block_id: "block-1" },
    });
  });

  it("the same block asked for again on this call (its result never came back) is handed back — no second row, no rate limit", async () => {
    db.queues.appointments = [{ data: JOBS, error: null }];
    db.queues.blocked_times = [{ data: [{ id: "block-1", title: "Quote visit" }], error: null }];
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx);
    expect(r).toEqual({
      success: true,
      message: `${SPAN} is already blocked out for everyone — that's the block from a moment ago.`,
      data: { outcome: "blocked", when: SPAN, title: "Quote visit", jobs_in_the_way: 2, block_id: "block-1" },
    });
    const same = opsOn("blocked_times")[0];
    expect(filters(same, "eq")).toEqual([["organization_id", ORG], ["created_on_call_id", CALL], ["start_time", "2026-10-16T02:00:00.000Z"], ["end_time", "2026-10-16T06:00:00.000Z"]]);
    expect(opsOn("blocked_times").some((o) => o.insert)).toBe(false);
    expect(rateLimitDistributed).not.toHaveBeenCalled();
    expect(runAfterResponse).not.toHaveBeenCalled();
  });

  it("an unreadable same-call check is a fault: nothing blocked", async () => {
    silence("error");
    db.queues.blocked_times = [{ data: null, error: { code: "57014" } }];
    expect(await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx)).toEqual({ success: false, error: true, message: TROUBLE });
    expect(opsOn("blocked_times").some((o) => o.insert)).toBe(false);
  });

  it("a block already under way names only the jobs still to come (never the ones done this morning)", async () => {
    await handleOwnerBlockTime(ORG, { start: "2026-10-15T08:00", end: "2026-10-15T17:00" }, ctx);
    expect(filters(opsOn("appointments")[0], "gt")).toEqual([["end_time", NOW.toISOString()]]);
  });

  it("whole days are all-day rows and read as such", async () => {
    db.queues.blocked_times = [{ data: [], error: null }, { data: { id: "block-2" }, error: null }];
    const r = await handleOwnerBlockTime(ORG, { start: "2026-10-17T00:00", end: "2026-10-18T00:00", confirmed: true }, ctx);
    expect(opsOn("blocked_times")[1].insert).toMatchObject({ all_day: true, title: "Time off", start_time: "2026-10-16T13:00:00.000Z", end_time: "2026-10-17T13:00:00.000Z" });
    expect(r.message).toBe("Blocked out Saturday, October 17 (all day) for everyone.");
  });

  it("several whole days keep their start and end (code lens N2: the dashboard shows an all-day block as one date)", async () => {
    db.queues.blocked_times = [{ data: [], error: null }, { data: { id: "block-5" }, error: null }];
    const r = await handleOwnerBlockTime(ORG, { start: "2026-10-19T00:00", end: "2026-10-24T00:00", confirmed: true }, ctx);
    expect(opsOn("blocked_times")[1].insert).toMatchObject({ all_day: false, start_time: "2026-10-18T13:00:00.000Z", end_time: "2026-10-23T13:00:00.000Z" });
    expect(r.message).toBe("Blocked out Monday, October 19 to Friday, October 23 (all day) for everyone.");
  });

  it("an unreadable owner is non-fatal: the block is made without created_by", async () => {
    silence("warn");
    db.queues.org_members = [{ data: null, error: { code: "57014" } }];
    db.queues.blocked_times = [{ data: [], error: null }, { data: { id: "block-3" }, error: null }];
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx);
    expect(r.data).toMatchObject({ outcome: "blocked" });
    expect(opsOn("blocked_times")[1].insert).toMatchObject({ created_by: null });
  });

  it.each([
    ["no start", { start: undefined }, "I need the start and end as dates and times, like 2026-10-30T13:00 to 2026-10-30T17:00."],
    ["an unreadable end", { end: "5pm" }, "I need the start and end as dates and times, like 2026-10-30T13:00 to 2026-10-30T17:00."],
    ["an end before the start", { end: "2026-10-16T12:00" }, "The end has to be after the start. What time should the block finish?"],
    ["an end equal to the start", { end: "2026-10-16T13:00" }, "The end has to be after the start. What time should the block finish?"],
    ["all of it already gone", { start: "2026-10-15T08:00", end: "2026-10-15T12:00" }, "That time has already passed. Which time should I block out?"],
    ["more than two weeks", { start: "2026-10-16T00:00", end: "2026-10-30T00:01" }, "That's longer than two weeks — please block that out in the dashboard."],
  ])("%s is refused before the diary is touched", async (_label, change, message) => {
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, ...change, confirmed: true } as any, ctx);
    expect(r).toEqual({ success: false, message, data: { outcome: "invalid_time" } });
    expect(ownerDiaryProvider).not.toHaveBeenCalled();
    expect(opsOn("blocked_times")).toEqual([]);
  });

  it("exactly two weeks, and a block already under way, are allowed", async () => {
    expect((await handleOwnerBlockTime(ORG, { start: "2026-10-16T00:00", end: "2026-10-30T00:00" }, ctx)).data).toMatchObject({ outcome: "needs_confirmation" });
    db.queues.organizations = [AU_ORG];
    expect((await handleOwnerBlockTime(ORG, { start: "2026-10-15T09:00", end: "2026-10-15T17:00" }, ctx)).data).toMatchObject({ outcome: "needs_confirmation" });
  });

  it("an org on Cliniko or Cal.com is refused; a failed diary check or jobs read is a fault — nothing is blocked", async () => {
    vi.mocked(ownerDiaryProvider).mockResolvedValueOnce("Cliniko");
    expect(await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx)).toEqual({
      success: false, message: "Your diary is in Cliniko, so I haven't blocked anything — please do it there.", data: { outcome: "external_calendar" },
    });
    db.queues.organizations = [AU_ORG];
    vi.mocked(ownerDiaryProvider).mockResolvedValueOnce("error");
    expect(await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx)).toEqual({ success: false, error: true, message: TROUBLE });
    silence("error");
    db.queues.organizations = [AU_ORG];
    db.queues.appointments = [{ data: null, error: { code: "57014" } }];
    expect(await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx)).toEqual({ success: false, error: true, message: TROUBLE });
    expect(opsOn("blocked_times")).toEqual([]);
  });

  it("rate limited: nothing is blocked", async () => {
    vi.mocked(rateLimitDistributed).mockResolvedValueOnce({ allowed: false } as any);
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx);
    expect(r).toMatchObject({ success: false, data: { outcome: "rate_limited" } });
    expect(opsOn("blocked_times").some((o) => o.insert)).toBe(false);
  });

  it("a failed insert is the owner's fault line, with no cache refresh and never 'blocked'", async () => {
    silence("error");
    db.queues.blocked_times = [{ data: [], error: null }, { data: null, error: { code: "23514" } }];
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx);
    expect(r).toEqual({ success: false, error: true, message: "I couldn't block that time out — something went wrong on our side. Please check the diary in the dashboard." });
    expect(runAfterResponse).not.toHaveBeenCalled();
  });

  it("the title is the owner's words as one capped line", async () => {
    db.queues.blocked_times = [{ data: [], error: null }, { data: { id: "block-4" }, error: null }];
    await handleOwnerBlockTime(ORG, { ...BLOCK, reason: "Day\noff\u200b" + "x".repeat(200), confirmed: true }, ctx);
    const title = opsOn("blocked_times")[1].insert!.title as string;
    expect(title.startsWith("Day off")).toBe(true);
    expect(title).not.toMatch(/[\n\u200b]/);
    expect(Array.from(title).length).toBeLessThanOrEqual(80);
  });
});

// ─── owner_mark_callback_done ─────────────────────────────────────────────────
describe("owner_mark_callback_done", () => {
  const PENDING = { id: CALLBACK, caller_name: "Sue Brown", reason: "Blocked drain", created_at: "2026-10-14T22:12:00Z" };
  const NOT_WAITING = "That callback isn't waiting any more — it may already be done. Check the messages again if you're not sure.";
  const RECEIVED = "Thursday, October 15 at 9:12 AM";

  it("without confirmed=true reads it back from the org's own pending callback and changes NOTHING", async () => {
    db.queues.callback_requests = [{ data: PENDING, error: null }];
    const r = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK }, ctx);
    expect(r).toEqual({
      success: false,
      message: `Read this back and get a clear yes before changing anything: mark Sue Brown's callback (Blocked drain, received ${RECEIVED}) as done. If the owner confirms, call owner_mark_callback_done again with confirmed=true and the same callback_id and note.`,
      data: { outcome: "needs_confirmation", callback_id: CALLBACK, caller_name: "Sue Brown", reason: "Blocked drain", received: RECEIVED },
    });
    expect(filters(opsOn("callback_requests")[0], "eq")).toEqual([["id", CALLBACK], ["organization_id", ORG], ["status", "pending"]]);
    expect(opsOn("callback_requests").some((o) => o.update)).toBe(false);
    expect(rateLimitDistributed).not.toHaveBeenCalled();
  });

  it("a note is read back with the rest (it is written to the record, so the owner must hear it)", async () => {
    db.queues.callback_requests = [{ data: PENDING, error: null }];
    const r = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, note: "Rang\nthem back" }, ctx);
    expect(r.message).toContain(`mark Sue Brown's callback (Blocked drain, received ${RECEIVED}) as done, with the note "Rang them back".`);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation", note: "Rang them back" });
  });

  it("a nonsense id is 'not waiting' without any read", async () => {
    for (const callback_id of [undefined, "", "cb-1", `${CALLBACK}' or 1=1`]) {
      expect(await handleOwnerMarkCallbackDone(ORG, { callback_id, confirmed: true }, ctx)).toEqual({ success: false, message: NOT_WAITING, data: { outcome: "not_found" } });
    }
    expect(db.log).toEqual([]);
  });

  it("done already, cancelled, or another org's: 'not waiting', and nothing is updated", async () => {
    db.queues.callback_requests = [{ data: null, error: null }];
    const r = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, confirmed: true }, ctx);
    expect(r).toEqual({ success: false, message: NOT_WAITING, data: { outcome: "not_found", callback_id: CALLBACK } });
    expect(opsOn("callback_requests").some((o) => o.update)).toBe(false);
  });

  it("confirmed: the dashboard's own update — completed, by the org's owner, linked to this call — only while it's still pending", async () => {
    db.queues.callback_requests = [{ data: PENDING, error: null }, { data: [{ id: CALLBACK }], error: null }];
    db.queues.org_members = [{ data: { user_id: OWNER_USER }, error: null }];
    const r = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, note: "Rang\nthem back", confirmed: true }, ctx);
    expect(rateLimitDistributed).toHaveBeenCalledWith(expect.anything(), `${ORG}:owner`, "appt-mutate", "auth");
    const update = opsOn("callback_requests")[1];
    expect(update.update).toEqual({
      status: "completed",
      completed_at: NOW.toISOString(),
      completed_by: OWNER_USER,
      completion_notes: "Rang them back",
      completed_on_call_id: CALL,
      updated_at: NOW.toISOString(),
    });
    expect(filters(update, "eq")).toEqual([["id", CALLBACK], ["organization_id", ORG], ["status", "pending"]]);
    expect(r).toEqual({
      success: true,
      message: "Marked Sue Brown's callback as done.",
      data: { outcome: "callback_done", callback_id: CALLBACK, caller_name: "Sue Brown", reason: "Blocked drain", received: RECEIVED },
    });
  });

  it("no note: the default one", async () => {
    db.queues.callback_requests = [{ data: PENDING, error: null }, { data: [{ id: CALLBACK }], error: null }];
    await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, confirmed: true }, ctx);
    expect(opsOn("callback_requests")[1].update).toMatchObject({ completion_notes: "Marked done on your assistant line" });
  });

  it("marked done by someone else in between (no row updated): 'not waiting', never 'done'", async () => {
    db.queues.callback_requests = [{ data: PENDING, error: null }, { data: [], error: null }];
    const r = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, confirmed: true }, ctx);
    expect(r).toMatchObject({ success: false, message: NOT_WAITING, data: { outcome: "not_found", callback_id: CALLBACK } });
  });

  it("a failed read or update is a fault in the owner's words, never 'done'", async () => {
    silence("error");
    db.queues.callback_requests = [{ data: null, error: { code: "57014" } }];
    expect(await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, confirmed: true }, ctx)).toEqual({ success: false, error: true, message: TROUBLE });
    db.queues.organizations = [AU_ORG];
    db.queues.callback_requests = [{ data: PENDING, error: null }, { data: null, error: { code: "57014" } }];
    expect(await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, confirmed: true }, ctx)).toEqual({
      success: false, error: true, message: "I couldn't mark that callback done — something went wrong on our side. Please check it in the dashboard.",
    });
  });

  it("rate limited: nothing is updated", async () => {
    db.queues.callback_requests = [{ data: PENDING, error: null }];
    vi.mocked(rateLimitDistributed).mockResolvedValueOnce({ allowed: false } as any);
    const r = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, confirmed: true }, ctx);
    expect(r).toMatchObject({ success: false, data: { outcome: "rate_limited" } });
    expect(opsOn("callback_requests").some((o) => o.update)).toBe(false);
  });

  it("the caller's name and reason are customer-written: one capped line each, with plain defaults", async () => {
    db.queues.callback_requests = [{ data: { ...PENDING, caller_name: "Sue\nBrown", reason: null }, error: null }];
    const r = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK }, ctx);
    expect(r.message).toContain("mark Sue Brown's callback (no reason given, received");
    db.queues.organizations = [AU_ORG];
    db.queues.callback_requests = [{ data: { ...PENDING, caller_name: null }, error: null }];
    expect((await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK }, ctx)).message).toContain("mark the caller's callback");
  });
});
