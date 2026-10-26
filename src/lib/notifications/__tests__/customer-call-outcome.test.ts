import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-598: the email the owner gets after the assistant's call to a customer. OWNER
// only, no preference gate, demo org skipped, honest settle. The result and the diary
// are facts; the assistant's note, the summary and the voicemail text are labelled as
// the AI's words. The report is NESTED data, which the template's top-level escaping
// never reaches — so hostile values are pinned with the real escapeHtml.

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
import { sendCustomerCallOutcomeNotification, NotificationDeliveryError } from "@/lib/notifications/notification-service";
import type { CallOutcomeReport, CallResult } from "@/lib/owner-assistant/call-outcome";

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL = "55555555-5555-4555-8555-555555555555";
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

const REPORT: CallOutcomeReport = {
  callId: CALL,
  purpose: "find_new_time",
  customer: "Jane Smith",
  phone: "+61412345678",
  bookingWhen: "Wednesday, October 28 at 2:30 PM",
  result: { kind: "answered", seconds: 130, endedOnAFault: false },
  diary: [{ kind: "moved", from: "Wednesday, October 28 at 2:30 PM", when: "Thursday, October 29 at 3:00 PM" }],
  assistantOutcome: "rebooked",
  assistantNote: "Moved to Thursday",
  summary: "Jane said Thursday suits her better.",
  voicemailText: null,
};

beforeEach(() => {
  queried = [];
  resendSend.mockClear();
  process.env.EMAIL_API_KEY = "re_test";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("sendCustomerCallOutcomeNotification", () => {
  it("emails the OWNER only: why the call was made, the result and the diary as facts, the AI's words labelled", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    expect(await sendCustomerCallOutcomeNotification({ organizationId: ORG, report: REPORT })).toBe("sent");
    expect(queried.find((q) => q.table === "org_members")?.eqs).toEqual([["organization_id", ORG], ["role", "owner"]]);
    expect(queried.some((q) => q.table === "notification_preferences")).toBe(false);
    const [mail] = sent();
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toBe("Your assistant called Jane Smith — they answered");
    expect(mail.html).toContain("You asked it to call Jane Smith (+61412345678) to find a new time for their booking on Wednesday, October 28 at 2:30 PM.");
    expect(mail.html).toContain("They answered — the call lasted 2 min 10 s.");
    expect(mail.html).toContain("Moved from Wednesday, October 28 at 2:30 PM to <strong>Thursday, October 29 at 3:00 PM</strong>");
    expect(mail.html).toContain("(AI-written)</span></td><td style=\"padding: 8px; border-bottom: 1px solid #ddd;\">booked or moved a time for them — &ldquo;Moved to Thursday&rdquo;");
    expect(mail.html).toContain("Jane said Thursday suits her better.");
    expect(mail.html).toContain("The notes and summary are the AI's own words — <strong>if anything matters, listen to the call</strong>");
    expect(mail.html).toContain(`href="https://app.example.test/calls/${CALL}"`);
    expect(mail.html).toContain('href="https://app.example.test/appointments"');
    expect(mail.html).not.toContain("Message left");
  });

  it("every result has its own words, in the subject and the body", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    const cases: Array<[CallResult, string, string]> = [
      [{ kind: "voicemail" }, "left a voicemail", "Their voicemail picked up and the assistant left a message."],
      [{ kind: "no_answer" }, "no answer", "No answer, and no message left."],
      [{ kind: "busy" }, "their line was busy", "Their line was busy. Nothing was said."],
      [{ kind: "dropped" }, "they hung up straight away", "They picked up but the call ended before the assistant spoke."],
      [{ kind: "cut_off", seconds: 45 }, "the call was cut off", "The call was cut off on our side after 45 s"],
      // The body's lines go through escapeHtml, so an apostrophe arrives as &#39;.
      [{ kind: "failed" }, "the call didn't go through", "The call didn&#39;t go through. Nothing was said."],
      [{ kind: "answered", seconds: 61, endedOnAFault: true }, "they answered", "the call lasted 1 min 1 s. It ended on a fault on our side, so check the recording."],
    ];
    for (const [result, short, line] of cases) {
      resendSend.mockClear();
      await sendCustomerCallOutcomeNotification({ organizationId: ORG, report: { ...REPORT, result } });
      const [mail] = sent();
      expect(mail.subject).toBe(`Your assistant called Jane Smith — ${short}`);
      expect(mail.html).toContain(line);
    }
  });

  it("each purpose and diary line reads right, and a voicemail shows the message left", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    await sendCustomerCallOutcomeNotification({
      organizationId: ORG,
      report: { ...REPORT, purpose: "cancelled", result: { kind: "voicemail" }, diary: [{ kind: "unchanged", when: "Wednesday, October 28 at 2:30 PM", stillBooked: false }], assistantOutcome: null, assistantNote: null, summary: null, voicemailText: "Hi Jane, your booking has been cancelled." },
    });
    let html = sent()[0].html;
    expect(html).toContain("to tell them their booking on Wednesday, October 28 at 2:30 PM was cancelled");
    expect(html).toContain("No change to the booking on Wednesday, October 28 at 2:30 PM (it isn't active)");
    expect(html).toContain("&ldquo;Hi Jane, your booking has been cancelled.&rdquo;");
    expect(html).not.toContain("The assistant noted");
    expect(html).not.toContain("Summary <span");
    resendSend.mockClear();
    await sendCustomerCallOutcomeNotification({
      organizationId: ORG,
      report: { ...REPORT, purpose: "confirm", diary: [{ kind: "unchanged", when: "Wednesday, October 28 at 2:30 PM", stillBooked: true }, { kind: "booked", when: "Friday" }, { kind: "cancelled", when: "Saturday" }], assistantOutcome: "do_not_call", assistantNote: null },
    });
    html = sent()[0].html;
    expect(html).toContain("to check they're still OK for Wednesday, October 28 at 2:30 PM");
    expect(html).toContain("No change — still booked for <strong>Wednesday, October 28 at 2:30 PM</strong>");
    expect(html).toContain("Booked a new time: <strong>Friday</strong>");
    expect(html).toContain("Cancelled the booking on <strong>Saturday</strong>");
    expect(html).toContain("they asked not to be called again — your assistant won&#39;t call them again");
  });

  it("escapes every customer- and AI-written value (the report bypasses the top-level escaping)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    const evil = `<img src=x onerror="alert(1)">&"'`;
    await sendCustomerCallOutcomeNotification({
      organizationId: ORG,
      report: { ...REPORT, customer: evil, phone: evil, bookingWhen: evil, diary: [{ kind: "moved", from: evil, when: evil }], assistantNote: evil, summary: evil, voicemailText: evil, assistantOutcome: evil },
    });
    const [mail] = sent();
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).not.toContain('onerror="');
    expect(mail.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&quot;&#39;");
    expect(mail.html).not.toContain("undefined");
  });

  it("the demo org is skipped without a lookup; no owner email is a delivery error", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    expect(await sendCustomerCallOutcomeNotification({ organizationId: DEMO_ORG_ID, report: REPORT })).toBe("skipped");
    expect(queried).toEqual([]);
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ org_members: { data: { user_id: "owner-1" }, error: null }, user_profiles: { data: { email: null }, error: null } }) as any);
    await expect(sendCustomerCallOutcomeNotification({ organizationId: ORG, report: REPORT })).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("times shown in Sydney time say so when the org's zone couldn't be read", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    await sendCustomerCallOutcomeNotification({ organizationId: ORG, report: REPORT, timesInDefaultZone: true });
    expect(sent()[0].html).toContain("Times are shown in Sydney time");
  });
});
