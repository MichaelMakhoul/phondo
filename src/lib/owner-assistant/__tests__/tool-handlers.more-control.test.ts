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
    expect(r.message).toContain(`Read this back and get a clear yes before changing anything: book Jane Smith on 0412 345 678 for ${WHEN} — notes: "Hot water unit leaking".`);
    // SCRUM-601: the read-back must SAY the number (a real session saved a misheard digit), the note, and spell an unusual name.
    expect(r.message).toMatch(/ Say the phone number back digit by digit, in its groups: "oh-four-one-two, three-four-five, six-seven-eight"\. Say the note\. Spell back letter by letter any name that isn't a common one, or that the owner corrected — once, not again on a repeated read-back unless it changed\.$/);
    expect(r.message).toContain(`In the same question, ask whether to let Jane Smith know: by text, or not tell them — or, if the owner already said, don't ask again: say their choice in the read-back ("…and text them, right?" or "…and not tell them, right?").`);
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
    expect(r.message).toContain(`book Jane Smith on 0412 345 678 for Hot water service on ${WHEN}.`);
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
      expect(r.message).toContain("It keeps the service, note and contact details it was booked with — the new ones weren't added; they can be changed in Appointments.");
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

describe("SCRUM-601: the booking's read-back says the number that will be SAVED", () => {
  it("the number is read back in the national format of what will be stored — whatever way the owner said it", async () => {
    for (const said of ["0412 345 678", "+61 412 345 678", "61412345678", "0412-345-678"]) {
      db.queues.organizations = [AU_ORG];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: said }, ctx);
      expect(r.message, said).toContain(`book Jane Smith on 0412 345 678 for ${WHEN}`);
      expect(r.data, said).toMatchObject({ customer_phone: "0412 345 678" });
    }
  });

  it("a landline reads in its groups; a US number as (415) 555-1234; a number from elsewhere as the owner said it", async () => {
    db.queues.organizations = [AU_ORG];
    expect((await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "+61 2 9555 1234" }, ctx)).data).toMatchObject({ customer_phone: "02 9555 1234" });
    db.queues.organizations = [{ data: { timezone: "America/New_York", country: "US" }, error: null }];
    expect((await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "415 555 1234", start: "2026-10-16T10:00" }, ctx)).data).toMatchObject({ customer_phone: "(415) 555-1234" });
    db.queues.organizations = [AU_ORG];
    expect((await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "+44 20 7946 0958" }, ctx)).data).toMatchObject({ customer_phone: "+44 20 7946 0958" });
  });

  it("the digits to say are the number's OWN, spelled out — a misheard 378 is said as three-seven-eight, never an example's digits", async () => {
    const said = async (phone: string, org = AU_ORG) => {
      db.queues.organizations = [org];
      return (await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: phone }, ctx)).message;
    };
    expect(await said("0412 345 378")).toContain(' in its groups: "oh-four-one-two, three-four-five, three-seven-eight".');
    expect(await said("+61 2 9555 1234")).toContain(' in its groups: "oh-two, nine-five-five-five, one-two-three-four".');
    expect(await said("+44 20 7946 0958")).toContain(' in its groups: "plus four-four, two-oh, seven-nine-four-six, oh-nine-five-eight".');
    expect(await said("415 555 1234", { data: { timezone: "America/New_York", country: "US" }, error: null })).toContain(' in its groups: "four-one-five, five-five-five, one-two-three-four".');
  });

  it("a booking with no note says so — a note the model dropped is heard missing (27 Oct: 'shower installation' was lost)", async () => {
    const r = await handleOwnerBookAppointment(ORG, BOOK, ctx); // this block's BOOK has no note
    expect(r.message).toContain(`. There's no job note: say "no job note", so the owner can add one. Spell back letter by letter`);
    expect(r.message).not.toContain("Say the note.");
  });

  it("an unbroken number is said in threes, a lone last digit joining the group before", async () => {
    const said = async (phone: string, org: typeof AU_ORG) => {
      db.queues.organizations = [org];
      return (await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: phone }, ctx)).message;
    };
    const US = { data: { timezone: "America/New_York", country: "US" }, error: null };
    expect(await said("+442079460958", AU_ORG)).toContain(' in its groups: "plus four-four-two, oh-seven-nine, four-six-oh, nine-five-eight".');
    expect(await said("+61412345678", US)).toContain(' in its groups: "plus six-one-four, one-two-three, four-five-six, seven-eight".');
    expect(await said("0412345678", US)).toContain(' in its groups: "oh-four-one, two-three-four, five-six-seven-eight".');
  });

  it("the number read back is the one booked: the confirm saves exactly that number", async () => {
    await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "0412 345 378", confirmed: true, notify_customer: "none" }, ctx);
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ phone: "+61412345378" });
  });
});

