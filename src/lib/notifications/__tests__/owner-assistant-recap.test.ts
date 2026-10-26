import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-597: the owner-assistant recap email. OWNER only (like the PIN alert), no
// preference gate (the owner asked for it after every change), honest settle (no
// owner email ⇒ NotificationDeliveryError). Customer names are customer-written and
// arrive inside an ARRAY, which the template's top-level escaping never reaches —
// so the real escapeHtml is used here and hostile names are pinned.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ hasFeatureAccess: vi.fn(async () => true) }));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: unknown) => void) => fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() })),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));
const resendSend = vi.hoisted(() => vi.fn(async (_m: unknown) => ({ data: { id: "email-1" }, error: null as null | { message: string } })));
vi.mock("resend", () => ({ Resend: class { emails = { send: resendSend }; } }));

import { createAdminClient } from "@/lib/supabase/admin";
import { DEMO_ORG_ID } from "@/lib/demo/config";
import { sendOwnerAssistantRecapNotification, NotificationDeliveryError } from "@/lib/notifications/notification-service";
import type { OwnerRecapItem } from "@/lib/owner-assistant/recap";

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
let queried: Array<{ table: string; eqs: Array<[string, unknown]> }> = [];

function fakeAdmin(tables: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: (table: string) => {
      const rec = { table, eqs: [] as Array<[string, unknown]> };
      queried.push(rec);
      const b: any = {};
      Object.assign(b, {
        select: () => b, in: () => b, limit: () => b, order: () => b,
        eq: (c: string, v: unknown) => { rec.eqs.push([c, v]); return b; },
        single: async () => tables[table] ?? { data: null, error: null },
      });
      return b;
    },
  };
}
const OWNER_FOUND = {
  org_members: { data: { user_id: "owner-1" }, error: null },
  user_profiles: { data: { email: "owner@example.com" }, error: null },
};
const sent = () => resendSend.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string });

const ITEMS: OwnerRecapItem[] = [
  { change: "cancelled", customer: "Michael Dunn", when: "Monday, October 26 at 12:30 PM", told: "not_told" },
  { change: "moved", customer: "Jane Smith", when: "Thursday, October 29 at 2:00 PM", from: "Wednesday, October 28 at 9:00 AM", told: "texted" },
  { change: "cancelled", customer: "Ann Lee", when: "Friday, October 30 at 9:00 AM", told: "not_texted", toldWhy: "customer texts are switched off" },
  { change: "booked", customer: "Raj Patel", when: "Friday, October 30 at 11:00 AM", told: "text_failed" },
];

describe("SCRUM-598: a change whose customer is being called", () => {
  it("says the assistant is calling, and that a separate email follows — never 'told'", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    await sendOwnerAssistantRecapNotification({
      organizationId: ORG,
      callId: CALL,
      channel: "web",
      items: [{ change: "cancelled", customer: "Michael Dunn", when: "Monday, October 26 at 12:30 PM", told: "calling" }],
    });
    const html = sent()[0].html;
    expect(html).toContain("Your assistant called (or is calling) the customer — see the separate email for how it went.");
    expect(html).not.toContain("Customer not told.");
  });
});

