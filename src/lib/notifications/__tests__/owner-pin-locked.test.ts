import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-586: the owner-line PIN lockout alert. Security alert ⇒ no preference
// or plan gate; OWNER only (only the owner role can change the PIN); honest
// settle semantics shared with every other owner alert (no owner email ⇒
// NotificationDeliveryError, never a silent "sent").
//
// The lock is 5 tries per 15 minutes (cleared by a correct PIN) plus 20 tries
// per 24 hours (right or wrong); saving a new PIN clears both at once. The
// email copy must say exactly that — never "5 failed attempts in 15 minutes"
// or "clears itself after 15 minutes", which are false for the 24-hour cap.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => true) }));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: unknown) => void) => fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() })),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("@/lib/security/validation", () => ({
  ssrfSafeFetch: vi.fn(async () => ({ ok: true, status: 200 })),
  escapeHtml: (s: string) => s.replace(/</g, "&lt;"),
}));
const resendSend = vi.hoisted(() =>
  vi.fn(async (_message: unknown): Promise<{ data: { id: string } | null; error: { message: string } | null }> => (
    { data: { id: "email-1" }, error: null }
  )),
);
// A class, not vi.fn(() => …): vitest 4 rejects `new` on an arrow-function mock.
vi.mock("resend", () => ({ Resend: class { emails = { send: resendSend }; } }));

import { createAdminClient } from "@/lib/supabase/admin";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { DEMO_ORG_ID } from "@/lib/demo/config";
import { sendOwnerPinLockedNotification, NotificationDeliveryError } from "@/lib/notifications/notification-service";

type SingleResult = { data: Record<string, unknown> | null; error: { message?: string; code?: string } | null };
type Queried = { table: string; eqs: Array<[string, unknown]> };

// Every from(table) the service opens, with its .eq() filters, so the tests can
// pin WHICH rows the alert looks up (owner role only, no preferences row).
let queried: Queried[] = [];

function builder(table: string, result: SingleResult) {
  const record: Queried = { table, eqs: [] };
  queried.push(record);
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain, in: chain, limit: chain, order: chain,
    eq: (col: string, val: unknown) => { record.eqs.push([col, val]); return b; },
    single: async () => result,
    then: (resolve: (v: SingleResult) => unknown) => resolve(result),
  });
  return b;
}
function fakeAdmin(tables: Record<string, SingleResult>) {
  return { from: (table: string) => builder(table, tables[table] ?? { data: null, error: null }) };
}

const ORG = "11111111-2222-4333-a444-555555555555";
// The route hands the sender the time already formatted in the ORG's zone (formatOwnerLockTime).
const data = { organizationId: ORG, callId: "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f", callerPhoneMasked: "04xx xxx 137", localTime: "Thursday 15 October at 3:04 pm" };

type Sent = { from: string; to: string; subject: string; html: string };
const lastSent = () => resendSend.mock.calls[0][0] as Sent;
// The email's visible words: tags dropped, whitespace collapsed to single spaces.
const words = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

beforeEach(() => {
  vi.clearAllMocks();
  queried = [];
  process.env.EMAIL_API_KEY = "re_test";
  process.env.EMAIL_FROM = "notifications@phondo.ai";
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({
    org_members: { data: { user_id: "user-owner" }, error: null },
    user_profiles: { data: { email: "owner@example.com" }, error: null },
  }) as any);
});

describe("sendOwnerPinLockedNotification (SCRUM-586)", () => {
  it("emails the OWNER once with the locked-PIN subject and the masked number", async () => {
    const result = await sendOwnerPinLockedNotification(data);
    expect(result).toBe("sent");
    expect(resendSend).toHaveBeenCalledTimes(1);
    const sent = lastSent();
    expect(sent.from).toBe("notifications@phondo.ai");
    expect(sent.to).toBe("owner@example.com");
    expect(sent.subject).toBe("Your assistant line PIN is locked");
    expect(sent.html).toContain("04xx xxx 137");
  });

  it("tells the owner what really happened and how to undo it (5/15min + 20/24h lock, new PIN unlocks)", async () => {
    await sendOwnerPinLockedNotification(data);
    const text = words(lastSent().html);
    expect(text).toContain(
      "Someone rang your assistant line from 04xx xxx 137 on Thursday 15 October at 3:04 pm and entered the wrong PIN too many times, so the owner line is locked.",
    );
    expect(text).toContain(
      "If this wasn't you, set a new PIN in Settings → Your assistant line: that unlocks it straight away and the old PIN stops working.",
    );
    expect(text).toContain(
      "If it was you, it unlocks by itself after 15 minutes (or after 24 hours if there were too many tries in one day). Until then, calls from that number are answered as normal customer calls.",
    );
  });

  it("quotes the org-local time it is handed verbatim — it formats no clock of its own, so it can never fall back to server time", async () => {
    await sendOwnerPinLockedNotification({ ...data, localTime: "Friday 2 January at 9:15 am" });
    expect(words(lastSent().html)).toContain("from 04xx xxx 137 on Friday 2 January at 9:15 am and entered");
    expect(lastSent().html).not.toContain("Thursday 15 October");
  });

  it("never states the old, wrong lock rule", async () => {
    await sendOwnerPinLockedNotification(data);
    const text = words(lastSent().html);
    expect(text).not.toContain("5 failed attempts in 15 minutes");
    expect(text).not.toContain("clears itself after 15 minutes");
  });

  it("promises no caller-facing text message (customer SMS is paused, SCRUM-264)", async () => {
    await sendOwnerPinLockedNotification(data);
    expect(words(lastSent().html)).not.toMatch(/\bsms\b|text message/i);
  });

  it("is a security alert: looks up the OWNER's row only, with no preference or plan gate", async () => {
    await sendOwnerPinLockedNotification(data);
    expect(queried.map((q) => q.table)).toEqual(["org_members", "user_profiles"]); // never notification_preferences
    expect(queried[0].eqs).toEqual([["organization_id", ORG], ["role", "owner"]]); // not admins
    expect(hasFeatureAccess).not.toHaveBeenCalled();
  });

  it("throws NotificationDeliveryError (0 delivered) when the org has no owner email — never a silent 'sent'", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ org_members: { data: null, error: { message: "0 rows", code: "PGRST116" } } }) as any);
    const err = await sendOwnerPinLockedNotification(data).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotificationDeliveryError);
    expect((err as NotificationDeliveryError).deliveredCount).toBe(0);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("throws NotificationDeliveryError when Resend rejects", async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { message: "invalid to" } });
    await expect(sendOwnerPinLockedNotification(data)).rejects.toBeInstanceOf(NotificationDeliveryError);
  });

  it("skips the demo org (no members to notify)", async () => {
    expect(await sendOwnerPinLockedNotification({ ...data, organizationId: DEMO_ORG_ID })).toBe("skipped");
    expect(resendSend).not.toHaveBeenCalled();
    expect(queried).toEqual([]); // not even an owner lookup
  });
});