// SCRUM-601 mutation-lens killers (survivors W5, W6, W15 of the test review).
describe("SCRUM-601: a foreign number keeps its country code, and every result names the number as saved", () => {
  const US_ORG = { data: { timezone: "America/New_York", country: "US" }, error: null };
  const WORDS = ["oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  /** The digits a read-back has the model say, from its spelled-out groups ("plus one-four-one, …" → "+141…"), however they're grouped. */
  const digitsSaid = (message: string) =>
    (/in its groups: "([^"]+)"/.exec(message)?.[1] ?? "")
      .replace(/plus /g, "+")
      .split(/[-, ]+/)
      .map((w) => (w.startsWith("+") ? `+${WORDS.indexOf(w.slice(1))}` : String(WORDS.indexOf(w))))
      .join("");

  it("a number from outside the org's country, written in E.164, is read back with its country code — never as an org-country national number", async () => {
    // An AU number on a US org's booking is saved as +61412345678: never read back as "0412 345 678".
    db.queues.organizations = [US_ORG];
    const us = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "+61412345678" }, ctx);
    expect(String((us.data as Record<string, unknown>).customer_phone).replace(/\D/g, "")).toBe("61412345678");
    expect(digitsSaid(us.message)).toBe("+61412345678");
    // A US number on an AU org's booking is saved as +14155551234: never read back as "(415) 555-1234".
    db.queues.organizations = [AU_ORG];
    const au = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "+14155551234" }, ctx);
    expect(String((au.data as Record<string, unknown>).customer_phone).replace(/\D/g, "")).toBe("14155551234");
    expect(digitsSaid(au.message)).toBe("+14155551234");
  });

  it("the booking handed back again (its result never came back) names the number as it was saved and read back, however the owner said it", async () => {
    const EARLIER = { id: NEW_ID, attendee_name: "Jane Smith", attendee_phone: "+61412345678", confirmation_code: "654321", practitioners: { name: "Alex" } };
    db.queues.appointments = [{ data: [EARLIER], error: null }];
    db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
    db.queues.appointment_confirmations = [{ data: { status: "sent" }, error: null }];
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "+61 412 345 678", confirmed: true, notify_customer: "text" }, ctx);
    expect(handleBookAppointment).not.toHaveBeenCalled();
    expect(r.data).toMatchObject({ outcome: "booked", appointment_id: NEW_ID, customer_phone: "0412 345 678" });
  });
});

// SCRUM-601 mutation-lens killers, round 2 (survivors A1, A10).
describe("SCRUM-601 round 2: how a read-back groups digits, and a blank note", () => {
  it("a five-digit run is said in threes like any run longer than four — 'up to four as one' is a ceiling", async () => {
    // A UK number given in its national form, on an AU org: read back as said, in its groups.
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_phone: "01632 960123" }, ctx);
    expect(r.message).toContain(' in its groups: "oh-one-six, three-two, nine-six-oh, one-two-three".');
  });

  it("a note that is only spaces or invisible characters is no note: the read-back says \"no job note\", never \"Say the note.\"", async () => {
    for (const blank of ["   ", "\u200b"]) {
      db.queues.organizations = [AU_ORG];
      const r = await handleOwnerBookAppointment(ORG, { ...BOOK, notes: blank }, ctx);
      expect(r.message, JSON.stringify(blank)).toContain(`There's no job note: say "no job note", so the owner can add one.`);
      expect(r.message, JSON.stringify(blank)).not.toContain("Say the note.");
    }
  });
});

