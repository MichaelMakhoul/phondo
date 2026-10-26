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
  // The gates an owner-requested text must still meet (test lens round 2).
  ownerError: null as null | { code: string },
  optedOut: false,
  orgTexts: true,
  planOk: true,
};

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), withScope: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({
  getNotificationPreferences: vi.fn(async () => ({ sms_appointment_confirmation: true, sms_textback_on_missed_call: true })),
}));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => db.planOk) }));
vi.mock("@/lib/twilio/client", () => ({ getTwilioClient: () => ({ messages: { create: twilioCreate } }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown[]]> = [];
      const b: any = {};
      for (const m of ["select", "eq", "gte", "in", "order", "limit"]) b[m] = (...a: unknown[]) => { filters.push([m, a]); return b; };
      b.maybeSingle = async () => {
        if (table === "organizations") return { data: { send_customer_confirmations: db.orgTexts, sms_sender: null }, error: null };
        if (table === "phone_numbers") return { data: { phone_number: "+61257015064", telephony_provider: "twilio" }, error: null };
        if (table === "caller_sms_optouts") return { data: db.optedOut ? { id: "opt-1" } : null, error: null };
        return { data: null, error: null };
      };
      b.single = async () =>
        table === "organizations"
          ? { data: { business_name: "Copperline Plumbing", business_phone: "+61257015064", timezone: "Australia/Sydney" }, error: null }
          : { data: null, error: null };
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === "caller_sms_log") {
          db.logFilters.push(filters);
          const owner = filters.some(([m]) => m === "in");
          if (owner && db.ownerError) return Promise.resolve({ count: null, error: db.ownerError }).then(resolve);
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
  db.ownerError = null;
  db.optedOut = false;
  db.orgTexts = true;
  db.planOk = true;
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

// Test lens round 2: an owner-requested text is exempt ONLY from the hourly cap — the
// org's toggle, the customer's STOP, the plan and a fail-closed owner cap all still hold.
describe("an owner-requested text is exempt ONLY from the hourly cap", () => {
  it("only the exact boolean true counts — for confirmations too; the dashboard's { moved: true } stays on the hourly cap", async () => {
    const { sendAppointmentConfirmationSMS } = await load();
    for (const options of [{}, { ownerRequested: "yes" as any }, { moved: true }]) {
      expect((await sendAppointmentConfirmationSMS(ORG, "+61414141883", START, "Australia/Sydney", undefined, APPT, options)).reason, JSON.stringify(options)).toBe("rate_limited");
    }
    expect(twilioCreate).not.toHaveBeenCalled();
  });
  it("a customer who replied STOP is never texted, even when the owner asks", async () => {
    db.optedOut = true;
    const { sendCancellationSMS } = await load();
    expect(await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, { ownerRequested: true })).toEqual({ sent: false, status: "blocked_optout", reason: "caller_opted_out" });
    expect(twilioCreate).not.toHaveBeenCalled();
  });
  it("the org's 'no customer texts' toggle still wins", async () => {
    db.orgTexts = false;
    const { sendAppointmentConfirmationSMS } = await load();
    expect(await sendAppointmentConfirmationSMS(ORG, "+61414141883", START, "Australia/Sydney", undefined, APPT, { ownerRequested: true, moved: true })).toEqual({ sent: false, status: "skipped", reason: "org_disabled" });
    expect(twilioCreate).not.toHaveBeenCalled();
  });
  it("a plan without SMS still blocks it", async () => {
    db.planOk = false;
    const { sendCancellationSMS } = await load();
    expect(await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, { ownerRequested: true })).toEqual({ sent: false, status: "blocked_plan", reason: "plan_not_eligible" });
    expect(twilioCreate).not.toHaveBeenCalled();
  });
  it("an owner cap that can't be counted holds the text back (fails closed) — recorded as the failed check, not a cap hit", async () => {
    db.ownerError = { code: "57014" };
    const { sendCancellationSMS } = await load();
    // Never "rate_limited": the owner would hear "another text went to them moments ago".
    expect(await sendCancellationSMS(ORG, "+61414141883", START, "Australia/Sydney", APPT, { ownerRequested: true })).toEqual({ sent: false, status: "skipped", reason: "cap_check_failed" });
    expect(twilioCreate).not.toHaveBeenCalled();
    expect(db.upserts.at(-1)).toMatchObject({ status: "skipped_db_error" });
  });
});
