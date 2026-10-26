import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-597: no customer text of any kind goes to an AU landline or a 13/1300/1800
// number — the numbering plan says so for free. Recorded as skipped_no_contact, and
// never reaches Twilio. CALLER_SMS_ENABLED is read at module load, so each case
// loads a fresh copy of the module with the env it needs.

const upserts: Array<{ row: Record<string, unknown>; opts: unknown }> = [];
const twilioCreate = vi.fn();

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), withScope: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({ getNotificationPreferences: vi.fn(async () => null) }));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => true) }));
vi.mock("@/lib/twilio/client", () => ({ getTwilioClient: () => ({ messages: { create: twilioCreate } }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: any = {
        select: () => b,
        eq: () => b,
        gte: () => b,
        in: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () =>
          table === "organizations"
            ? { data: { business_name: "Copperline Plumbing", business_phone: "+61257015064", timezone: "Australia/Sydney" }, error: null }
            : { data: null, error: null },
        upsert: async (row: Record<string, unknown>, opts: unknown) => {
          upserts.push({ row, opts });
          return { error: null };
        },
        insert: async () => ({ error: null }),
      };
      return b;
    },
  }),
}));

const ORG = "11111111-2222-4333-a444-555555555555";
const APPT = "44444444-5555-4666-8777-888888888888";
const START = new Date("2026-10-16T23:00:00Z");

async function loadCallerSms(smsEnabled: boolean) {
  vi.resetModules();
  if (smsEnabled) process.env.CALLER_SMS_ENABLED = "true";
  else delete process.env.CALLER_SMS_ENABLED;
  return import("../caller-sms");
}

beforeEach(() => {
  upserts.length = 0;
  twilioCreate.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CALLER_SMS_ENABLED;
});

describe("sendCallerSMS: never text a number that can't take one", () => {
  it("an AU landline cancellation is skipped as not_mobile, recorded skipped_no_contact, and never sent", async () => {
    const { sendCancellationSMS } = await loadCallerSms(true);
    const r = await sendCancellationSMS(ORG, "+61295551234", START, "Australia/Sydney", APPT);
    expect(r).toEqual({ sent: false, status: "skipped", reason: "not_mobile" });
    expect(twilioCreate).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].row).toMatchObject({
      organization_id: ORG, appointment_id: APPT, channel: "sms", recipient: "+61295551234", status: "skipped_no_contact",
    });
    // The intent lives in the idempotency key (appointment:channel:intent:start).
    expect(upserts[0].row.idempotency_key).toBe(`${APPT}:sms:cancellation:${START.toISOString()}`);
  });

  it("13/1300/1800 numbers are skipped the same way (a confirmation, here)", async () => {
    const { sendAppointmentConfirmationSMS } = await loadCallerSms(true);
    for (const n of ["+61130055", "+611300123456", "+611800123456"]) {
      expect(await sendAppointmentConfirmationSMS(ORG, n, START, "Australia/Sydney", undefined, APPT)).toEqual({ sent: false, status: "skipped", reason: "not_mobile" });
    }
    expect(twilioCreate).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(3);
    expect(upserts.every((u) => u.row.status === "skipped_no_contact" && String(u.row.idempotency_key).includes(":sms:confirmation:"))).toBe(true);
  });

  it("an AU mobile and a NANP number get past this guard (later gates decide)", async () => {
    const { sendCancellationSMS } = await loadCallerSms(true);
    for (const n of ["+61414141883", "+14155551234"]) {
      const r = await sendCancellationSMS(ORG, n, START, "Australia/Sydney", APPT);
      expect(r.reason).not.toBe("not_mobile");
    }
  });

  it("the global pause still comes first: a paused landline reads sms_globally_paused", async () => {
    const { sendCancellationSMS } = await loadCallerSms(false);
    expect(await sendCancellationSMS(ORG, "+61295551234", START, "Australia/Sydney", APPT)).toEqual({ sent: false, status: "skipped", reason: "sms_globally_paused" });
    expect(upserts[0].row.status).toBe("skipped_disabled");
  });
});

describe("sendCallerSMS: stored numbers come formatted", () => {
  it("a mobile written with spaces is a mobile (not 'other'); formatted and national landlines are still skipped", async () => {
    const { sendCancellationSMS } = await loadCallerSms(true);
    const mobile = await sendCancellationSMS(ORG, "+61 412 345 678", START, "Australia/Sydney", APPT);
    expect(mobile.reason).not.toBe("not_mobile");
    for (const landline of ["+61 2 9555 1234", "(02) 9555 1234", "02 9555 1234 "]) {
      upserts.length = 0;
      expect(await sendCancellationSMS(ORG, landline, START, "Australia/Sydney", APPT), landline).toEqual({ sent: false, status: "skipped", reason: "not_mobile" });
      expect(upserts[0]?.row.status).toBe("skipped_no_contact");
    }
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it("a NANP national number isn't read as AU, so it isn't guarded (later gates decide)", async () => {
    const { sendCancellationSMS } = await loadCallerSms(true);
    expect((await sendCancellationSMS(ORG, "415-555-1234", START, "Australia/Sydney", APPT)).reason).not.toBe("not_mobile");
  });
});

// SCRUM-597 (test lens N5): the guard covers every customer text, not just booking texts.
describe("sendCallerSMS: the landline guard on a missed-call text-back", () => {
  it("a missed-call text-back to an AU landline is skipped as not_mobile and never sent", async () => {
    const { sendMissedCallTextBack } = await loadCallerSms(true);
    expect(await sendMissedCallTextBack(ORG, "+61295551234")).toEqual({ sent: false, status: "skipped", reason: "not_mobile" });
    expect(twilioCreate).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0); // no booking, no confirmation row
  });
});
