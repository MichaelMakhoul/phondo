import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-442: the public live-demo org (seed 00105) intentionally has NO
// org_members, so any notification dispatched for it used to fail the
// owner-email lookup (Sentry warning) and then throw "0 channels delivered"
// (Sentry-visible error) on every notification-worthy demo call. The senders
// must skip the demo org outright — no DB reads, no Sentry noise, "skipped".

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({
  hasFeatureAccess: vi.fn(async () => true),
}));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: unknown) => void) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() })
  ),
  captureMessage: vi.fn(),
}));
vi.mock("@/lib/security/validation", () => ({
  ssrfSafeFetch: vi.fn(async () => ({ ok: true, status: 200 })),
  escapeHtml: (s: string) => s,
}));

import { createAdminClient } from "@/lib/supabase/admin";
import * as Sentry from "@sentry/nextjs";
import { DEMO_ORG_ID } from "@/lib/demo/config";
import {
  sendMissedCallNotification,
  sendFailedCallNotification,
  sendUnsuccessfulCallNotification,
  sendAppointmentNotification,
  sendCallbackNotification,
  sendCallbackReminderNotification,
  sendDailySummaryNotification,
} from "@/lib/notifications/notification-service";

const CALL = {
  organizationId: DEMO_ORG_ID,
  callId: "call-demo",
  callerPhone: "+61400000000",
  timestamp: new Date("2026-06-15T00:00:00Z"),
};

describe("demo-org notification skip (SCRUM-442)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Any DB access would blow up — proves the skip happens before all reads.
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("demo-org dispatch must not touch the database");
    });
  });

  it("call senders resolve 'skipped' without DB access or Sentry noise", async () => {
    await expect(sendMissedCallNotification(CALL)).resolves.toBe("skipped");
    await expect(
      sendFailedCallNotification({ ...CALL, failureReason: "stt failed" }),
    ).resolves.toBe("skipped");
    await expect(
      sendUnsuccessfulCallNotification({ ...CALL, successEvaluation: "partial" }),
    ).resolves.toBe("skipped");

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("appointment/callback/summary senders resolve 'skipped' too", async () => {
    await expect(
      sendAppointmentNotification({
        organizationId: DEMO_ORG_ID,
        callerPhone: "+61400000000",
        appointmentDate: new Date("2026-06-16T00:00:00Z"),
        appointmentTime: "10:00 AM",
      }),
    ).resolves.toBe("skipped");
    await expect(
      sendCallbackNotification({
        organizationId: DEMO_ORG_ID,
        callerName: "Demo Caller",
        callerPhone: "+61400000000",
        reason: "demo",
        urgency: "normal",
      }),
    ).resolves.toBe("skipped");
    await expect(
      sendCallbackReminderNotification({
        organizationId: DEMO_ORG_ID,
        callerName: "Demo Caller",
        callerPhone: "+61400000000",
        reason: "demo",
        urgency: "normal",
      }),
    ).resolves.toBe("skipped");
    await expect(
      sendDailySummaryNotification({
        organizationId: DEMO_ORG_ID,
        date: new Date("2026-06-15T00:00:00Z"),
        totalCalls: 3,
        answeredCalls: 3,
        missedCalls: 0,
        appointmentsBooked: 1,
        averageCallDuration: 60,
        topCallerIntents: [],
      }),
    ).resolves.toBe("skipped");

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("a real org still goes through the full pipeline (guard is demo-only)", async () => {
    // Restore a working admin so the real-org path can run; prefs row says
    // everything off → legitimate "skipped" via settleChannels, but the DB
    // WAS consulted — proving the demo guard didn't swallow real orgs.
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain,
      eq: chain,
      single: async () => ({
        data: {
          email_on_missed_call: false,
          sms_on_missed_call: false,
          sms_phone_number: null,
          webhook_url: null,
        },
        error: null,
      }),
    });
    vi.mocked(createAdminClient).mockReturnValue({ from: () => builder } as never);

    await expect(
      sendMissedCallNotification({ ...CALL, organizationId: "org-real" }),
    ).resolves.toBe("skipped");
    expect(createAdminClient).toHaveBeenCalled();
  });
});
