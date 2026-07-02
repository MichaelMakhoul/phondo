import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-419 (audit finding #21): an owner-email lookup failure used to
// silently remove the only notification channel — Promise.allSettled([])
// resolved cleanly and the caller reported "sent" with ZERO channels
// delivered. These tests pin the honest-reporting contract:
//   wanted-but-unavailable + nothing else => REJECT (caller records failure)
//   everything disabled by preference     => resolve (legitimate no-op)
//   email dropped but another channel ok  => resolve (degrade per-channel)

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
// These tests assume a fully ENTITLED org — send-time plan gating (SCRUM-423)
// is exercised separately in plan-gating.test.ts.
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
import { ssrfSafeFetch } from "@/lib/security/validation";
import {
  sendMissedCallNotification,
  getOrganizationOwnerEmail,
  getNotificationPreferences,
} from "@/lib/notifications/notification-service";

type SingleResult = { data: Record<string, unknown> | null; error: { message?: string; code?: string } | null };

// Thenable query builder: chained methods return self; .single() resolves
// to the configured per-table result.
function builder(result: SingleResult) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain, eq: chain, in: chain, limit: chain, order: chain,
    single: async () => result,
    // Multi-row queries await the builder directly (no .single()) — e.g. the
    // owner+admin recipient lookup (SCRUM-497). Same configured result.
    then: (resolve: (v: SingleResult) => unknown) => resolve(result),
  });
  return b;
}

function fakeAdmin(tables: Record<string, SingleResult>) {
  return {
    from: (table: string) => builder(tables[table] ?? { data: null, error: null }),
  };
}

const PREFS_EMAIL_ONLY = {
  data: {
    email_on_missed_call: true,
    sms_on_missed_call: false,
    sms_phone_number: null,
    webhook_url: null,
  },
  error: null,
};

describe("owner-email channel drop honesty (SCRUM-419)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("REJECTS when the owner-email lookup fails and no other channel exists", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: PREFS_EMAIL_ONLY,
        org_members: { data: null, error: { message: "db down" } },
      }) as never,
    );

    await expect(
      sendMissedCallNotification({
        organizationId: "org-1",
        callId: "call-1",
        callerPhone: "+61400000000",
        timestamp: new Date("2026-06-15T00:00:00Z"),
      }),
    ).rejects.toThrow(/0 notification channels delivered.*owner-email/);
  });

  it("REJECTS when the org simply has no owner member (data state, not just DB error)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: PREFS_EMAIL_ONLY,
        org_members: { data: null, error: null },
      }) as never,
    );

    await expect(
      sendMissedCallNotification({
        organizationId: "org-1",
        callId: "call-1",
        callerPhone: "+61400000000",
        timestamp: new Date("2026-06-15T00:00:00Z"),
      }),
    ).rejects.toThrow(/0 notification channels delivered/);
  });

  it("resolves when every channel is disabled by preference (legitimate no-op)", async () => {
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
        // Owner lookup fails too — but email wasn't wanted, so no false failure.
        org_members: { data: null, error: { message: "db down" } },
      }) as never,
    );

    await expect(
      sendMissedCallNotification({
        organizationId: "org-1",
        callId: "call-1",
        callerPhone: "+61400000000",
        timestamp: new Date("2026-06-15T00:00:00Z"),
      }),
    ).resolves.toBe("skipped"); // honest no-op reporting (SCRUM-442)
    // Email wasn't wanted, so the owner lookup must not even run — no Sentry noise.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("REJECTS when SMS is wanted but unconfigured and no other channel exists", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: {
          data: {
            email_on_missed_call: false,
            sms_on_missed_call: true, // wanted...
            sms_phone_number: null,   // ...but no number to send to
            webhook_url: null,
          },
          error: null,
        },
      }) as never,
    );

    await expect(
      sendMissedCallNotification({
        organizationId: "org-1",
        callId: "call-1",
        callerPhone: "+61400000000",
        timestamp: new Date("2026-06-15T00:00:00Z"),
      }),
    ).rejects.toThrow(/0 notification channels delivered.*sms/);
  });

  it("getNotificationPreferences fails OPEN to email-on defaults on a real DB error", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: { data: null, error: { message: "timeout", code: "57014" } },
      }) as never,
    );

    const prefs = await getNotificationPreferences("org-1");
    expect(prefs).not.toBeNull(); // previously null — silently skipped appointment/daily senders
    expect(prefs!.email_on_missed_call).toBe(true);
    expect(prefs!.email_daily_summary).toBe(true);
    expect(prefs!.sms_on_missed_call).toBe(false); // unknown number — SMS stays off
  });

  it("getNotificationPreferences still returns null for a genuinely missing row (PGRST116)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: { data: null, error: { message: "no rows", code: "PGRST116" } },
      }) as never,
    );

    expect(await getNotificationPreferences("org-1")).toBeNull();
  });

  it("degrades per-channel: email dropped but webhook delivers → resolves", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: {
          data: {
            email_on_missed_call: true,
            sms_on_missed_call: false,
            sms_phone_number: null,
            webhook_url: "https://hooks.example.com/x",
          },
          error: null,
        },
        org_members: { data: null, error: { message: "db down" } },
      }) as never,
    );

    await expect(
      sendMissedCallNotification({
        organizationId: "org-1",
        callId: "call-1",
        callerPhone: "+61400000000",
        timestamp: new Date("2026-06-15T00:00:00Z"),
      }),
    ).resolves.toBe("sent"); // something was attempted and delivered
    expect(ssrfSafeFetch).toHaveBeenCalledTimes(1); // the webhook actually went out
  });

  it("getOrganizationOwnerEmail surfaces lookup failures to Sentry", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: { data: null, error: { message: "db down" } },
      }) as never,
    );

    const email = await getOrganizationOwnerEmail("org-1");
    expect(email).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/owner-email lookup failed/i),
    );
  });

  it("getOrganizationOwnerEmail surfaces no-owner and no-email states to Sentry too", async () => {
    // No owner member
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ org_members: { data: null, error: null } }) as never,
    );
    expect(await getOrganizationOwnerEmail("org-1")).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);

    // Owner exists but profile has no email
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: { data: { user_id: "user-1" }, error: null },
        user_profiles: { data: { email: null }, error: null },
      }) as never,
    );
    expect(await getOrganizationOwnerEmail("org-1")).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
  });

  it("returns the owner email on the happy path with no Sentry noise", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: { data: { user_id: "user-1" }, error: null },
        user_profiles: { data: { email: "owner@biz.com.au" }, error: null },
      }) as never,
    );

    expect(await getOrganizationOwnerEmail("org-1")).toBe("owner@biz.com.au");
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
