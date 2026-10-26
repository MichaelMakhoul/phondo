import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-597: the recap is built ONLY from the system's records — the appointment
// audit trail (appointment_events.call_id) and the text log (appointment_confirmations)
// — never from anything the AI said. A failed read is null (a failure), never [].

import { buildOwnerRecap } from "../recap";

const ORG = "11111111-2222-4333-a444-555555555555";
const CALL = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const TZ = "Australia/Sydney";
const A = "aaaaaaaa-0000-4000-8000-000000000001"; // cancelled
const OLD = "aaaaaaaa-0000-4000-8000-000000000002"; // the leg a move replaced
const NEW = "aaaaaaaa-0000-4000-8000-000000000003"; // the move's new leg
const SINCE = new Date("2026-10-26T04:20:00Z"); // the session's start, less a margin

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
      for (const m of ["select", "eq", "in", "order", "gte"]) b[m] = (...args: unknown[]) => { op.calls.push([m, args]); return b; };
      b.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(queues[table]?.shift() ?? { data: [], error: null }).then(resolve, reject);
      return b;
    },
  };
}
const calls = (table: string, i = 0) => ops.filter((o) => o.table === table)[i]?.calls ?? [];

beforeEach(() => {
  ops = [];
  queues = {};
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const EVENT_AT = "2026-10-26T04:33:55Z";
const events = (rows: Array<[string, string]>) => ({ data: rows.map(([appointment_id, event_type]) => ({ appointment_id, event_type, created_at: EVENT_AT })), error: null });
const ATTEMPT = "2026-10-26T04:33:56Z"; // the change's own text, a second after its audit row

describe("buildOwnerRecap", () => {
  it("no events on the call: [] after one org- and call-scoped read of the audit trail", async () => {
    queues.appointment_events = [{ data: [], error: null }];
    expect(await buildOwnerRecap(fake(), { organizationId: ORG, callId: CALL, timezone: TZ, since: SINCE })).toEqual([]);
    expect(calls("appointment_events")).toEqual([
      ["select", ["appointment_id, event_type, created_at"]],
      ["eq", ["organization_id", ORG]],
      ["eq", ["call_id", CALL]],
      ["in", ["event_type", ["cancelled", "rescheduled", "created"]]],
      ["order", ["created_at", { ascending: true }]],
    ]);
    expect(ops.map((o) => o.table)).toEqual(["appointment_events"]);
  });

  it("a cancel and a move, oldest first, in the org's zone, with the move's old time from the leg it replaced", async () => {
    queues.appointment_events = [events([[A, "cancelled"], [NEW, "rescheduled"]])];
    queues.appointments = [
      { data: [
        { id: A, attendee_name: "Michael Dunn", start_time: "2026-10-26T01:30:00Z", rescheduled_from_id: null },
        { id: NEW, attendee_name: "Jane Smith", start_time: "2026-10-29T03:00:00Z", rescheduled_from_id: OLD },
      ], error: null },
      { data: [{ id: OLD, start_time: "2026-10-27T22:00:00Z" }], error: null },
    ];
    queues.appointment_confirmations = [{ data: [], error: null }];
    const items = await buildOwnerRecap(fake(), { organizationId: ORG, callId: CALL, timezone: TZ, since: SINCE });
    expect(items).toEqual([
      { change: "cancelled", customer: "Michael Dunn", when: "Monday, October 26 at 12:30 PM", told: "not_told" },
      { change: "moved", customer: "Jane Smith", when: "Thursday, October 29 at 2:00 PM", from: "Wednesday, October 28 at 9:00 AM", told: "not_told" },
    ]);
    // Every read is org-scoped.
    expect(calls("appointments", 0)).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(calls("appointments", 0)).toContainEqual(["in", ["id", [A, NEW]]]);
    expect(calls("appointments", 1)).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(calls("appointments", 1)).toContainEqual(["in", ["id", [OLD]]]);
    expect(calls("appointment_confirmations")).toContainEqual(["eq", ["organization_id", ORG]]);
    // Only text attempts since the session started count (an earlier cancellation of a
    // reinstated booking must not read as this change's text).
    expect(calls("appointment_confirmations")).toContainEqual(["gte", ["last_attempt_at", SINCE.toISOString()]]);
  });

  it("whether the customer was told comes from the text log: the cancellation text on a cancel, the confirmation on a new leg", async () => {
    const statusCases: Array<[string, object]> = [
      ["sent", { told: "texted" }],
      ["delivered", { told: "texted" }],
      ["failed", { told: "text_failed" }],
      ["undelivered", { told: "text_failed" }],
      ["skipped_disabled", { told: "not_texted", toldWhy: "customer texts are switched off" }],
      ["skipped_no_contact", { told: "not_texted", toldWhy: "no mobile number to text" }],
      ["opted_out", { told: "not_texted", toldWhy: "they've opted out of texts" }],
      ["skipped_cap", { told: "not_texted", toldWhy: "they'd already had texts from you within the hour, so this one was held back" }],
      ["skipped_db_error", { told: "not_texted", toldWhy: "we couldn't run a check, so the text was held back" }],
      // 'pending' is only the column default (caller-sms always records an outcome): never "texted".
      ["pending", { told: "not_texted", toldWhy: "we couldn't confirm the text went out" }],
      ["something_new", { told: "not_texted", toldWhy: "the text didn't go out" }],
    ];
    for (const [status, told] of statusCases) {
      queues.appointment_events = [events([[A, "cancelled"]])];
      queues.appointments = [{ data: [{ id: A, attendee_name: "Bob", start_time: "2026-10-26T01:30:00Z", rescheduled_from_id: null }], error: null }];
      queues.appointment_confirmations = [{ data: [
        // A confirmation-intent row for the same booking never answers for its cancellation.
        { appointment_id: A, idempotency_key: `${A}:sms:confirmation:2026-10-26T01:30:00.000Z`, status: "sent", last_attempt_at: ATTEMPT },
        { appointment_id: A, idempotency_key: `${A}:sms:cancellation:2026-10-26T01:30:00.000Z`, status, last_attempt_at: ATTEMPT },
      ], error: null }];
      const [item] = (await buildOwnerRecap(fake(), { organizationId: ORG, callId: CALL, timezone: TZ, since: SINCE }))!;
      expect(item, status).toMatchObject(told);
    }
  });

  it("a move's text is looked up on the NEW leg with the confirmation intent; an email row or another booking's text never counts", async () => {
    queues.appointment_events = [events([[NEW, "rescheduled"]])];
    queues.appointments = [
      { data: [{ id: NEW, attendee_name: "Jane", start_time: "2026-10-29T03:00:00Z", rescheduled_from_id: OLD }], error: null },
      { data: [{ id: OLD, start_time: "2026-10-27T22:00:00Z" }], error: null },
    ];
    queues.appointment_confirmations = [{ data: [
      { appointment_id: OLD, idempotency_key: `${OLD}:sms:confirmation:x`, status: "sent", last_attempt_at: ATTEMPT },
      { appointment_id: NEW, idempotency_key: `${NEW}:email:confirmation:x`, status: "sent", last_attempt_at: ATTEMPT },
      { appointment_id: NEW, idempotency_key: `${NEW}:sms:cancellation:x`, status: "sent", last_attempt_at: ATTEMPT },
    ], error: null }];
    const [item] = (await buildOwnerRecap(fake(), { organizationId: ORG, callId: CALL, timezone: TZ, since: SINCE }))!;
    expect(item.told).toBe("not_told");
    queues.appointment_events = [events([[NEW, "rescheduled"]])];
    queues.appointments = [
      { data: [{ id: NEW, attendee_name: "Jane", start_time: "2026-10-29T03:00:00Z", rescheduled_from_id: OLD }], error: null },
      { data: [{ id: OLD, start_time: "2026-10-27T22:00:00Z" }], error: null },
    ];
    queues.appointment_confirmations = [{ data: [{ appointment_id: NEW, idempotency_key: `${NEW}:sms:confirmation:x`, status: "sent", last_attempt_at: ATTEMPT }], error: null }];
    const [texted] = (await buildOwnerRecap(fake(), { organizationId: ORG, callId: CALL, timezone: TZ, since: SINCE }))!;
    expect(texted.told).toBe("texted");
  });

  it("customer names are flattened to one capped line (they are customer-written)", async () => {
    queues.appointment_events = [events([[A, "cancelled"]])];
    queues.appointments = [{ data: [{ id: A, attendee_name: "Jane\nSmith​" + "x".repeat(200), start_time: "2026-10-26T01:30:00Z", rescheduled_from_id: null }], error: null }];
    const [item] = (await buildOwnerRecap(fake(), { organizationId: ORG, callId: CALL, timezone: TZ, since: SINCE }))!;
    expect(item.customer.startsWith("Jane Smith")).toBe(true);
    expect(item.customer).not.toMatch(/[\n​]/);
    expect(Array.from(item.customer).length).toBeLessThanOrEqual(80);
  });

  it("a booking made on the call is 'booked'; an audited row that can't be read is left out and logged", async () => {
    queues.appointment_events = [events([[A, "created"], [NEW, "cancelled"]])];
    queues.appointments = [{ data: [{ id: A, attendee_name: "Bob", start_time: "2026-10-26T01:30:00Z", rescheduled_from_id: null }], error: null }];
    const items = await buildOwnerRecap(fake(), { organizationId: ORG, callId: CALL, timezone: TZ, since: SINCE });
    expect(items).toEqual([{ change: "booked", customer: "Bob", when: "Monday, October 26 at 12:30 PM", told: "not_told" }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("audited appointment is missing"), expect.objectContaining({ appointmentId: NEW }));
  });

  it("any failed read is null — a failure to report, never 'no changes'", async () => {
    const fail = { data: null, error: { code: "57014" } };
    for (const failAt of ["appointment_events", "appointments0", "appointments1", "appointment_confirmations"]) {
      queues = {
        appointment_events: [failAt === "appointment_events" ? fail : events([[NEW, "rescheduled"]])],
        appointments: [
          failAt === "appointments0" ? fail : { data: [{ id: NEW, attendee_name: "J", start_time: "2026-10-29T03:00:00Z", rescheduled_from_id: OLD }], error: null },
          failAt === "appointments1" ? fail : { data: [{ id: OLD, start_time: "2026-10-27T22:00:00Z" }], error: null },
        ],
        appointment_confirmations: [failAt === "appointment_confirmations" ? fail : { data: [], error: null }],
      };
      expect(await buildOwnerRecap(fake(), { organizationId: ORG, callId: CALL, timezone: TZ, since: SINCE }), failAt).toBeNull();
    }
    expect(console.error).toHaveBeenCalledTimes(4);
  });
});

describe("SCRUM-597 (silent round 2): a change's text is attempted right after it", () => {
  it("a text attempted before the change (an earlier cancellation of a reinstated booking) is never its text; within the skew it is", async () => {
    for (const [attemptAt, told] of [
      ["2026-10-26T04:20:00Z", "not_told"], // 14 minutes before the change: an older text
      ["2026-10-26T04:33:20Z", "texted"], // 35 s before (clock skew): counts
      ["2026-10-26T04:34:10Z", "texted"], // after the change
    ] as const) {
      queues.appointment_events = [events([[A, "cancelled"]])];
      queues.appointments = [{ data: [{ id: A, attendee_name: "Bob", start_time: "2026-10-26T01:30:00Z", rescheduled_from_id: null }], error: null }];
      queues.appointment_confirmations = [{ data: [{ appointment_id: A, idempotency_key: `${A}:sms:cancellation:x`, status: "sent", last_attempt_at: attemptAt }], error: null }];
      const [item] = (await buildOwnerRecap(fake(), { organizationId: ORG, callId: CALL, timezone: TZ, since: SINCE }))!;
      expect(item.told, attemptAt).toBe(told);
    }
    expect(calls("appointment_confirmations").find(([m]) => m === "select")?.[1]).toEqual(["appointment_id, idempotency_key, status, last_attempt_at"]);
  });
});
