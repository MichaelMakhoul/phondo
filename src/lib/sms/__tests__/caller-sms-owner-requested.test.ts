import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-597 (silent lens G1): a text the business owner asks for — about a change
// they just made — skips the automated one-per-hour cap. Otherwise a move made
// minutes after the booking's own confirmation would be held back, and the owner
// told the customer "already knows" when they only have the OLD time. Automated
// texts keep the cap. Everything else (opt-out, the org's toggle, plan) still applies.

const twilioCreate = vi.fn(async () => ({ sid: "SM-test" }));
const db = { rateLimitCount: 1, inserts: [] as Array<{ table: string; row: unknown }>, upserts: [] as Array<Record<string, unknown>> };

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), withScope: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({
  getNotificationPreferences: vi.fn(async () => ({ sms_appointment_confirmation: true, sms_textback_on_missed_call: true })),
}));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => true) }));
vi.mock("@/lib/twilio/client", () => ({ getTwilioClient: () => ({ messages: { create: twilioCreate } }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: any = {};
      for (const m of ["select", "eq", "gte", "in", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => {
        if (table === "organizations") return { data: { send_customer_confirmations: true, sms_sender: null }, error: null };
        if (table === "phone_numbers") return { data: { phone_number: "+61257015064", telephony_provider: "twilio" }, error: null };
        return { data: null, error: null }; // caller_sms_optouts: not opted out
      };
      b.single = async () =>
        table === "organizations"
          ? { data: { business_name: "Copperline Plumbing", business_phone: "+61257015064", timezone: "Australia/Sydney" }, error: null }
          : { data: null, error: null };
      // The rate-limit count query (caller_sms_log, head + count) resolves via then.
      b.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(table === "caller_sms_log" ? { count: db.rateLimitCount, error: null } : { data: null, error: null }).then(resolve);
      b.insert = async (row: unknown) => { db.inserts.push({ table, row }); return { error: null }; };
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
  db.rateLimitCount = 1; // a text already went to this number within the hour
  db.inserts = [];
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

  it("the same cancellation text asked for by the owner goes out", async () => {
    const { sendCancellationSMS } = await load();
    expect(await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, { skipRateLimit: true })).toEqual({ sent: true, status: "sent" });
    expect(twilioCreate).toHaveBeenCalledTimes(1);
  });

  it("a new-time confirmation asked for by the owner goes out, minutes after the booking's own confirmation; an automated one doesn't", async () => {
    const { sendAppointmentConfirmationSMS } = await load();
    expect((await sendAppointmentConfirmationSMS(ORG, "+61414141883", START, "Australia/Sydney", undefined, APPT)).reason).toBe("rate_limited");
    expect(await sendAppointmentConfirmationSMS(ORG, "+61414141883", START, "Australia/Sydney", undefined, APPT, { skipRateLimit: true })).toEqual({ sent: true, status: "sent" });
    expect(twilioCreate).toHaveBeenCalledTimes(1);
  });

  it("only the exact boolean true skips it", async () => {
    const { sendCancellationSMS } = await load();
    expect((await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, { skipRateLimit: "yes" as any })).reason).toBe("rate_limited");
    expect((await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, {})).reason).toBe("rate_limited");
  });
});
