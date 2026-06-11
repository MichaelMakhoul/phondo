import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-423 (audit finding #13): plan gating must hold at SEND time — a
// prefs row written before the write-time gate existed (or while the org was
// on a higher plan) must not keep Professional channels (owner-alert SMS,
// legacy prefs webhook) after a downgrade.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn() }));
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
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { ssrfSafeFetch } from "@/lib/security/validation";
import { sendMissedCallNotification } from "@/lib/notifications/notification-service";

type SingleResult = { data: Record<string, unknown> | null; error: { message?: string; code?: string } | null };

function builder(result: SingleResult) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain, eq: chain, in: chain, limit: chain, order: chain,
    single: async () => result,
  });
  return b;
}

function fakeAdmin(tables: Record<string, SingleResult>) {
  return {
    from: (table: string) => builder(tables[table] ?? { data: null, error: null }),
  };
}

const CALL = {
  organizationId: "org-1",
  callId: "call-1",
  callerPhone: "+61400000000",
  timestamp: new Date("2026-06-15T00:00:00Z"),
};

describe("send-time plan gating (SCRUM-423)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("strips owner-alert SMS when the plan lacks smsNotifications (resolves, nothing attempted)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: {
          data: {
            email_on_missed_call: false,
            sms_on_missed_call: true,          // wanted by prefs...
            sms_phone_number: "+61499999999",  // ...and configured
            webhook_url: null,
          },
          error: null,
        },
      }) as never,
    );
    vi.mocked(hasFeatureAccess).mockResolvedValue(false); // Starter org

    // Entitlement strip → nothing wanted → clean no-op. If the SMS channel
    // were attempted it would REJECT (no Twilio creds in test env).
    await expect(sendMissedCallNotification(CALL)).resolves.toBe("skipped");
    expect(hasFeatureAccess).toHaveBeenCalledWith("org-1", "smsNotifications");
  });

  it("keeps owner-alert SMS for an entitled org (channel attempted)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: {
          data: {
            email_on_missed_call: false,
            sms_on_missed_call: true,
            sms_phone_number: "+61499999999",
            webhook_url: null,
          },
          error: null,
        },
      }) as never,
    );
    vi.mocked(hasFeatureAccess).mockResolvedValue(true); // Professional org

    // Twilio creds are absent in the test env, so an ATTEMPTED SMS channel
    // fails — the rejection is the proof the gate let it through.
    await expect(sendMissedCallNotification(CALL)).rejects.toThrow(/channels failed/);
  });

  it("strips the legacy prefs webhook when the plan lacks webhookIntegrations", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: {
          data: {
            email_on_missed_call: false,
            sms_on_missed_call: false,
            sms_phone_number: null,
            webhook_url: "https://hooks.example.com/x",
          },
          error: null,
        },
      }) as never,
    );
    vi.mocked(hasFeatureAccess).mockResolvedValue(false);

    await expect(sendMissedCallNotification(CALL)).resolves.toBe("skipped");
    expect(ssrfSafeFetch).not.toHaveBeenCalled(); // webhook never fired
    expect(hasFeatureAccess).toHaveBeenCalledWith("org-1", "webhookIntegrations");
  });

  it("delivers the webhook for an entitled org", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: {
          data: {
            email_on_missed_call: false,
            sms_on_missed_call: false,
            sms_phone_number: null,
            webhook_url: "https://hooks.example.com/x",
          },
          error: null,
        },
      }) as never,
    );
    vi.mocked(hasFeatureAccess).mockResolvedValue(true);

    await expect(sendMissedCallNotification(CALL)).resolves.toBe("sent");
    expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
  });

  it("does not consult billing at all when no gated channel is configured", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: {
          data: {
            email_on_missed_call: false,
            sms_on_missed_call: false,
            sms_phone_number: null,
            webhook_url: null,
          },
          error: null,
        },
      }) as never,
    );

    await expect(sendMissedCallNotification(CALL)).resolves.toBe("skipped");
    expect(hasFeatureAccess).not.toHaveBeenCalled();
  });
});