// SCRUM-602: each business decides what its bookings need (Assistants → Caller Data
// Collection). The owner assistant asks for exactly that — before the read-back, so a
// booking never fails after the owner's yes — and nothing the business didn't ask for.
describe("SCRUM-602: owner bookings follow each business's own required details", () => {
  const F = (id: string, label: string, required: boolean, verification = "repeat-confirm") => ({ id, label, required, verification, type: "text", category: "universal" });
  const NAME_FIELDS = (lastRequired: boolean) => [F("first_name", "First Name", true), F("last_name", "Last Name", lastRequired), F("phone_number", "Phone Number", true, "read-back-digits"), F("email_address", "Email Address", false, "spell-out")];
  const TRADIE = [...NAME_FIELDS(false), F("service_address", "Service Address", true), F("problem_description", "Problem Description", true), F("urgency_level", "Urgency Level", true)];
  const configured = (fields: unknown[]) => { db.queues.assistants = [{ data: { prompt_config: { fields } }, error: null }]; };
  const bookArgs = (customer_name: string, extra: Record<string, unknown> = {}) => ({ ...BOOK, customer_name, notes: "Hot water unit leaking", ...extra });

  it("a business that requires a last name: a first name alone is asked for the surname BEFORE the read-back — nothing booked, even with confirmed:true", async () => {
    for (const confirmed of [undefined, true]) {
      configured(NAME_FIELDS(true));
      const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", confirmed ? { confirmed, notify_customer: "none" } : {}), ctx);
      expect(r.data, String(confirmed)).toMatchObject({ outcome: "invalid_details", missing_fields: [{ id: "last_name", label: "Last Name" }] });
      expect(r.message).toContain(`Not booked yet: this business's bookings also need Jane's last name. Pass anything the owner has already said without asking again, and ask for the rest in one question ("I'll also need Jane's last name" — leaving out anything they already told you).`);
      expect(r.message).toContain("they can make that field optional in Assistants → Caller Data Collection (for example Last Name).");
      expect(handleBookAppointment).not.toHaveBeenCalled();
    }
  });

  it("the same business books 'Jane Smith' straight to the read-back; a business with the last name optional books 'Jane' alone", async () => {
    configured(NAME_FIELDS(true));
    expect((await handleOwnerBookAppointment(ORG, bookArgs("Jane Smith"), ctx)).data).toMatchObject({ outcome: "needs_confirmation", customer_name: "Jane Smith" });
    configured(NAME_FIELDS(false));
    db.queues.organizations = [AU_ORG];
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { confirmed: true, notify_customer: "none" }), ctx);
    expect(r.data).toMatchObject({ outcome: "booked" });
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ first_name: "Jane" });
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).not.toHaveProperty("last_name");
  });

  it("a surname given as a detail ('last name=Smith') counts: the booking is Jane Smith's", async () => {
    configured(NAME_FIELDS(true));
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "last name=Smith" }), ctx);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation", customer_name: "Jane Smith" });
    expect(r.message).toContain("book Jane Smith on 0412 345 678");
  });

  it("a business that requires an email asks for it, checks it, spells it back, and saves it on the booking", async () => {
    const fields = [...NAME_FIELDS(false).filter((f) => f.id !== "email_address"), F("email_address", "Email Address", true, "spell-out")];
    configured(fields);
    const asked = await handleOwnerBookAppointment(ORG, bookArgs("Jane"), ctx);
    expect(asked.data).toMatchObject({ outcome: "invalid_details", missing_fields: [{ id: "email_address", label: "Email Address" }] });
    expect(asked.message).toContain("this business's bookings also need Jane's email address.");
    configured(fields);
    db.queues.organizations = [AU_ORG];
    const bad = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { customer_email: "jane at example" }), ctx);
    expect(bad.data).toMatchObject({ outcome: "invalid_details" });
    expect(bad.message).toContain(`That email address doesn't look right ("janeatexample")`);
    configured(fields);
    db.queues.organizations = [AU_ORG];
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { customer_email: "jane.smith @ example.com" }), ctx);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation", customer_email: "jane.smith@example.com" });
    expect(r.message).toContain(`${WHEN} — notes: "Hot water unit leaking" — details: email jane.smith@example.com.`);
    expect(r.message).toContain("Say the note. Spell the email address out letter by letter. Spell back letter by letter any name");
    configured(fields);
    db.queues.organizations = [AU_ORG];
    await handleOwnerBookAppointment(ORG, bookArgs("Jane", { customer_email: "jane.smith@example.com", confirmed: true, notify_customer: "none" }), ctx);
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ email: "jane.smith@example.com", notes: "Hot water unit leaking" });
  });

  it("a tradie's business: the address, the problem and the urgency are all asked for in ONE message, read back per field, and saved as lines in the job's note", async () => {
    configured(TRADIE);
    const asked = await handleOwnerBookAppointment(ORG, bookArgs("Jane"), ctx);
    expect(asked.message).toContain("this business's bookings also need the service address, the problem description and the urgency level.");
    expect(asked.message).toContain("they can make that field optional in Assistants → Caller Data Collection (for example Service Address).");
    expect((asked.data as Record<string, unknown>).missing_fields).toEqual([
      { id: "service_address", label: "Service Address" },
      { id: "problem_description", label: "Problem Description" },
      { id: "urgency_level", label: "Urgency Level" },
    ]);
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const details = "service address=12 Smith St, Wyong; Problem Description: leaking tap; urgency_level = today";
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details }), ctx);
    expect(r.data).toMatchObject({
      outcome: "needs_confirmation",
      details: [
        { id: "service_address", label: "Service Address", value: "12 Smith St, Wyong" },
        { id: "problem_description", label: "Problem Description", value: "leaking tap" },
        { id: "urgency_level", label: "Urgency Level", value: "today" },
      ],
    });
    expect(r.message).toContain(` — details: Service Address: 12 Smith St, Wyong; Problem Description: leaking tap; Urgency Level: today.`);
    expect(r.message).toContain("Say the note. Repeat the service address back. Repeat the problem description back. Repeat the urgency level back. Spell back");
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const booked = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details, confirmed: true, notify_customer: "none" }), ctx);
    expect(booked.data).toMatchObject({ outcome: "booked" });
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ notes: "Hot water unit leaking\nService Address: 12 Smith St, Wyong\nProblem Description: leaking tap\nUrgency Level: today" });
  });

  it("each detail is read back the way the business set it: digits, letters, characters, or repeated — and an optional detail the owner gives is kept", async () => {
    configured([...NAME_FIELDS(false), F("dob", "Date of Birth", true), F("insurance_member_id", "Insurance Member ID", false, "read-back-characters"), F("medicare_card_number", "Medicare Card Number", false, "read-back-digits")]);
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "Date of Birth=12/03/1980; insurance member id=AB-12345; medicare card number=2123 45670 1" }), ctx);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation" });
    expect(r.message).toContain("Repeat the date of birth back. Read the insurance member id back character by character. Say the medicare card number digit by digit.");
    expect((r.data as Record<string, unknown>).details).toHaveLength(3);
  });

  it("nothing the business didn't ask for is asked: an unknown field is refused with the business's own list, a blank value is no value", async () => {
    configured(TRADIE);
    const unknown = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "shoe size=9" }), ctx);
    expect(unknown.data).toMatchObject({ outcome: "invalid_details" });
    expect(unknown.message).toBe(`I don't know a "shoe size" detail for this business. Its fields are: Service Address, Problem Description and Urgency Level. Anything else goes in the note.`);
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const blank = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "service address=12 Smith St; problem description= ; urgency level=today" }), ctx);
    expect(blank.data).toMatchObject({ outcome: "invalid_details", missing_fields: [{ id: "problem_description", label: "Problem Description" }] });
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("the same field twice — by id, by label, or one of each — is refused, never picked by position (the gate's key couldn't tell which one was read back)", async () => {
    const DENTAL = [...NAME_FIELDS(false), F("dob", "Date of Birth", true)];
    for (const details of ["dob=12/03/1980; dob=01/01/2000", "Date of Birth=12/03/1980; date of birth=01/01/2000", "dob=12/03/1980; Date of Birth=01/01/2000", "date of birth=01/01/2000; dob=12/03/1980", "dob=; dob=12/03/1980"]) {
      configured(DENTAL);
      db.queues.organizations = [AU_ORG];
      const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details, confirmed: true, notify_customer: "none" }), ctx);
      expect(r.data, details).toMatchObject({ outcome: "invalid_details" });
      expect(r.message, details).toBe(`"Date of Birth" is given twice in the details — pass each detail once.`);
    }
    // The booking's own fields under either spelling, and an email in both places.
    for (const [extra, line] of [
      [{ details: "surname=Smith; last name=Jones" }, `"Last Name" is given twice in the details — pass each detail once.`],
      [{ details: "email=a@example.com; email address=b@example.com" }, `"Email Address" is given twice in the details — pass each detail once.`],
      [{ customer_email: "a@example.com", details: "email=b@example.com" }, "The email is given twice — pass it once, in customer_email."],
    ] as const) {
      configured(DENTAL);
      db.queues.organizations = [AU_ORG];
      const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { ...extra, confirmed: true, notify_customer: "none" }), ctx);
      expect(r.data, JSON.stringify(extra)).toMatchObject({ outcome: "invalid_details" });
      expect(r.message, JSON.stringify(extra)).toBe(line);
    }
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("details that can't be read, or are too long, are refused before anything else — never cut", async () => {
    configured(TRADIE);
    const unreadable = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "twelve smith street" }), ctx);
    expect(unreadable.message).toBe(`I couldn't read the details. Pass them as "field=value; field=value", using this business's field names: Service Address, Problem Description and Urgency Level.`);
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const long = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: `service address=${"x".repeat(700)}` }), ctx);
    expect(long.message).toBe("That's too much detail for one booking — keep each detail short (about 100 words in all).");
    // Measured after normalisation (security lens): 230 ligatures are 230 characters typed but 690 once ﬃ → ffi — refused, never cut.
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const wide = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: `service address=${"\uFB03".repeat(230)}` }), ctx);
    expect(wide.message).toBe("That's too much detail for one booking — keep each detail short (about 100 words in all).");
    // The job's note is the owner's note plus the details: over the diary's 500 characters it is refused, not trimmed.
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const over = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { notes: "n".repeat(200), details: `service address=${"a".repeat(120)}; problem description=${"b".repeat(120)}; urgency level=${"c".repeat(120)}` }), ctx);
    expect(over.data).toMatchObject({ outcome: "invalid_details" });
    expect(over.message).toMatch(/^That's too much for the job's note — about \d+ words over; the note is the longest part\. Ask the owner to shorten it, then call again\.$/);
    // One detail over its own cap is refused by name, in words — never trimmed (clients lens: a lawyer's matter description).
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const longValue = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: `problem description=${"p".repeat(330)}; service address=12 Smith St` }), ctx);
    expect(longValue.data).toMatchObject({ outcome: "invalid_details" });
    expect(longValue.message).toBe("The problem description is too long for a booking detail — about 5 words over. Ask the owner for a shorter version, then call again.");
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("a field's own description is the hint: it's named with the field and handed back, so the model offers the options instead of asking vaguely", async () => {
    configured([...NAME_FIELDS(false), { ...F("urgency_level", "Urgency Level", true, "none"), description: "Routine, Urgent, or Emergency" }]);
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane"), ctx);
    expect(r.message).toContain("this business's bookings also need the urgency level (Routine, Urgent, or Emergency).");
    expect(r.data).toMatchObject({ outcome: "invalid_details", missing_fields: [{ id: "urgency_level", label: "Urgency Level", hint: "Routine, Urgent, or Emergency" }] });
  });

  it("any name given twice — even one the booking ignores (phone, name) — is refused: the gate's key can't confirm a repeat, so accepting it would loop the read-back", async () => {
    for (const details of ["phone=0412 345 678; phone=0412 345 679", "name=Jane; Name=Janet", "service address=12 Smith St; Service_Address=14 Smith St"]) {
      configured(TRADIE);
      db.queues.organizations = [AU_ORG];
      const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details }), ctx);
      expect(r.data, details).toMatchObject({ outcome: "invalid_details" });
      expect(r.message, details).toMatch(/^".+" is given twice in the details — pass each detail once\.$/);
    }
  });

  it("details are kept in the business's own field order, whatever order the model gave them — in the data, the read-back and the note", async () => {
    configured(TRADIE);
    const details = "urgency level=today; problem description=leaking tap; service address=12 Smith St";
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details }), ctx);
    expect(((r.data as Record<string, unknown>).details as Array<{ id: string }>).map((d) => d.id)).toEqual(["service_address", "problem_description", "urgency_level"]);
    expect(r.message).toContain("— details: Service Address: 12 Smith St; Problem Description: leaking tap; Urgency Level: today.");
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details, confirmed: true, notify_customer: "none" }), ctx);
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ notes: "Hot water unit leaking\nService Address: 12 Smith St\nProblem Description: leaking tap\nUrgency Level: today" });
  });

  it("a name that isn't in English letters is asked about BEFORE the read-back (the diary's rule used to fire only after the yes)", async () => {
    for (const confirmed of [undefined, true]) {
      db.queues.organizations = [AU_ORG];
      const r = await handleOwnerBookAppointment(ORG, bookArgs("Джон Смит", confirmed ? { confirmed, notify_customer: "none" } : {}), ctx);
      expect(r.data, String(confirmed)).toMatchObject({ outcome: "invalid_details" });
      expect(r.message).toBe("The diary keeps names in English letters. Ask the owner how Джон Смит is spelled in English letters, then call again.");
    }
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("the business's fields are read from ONE ordered row — the same the receptionist's booking path reads (several assistants on an org must not pick different ones)", async () => {
    configured(NAME_FIELDS(true));
    await handleOwnerBookAppointment(ORG, bookArgs("Jane"), ctx);
    const read = opsOn("assistants")[0];
    expect(filters(read, "eq")).toEqual([["organization_id", ORG]]);
    expect(filters(read, "order")).toEqual([["created_at", { ascending: true }], ["id", { ascending: true }]]);
    expect(filters(read, "limit")).toEqual([[1]]);
  });

  it("a repeated booking with another email is handed back AS BOOKED and says it kept its contact details; the same email again says nothing of the kind", async () => {
    const EARLIER_602 = { id: NEW_ID, attendee_first_name: "Jane", attendee_name: "Jane Smith", attendee_phone: "+61412345678", attendee_email: "jane@example.com", confirmation_code: "654321", service_type_id: null, notes: "Hot water unit leaking" };
    db.queues.appointments = [{ data: [EARLIER_602], error: null }];
    db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
    const other = await handleOwnerBookAppointment(ORG, bookArgs("Jane Smith", { customer_email: "other@example.com", confirmed: true, notify_customer: "none" }), ctx);
    expect(handleBookAppointment).not.toHaveBeenCalled();
    expect(other.message).toContain("It keeps the service, note and contact details it was booked with");
    db.queues.organizations = [AU_ORG];
    db.queues.appointments = [{ data: [EARLIER_602], error: null }];
    db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
    const same = await handleOwnerBookAppointment(ORG, bookArgs("Jane Smith", { customer_email: "jane@example.com", confirmed: true, notify_customer: "none" }), ctx);
    expect(same.message).not.toContain("It keeps");
    // The diary's placeholder address is no email of the customer's: a retry without one matches it.
    db.queues.organizations = [AU_ORG];
    db.queues.appointments = [{ data: [{ ...EARLIER_602, attendee_email: "booking-0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f@noreply.phondo.ai" }], error: null }];
    db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
    const none = await handleOwnerBookAppointment(ORG, bookArgs("Jane Smith", { confirmed: true, notify_customer: "none" }), ctx);
    expect(none.message).not.toContain("It keeps");
  });

  it("a line break between details separates like a semicolon; inside a value it leaves a part with no field, which is refused — never a garbled read-back", async () => {
    configured(TRADIE);
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "service address=12 Smith St\nproblem description: leaking tap\r\nurgency level=today" }), ctx);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation" });
    expect(((r.data as Record<string, unknown>).details as Array<{ value: string }>).map((d) => d.value)).toEqual(["12 Smith St", "leaking tap", "today"]);
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const inside = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "service address=12 Smith St; problem description=tap leaking\nunder the sink; urgency level=today" }), ctx);
    expect(inside.data).toMatchObject({ outcome: "invalid_details" });
    expect(inside.message).toContain("I couldn't read the details.");
    // A ";" inside a value is the same: refused, consistently on both sides.
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const semi = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "service address=12 Smith St; Wyong; urgency level=today" }), ctx);
    expect(semi.message).toContain("I couldn't read the details.");
  });

  it("'required' is read as the booking path reads it — truthy — so a config with the string \"true\" is required on both sides, never required only after the yes", async () => {
    configured([F("first_name", "First Name", true), { ...F("last_name", "Last Name", false), required: "true" }, F("phone_number", "Phone Number", true)]);
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane"), ctx);
    expect(r.data).toMatchObject({ outcome: "invalid_details", missing_fields: [{ id: "last_name", label: "Last Name" }] });
  });

  it("an email the owner gives is kept even when the business doesn't collect one — an extra, never asked for", async () => {
    configured(NAME_FIELDS(false).filter((f) => f.id !== "email_address"));
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { customer_email: "jane@example.com", confirmed: true, notify_customer: "none" }), ctx);
    expect(r.data).toMatchObject({ outcome: "booked" });
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ email: "jane@example.com" });
  });

  it("no configured fields (no assistant row, or no fields) means nothing beyond the name and number; a read fault is a fault, never 'nothing required'", async () => {
    db.queues.assistants = [{ data: null, error: null }];
    expect((await handleOwnerBookAppointment(ORG, bookArgs("Jane"), ctx)).data).toMatchObject({ outcome: "needs_confirmation" });
    db.queues.organizations = [AU_ORG];
    db.queues.assistants = [{ data: { prompt_config: null }, error: null }];
    expect((await handleOwnerBookAppointment(ORG, bookArgs("Jane"), ctx)).data).toMatchObject({ outcome: "needs_confirmation" });
    db.queues.organizations = [AU_ORG];
    db.queues.assistants = [{ data: null, error: { code: "57014" } }];
    const fault = await handleOwnerBookAppointment(ORG, bookArgs("Jane"), ctx);
    expect(fault.error).toBe(true);
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });
});

