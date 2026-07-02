import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

// SCRUM-497 review P2: Resend treats a multi-recipient `to` as ONE email, so a
// single malformed admin address used to 422 the whole send — owner included.
// sendEmail now fans out per recipient: the channel succeeds when at least one
// recipient is reached, and throws only when nobody is.

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

// Per-recipient Resend mock: addresses containing "bad" fail validation.
const sendCalls = vi.hoisted(() => ({ recipients: [] as string[] }));
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async ({ to }: { to: string }) => {
        sendCalls.recipients.push(to);
        return to.includes("bad")
          ? { error: { message: "Invalid `to` address" } }
          : { error: null };
      },
    };
  },
}));
vi.mock("twilio", () => ({ default: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { sendMissedCallNotification } from "@/lib/notifications/notification-service";

type QueryResult = { data: unknown; error: { message?: string } | null };

function builder(result: QueryResult) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain, eq: chain, in: chain, limit: chain, order: chain,
    single: async () => result,
    then: (resolve: (v: QueryResult) => unknown) => resolve(result),
  });
  return b;
}

function fakeAdmin(tables: Record<string, QueryResult>) {
  return {
    from: (table: string) => builder(tables[table] ?? { data: null, error: null }),
  };
}

const PREFS_EMAIL_ONLY: QueryResult = {
  data: {
    email_on_missed_call: true,
    sms_on_missed_call: false,
    sms_phone_number: null,
    webhook_url: null,
  },
  error: null,
};

function orgWithRecipients(emails: Array<{ id: string; email: string; role: string }>) {
  return fakeAdmin({
    notification_preferences: PREFS_EMAIL_ONLY,
    org_members: {
      data: emails.map((e) => ({ user_id: e.id, role: e.role })),
      error: null,
    },
    user_profiles: {
      data: emails.map((e) => ({ id: e.id, email: e.email })),
      error: null,
    },
  });
}

const CALL = {
  organizationId: "org-1",
  callId: "call-1",
  callerPhone: "+61400000000",
  timestamp: new Date("2026-07-02T00:00:00Z"),
};

const ORIGINAL_EMAIL_KEY = process.env.EMAIL_API_KEY;
beforeAll(() => { process.env.EMAIL_API_KEY = "test-key"; });
afterAll(() => {
  if (ORIGINAL_EMAIL_KEY === undefined) delete process.env.EMAIL_API_KEY;
  else process.env.EMAIL_API_KEY = ORIGINAL_EMAIL_KEY;
});
beforeEach(() => {
  vi.clearAllMocks();
  sendCalls.recipients = [];
});

describe("sendEmail per-recipient fan-out (SCRUM-497 review P2)", () => {
  it("one bad admin address does NOT take down the owner's alert", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      orgWithRecipients([
        { id: "u-owner", email: "owner@biz.com", role: "owner" },
        { id: "u-admin", email: "bad@", role: "admin" },
      ]) as never,
    );

    await expect(sendMissedCallNotification(CALL)).resolves.toBe("sent");
    expect(sendCalls.recipients).toEqual(["owner@biz.com", "bad@"]); // one send per recipient
  });

  it("throws (channel failure) only when EVERY recipient fails", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      orgWithRecipients([
        { id: "u-owner", email: "bad-owner@", role: "owner" },
        { id: "u-admin", email: "bad-admin@", role: "admin" },
      ]) as never,
    );

    await expect(sendMissedCallNotification(CALL)).rejects.toThrow(/channels failed/);
  });

  it("single-recipient behavior unchanged: a provider failure still fails the channel", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      orgWithRecipients([{ id: "u-owner", email: "bad-owner@", role: "owner" }]) as never,
    );

    await expect(sendMissedCallNotification(CALL)).rejects.toThrow(/channels failed/);
  });
});
