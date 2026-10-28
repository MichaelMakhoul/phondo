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
type Sent = { to: string; subject: string; html: string; replyTo?: string };
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
    const owner = sent().find((m) => m.to === "owner@example.com")!;
    const team = sent().find((m) => m.to === "team@phondo.ai")!;
    expect(sent().map((m) => m.to)).toEqual(["team@phondo.ai", "owner@example.com"]); // the team first, so the owner's line is true
    expect(owner.to).toBe("owner@example.com");
    expect(owner.subject).toBe("You've used 153% of your plan's calls this month");
    expect(words(owner.html)).toContain("We've let the Phondo team know too — reply to this email if you'd like a hand choosing.");
    expect(team.to).toBe("team@phondo.ai");
    expect(team.subject).toBe("[Phondo] An org is at 153% of its Starter plan");
    expect(words(team.html)).toContain(`Org ${ORG} has used 230 of 150 calls this period on the Starter plan (customer calls plus owner-assistant chats).`);
    expect(words(team.html)).toContain("Nothing is cut off. The owner is being emailed with an upgrade link.");
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

  // Mutation lens gap: the owner was told "we've let the Phondo team know" even when nobody had been.
  it("the owner hears the team knows ONLY when the team email went: no team address, or a failed team send, and the line is left out", async () => {
    delete process.env.ADMIN_ALERT_EMAIL;
    await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 });
    expect(words(sent()[0].html)).not.toContain("Phondo team know");
    resendSend.mockClear();
    process.env.ADMIN_ALERT_EMAIL = "team@phondo.ai";
    resendSend.mockImplementationOnce(async () => ({ data: null, error: { message: "team inbox bounced" } }));
    await expect(sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 })).rejects.toBeInstanceOf(NotificationDeliveryError);
    const owner = sent().find((m) => m.to === "owner@example.com");
    expect(owner).toBeDefined();
    expect(words(owner!.html)).not.toContain("Phondo team know");
  });

  it("the team hears when the owner has no email on file — they can't have been told", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ org_members: { data: null, error: null } }) as any);
    await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 });
    expect(sent().map((m) => m.to)).toEqual(["team@phondo.ai"]);
    expect(words(sent()[0].html)).toContain("The owner has no email address on file, so they haven't been told.");
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

// SCRUM-608 review (independent mutation run): channel and copy behaviour the tests above
// leave open. Each passes on the real code and fails on the mutant named above it.
describe("sendPlanUsageAlertNotification (SCRUM-608) — review killers", () => {
  // kills: the missing team address not pushed to droppedChannels (the test above only checks "sent")
  it("at 150% with no team address, the dropped team channel is actually reported (logged), not hidden", async () => {
    delete process.env.ADMIN_ALERT_EMAIL;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 })).toBe("sent");
    expect(logged.mock.calls.some((c) => String(c[0]).includes("team-email"))).toBe(true);
  });

  // kills: the team email gated on the owner having an address
  it("at 150% with no owner email, the Phondo team is still told — only no owner AND no team throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ org_members: { data: null, error: null } }) as any);
    expect(await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 })).toBe("sent");
    expect(sent().map((s) => s.to)).toEqual(["team@phondo.ai"]);
  });

  // kills: Math.round -> Math.floor (188 and 230 both round down, so the tests above can't tell)
  it("the percentage is rounded, not floored: 226 of 150 is 151%", async () => {
    await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 226 });
    expect(sent().map((s) => s.subject).sort()).toEqual(["You've used 151% of your plan's calls this month", "[Phondo] An org is at 151% of its Starter plan"].sort());
  });

  // kills: the trailing-slash strip dropped (//billing), and the https://phondo.ai fallback dropped (a relative link)
  it("the plans link is absolute and single-slashed — a trailing-slash app URL, or none at all", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.phondo.ai/";
    await sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188 });
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188 });
    expect(sent().map((s) => s.html.match(/<a href="([^"]+)">see plans<\/a>/)?.[1])).toEqual(["https://app.phondo.ai/billing", "https://phondo.ai/billing"]);
  });
});