// ─── SCRUM-602 test lens (independent mutants): killers for what the PR's own suite let through ───
// APPEND TO: src/lib/owner-assistant/__tests__/tool-handlers.more-control.test.ts (at the end of
// the file — `cat killers-website.txt >> …`). Uses the file's top-level fixtures (db, BOOK, ORG, ctx,
// AU_ORG, NEW_ID, handleOwnerBookAppointment, handleBookAppointment). The SCRUM-602 block's small
// helpers are local to that describe, so they are redefined here with the same shapes.
// Each test names the mutant it kills (see the review's mutant table); all pass on the real code.
describe("SCRUM-602 test lens: killers for the surviving mutants", () => {
  const F = (id: string, label: string, required: boolean, verification = "repeat-confirm") => ({ id, label, required, verification, type: "text", category: "universal" });
  const NAME_FIELDS = (lastRequired: boolean) => [F("first_name", "First Name", true), F("last_name", "Last Name", lastRequired), F("phone_number", "Phone Number", true, "read-back-digits"), F("email_address", "Email Address", false, "spell-out")];
  const TRADIE = [...NAME_FIELDS(false), F("service_address", "Service Address", true), F("problem_description", "Problem Description", true), F("urgency_level", "Urgency Level", true)];
  const configured = (fields: unknown[]) => { db.queues.assistants = [{ data: { prompt_config: { fields } }, error: null }]; };
  const bookArgs = (customer_name: string, extra: Record<string, unknown> = {}) => ({ ...BOOK, customer_name, notes: "Hot water unit leaking", ...extra });
  const KEPT = "It keeps the service, note and contact details it was booked with — the new ones weren't added";

  it("W05: when the model passes both, neither email is picked over the other — it is refused, and nothing of the second shows anywhere", async () => {
    configured(NAME_FIELDS(false));
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { customer_email: "jane@example.com", details: "email=other@example.com" }), ctx);
    expect(r.data).toMatchObject({ outcome: "invalid_details" });
    expect(r.message).toBe("The email is given twice — pass it once, in customer_email.");
    expect(r.message).not.toContain("other@example.com");
  });

  it("W07: a job note of exactly the diary's 500 characters is kept — only one OVER is refused, and the count says by how much", async () => {
    // 200 (the owner's note, its own cap) + "\n" + "Service Address: " (17) + 100 + "\n" + "Problem Description: " (21) + 100 + "\n" + "Urgency Level: " (15) + 44 = 500
    const details = `service address=${"a".repeat(100)}; problem description=${"b".repeat(100)}; urgency level=${"c".repeat(44)}`;
    configured(TRADIE);
    const at = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { notes: "n".repeat(200), details }), ctx);
    expect(at.data).toMatchObject({ outcome: "needs_confirmation" });
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    const over = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { notes: "n".repeat(200), details: details.replace("c".repeat(44), "c".repeat(45)) }), ctx);
    expect(over.data).toMatchObject({ outcome: "invalid_details" });
    expect(over.message).toBe("That's too much for the job's note — about 1 word over; the note is the longest part. Ask the owner to shorten it, then call again.");
  });

  it("W10: a field's id written with spaces ('service address' for service_address) is that field even when its label is something else", async () => {
    configured([...NAME_FIELDS(false), F("service_address", "Address", true)]);
    const byId = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "service address=12 Smith St" }), ctx);
    expect(byId.data).toMatchObject({ outcome: "needs_confirmation", details: [{ id: "service_address", label: "Address", value: "12 Smith St" }] });
    configured([...NAME_FIELDS(false), F("service_address", "Address", true)]);
    db.queues.organizations = [AU_ORG];
    const byLabel = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "Address: 12 Smith St" }), ctx);
    expect(byLabel.data).toMatchObject({ outcome: "needs_confirmation", details: [{ id: "service_address", label: "Address", value: "12 Smith St" }] });
  });

  it("W13: an email given to a business with no email field is still spelled back letter by letter (the default), never merely said", async () => {
    configured(NAME_FIELDS(false).filter((f) => f.id !== "email_address"));
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { customer_email: "jane@example.com" }), ctx);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation", customer_email: "jane@example.com" });
    expect(r.message).toContain("Say the note. Spell the email address out letter by letter. Spell back letter by letter any name");
  });

  it("W15: the surname the owner SAID ('Jane Smith') is the booking's — a 'last name=' detail that disagrees doesn't replace it", async () => {
    configured(NAME_FIELDS(true));
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane Smith", { details: "last name=Smyth" }), ctx);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation", customer_name: "Jane Smith" });
    expect(r.message).toContain("book Jane Smith on 0412 345 678");
  });

  it("W18: a repeat of a booking made WITH details compares the WHOLE note — the same note and details again say nothing about kept details; details the first booking lacked do", async () => {
    const EARLIER = { id: NEW_ID, attendee_name: "Jane", attendee_phone: "+61412345678", confirmation_code: "654321", practitioners: { name: "Alex" }, service_type_id: null };
    const details = "service address=12 Smith St, Wyong; problem description=leaking tap; urgency level=today";
    const diaryNotes = "Hot water unit leaking\nService Address: 12 Smith St, Wyong\nProblem Description: leaking tap\nUrgency Level: today";
    configured(TRADIE);
    db.queues.appointments = [{ data: [{ ...EARLIER, notes: diaryNotes }], error: null }];
    db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
    const same = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details, confirmed: true, notify_customer: "none" }), ctx);
    expect(same.data).toMatchObject({ outcome: "booked", appointment_id: NEW_ID });
    expect(same.message).not.toContain(KEPT);
    configured(TRADIE);
    db.queues.organizations = [AU_ORG];
    db.queues.appointments = [{ data: [{ ...EARLIER, notes: "Hot water unit leaking" }], error: null }];
    db.queues.appointment_events = [{ data: [{ id: "ev-1" }], error: null }];
    const added = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details, confirmed: true, notify_customer: "none" }), ctx);
    expect(added.data).toMatchObject({ outcome: "booked", appointment_id: NEW_ID });
    expect(added.message).toContain(KEPT);
    expect(handleBookAppointment).not.toHaveBeenCalled();
  });

  it("W19: the same field twice in details is never picked by position — refused, and neither value shows anywhere", async () => {
    configured(TRADIE);
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "service address=12 Smith St; Service Address=14 Smith St; problem description=leaking tap; urgency level=today" }), ctx);
    expect(r.data).toMatchObject({ outcome: "invalid_details" });
    expect(r.message).toBe(`"Service Address" is given twice in the details — pass each detail once.`);
    expect(r.message).not.toContain("14 Smith St");
  });

  it("W20: a field listed twice in the business's config is one field — asked for once, named once", async () => {
    configured([...TRADIE, F("service_address", "Service Address", true)]);
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane"), ctx);
    expect((r.data as Record<string, unknown>).missing_fields).toEqual([
      { id: "service_address", label: "Service Address" },
      { id: "problem_description", label: "Problem Description" },
      { id: "urgency_level", label: "Urgency Level" },
    ]);
    expect(r.message).toContain("this business's bookings also need the service address, the problem description and the urgency level.");
  });

  it("W24: the booking's own fields passed again through details ('first name=', 'phone=') are ignored — never refused as unknown", async () => {
    configured(TRADIE);
    const r = await handleOwnerBookAppointment(ORG, bookArgs("Jane", { details: "first name=Jane; phone=0412 345 678; service address=12 Smith St; problem description=leaking tap; urgency level=today" }), ctx);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation", customer_name: "Jane" });
    expect((r.data as Record<string, unknown>).details).toHaveLength(3);
  });
});
