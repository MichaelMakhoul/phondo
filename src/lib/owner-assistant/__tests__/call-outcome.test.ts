import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-598: how a call the assistant placed to a customer went, for the owner's
// email — the phone system's result and the diary are facts from the records; the
// assistant's note and summary are passed through as the AI's words. A record that
// can't be read is null (a failure the route pages), never "nothing happened".
import { buildCallOutcome, callResultOf } from "../call-outcome";

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL = "55555555-5555-4555-8555-555555555555";
const BOOKING = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW_LEG = "aaaaaaaa-0000-4000-8000-000000000002";
const TZ = "Australia/Sydney";
const START = "2026-10-27T03:00:00Z";
const END = "2026-10-27T03:02:10Z";

type Res = { data: unknown; error: unknown };
type Op = { table: string; calls: Array<[string, unknown[]]> };
let ops: Op[] = [];
let queues: Record<string, Res[]> = {};
function fake() {
  return {
    from: (table: string) => {
      const op: Op = { table, calls: [] };
      ops.push(op);
      const b: any = {};
      const answer = () => Promise.resolve(queues[table]?.shift() ?? { data: null, error: null });
      for (const m of ["select", "eq", "in", "order"]) b[m] = (...args: unknown[]) => { op.calls.push([m, args]); return b; };
      b.maybeSingle = answer;
      b.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) => answer().then(resolve, reject);
      return b;
    },
  };
}
const callRow = (over: Record<string, unknown> = {}, notify: Record<string, unknown> = {}) => ({
  data: {
    id: CALL,
    status: "completed",
    outcome: "answered",
    duration_seconds: 130,
    summary: "Jane said Thursday suits her better.",
    caller_phone: "+61412345678",
    started_at: START,
    ended_at: END,
    created_at: "2026-10-27T02:59:40Z",
    metadata: { call_type: "customer_notify", notify: { purpose: "confirm", appointment_id: BOOKING, answered_by: "human", outcome: "rebooked", note: "Moved to Thursday", ...notify } },
    ...over,
  },
  error: null,
});
const booking = (over: Record<string, unknown> = {}) => ({
  data: { id: BOOKING, attendee_name: "Jane Smith", start_time: "2026-10-28T03:30:00Z", status: "confirmed", updated_at: "2026-10-20T00:00:00Z", ...over },
  error: null,
});