// SCRUM-609: /review-and-fix on the merged #459 (silent-failure + code lenses).
describe("sendPlanUsageAlertNotification (SCRUM-609) — review-and-fix", () => {
  // Silent lens: a database blip looked exactly like "no owner email" — at 125% the period's alert
  // was spent (kept as no-address), at 150% the team was told the owner had no email on file.
  it("a database fault looking up the owner THROWS — never mistaken for no owner email; nothing is sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ org_members: { data: null, error: { code: "08006", message: "connection reset" } } }) as any);
    const p = sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 });
    await expect(p).rejects.toThrow("org owner query failed: connection reset");
    await expect(p).rejects.not.toBeInstanceOf(NotificationDeliveryError);
    expect(sent()).toEqual([]);
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({
      org_members: { data: { user_id: "user-owner" }, error: null },
      user_profiles: { data: null, error: { code: "57014", message: "statement timeout" } },
    }) as any);
    await expect(sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188 })).rejects.toThrow("owner profile query failed: statement timeout");
    expect(sent()).toEqual([]);
  });

  it("no owner row (PostgREST's PGRST116) is a real missing owner: the 125% alert is a no-address failure, as before", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ org_members: { data: null, error: { code: "PGRST116", message: "0 rows" } } }) as any);
    const err = await sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188 }).catch((e) => e);
    expect(err).toBeInstanceOf(NotificationDeliveryError);
    expect(err.permanentCause).toBe("org-config");
  });

  it("at 150% with no team address, Sentry hears it — the owner's delivery makes the send 'sent', so a log line was all there was", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.ADMIN_ALERT_EMAIL;
    const Sentry = await import("@sentry/nextjs");
    expect(await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 })).toBe("sent");
    expect(Sentry.captureMessage).toHaveBeenCalledWith("Plan usage alert: ADMIN_ALERT_EMAIL is unset — the team wasn't told a business is at 150%");
    vi.mocked(Sentry.captureMessage).mockClear();
    await sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188 }); // 125% never wants the team
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // Silent lens: a partial delivery is confirmed and never re-sent — the failure says who missed it.
  it("a failed send says each recipient's outcome by role: the team's failed, the owner's went; no owner at 125%", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    resendSend.mockImplementationOnce(async () => ({ data: null, error: { message: "team inbox bounced" } }));
    const partial = await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 }).catch((e) => e);
    expect(partial).toBeInstanceOf(NotificationDeliveryError);
    expect(partial.deliveredCount).toBe(1);
    expect(partial.recipients).toEqual({ team: "failed", owner: "sent" });
    resendSend.mockClear();
    resendSend.mockImplementation(async () => ({ data: null, error: { message: "owner inbox bounced" } }));
    delete process.env.ADMIN_ALERT_EMAIL;
    const ownerOnly = await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 }).catch((e) => e);
    expect(ownerOnly.recipients).toEqual({ team: "no-address", owner: "failed" });
    resendSend.mockImplementation(async () => ({ data: { id: "email-1" }, error: null }));
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ org_members: { data: null, error: null } }) as any);
    const none = await sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188 }).catch((e) => e);
    expect(none.recipients).toEqual({ owner: "no-address" });
    expect(none.permanentCause).toBe("org-config");
  });

  // Code lens: "reply to this email" went to the sending address, which nobody reads.
  it("the owner's email replies to support@phondo.ai; the team's sets no reply-to", async () => {
    await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 });
    const owner = sent().find((m) => m.to === "owner@example.com")!;
    const team = sent().find((m) => m.to === "team@phondo.ai")!;
    expect(owner.replyTo).toBe("support@phondo.ai");
    expect(team).not.toHaveProperty("replyTo");
  });
});


// SCRUM-609 test lens (independent mutation run on 0a78c998): paths the tests above leave open.
// Each passes on the real code and fails on the mutant named in the comment above it.
describe("SCRUM-609 — test-lens killers", () => {
  // kills: the profile lookup's PGRST116 exception dropped (strict mode throws on a missing profile row too)
  it("an owner whose profile row is missing (PGRST116 on user_profiles) is a no-address failure, like a missing owner — not a throw retried on every counted call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({
      org_members: { data: { user_id: "user-owner" }, error: null },
      user_profiles: { data: null, error: { code: "PGRST116", message: "0 rows" } },
    }) as any);
    const err = await sendPlanUsageAlertNotification({ ...base, level: 125, callsUsed: 188 }).catch((e) => e);
    expect(err).toBeInstanceOf(NotificationDeliveryError);
    expect(err.permanentCause).toBe("org-config");
    expect(sent()).toEqual([]);
  });

  // kills: the lookup's throw no longer gated on throwOnQueryError, in either branch — every other
  // caller (missed-call, recap, PIN lockout, Cliniko) would reject on a DB blip instead of degrading
  it("strict mode is opt-in: without it, a DB fault on either lookup still returns null, never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { getOrganizationOwnerEmail } = await import("@/lib/notifications/notification-service");
    for (const tables of [
      { org_members: { data: null, error: { code: "08006", message: "connection reset" } } },
      { org_members: { data: { user_id: "user-owner" }, error: null }, user_profiles: { data: null, error: { code: "57014", message: "statement timeout" } } },
    ] as Array<Record<string, SingleResult>>) {
      vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(tables) as any);
      await expect(getOrganizationOwnerEmail(ORG)).resolves.toBeNull();
    }
  });

  // kills: the ADMIN_ALERT_EMAIL-unset page losing its extras — its message names no business,
  // so the org id on the scope is all the team has to find who is at 150%
  it("the team-unset page carries the org and level, at warning level", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.ADMIN_ALERT_EMAIL;
    const Sentry = await import("@sentry/nextjs");
    const scope = { setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() };
    vi.mocked(Sentry.withScope).mockImplementationOnce(((fn: (s: typeof scope) => unknown) => fn(scope)) as any);
    expect(await sendPlanUsageAlertNotification({ ...base, level: 150, callsUsed: 230 })).toBe("sent");
    expect(Sentry.captureMessage).toHaveBeenCalledWith("Plan usage alert: ADMIN_ALERT_EMAIL is unset — the team wasn't told a business is at 150%");
    expect(scope.setExtras).toHaveBeenCalledWith({ organizationId: ORG, level: 150 });
    expect(scope.setLevel).toHaveBeenCalledWith("warning");
  });
});
