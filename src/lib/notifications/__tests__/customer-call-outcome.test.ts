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
  previousWhen: null,
  result: { kind: "answered", seconds: 130, endedOnAFault: false, sureItWasAPerson: true },
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
    expect(mail.html).toContain('You asked it to call Jane Smith (<a href="tel:+61412345678">0412 345 678</a>) to find a new time for their booking on Wednesday, October 28 at 2:30 PM.');
    expect(mail.html, "a new time was agreed: nothing left to do").not.toContain("Next step");
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
      [{ kind: "voicemail", playedToEnd: true }, "left a voicemail", "Their voicemail picked up and the assistant left a message."],
      [{ kind: "voicemail", playedToEnd: false }, "left a voicemail", "the assistant left a message (we couldn&#39;t confirm it played to the end)."],
      // Silent lens G1: a voicemail that took no message never reads as one left.
      [{ kind: "voicemail_not_left" }, "voicemail, no message left", "Their voicemail picked up, but the assistant couldn&#39;t leave a message — give them a ring."],
      // Silent lens N4: our own setup failure never reads as the customer hanging up.
      [{ kind: "failed_on_our_side" }, "the call failed on our side", "They picked up, but the call failed on our side before the assistant could speak — please give them a ring."],
      // Silent lens N7: an AMD "unknown" is never stated as a person answering.
      [{ kind: "answered", seconds: 70, endedOnAFault: false, sureItWasAPerson: false }, "they answered", "The call connected (the phone system couldn&#39;t tell whether a person or a voicemail answered — the summary says what happened) — the call lasted 1 min 10 s."],
      [{ kind: "machine_answered" }, "a fax or machine answered", "A fax or another machine answered, so nothing was said — the number on the booking may be wrong."],
      [{ kind: "no_answer" }, "no answer", "No answer, and no message left."],
      [{ kind: "busy" }, "their line was busy", "Their line was busy. Nothing was said."],
      [{ kind: "dropped" }, "they hung up straight away", "They picked up but the call ended before the assistant spoke."],
      [{ kind: "cut_off", seconds: 45 }, "the call was cut off", "The call was cut off on our side after 45 s"],
      // The body's lines go through escapeHtml, so an apostrophe arrives as &#39;.
      [{ kind: "failed" }, "the call didn't go through", "The call didn&#39;t go through. Nothing was said."],
      [{ kind: "answered", seconds: 61, endedOnAFault: true, sureItWasAPerson: true }, "they answered", "the call lasted 1 min 1 s. It ended on a fault on our side, so check the recording."],
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
      report: { ...REPORT, purpose: "cancelled", result: { kind: "voicemail", playedToEnd: true }, diary: [{ kind: "unchanged", when: "Wednesday, October 28 at 2:30 PM", state: "cancelled" }], assistantOutcome: null, assistantNote: null, summary: null, voicemailText: "Hi Jane, your booking has been cancelled." },
    });
    let html = sent()[0].html;
    expect(html).toContain("to tell them their booking on Wednesday, October 28 at 2:30 PM was cancelled");
    expect(html).toContain("Nothing changed on the call — the booking on Wednesday, October 28 at 2:30 PM is still cancelled");
    expect(html).toContain("&ldquo;Hi Jane, your booking has been cancelled.&rdquo;");
    expect(html).not.toContain("The assistant noted");
    expect(html).not.toContain("Summary <span");
    resendSend.mockClear();
    await sendCustomerCallOutcomeNotification({
      organizationId: ORG,
      report: { ...REPORT, purpose: "confirm", diary: [{ kind: "unchanged", when: "Wednesday, October 28 at 2:30 PM", state: "booked" }, { kind: "booked", when: "Friday" }, { kind: "cancelled", when: "Saturday" }, { kind: "unchanged", when: "Sunday", state: "inactive" }], assistantOutcome: "do_not_call", assistantNote: null },
    });
    html = sent()[0].html;
    expect(html).toContain("to check they're still OK for Wednesday, October 28 at 2:30 PM");
    // Code lens R2-N4: beside what the call made, the old booking's line says where it stands.
    expect(html).toContain("Still booked for <strong>Wednesday, October 28 at 2:30 PM</strong>");
    expect(html).toContain("The booking on Sunday is no longer active");
    expect(html).not.toContain("Nothing changed on the call");
    expect(html).toContain("Booked a new time: <strong>Friday</strong>");
    expect(html).toContain("Cancelled the booking on <strong>Saturday</strong>");
    expect(html).toContain("they asked not to be called again — your assistant won&#39;t call them again");
  });

  it("a move's call says the NEW time, and where it moved from (clients lens M1)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    const moved = { ...REPORT, purpose: "moved" as const, bookingWhen: "Thursday, October 29 at 3:00 PM", previousWhen: "Wednesday, October 28 at 2:30 PM", diary: [{ kind: "unchanged" as const, when: "Thursday, October 29 at 3:00 PM", state: "booked" as const }], assistantOutcome: "confirmed" as const };
    await sendCustomerCallOutcomeNotification({ organizationId: ORG, report: moved });
    let html = sent()[0].html;
    expect(html).toContain("to tell them their booking was moved to Thursday, October 29 at 3:00 PM (from Wednesday, October 28 at 2:30 PM). Here's how it went.");
    expect(html).not.toContain("it was on");
    expect(html).toContain("Nothing changed on the call — still booked for <strong>Thursday, October 29 at 3:00 PM</strong>");
    resendSend.mockClear();
    await sendCustomerCallOutcomeNotification({ organizationId: ORG, report: { ...moved, bookingWhen: null, previousWhen: null, diary: [] } });
    html = sent()[0].html;
    expect(html).toContain("to tell them their booking was moved. Here's how it went.");
    expect(html).toContain("Nothing changed on the call.");
    resendSend.mockClear();
    await sendCustomerCallOutcomeNotification({ organizationId: ORG, report: { ...REPORT, purpose: "cancelled", bookingWhen: null } });
    expect(sent()[0].html).toContain("to tell them their booking was cancelled. Here's how it went.");
  });

  it("says plainly when the customer still doesn't know, didn't confirm, or nothing was agreed (clients lens M2, R2-1; silent lens R2-1; types lens N1)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    const RING = ' — ring them on <a href="tel:+61412345678">0412 345 678</a>.';
    const ON = "Wednesday, October 28 at 2:30 PM";
    const unchanged = [{ kind: "unchanged" as const, when: ON, state: "booked" as const }];
    const nextOf = async (over: Partial<CallOutcomeReport>) => {
      resendSend.mockClear();
      await sendCustomerCallOutcomeNotification({ organizationId: ORG, report: { ...REPORT, diary: unchanged, ...over } });
      const m = /<p><strong>Next step:<\/strong> (.*?)<\/p>/.exec(sent()[0].html);
      return m ? m[1] : null;
    };
    const answered = { kind: "answered" as const, seconds: 60, endedOnAFault: false, sureItWasAPerson: true };
    const played = { kind: "voicemail" as const, playedToEnd: true };
    const unplayed = { kind: "voicemail" as const, playedToEnd: false };
    type Case = [string, Partial<CallOutcomeReport>, string | null];
    const cases: Case[] = [
      // A change: told only when they reacted to it, or the message played to the end.
      ["cancel, no answer", { purpose: "cancelled", result: { kind: "no_answer" }, assistantOutcome: null }, `Jane Smith hasn't been told about this change${RING}`],
      ["move, wrong person", { purpose: "moved", result: answered, assistantOutcome: "wrong_person" }, `Jane Smith hasn't been told about this change${RING}`],
      ["cancel, answered, no outcome", { purpose: "cancelled", result: answered, assistantOutcome: null }, `Jane Smith may not have heard about this change${RING}`],
      ["move, cut off", { purpose: "moved", result: { kind: "cut_off", seconds: 40 }, assistantOutcome: null }, `Jane Smith may not have heard about this change${RING}`],
      ["cancel, kind path ('other')", { purpose: "cancelled", result: answered, assistantOutcome: "other" }, `Jane Smith may not have heard about this change (see the assistant's note)${RING}`],
      ["cancel, do not call", { purpose: "cancelled", result: answered, assistantOutcome: "do_not_call" }, "Jane Smith may not have heard about this change (see the assistant's note), and they asked not to be called again."],
      ["move, message not confirmed played", { purpose: "moved", result: unplayed, assistantOutcome: null }, `Jane Smith may not have heard about this change (we couldn't confirm the message played to the end)${RING}`],
      ["cancel, declined another time", { purpose: "cancelled", result: answered, assistantOutcome: "declined" }, null],
      ["cancel, will call back", { purpose: "cancelled", result: answered, assistantOutcome: "will_call_back" }, null],
      ["move, confirmed", { purpose: "moved", result: answered, assistantOutcome: "confirmed" }, null],
      // Silent lens R3-1: a move's call asks whether the new time suits — "declined" / "will call back" may not have taken it.
      ["move, declined", { purpose: "moved", result: answered, assistantOutcome: "declined" }, `Jane Smith heard about the move, but the new time may not suit them (see the assistant's note). It's still booked for ${ON}${RING}`],
      ["move, will call back", { purpose: "moved", result: answered, assistantOutcome: "will_call_back" }, `Jane Smith heard about the move, but the new time may not suit them (see the assistant's note). It's still booked for ${ON}${RING}`],
      ["move, declined, no number", { purpose: "moved", result: answered, assistantOutcome: "declined", phone: null }, `Jane Smith heard about the move, but the new time may not suit them (see the assistant's note). It's still booked for ${ON}.`],
      ["move, moved again on the call", { purpose: "moved", result: answered, assistantOutcome: "rebooked", diary: [{ kind: "moved", from: ON, when: "Fri" }] }, null],
      // A new booking where the call should have moved the old one.
      ["move, booked a new one beside it", { purpose: "moved", result: answered, assistantOutcome: "rebooked", diary: [...unchanged, { kind: "booked", when: "Fri" }] }, `A new time was booked for Jane Smith, but their booking on ${ON} is still in your diary — cancel it if the new time replaces it.`],
      ["move, message played", { purpose: "moved", result: played, assistantOutcome: null }, null],
      // A confirmation: done only when they confirmed, or the diary changed on the call.
      ["confirm, busy", { purpose: "confirm", result: { kind: "busy" }, assistantOutcome: null }, `Jane Smith hasn't confirmed their booking${RING}`],
      ["confirm, message", { purpose: "confirm", result: played, assistantOutcome: null }, `Jane Smith hasn't confirmed their booking (the assistant left a message)${RING}`],
      ["confirm, answered, no outcome", { purpose: "confirm", result: answered, assistantOutcome: null }, `Jane Smith may not have confirmed their booking (check the summary)${RING}`],
      ["confirm, declined", { purpose: "confirm", result: answered, assistantOutcome: "declined" }, `Jane Smith didn't confirm their booking (see the assistant's note)${RING}`],
      ["confirm, will call back", { purpose: "confirm", result: answered, assistantOutcome: "will_call_back" }, `Jane Smith didn't confirm their booking (see the assistant's note)${RING}`],
      ["confirm, other", { purpose: "confirm", result: answered, assistantOutcome: "other" }, `Jane Smith may not have confirmed their booking (see the assistant's note)${RING}`],
      ["confirm, do not call", { purpose: "confirm", result: answered, assistantOutcome: "do_not_call" }, "Jane Smith may not have confirmed their booking (see the assistant's note), and they asked not to be called again."],
      ["confirm, confirmed", { purpose: "confirm", result: answered, assistantOutcome: "confirmed" }, null],
      ["confirm, moved on the call", { purpose: "confirm", result: answered, assistantOutcome: "rebooked", diary: [{ kind: "moved", from: ON, when: "Thu" }] }, null],
      ["confirm, cancelled on the call", { purpose: "confirm", result: answered, assistantOutcome: "declined", diary: [{ kind: "cancelled", when: ON }] }, null],
      // Finding a new time: nothing agreed is back with the owner.
      ["find, declined", { purpose: "find_new_time", result: answered, assistantOutcome: "declined" }, `No new time was agreed, so Jane Smith's booking on ${ON} still stands. It's back with you${RING}`],
      ["find, other", { purpose: "find_new_time", result: answered, assistantOutcome: "other" }, `No new time was agreed, so Jane Smith's booking on ${ON} still stands (see the assistant's note). It's back with you${RING}`],
      ["find, do not call", { purpose: "find_new_time", result: answered, assistantOutcome: "do_not_call" }, `No new time was agreed, so Jane Smith's booking on ${ON} still stands (see the assistant's note), and they asked not to be called again. It's back with you.`],
      ["find, no answer", { purpose: "find_new_time", result: { kind: "no_answer" }, assistantOutcome: null }, `Jane Smith doesn't know yet that their booking needs to move${RING}`],
      ["find, message", { purpose: "find_new_time", result: played, assistantOutcome: null }, `Jane Smith doesn't know yet that their booking needs to move (the assistant left a message asking them to call back)${RING}`],
      ["find, moved", { purpose: "find_new_time", result: answered, assistantOutcome: "rebooked", diary: [{ kind: "moved", from: "Wed", when: "Thu" }] }, null],
      ["find, booked a new one beside it", { purpose: "find_new_time", result: answered, assistantOutcome: "rebooked", diary: [...unchanged, { kind: "booked", when: "Thu" }] }, `A new time was booked for Jane Smith, but their booking on ${ON} is still in your diary — cancel it if the new time replaces it.`],
      ["confirm, booked another job beside it (fine)", { purpose: "confirm", result: answered, assistantOutcome: "confirmed", diary: [...unchanged, { kind: "booked", when: "Thu" }] }, null],
      // Silent lens R3 (low): "still stands" only when the diary says so.
      ["find, declined, booking cancelled since", { purpose: "find_new_time", result: answered, assistantOutcome: "declined", diary: [{ kind: "unchanged", when: ON, state: "cancelled" }] }, `No new time was agreed, and the booking on ${ON} is now cancelled — check Appointments.`],
      ["find, declined, booking no longer active", { purpose: "find_new_time", result: answered, assistantOutcome: "declined", diary: [{ kind: "unchanged", when: ON, state: "inactive" }] }, `No new time was agreed, and the booking on ${ON} is no longer active — check Appointments.`],
      // Silent lens R2-1(c): cancelled on the call is never "still stands".
      ["find, cancelled on the call", { purpose: "find_new_time", result: answered, assistantOutcome: "declined", diary: [{ kind: "cancelled", when: ON }] }, null],
      // Code lens G4: a time booked then cancelled on the call isn't agreed.
      ["find, booked then cancelled", { purpose: "find_new_time", result: answered, assistantOutcome: "declined", diary: [{ kind: "booked", when: "Thu" }, { kind: "cancelled", when: "Thu" }] }, `No new time was agreed, so Jane Smith's booking on ${ON} still stands. It's back with you${RING}`],
      // Silent lens R2-1(d): a "rebooked" the diary doesn't show is flagged, whatever the purpose.
      ["find, rebooked but nothing in the diary", { purpose: "find_new_time", result: answered, assistantOutcome: "rebooked" }, `The assistant noted it booked or moved a time for Jane Smith, but your diary shows no new time. Check the call and Appointments${RING}`],
      ["cancel, rebooked but only a cancelled time", { purpose: "cancelled", result: answered, assistantOutcome: "rebooked", diary: [{ kind: "booked", when: "Thu" }, { kind: "cancelled", when: "Thu" }] }, `The assistant noted it booked or moved a time for Jane Smith, but your diary shows no new time. Check the call and Appointments${RING}`],
      // No number: no "ring them"; a number we can't format is shown as written, never as a link.
      ["no number", { purpose: "cancelled", result: { kind: "no_answer" }, assistantOutcome: null, phone: null }, "Jane Smith hasn't been told about this change."],
      ["overseas number", { purpose: "cancelled", result: { kind: "no_answer" }, assistantOutcome: null, phone: "+15551234567" }, "Jane Smith hasn't been told about this change — ring them on +15551234567."],
    ];
    for (const [label, over, want] of cases) {
      const got = await nextOf(over);
      expect(got === null ? null : got.replace(/&#39;/g, "'"), label).toBe(want);
    }
    // Every result kind finds a home (a fax or our own failure is "hasn't been told").
    for (const result of [{ kind: "busy" }, { kind: "dropped" }, { kind: "failed" }, { kind: "failed_on_our_side" }, { kind: "voicemail_not_left" }, { kind: "machine_answered" }] as const) {
      expect(await nextOf({ purpose: "cancelled", result, assistantOutcome: null }), result.kind).toBe(`Jane Smith hasn't been told about this change${RING}`);
    }
  });

  it("'Listen to the call' only when the call reached someone (clients lens S4)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    const htmlOf = async (result: CallResult) => {
      resendSend.mockClear();
      await sendCustomerCallOutcomeNotification({ organizationId: ORG, report: { ...REPORT, result } });
      return sent()[0].html;
    };
    for (const result of [{ kind: "no_answer" }, { kind: "busy" }, { kind: "voicemail", playedToEnd: true }, { kind: "failed" }] as const) {
      const html = await htmlOf(result);
      expect(html, result.kind).not.toContain(`/calls/${CALL}`);
      expect(html, result.kind).not.toContain("listen to the call");
      expect(html, result.kind).toContain('href="https://app.example.test/appointments"');
    }
    expect(await htmlOf({ kind: "cut_off", seconds: 30 })).toContain(`href="https://app.example.test/calls/${CALL}">Listen to the call</a>`);
  });

  it("escapes every customer- and AI-written value (the report bypasses the top-level escaping)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    const evil = `<img src=x onerror="alert(1)">&"'`;
    await sendCustomerCallOutcomeNotification({
      organizationId: ORG,
      report: { ...REPORT, purpose: "moved", result: { kind: "no_answer" }, customer: evil, phone: evil, bookingWhen: evil, previousWhen: evil, diary: [{ kind: "moved", from: evil, when: evil }, { kind: "unchanged", when: evil, state: "cancelled" }], assistantNote: evil, summary: evil, voicemailText: evil, assistantOutcome: "other" },
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

describe("SCRUM-598 (test lens): every AI-written row is labelled", () => {
  it("the summary row says it's AI-written, right next to the summary", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(OWNER_FOUND) as any);
    await sendCustomerCallOutcomeNotification({ organizationId: ORG, report: REPORT });
    const [mail] = sent();
    expect(mail.html).toContain('Summary <span style="font-weight: normal; color: #6b7280;">(AI-written)</span></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">Jane said Thursday suits her better.');
  });
});