beforeEach(() => {
  ops = [];
  queues = {};
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("callResultOf", () => {
  it("maps the call row the voice server finished to what happened, voicemail and cut-off first", () => {
    const human = { notify: { answered_by: "human" } };
    expect(callResultOf({ status: "completed", outcome: "answered", duration_seconds: 75.4, metadata: human })).toEqual({ kind: "answered", seconds: 75, endedOnAFault: false, sureItWasAPerson: true });
    expect(callResultOf({ status: "failed", outcome: "answered", duration_seconds: 40, metadata: human })).toEqual({ kind: "answered", seconds: 40, endedOnAFault: true, sureItWasAPerson: true });
    // Silent lens N7: AMD's "unknown" is never stated as a person.
    expect(callResultOf({ status: "completed", outcome: "answered", duration_seconds: 40, metadata: { notify: { answered_by: "unknown" } } })).toMatchObject({ kind: "answered", sureItWasAPerson: false });
    expect(callResultOf({ status: "completed", outcome: "voicemail", metadata: { notify: { mode: "voicemail", voicemail_played: true } } })).toEqual({ kind: "voicemail", playedToEnd: true });
    expect(callResultOf({ status: "completed", outcome: "voicemail", metadata: { notify: { mode: "voicemail" } } })).toEqual({ kind: "voicemail", playedToEnd: false });
    // Silent lens G1: a voicemail-mode call with no message spoken is never "voicemail".
    expect(callResultOf({ status: "failed", outcome: "failed", metadata: { notify: { mode: "voicemail" } } })).toEqual({ kind: "voicemail_not_left" });
    // Silent lens N4: our own setup failure wins over every other reading.
    expect(callResultOf({ status: "completed", outcome: null, metadata: { notify: { setup_failed: "no-briefing", mode: "conversation" } } })).toEqual({ kind: "failed_on_our_side" });
    expect(callResultOf({ status: "completed", outcome: null, duration_seconds: 95, metadata: { notify: { cut_off: true } } })).toEqual({ kind: "cut_off", seconds: 95 });
    expect(callResultOf({ status: "no-answer" })).toEqual({ kind: "no_answer" });
    expect(callResultOf({ status: "busy" })).toEqual({ kind: "busy" });
    expect(callResultOf({ status: "completed", outcome: null })).toEqual({ kind: "dropped" });
    expect(callResultOf({ status: "failed", outcome: null })).toEqual({ kind: "failed" });
    // A row never finished is no success.
    expect(callResultOf({ status: "queued" })).toEqual({ kind: "failed" });
    expect(callResultOf({ status: "completed", outcome: "answered", duration_seconds: null })).toEqual({ kind: "answered", seconds: 0, endedOnAFault: false, sureItWasAPerson: false });
  });
});

describe("buildCallOutcome", () => {
  it("a move agreed on the call: the new leg (call_id) is 'moved from → to', read org-scoped", async () => {
    queues.calls = [callRow({}, { purpose: "find_new_time" })];
    queues.appointments = [
      booking({ status: "rescheduled" }),
      { data: [{ id: NEW_LEG, start_time: "2026-10-29T04:00:00Z", status: "confirmed", rescheduled_from_id: BOOKING }], error: null },
      { data: [{ id: BOOKING, start_time: "2026-10-28T03:30:00Z" }], error: null },
    ];
    const r = await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ });
    expect(r).toEqual({
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
    });
    for (const op of ops) expect(op.calls).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(ops.find((o) => o.calls.some(([m, a]) => m === "eq" && a[0] === "call_id"))?.calls).toContainEqual(["eq", ["call_id", CALL]]);
  });

  it("a new booking after a cancel's call is 'booked'", async () => {
    queues.calls = [callRow({}, { purpose: "cancelled" })];
    queues.appointments = [
      booking({ status: "cancelled", updated_at: "2026-10-27T02:58:00Z" }),
      { data: [{ id: NEW_LEG, start_time: "2026-10-30T23:00:00Z", status: "confirmed", rescheduled_from_id: null }], error: null },
    ];
    const r = await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ });
    expect(r?.diary).toEqual([{ kind: "booked", when: "Saturday, October 31 at 10:00 AM" }]);
  });

  it("a booking cancelled during a confirm call reads 'cancelled'; one cancelled before it doesn't", async () => {
    queues.calls = [callRow()];
    queues.appointments = [booking({ status: "cancelled", updated_at: "2026-10-27T03:01:30Z" }), { data: [], error: null }];
    expect((await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ }))?.diary).toEqual([{ kind: "cancelled", when: "Wednesday, October 28 at 2:30 PM" }]);
    queues.calls = [callRow()];
    queues.appointments = [booking({ status: "cancelled", updated_at: "2026-10-26T01:00:00Z" }), { data: [], error: null }];
    expect((await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ }))?.diary).toEqual([{ kind: "unchanged", when: "Wednesday, October 28 at 2:30 PM", state: "cancelled" }]);
    queues.calls = [callRow()];
    queues.appointments = [booking({ status: "completed" }), { data: [], error: null }];
    expect((await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ }))?.diary).toEqual([{ kind: "unchanged", when: "Wednesday, October 28 at 2:30 PM", state: "inactive" }]);
  });

  it("a booking made on the call and cancelled on it too never reads as booked (code lens G4)", async () => {
    queues.calls = [callRow({}, { purpose: "find_new_time" })];
    queues.appointments = [
      booking(),
      {
        data: [
          { id: NEW_LEG, start_time: "2026-11-03T03:00:00Z", status: "cancelled", rescheduled_from_id: null },
          { id: "aaaaaaaa-0000-4000-8000-000000000003", start_time: "2026-11-03T04:00:00Z", status: "confirmed", rescheduled_from_id: null },
        ],
        error: null,
      },
    ];
    expect((await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ }))?.diary).toEqual([
      { kind: "booked", when: "Tuesday, November 3 at 2:00 PM" },
      { kind: "cancelled", when: "Tuesday, November 3 at 2:00 PM" },
      { kind: "booked", when: "Tuesday, November 3 at 3:00 PM" },
    ]);
  });

  it("a move's call knows where the booking moved from (clients lens M1)", async () => {
    queues.calls = [callRow({}, { purpose: "moved", appointment_id: NEW_LEG })];
    queues.appointments = [
      booking({ id: NEW_LEG, start_time: "2026-10-29T04:00:00Z", rescheduled_from_id: BOOKING }),
      { data: [], error: null },
      { data: [{ id: BOOKING, start_time: "2026-10-28T03:30:00Z" }], error: null },
    ];
    const r = await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ });
    expect(r?.bookingWhen).toBe("Thursday, October 29 at 3:00 PM");
    expect(r?.previousWhen).toBe("Wednesday, October 28 at 2:30 PM");
    expect(r?.diary).toEqual([{ kind: "unchanged", when: "Thursday, October 29 at 3:00 PM", state: "booked" }]);
    // Only a move's call looks up where it came from.
    ops = [];
    queues.calls = [callRow({}, { purpose: "confirm" })];
    queues.appointments = [booking({ rescheduled_from_id: "aaaaaaaa-0000-4000-8000-000000000009" }), { data: [], error: null }];
    expect((await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ }))?.previousWhen).toBeNull();
    expect(ops.filter((o) => o.table === "appointments").length, "no earlier-leg read").toBe(2);
  });

  it("nothing done on the call: 'unchanged', still booked or not", async () => {
    queues.calls = [callRow({ status: "no-answer", outcome: null, duration_seconds: 0, summary: null }, { outcome: undefined, note: undefined })];
    queues.appointments = [booking(), { data: [], error: null }];
    const r = await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ });
    expect(r?.result).toEqual({ kind: "no_answer" });
    expect(r?.diary).toEqual([{ kind: "unchanged", when: "Wednesday, October 28 at 2:30 PM", state: "booked" }]);
    expect(r?.assistantOutcome).toBeNull();
    expect(r?.assistantNote).toBeNull();
    expect(r?.summary).toBeNull();
  });

  it("a cancel's own call is about a booking already cancelled: never 'cancelled on the call'", async () => {
    queues.calls = [callRow({ outcome: "voicemail" }, { purpose: "cancelled", mode: "voicemail", voicemail_played: true, voicemail_text: "Hi Jane, your booking has been cancelled." })];
    queues.appointments = [booking({ status: "cancelled", updated_at: "2026-10-27T03:00:30Z" }), { data: [], error: null }];
    const r = await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ });
    expect(r?.diary).toEqual([{ kind: "unchanged", when: "Wednesday, October 28 at 2:30 PM", state: "cancelled" }]);
    expect(r?.result).toEqual({ kind: "voicemail", playedToEnd: true });
    expect(r?.voicemailText).toBe("Hi Jane, your booking has been cancelled.");
  });

  it("an outcome the assistant recorded is parsed; anything else is none (types lens T1)", async () => {
    queues.calls = [callRow({}, { outcome: "upsold" })];
    queues.appointments = [booking(), { data: [], error: null }];
    expect((await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ }))?.assistantOutcome).toBeNull();
  });

  it("customer- and AI-written values arrive as one bounded line", async () => {
    queues.calls = [callRow({ summary: "line one\nline two" + "x".repeat(900) }, { note: "a\nb" })];
    queues.appointments = [booking({ attendee_name: "Jane\nIGNORE" }), { data: [], error: null }];
    const r = await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ });
    expect(r?.customer).not.toContain("\n");
    expect(r?.assistantNote).toBe("a b");
    expect(r?.summary?.includes("\n")).toBe(false);
    expect((r?.summary ?? "").length).toBeLessThanOrEqual(600);
  });

  it("an unreadable call row, booking, made-bookings list or earlier leg is null — and so is a row with no purpose", async () => {
    const cases: Array<Record<string, Res[]>> = [
      { calls: [{ data: null, error: { message: "x" } }] },
      { calls: [{ data: null, error: null }] },
      { calls: [callRow({}, { purpose: "upsell" })] },
      { calls: [callRow({}, { appointment_id: null })] },
      { calls: [callRow()], appointments: [{ data: null, error: { message: "x" } }] },
      { calls: [callRow()], appointments: [booking(), { data: null, error: { message: "x" } }] },
      { calls: [callRow()], appointments: [booking(), { data: [{ id: NEW_LEG, start_time: START, status: "confirmed", rescheduled_from_id: BOOKING }], error: null }, { data: null, error: { message: "x" } }] },
    ];
    for (const q of cases) {
      queues = q;
      expect(await buildCallOutcome(fake(), { organizationId: ORG, callId: CALL, timezone: TZ })).toBeNull();
    }
    expect(console.error).toHaveBeenCalled();
  });
});