beforeEach(() => {
  queried = [];
  resendSend.mockClear();
  process.env.EMAIL_API_KEY = "re_test";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("sendOwnerAssistantRecapNotification", () => {
  it("emails the OWNER only (role owner, no preferences read), one row per change, saying what happened to each customer", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    expect(await sendOwnerAssistantRecapNotification({ organizationId: ORG, callId: CALL, channel: "web", items: ITEMS })).toBe("sent");
    expect(queried.find((q) => q.table === "org_members")?.eqs).toEqual([["organization_id", ORG], ["role", "owner"]]);
    expect(queried.some((q) => q.table === "notification_preferences")).toBe(false);
    const [mail] = sent();
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toBe("Your assistant changed 4 bookings — please check");
    expect(mail.html).toContain("What your assistant changed");
    expect(mail.html).toContain("Your assistant made 4 changes in your dashboard.");
    expect(mail.html).toContain("This list comes from your diary and our text log, not from what the AI said.");
    expect(mail.html).toContain("Cancelled <strong>Michael Dunn</strong>'s job on Monday, October 26 at 12:30 PM");
    expect(mail.html).toContain("Moved <strong>Jane Smith</strong>'s job from Wednesday, October 28 at 9:00 AM to Thursday, October 29 at 2:00 PM");
    expect(mail.html).toContain("Booked <strong>Raj Patel</strong> for Friday, October 30 at 11:00 AM");
    expect(mail.html).toContain("Customer not told.");
    expect(mail.html).toContain("Customer texted.");
    expect(mail.html).toContain("Customer not texted (customer texts are switched off).");
    expect(mail.html).toContain("The text to the customer failed — please let them know yourself.");
    expect(mail.html).toContain("fix it in Appointments and let the customer know");
    expect(mail.html).toContain('href="https://app.example.test/appointments"');
    expect(mail.html).toContain(`href="https://app.example.test/calls/${CALL}"`);
  });

  it("one change reads in the singular; a phone session says 'on your assistant line'", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    await sendOwnerAssistantRecapNotification({ organizationId: ORG, callId: CALL, channel: "phone", items: ITEMS.slice(0, 1) });
    const [mail] = sent();
    expect(mail.subject).toBe("Your assistant changed 1 booking — please check");
    expect(mail.html).toContain("Your assistant made 1 change on your assistant line.");
  });

  it("escapes every customer-written value inside the rows (the array bypasses the top-level escaping)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    const evil = `<img src=x onerror="alert(1)">&"'`;
    await sendOwnerAssistantRecapNotification({
      organizationId: ORG, callId: CALL, channel: "web",
      items: [{ change: "moved", customer: evil, when: `<b>${evil}</b>`, from: evil, told: "not_texted", toldWhy: evil }],
    });
    const [mail] = sent();
    // (The branded shell has its own logo <img>, so the hostile markup is matched exactly.)
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).not.toContain('onerror="');
    expect(mail.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&quot;&#39;");
  });

  it("nothing to report and the demo org are skipped without any lookup", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    expect(await sendOwnerAssistantRecapNotification({ organizationId: ORG, callId: CALL, channel: "web", items: [] })).toBe("skipped");
    expect(await sendOwnerAssistantRecapNotification({ organizationId: DEMO_ORG_ID, callId: CALL, channel: "web", items: ITEMS })).toBe("skipped");
    expect(queried).toEqual([]);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("no owner email is a delivery error, never a silent 'sent'", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ org_members: { data: { user_id: "owner-1" }, error: null }, user_profiles: { data: { email: null }, error: null } }) as any);
    await expect(sendOwnerAssistantRecapNotification({ organizationId: ORG, callId: CALL, channel: "web", items: ITEMS })).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("a Resend failure throws (the caller pages)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    resendSend.mockResolvedValueOnce({ data: null as any, error: { message: "rate limited" } });
    await expect(sendOwnerAssistantRecapNotification({ organizationId: ORG, callId: CALL, channel: "web", items: ITEMS })).rejects.toBeInstanceOf(NotificationDeliveryError);
  });
});

describe("SCRUM-597: an unreadable org timezone", () => {
  it("says the times are in Sydney time when the org's zone couldn't be read — and only then", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    await sendOwnerAssistantRecapNotification({ organizationId: ORG, callId: CALL, channel: "web", items: ITEMS, timesInDefaultZone: true });
    await sendOwnerAssistantRecapNotification({ organizationId: ORG, callId: CALL, channel: "web", items: ITEMS });
    const [withNote, without] = sent();
    expect(withNote.html).toContain("Times are shown in Sydney time — we couldn&#39;t read your business&#39;s timezone.".replace(/&#39;/g, "'"));
    expect(without.html).not.toContain("Times are shown in Sydney time");
  });
});
