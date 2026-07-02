import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

// SCRUM-447: settleChannels' failures used to be plain Errors whose MESSAGES
// the crons string-matched ("0 notification channels delivered" = permanent;
// "N/M channels failed" parsed for partial delivery). These tests pin the
// typed contract — NotificationDeliveryError fields — exercised through the
// public senders, plus the new config-absence classification:
//   credential ABSENT  => permanent + Sentry error page (deploy misconfig)
//   credential INVALID => transient (provider rejects; a retry could succeed
//                         once the value is corrected — env is present)

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

const webhookState = vi.hoisted(() => ({ ok: true, status: 200 }));
vi.mock("@/lib/security/validation", () => ({
  ssrfSafeFetch: vi.fn(async () => ({ ok: webhookState.ok, status: webhookState.status })),
  escapeHtml: (s: string) => s,
}));

// Resend mock — `result.error` drives the transient-provider-failure branch.
const resendState = vi.hoisted(() => ({
  result: { error: null } as { error: { message: string } | null },
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => resendState.result };
  },
}));
vi.mock("twilio", () => ({ default: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import * as Sentry from "@sentry/nextjs";
import { ssrfSafeFetch } from "@/lib/security/validation";
import {
  sendMissedCallNotification,
  NotificationDeliveryError,
} from "@/lib/notifications/notification-service";

type SingleResult = { data: Record<string, unknown> | null; error: { message?: string; code?: string } | null };

// Thenable query builder: chained methods return self; .single() resolves
// to the configured per-table result (same shape as owner-email-channel-drop).
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

const prefsRow = (over: Record<string, unknown> = {}): SingleResult => ({
  data: {
    email_on_missed_call: true,
    sms_on_missed_call: false,
    sms_phone_number: null,
    webhook_url: null,
    ...over,
  },
  error: null,
});

// Array shapes: the recipient lookup is multi-row (owner + admins, SCRUM-497).
const OWNER_OK = {
  org_members: { data: [{ user_id: "user-1", role: "owner" }] as never, error: null },
  user_profiles: { data: [{ id: "user-1", email: "owner@biz.com.au" }] as never, error: null },
};

const CALL = {
  organizationId: "org-1",
  callId: "call-1",
  callerPhone: "+61400000000",
  timestamp: new Date("2026-06-15T00:00:00Z"),
};

async function rejection(promise: Promise<unknown>): Promise<NotificationDeliveryError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(NotificationDeliveryError);
    return err as NotificationDeliveryError;
  }
  throw new Error("expected the send to reject");
}

const ORIGINAL_EMAIL_KEY = process.env.EMAIL_API_KEY;

beforeAll(() => {
  process.env.EMAIL_API_KEY = "test-key";
});
afterAll(() => {
  if (ORIGINAL_EMAIL_KEY === undefined) delete process.env.EMAIL_API_KEY;
  else process.env.EMAIL_API_KEY = ORIGINAL_EMAIL_KEY;
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EMAIL_API_KEY = "test-key";
  resendState.result = { error: null };
  webhookState.ok = true;
  webhookState.status = 200;
});

describe("NotificationDeliveryError typed contract (SCRUM-447)", () => {
  it("wanted-channel-unavailable: permanent=true, deliveredCount=0, message text preserved", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: prefsRow(),
        org_members: { data: null, error: { message: "db down" } },
      }) as never,
    );

    const err = await rejection(sendMissedCallNotification(CALL));
    expect(err.permanent).toBe(true);
    expect(err.permanentCause).toBe("org-config"); // claim-holders abandon — no env fix can help
    expect(err.deliveredCount).toBe(0);
    expect(err.wantedCount).toBe(1);
    // The crons used to regex this exact text — keep it stable for logs.
    expect(err.message).toMatch(/0 notification channels delivered.*owner-email/);
  });

  it("EMAIL_API_KEY absent: permanent=true + Sentry config-absence page", async () => {
    delete process.env.EMAIL_API_KEY;
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ notification_preferences: prefsRow(), ...OWNER_OK }) as never,
    );

    const err = await rejection(sendMissedCallNotification(CALL));
    expect(err.permanent).toBe(true);
    expect(err.permanentCause).toBe("credential-absence"); // claim-holders release — env fix makes retries succeed
    expect(err.deliveredCount).toBe(0);
    expect(err.wantedCount).toBe(1);
    expect(err.message).toMatch(/1\/1 notification channels failed/);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/credentials absent/i),
    );
  });

  it("EMAIL_API_KEY absent but webhook delivers: deliveredCount=1, still permanent", async () => {
    delete process.env.EMAIL_API_KEY;
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: prefsRow({ webhook_url: "https://hooks.example.com/x" }),
        ...OWNER_OK,
      }) as never,
    );

    const err = await rejection(sendMissedCallNotification(CALL));
    // Email can never go out until env is fixed, but the webhook DID deliver
    // — a claim-holder must not release/retry (would double the webhook).
    expect(err.permanent).toBe(true);
    expect(err.permanentCause).toBe("credential-absence");
    expect(err.deliveredCount).toBe(1);
    expect(err.wantedCount).toBe(2);
    expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
  });

  it("provider-side email failure (key present): transient, not permanent", async () => {
    resendState.result = { error: { message: "invalid api key" } };
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ notification_preferences: prefsRow(), ...OWNER_OK }) as never,
    );

    const err = await rejection(sendMissedCallNotification(CALL));
    expect(err.permanent).toBe(false); // mis-SET key stays retryable
    expect(err.permanentCause).toBeNull();
    expect(err.deliveredCount).toBe(0);
    expect(err.message).toMatch(/1\/1 notification channels failed/);
    // No config-absence page — the env var IS present.
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
      expect.stringMatching(/credentials absent/i),
    );
  });

  it("partial transient: email delivers, webhook 500 → deliveredCount=1, permanent=false", async () => {
    webhookState.ok = false;
    webhookState.status = 500;
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: prefsRow({ webhook_url: "https://hooks.example.com/x" }),
        ...OWNER_OK,
      }) as never,
    );

    const err = await rejection(sendMissedCallNotification(CALL));
    expect(err.permanent).toBe(false);
    expect(err.deliveredCount).toBe(1);
    expect(err.wantedCount).toBe(2);
    expect(err.message).toMatch(/1\/2 notification channels failed/);
  });

  it("mixed config-absent + transient failure: NOT permanent (a retry could deliver the transient channel)", async () => {
    delete process.env.EMAIL_API_KEY; // email permanently down
    webhookState.ok = false; // webhook transiently down
    webhookState.status = 503;
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        notification_preferences: prefsRow({ webhook_url: "https://hooks.example.com/x" }),
        ...OWNER_OK,
      }) as never,
    );

    const err = await rejection(sendMissedCallNotification(CALL));
    expect(err.permanent).toBe(false);
    expect(err.permanentCause).toBeNull();
    expect(err.deliveredCount).toBe(0);
    // The config absence still pages even though the overall error is transient.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/credentials absent/i),
    );
  });

  it("full success still resolves 'sent' (no typed error on the happy path)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ notification_preferences: prefsRow(), ...OWNER_OK }) as never,
    );

    await expect(sendMissedCallNotification(CALL)).resolves.toBe("sent");
  });
});
