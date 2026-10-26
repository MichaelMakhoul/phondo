import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-597: a text the business owner asks for — about a change they just made —
// isn't held to the automated one-per-hour cap (a move minutes after the booking's own
// confirmation would be held back, the customer left with only the OLD time). It gets
// a looser per-number cap instead (security round 2): at most 3 appointment texts an
// hour, confirmations and cancellations together, so a looping model or a misused
// owner session can't flood one customer. A move's text says it MOVED.

const twilioCreate = vi.fn(async (_m: { body: string }) => ({ sid: "SM-test" }));
const db = {
  automatedCount: 1, // sent texts of this message type to this number in the hour
  ownerCount: 1, // sent appointment texts (both types) to this number in the hour
  logFilters: [] as Array<Array<[string, unknown[]]>>,
  upserts: [] as Array<Record<string, unknown>>,
};

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), withScope: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({
  getNotificationPreferences: vi.fn(async () => ({ sms_appointment_confirmation: true, sms_textback_on_missed_call: true })),
}));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => true) }));
vi.mock("@/lib/twilio/client", () => ({ getTwilioClient: () => ({ messages: { create: twilioCreate } }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown[]]> = [];
      const b: any = {};
      for (const m of ["select", "eq", "gte", "in", "order", "limit"]) b[m] = (...a: unknown[]) => { filters.push([m, a]); return b; };
      b.maybeSingle = async () => {
        if (table === "organizations") return { data: { send_customer_confirmations: true, sms_sender: null }, error: null };
        if (table === "phone_numbers") return { data: { phone_number: "+61257015064", telephony_provider: "twilio" }, error: null };
        return { data: null, error: null }; // caller_sms_optouts: not opted out
      };
      b.single = async () =>
        table === "organizations"
          ? { data: { business_name: "Copperline Plumbing", business_phone: "+61257015064", timezone: "Australia/Sydney" }, error: null }
          : { data: null, error: null };
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === "caller_sms_log") {
          db.logFilters.push(filters);
          const owner = filters.some(([m]) => m === "in");
          return Promise.resolve({ count: owner ? db.ownerCount : db.automatedCount, error: null }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      };
      b.insert = async () => ({ error: null });
      b.upsert = async (row: Record<string, unknown>) => { db.upserts.push(row); return { error: null }; };
      return b;
    },
  }),
}));

const ORG = "11111111-2222-4333-a444-555555555555";
const APPT = "44444444-5555-4666-8777-888888888888";
const START = new Date("2026-10-16T23:00:00Z");

async function load() {
  vi.resetModules();
  process.env.CALLER_SMS_ENABLED = "true";
  return import("../caller-sms");
}

beforeEach(() => {
  twilioCreate.mockClear();
  db.automatedCount = 1;
  db.ownerCount = 1;
  db.logFilters = [];
  db.upserts = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CALLER_SMS_ENABLED;
});

describe("the hourly cap and owner-requested texts", () => {
  it("an automated cancellation text inside the hour is held back (blocked_ratelimit, skipped_cap)", async () => {
    const { sendCancellationSMS } = await load();
    expect(await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT)).toEqual({ sent: false, status: "blocked_ratelimit", reason: "rate_limited" });
    expect(twilioCreate).not.toHaveBeenCalled();
    expect(db.upserts.at(-1)?.status).toBe("skipped_cap");
  });

  it("the same text asked for by the owner goes out — the owner cap counts both appointment types to this number", async () => {
    const { sendCancellationSMS } = await load();
    expect(await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, { ownerRequested: true })).toEqual({ sent: true, status: "sent" });
    expect(twilioCreate).toHaveBeenCalledTimes(1);
    const ownerQuery = db.logFilters.at(-1)!;
    expect(ownerQuery).toContainEqual(["eq", ["caller_phone", "+61414141883"]]);
    expect(ownerQuery).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(ownerQuery).toContainEqual(["eq", ["status", "sent"]]);
    expect(ownerQuery).toContainEqual(["in", ["message_type", ["appointment_confirmation", "appointment_cancellation"]]]);
    expect(ownerQuery.some(([m, a]) => m === "gte" && a[0] === "created_at")).toBe(true);
  });

  it("the owner cap: 2 sent this hour → a third goes; 3 sent → held back (a looping model can't flood one customer)", async () => {
    const { sendCancellationSMS } = await load();
    db.ownerCount = 2;
    expect((await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, { ownerRequested: true })).sent).toBe(true);
    db.ownerCount = 3;
    expect(await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, { ownerRequested: true })).toEqual({ sent: false, status: "blocked_ratelimit", reason: "rate_limited" });
    expect(twilioCreate).toHaveBeenCalledTimes(1);
  });

  it("a move asked for by the owner goes out minutes after the booking's own confirmation, worded as a move", async () => {
    const { sendAppointmentConfirmationSMS } = await load();
    expect((await sendAppointmentConfirmationSMS(ORG, "+61414141883", START, "Australia/Sydney", undefined, APPT)).reason).toBe("rate_limited");
    expect(await sendAppointmentConfirmationSMS(ORG, "+61414141883", START, "Australia/Sydney", undefined, APPT, { ownerRequested: true, moved: true })).toEqual({ sent: true, status: "sent" });
    expect(twilioCreate).toHaveBeenCalledTimes(1);
    expect(twilioCreate.mock.calls[0][0].body).toMatch(/^Your appointment at Copperline Plumbing has been moved to Saturday, October 17 at 10:00 AM\./);
  });

  it("without 'moved' the text is the plain confirmation, as before", async () => {
    const { sendAppointmentConfirmationSMS } = await load();
    db.automatedCount = 0;
    await sendAppointmentConfirmationSMS(ORG, "+61414141883", START, "Australia/Sydney", undefined, APPT);
    expect(twilioCreate.mock.calls[0][0].body).toMatch(/^Your appointment at Copperline Plumbing is confirmed for Saturday, October 17 at 10:00 AM\./);
  });

  it("only the exact boolean true counts as owner-requested", async () => {
    const { sendCancellationSMS } = await load();
    expect((await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, { ownerRequested: "yes" as any })).reason).toBe("rate_limited");
    expect((await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, {})).reason).toBe("rate_limited");
  });
});
