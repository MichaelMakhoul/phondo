import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-608: the plan-usage heads-up. The owner at 125% and 150% of the plan's calls this
// billing period (customer calls AND the owner's own chats count); the Phondo team too at
// 150%. Nothing is cut off, so the copy must never say anything is. Honest settle: no owner
// email and no team email ⇒ NotificationDeliveryError, never a silent "sent".

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => true) }));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: unknown) => void) => fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() })),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("@/lib/security/validation", () => ({
  ssrfSafeFetch: vi.fn(async () => ({ ok: true, status: 200 })),
  escapeHtml: (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
}));
const resendSend = vi.hoisted(() =>
  vi.fn(async (_message: unknown): Promise<{ data: { id: string } | null; error: { message: string } | null }> => ({ data: { id: "email-1" }, error: null })),
);
vi.mock("resend", () => ({ Resend: class { emails = { send: resendSend }; } }));

import { createAdminClient } from "@/lib/supabase/admin";
import { DEMO_ORG_ID } from "@/lib/demo/config";
import { sendPlanUsageAlertNotification, NotificationDeliveryError } from "@/lib/notifications/notification-service";

type SingleResult = { data: Record<string, unknown> | null; error: { message?: string; code?: string } | null };
function builder(result: SingleResult) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, { select: chain, in: chain, limit: chain, order: chain, eq: chain, single: async () => result, then: (resolve: (v: SingleResult) => unknown) => resolve(result) });
  return b;
}
function fakeAdmin(tables: Record<string, SingleResult>) {
  return { from: (table: string) => builder(tables[table] ?? { data: null, error: null }) };
}

const ORG = "11111111-2222-4333-a444-555555555555";
const PERIOD_END = new Date("2026-11-20T13:00:00.000Z"); // 21 November in Sydney
const base = { organizationId: ORG, callsLimit: 150, planName: "Starter", periodEnd: PERIOD_END };
type Sent = { to: string; subject: string; html: string };
const sent = () => resendSend.mock.calls.map((c) => c[0] as Sent);
const words = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EMAIL_API_KEY = "re_test";
  process.env.EMAIL_FROM = "notifications@phondo.ai";
  process.env.ADMIN_ALERT_EMAIL = "team@phondo.ai";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.phondo.ai";
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({
    org_members: { data: { user_id: "user-owner" }, error: null },
    user_profiles: { data: { email: "owner@example.com" }, error: null },
  }) as any);
});

describe("sendPlanUsageAlertNotification (SCRUM-608)", () => {
  it("at 125%: the owner only — how many calls, that both kinds count, that nothing is cut off, when it resets, and where to see plans", async () => {
    expect(await sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188 })).toBe("sent");
    expect(sent()).toHaveLength(1);
    const owner = sent()[0];
    expect(owner.to).toBe("owner@example.com");
    expect(owner.subject).toBe("You've used 125% of your plan's calls this month");
    const text = words(owner.html);
    expect(text).toContain("Your receptionist has handled 188 calls this billing period on the Starter plan, which includes 150. That counts customer calls and your own chats with your assistant.");
    expect(text).toContain("Nothing has been cut off — your receptionist keeps answering every call. The count starts again on 21 November 2026.");
    expect(owner.html).toContain('<a href="https://app.phondo.ai/billing">see plans</a>');
    expect(text).not.toContain("Phondo team know");
  });

  it("at 150%: the owner hears the team knows, and the team gets its own email with the org id", async () => {
    expect(await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 })).toBe("sent");
    const [owner, team] = sent();
    expect(owner.to).toBe("owner@example.com");
    expect(owner.subject).toBe("You've used 153% of your plan's calls this month");
    expect(words(owner.html)).toContain("We've let the Phondo team know too — reply to this email if you'd like a hand choosing.");
    expect(team.to).toBe("team@phondo.ai");
    expect(team.subject).toBe("[Phondo] An org is at 153% of its Starter plan");
    expect(words(team.html)).toContain(`Org ${ORG} has used 230 of 150 calls this period on the Starter plan (customer calls plus owner-assistant chats).`);
    expect(words(team.html)).toContain("Nothing is cut off. The owner has been emailed with an upgrade link.");
  });

  it("at 150% with no team address configured: the owner is still told — the missing channel is reported, not hidden", async () => {
    delete process.env.ADMIN_ALERT_EMAIL;
    expect(await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 })).toBe("sent");
    expect(sent().map((s) => s.to)).toEqual(["owner@example.com"]);
  });

  it("no owner email (and 125%: no team either) is a failed send, never a silent 'sent'", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ org_members: { data: null, error: null } }) as any);
    await expect(sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188 })).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("the plan name is escaped — it reaches HTML", async () => {
    await sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188, planName: "<b>Starter</b>" });
    expect(sent()[0].html).toContain("&lt;b&gt;Starter&lt;/b&gt;");
    expect(sent()[0].html).not.toContain("<b>Starter</b>");
  });

  it("on a trial, it says when the trial ends — not that the count starts again", async () => {
    await sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188, trial: true });
    const text = words(sent()[0].html);
    expect(text).toContain("Nothing has been cut off — your receptionist keeps answering every call. Your trial ends on 21 November 2026.");
    expect(text).not.toContain("The count starts again");
  });

  it("the demo org is skipped (no members to tell)", async () => {
    expect(await sendPlanUsageAlertNotification({ ...base, organizationId: DEMO_ORG_ID, level: 150, callsUsed: 230 })).toBe("skipped");
    expect(resendSend).not.toHaveBeenCalled();
  });
});
