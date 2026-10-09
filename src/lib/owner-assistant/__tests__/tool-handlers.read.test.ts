import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-586: owner read tools. Pins: org scoping in the SQL, active-only
// statuses, org-local day bounds, ids in `data`, owner calls and summary-less
// calls filtered out of "messages", DB faults → errorResult (error:true).

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { OWNER_TOOL_NAMES, handleOwnerListAppointments, handleOwnerListMessages } from "../tool-handlers";

type Res = { data: unknown; error: { message?: string; code?: string } | null; count?: number | null };
type Op = { table: string; filters: Array<{ name: string; args: unknown[] }> };

const db = { log: [] as Op[], queues: {} as Record<string, Res[]> };
function fakeAdmin() {
  return {
    from: (table: string) => {
      const ctx: Op = { table, filters: [] };
      const res = () => db.queues[table]?.shift() ?? { data: [], error: null, count: 0 };
      const b: any = {};
      for (const name of ["select", "eq", "in", "gte", "lt", "order", "limit"]) {
        b[name] = (...args: unknown[]) => { ctx.filters.push({ name, args }); return b; };
      }
      b.single = async () => { db.log.push(ctx); return res(); };
      b.maybeSingle = b.single;
      b.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) => {
        db.log.push(ctx);
        return Promise.resolve(res()).then(resolve, reject);
      };
      return b;
    },
  };
}
const filter = (op: Op, name: string) => op.filters.filter((f) => f.name === name).map((f) => f.args);
/** A DB fault is logged on purpose; keep the test output clean and let the test assert the log. */
const silenceErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

const ORG = "11111111-2222-4333-a444-555555555555";
const TZ = "Australia/Sydney";
const NOW = new Date("2026-10-15T03:00:00Z"); // Thu 2026-10-15 14:00 AEDT (Wed 2026-10-14 23:00 in New York)

const ROW = {
  id: "44444444-5555-4666-8777-888888888888",
  confirmation_code: "123456",
  start_time: "2026-10-15T23:00:00+00:00", // Fri 16 Oct 10:00 AEDT
  end_time: "2026-10-16T00:00:00+00:00",
  status: "confirmed",
  attendee_name: "Jane Smith",
  attendee_phone: "+61412345678",
  notes: "gate code 1234",
  service_types: { name: "Hot water repair" },
  practitioners: { name: "Dave" },
};

beforeEach(() => {
  db.log = [];
  db.queues = { organizations: [{ data: { timezone: TZ }, error: null }] };
  vi.mocked(createAdminClient).mockReset().mockReturnValue(fakeAdmin() as any);
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("owner_list_appointments", () => {
  it("lists tomorrow's active jobs, org-scoped, with ids in data and a model-readable message", async () => {
    db.queues.appointments = [{ data: [ROW], error: null, count: 1 }];

    const r = await handleOwnerListAppointments(ORG, { range: "tomorrow" });

    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    const q = db.log.find((o) => o.table === "appointments")!;
    expect(filter(q, "eq")).toEqual([["organization_id", ORG]]);
    expect(filter(q, "in")).toEqual([["status", ["confirmed", "pending"]]]);
    expect(filter(q, "gte")).toEqual([["start_time", "2026-10-15T13:00:00.000Z"]]);
    expect(filter(q, "lt")).toEqual([["start_time", "2026-10-16T13:00:00.000Z"]]);
    expect(filter(q, "limit")).toEqual([[20]]);
    expect(filter(q, "select")[0][1]).toEqual({ count: "exact" });
    expect(r.data).toEqual({
      range: "tomorrow",
      date: "2026-10-16",
      count: 1,
      appointments: [{
        appointment_id: ROW.id,
        confirmation_code: "123456",
        start_local: "2026-10-16T10:00",
        end_local: "2026-10-16T11:00",
        when: "Friday, October 16 at 10:00 AM",
        customer_name: "Jane Smith",
        customer_phone: "+61412345678",
        service: "Hot water repair",
        practitioner: "Dave",
        notes: "gate code 1234",
        status: "confirmed",
      }],
    });
    expect(r.message).toContain("1 job tomorrow");
    expect(r.message).toContain("Friday, October 16 at 10:00 AM: Jane Smith");
    expect(r.message).toContain("Hot water repair");
    expect(r.message).toContain(`(id ${ROW.id})`);
  });

  it("says when nothing is booked", async () => {
    db.queues.appointments = [{ data: [], error: null, count: 0 }];
    const r = await handleOwnerListAppointments(ORG, { range: "today" });
    expect(r.success).toBe(true);
    expect(r.message).toBe("Nothing booked today.");
    expect((r.data as any).count).toBe(0);
  });

  it("notes when more than 20 are booked (count beyond the listed rows)", async () => {
    db.queues.appointments = [{ data: Array.from({ length: 20 }, (_, i) => ({ ...ROW, id: `${i}`.padStart(8, "0") + "-0000-4000-8000-000000000000" })), error: null, count: 23 }];
    const r = await handleOwnerListAppointments(ORG, { range: "this_week" });
    expect(r.message).toContain("23 jobs over the next 7 days (first 20 listed)");
    expect((r.data as any).count).toBe(23);
    expect((r.data as any).appointments).toHaveLength(20);
  });

  it("range=date needs a YYYY-MM-DD date; a bad range is refused — both without querying", async () => {
    const noDate = await handleOwnerListAppointments(ORG, { range: "date" });
    expect(noDate.success).toBe(false);
    expect(noDate.error).toBeUndefined();
    expect(noDate.message).toContain("year-month-day");
    const badRange = await handleOwnerListAppointments(ORG, { range: "next_month" });
    expect(badRange.success).toBe(false);
    expect(db.log.filter((o) => o.table === "appointments")).toHaveLength(0);
  });

  it("a DB fault is a genuine error (error:true), never an empty day", async () => {
    silenceErrors();
    db.queues.appointments = [{ data: null, error: { message: "boom" }, count: null }];
    const r = await handleOwnerListAppointments(ORG, { range: "today" });
    expect(r).toMatchObject({ success: false, error: true });
  });

  it("logs a DB fault with the org instead of swallowing it", async () => {
    const errors = silenceErrors();
    db.queues.appointments = [{ data: null, error: { message: "boom" }, count: null }];
    await handleOwnerListAppointments(ORG, { range: "today" });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("[owner-assistant]"),
      expect.objectContaining({ organizationId: ORG, error: { message: "boom" } })
    );
  });

  it("a fault is never mistaken for an empty day: no data, no 'nothing booked'", async () => {
    silenceErrors();
    db.queues.appointments = [{ data: null, error: { message: "boom" }, count: null }];
    const r = await handleOwnerListAppointments(ORG, { range: "today" });
    expect(r.data).toBeUndefined();
    expect(r.message).not.toMatch(/nothing booked/i);
  });

  it.each([
    ["today", undefined, "2026-10-14T13:00:00.000Z", "2026-10-15T13:00:00.000Z", "2026-10-15", "Nothing booked today."],
    ["this_week", undefined, "2026-10-14T13:00:00.000Z", "2026-10-21T13:00:00.000Z", "2026-10-15", "Nothing booked over the next 7 days."],
    ["date", "2026-11-02", "2026-11-01T13:00:00.000Z", "2026-11-02T13:00:00.000Z", "2026-11-02", "Nothing booked on Monday, November 2."],
  ])("range=%s (date %s) queries the org-local window %s → %s, soonest first", async (range, date, gte, lt, firstDate, empty) => {
    db.queues.appointments = [{ data: [], error: null, count: 0 }];
    const r = await handleOwnerListAppointments(ORG, { range, date });
    const q = db.log.find((o) => o.table === "appointments")!;
    expect(filter(q, "gte")).toEqual([["start_time", gte]]);
    expect(filter(q, "lt")).toEqual([["start_time", lt]]);
    expect(filter(q, "order")).toEqual([["start_time", { ascending: true }]]);
    expect(r.message).toBe(empty);
    expect(r.data).toEqual({ range, date: firstDate, count: 0, appointments: [] });
  });

  it("reads the timezone from the caller's own organization row", async () => {
    db.queues.appointments = [{ data: [], error: null, count: 0 }];
    await handleOwnerListAppointments(ORG, { range: "today" });
    const orgQuery = db.log.find((o) => o.table === "organizations")!;
    expect(filter(orgQuery, "select")).toEqual([["timezone"]]);
    expect(filter(orgQuery, "eq")).toEqual([["id", ORG]]);
  });

  it("works in the org's own zone, not Sydney's or the server's", async () => {
    // 03:00Z is still Wed 14 Oct 23:00 in New York (EDT, UTC-4).
    db.queues.organizations = [{ data: { timezone: "America/New_York" }, error: null }];
    db.queues.appointments = [{
      data: [{ ...ROW, start_time: "2026-10-15T01:30:00+00:00", end_time: "2026-10-15T02:30:00+00:00" }],
      error: null,
      count: 1,
    }];

    const r = await handleOwnerListAppointments(ORG, { range: "today" });

    const q = db.log.find((o) => o.table === "appointments")!;
    expect(filter(q, "gte")).toEqual([["start_time", "2026-10-14T04:00:00.000Z"]]);
    expect(filter(q, "lt")).toEqual([["start_time", "2026-10-15T04:00:00.000Z"]]);
    expect((r.data as any).date).toBe("2026-10-14");
    expect((r.data as any).appointments[0]).toMatchObject({
      start_local: "2026-10-14T21:30",
      end_local: "2026-10-14T22:30",
      when: "Wednesday, October 14 at 9:30 PM",
    });
  });

  it.each([[null], [""]])("an org with no timezone (%j) is read as Australia/Sydney, never UTC", async (timezone) => {
    db.queues.organizations = [{ data: { timezone }, error: null }];
    db.queues.appointments = [{ data: [], error: null, count: 0 }];

    await handleOwnerListAppointments(ORG, { range: "today" });

    const q = db.log.find((o) => o.table === "appointments")!;
    // The UTC day would be 2026-10-15T00:00Z → 2026-10-16T00:00Z.
    expect(filter(q, "gte")).toEqual([["start_time", "2026-10-14T13:00:00.000Z"]]);
    expect(filter(q, "lt")).toEqual([["start_time", "2026-10-15T13:00:00.000Z"]]);
  });

  it("a failed timezone lookup is a genuine error, and the day is not guessed", async () => {
    const errors = silenceErrors();
    db.queues.organizations = [{ data: null, error: { message: "boom" } }];

    const r = await handleOwnerListAppointments(ORG, { range: "today" });

    expect(r).toMatchObject({ success: false, error: true });
    expect(db.log.filter((o) => o.table === "appointments")).toHaveLength(0);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("[owner-assistant]"),
      expect.objectContaining({ organizationId: ORG })
    );
  });

  it("shows a pending job flagged, copes with array/null embeds and missing optional fields", async () => {
    const pending = {
      ...ROW,
      id: "55555555-6666-4777-8888-999999999999",
      confirmation_code: null,
      end_time: null,
      status: "pending",
      attendee_phone: null,
      notes: null,
      service_types: [{ name: "Quote visit" }], // PostgREST can embed a to-one relation as an array
      practitioners: null,
    };
    db.queues.appointments = [{ data: [pending], error: null, count: 1 }];

    const r = await handleOwnerListAppointments(ORG, { range: "tomorrow" });

    expect((r.data as any).appointments).toEqual([{
      appointment_id: pending.id,
      confirmation_code: null,
      start_local: "2026-10-16T10:00",
      end_local: null,
      when: "Friday, October 16 at 10:00 AM",
      customer_name: "Jane Smith",
      customer_phone: null,
      service: "Quote visit",
      practitioner: null,
      notes: null,
      status: "pending",
    }]);
    expect(r.message).toContain(`Jane Smith — Quote visit [pending] (id ${pending.id})`);
  });

  it("reads the service and practitioner whether PostgREST embeds them as objects or one-element arrays", async () => {
    db.queues.appointments = [{
      data: [{ ...ROW, service_types: [{ name: "Hot water repair" }], practitioners: [{ name: "Dave" }] }],
      error: null,
      count: 1,
    }];
    const r = await handleOwnerListAppointments(ORG, { range: "tomorrow" });
    expect((r.data as any).appointments[0]).toMatchObject({ service: "Hot water repair", practitioner: "Dave" });
  });

  it("always hands the model a string customer name, even for a row that somehow has none", async () => {
    db.queues.appointments = [{ data: [{ ...ROW, attendee_name: null }], error: null, count: 1 }];
    const r = await handleOwnerListAppointments(ORG, { range: "tomorrow" });
    expect((r.data as any).appointments[0].customer_name).toBe("Unknown");
  });

  it("puts the practitioner, phone and notes in the spoken line", async () => {
    db.queues.appointments = [{ data: [ROW], error: null, count: 1 }];
    const r = await handleOwnerListAppointments(ORG, { range: "tomorrow" });
    expect(r.message).toContain("Jane Smith — Hot water repair with Dave (+61412345678) — notes: gate code 1234 (id ");
  });

  it("falls back to the listed rows when the API sends no count", async () => {
    db.queues.appointments = [{ data: [ROW], error: null, count: null }];
    const r = await handleOwnerListAppointments(ORG, { range: "tomorrow" });
    expect((r.data as any).count).toBe(1);
    expect(r.message).toContain("1 job tomorrow");
  });

  it.each([
    ["no range at all", { range: undefined }],
    ["an invented range", { range: "next_month" }],
    ["a range with different casing", { range: "Today" }],
  ])("%s is refused as a non-success before touching the database", async (_label, args) => {
    const r = await handleOwnerListAppointments(ORG, args);
    expect(r.success).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.message).toContain("today, tomorrow, this week");
    expect(db.log).toHaveLength(0);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing date", undefined],
    ["a malformed date", "2/11/2026"],
    ["an impossible date", "2026-02-30"],
  ])("range=date with %s asks for a date and does not query appointments", async (_label, date) => {
    const r = await handleOwnerListAppointments(ORG, { range: "date", date });
    expect(r.success).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.message).toContain("year-month-day");
    expect(db.log.filter((o) => o.table === "appointments")).toHaveLength(0);
  });
});

describe("owner_list_messages", () => {
  it("returns pending callbacks (newest first, ≤10) and today's customer calls with a summary (≤10), skipping owner calls", async () => {
    db.queues.callback_requests = [{
      data: [{ id: "cb-1", caller_name: "Bob", caller_phone: "+61400000001", reason: "quote for a bathroom", requested_time: null, urgency: "high", created_at: "2026-10-15T01:00:00+00:00" }],
      error: null,
    }];
    db.queues.calls = [{
      data: [
        { id: "c-owner", caller_name: "Dave", caller_phone: "+61499999999", summary: "Owner checked tomorrow", created_at: "2026-10-15T02:30:00+00:00", metadata: { call_type: "owner" } },
        { id: "c-nosummary", caller_name: null, caller_phone: "+61400000002", summary: null, created_at: "2026-10-15T02:00:00+00:00", metadata: {} },
        { id: "c-1", caller_name: "Sue", caller_phone: "+61400000003", summary: "Blocked drain, wants Thursday", created_at: "2026-10-15T01:30:00+00:00", metadata: null },
      ],
      error: null,
    }];

    const r = await handleOwnerListMessages(ORG);

    expect(r.success).toBe(true);
    const cbq = db.log.find((o) => o.table === "callback_requests")!;
    expect(filter(cbq, "eq")).toEqual([["organization_id", ORG], ["status", "pending"]]);
    expect(filter(cbq, "order")).toEqual([["created_at", { ascending: false }]]);
    expect(filter(cbq, "limit")).toEqual([[10]]);
    const cq = db.log.find((o) => o.table === "calls")!;
    expect(filter(cq, "eq")).toEqual([["organization_id", ORG]]);
    expect(filter(cq, "gte")).toEqual([["created_at", "2026-10-14T13:00:00.000Z"]]);
    expect(filter(cq, "lt")).toEqual([["created_at", "2026-10-15T13:00:00.000Z"]]);
    expect(r.data).toEqual({
      callbacks: [{
        callback_id: "cb-1", caller_name: "Bob", caller_phone: "+61400000001", reason: "quote for a bathroom",
        requested: null, urgency: "high", received: "Thursday, October 15 at 12:00 PM",
      }],
      calls: [{ call_id: "c-1", at: "Thursday, October 15 at 12:30 PM", caller_name: "Sue", caller_phone: "+61400000003", summary: "Blocked drain, wants Thursday" }],
    });
    expect(r.message).toContain("1 callback waiting");
    expect(r.message).toContain("Bob");
    expect(r.message).toContain("1 customer call today");
    expect(r.message).not.toContain("Owner checked tomorrow");
  });

  it("says so when there is nothing", async () => {
    db.queues.callback_requests = [{ data: [], error: null }];
    db.queues.calls = [{ data: [], error: null }];
    const r = await handleOwnerListMessages(ORG);
    expect(r.success).toBe(true);
    expect(r.message).toBe("No messages waiting and no customer calls yet today.");
  });

  it("a DB fault on either query is a genuine error", async () => {
    silenceErrors();
    db.queues.callback_requests = [{ data: null, error: { message: "boom" } }];
    const r = await handleOwnerListMessages(ORG);
    expect(r).toMatchObject({ success: false, error: true });
  });

  it("a fault on the calls query is a genuine error too — never a half answer from the callbacks alone", async () => {
    const errors = silenceErrors();
    db.queues.callback_requests = [{ data: [{ id: "cb-1", caller_name: "Bob", caller_phone: "+61400000001", reason: "quote", requested_time: null, urgency: "low", created_at: "2026-10-15T01:00:00+00:00" }], error: null }];
    db.queues.calls = [{ data: null, error: { message: "boom" } }];

    const r = await handleOwnerListMessages(ORG);

    expect(r).toMatchObject({ success: false, error: true });
    expect(r.data).toBeUndefined();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("[owner-assistant]"),
      expect.objectContaining({ organizationId: ORG, error: { message: "boom" } })
    );
  });

  it("logs a callbacks fault with the org instead of swallowing it", async () => {
    const errors = silenceErrors();
    db.queues.callback_requests = [{ data: null, error: { message: "boom" } }];
    await handleOwnerListMessages(ORG);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("[owner-assistant]"),
      expect.objectContaining({ organizationId: ORG, error: { message: "boom" } })
    );
  });

  it("a failed timezone lookup is a genuine error and nothing is queried on a guessed day", async () => {
    silenceErrors();
    db.queues.organizations = [{ data: null, error: { message: "boom" } }];

    const r = await handleOwnerListMessages(ORG);

    expect(r).toMatchObject({ success: false, error: true });
    expect(db.log.filter((o) => o.table !== "organizations")).toHaveLength(0);
  });

  it("an org with no timezone is read as Australia/Sydney, never UTC", async () => {
    db.queues.organizations = [{ data: { timezone: null }, error: null }];
    db.queues.callback_requests = [{ data: [], error: null }];
    db.queues.calls = [{ data: [], error: null }];

    await handleOwnerListMessages(ORG);

    const cq = db.log.find((o) => o.table === "calls")!;
    expect(filter(cq, "gte")).toEqual([["created_at", "2026-10-14T13:00:00.000Z"]]);
    expect(filter(cq, "lt")).toEqual([["created_at", "2026-10-15T13:00:00.000Z"]]);
  });

  it("'today' and the spoken times are the org's own, not Sydney's", async () => {
    // 03:00Z is still Wed 14 Oct 23:00 in New York (EDT, UTC-4).
    db.queues.organizations = [{ data: { timezone: "America/New_York" }, error: null }];
    db.queues.callback_requests = [{ data: [], error: null }];
    db.queues.calls = [{
      data: [{ id: "c-1", caller_name: "Sue", caller_phone: "+15550100", summary: "Leaking tap", created_at: "2026-10-15T01:30:00+00:00", metadata: {} }],
      error: null,
    }];

    const r = await handleOwnerListMessages(ORG);

    const cq = db.log.find((o) => o.table === "calls")!;
    expect(filter(cq, "gte")).toEqual([["created_at", "2026-10-14T04:00:00.000Z"]]);
    expect(filter(cq, "lt")).toEqual([["created_at", "2026-10-15T04:00:00.000Z"]]);
    expect((r.data as any).calls[0].at).toBe("Wednesday, October 14 at 9:30 PM");
  });

  it("spells out when a callback was asked for and how urgent it is", async () => {
    db.queues.callback_requests = [{
      data: [{ id: "cb-2", caller_name: "Amy", caller_phone: "+61400000009", reason: "reschedule inspection", requested_time: "2026-10-16T23:00:00+00:00", urgency: "low", created_at: "2026-10-15T02:00:00+00:00" }],
      error: null,
    }];
    db.queues.calls = [{ data: [], error: null }];

    const r = await handleOwnerListMessages(ORG);

    expect((r.data as any).callbacks[0]).toMatchObject({
      callback_id: "cb-2",
      requested: "Saturday, October 17 at 10:00 AM",
      urgency: "low",
      received: "Thursday, October 15 at 1:00 PM",
    });
    expect(r.message).toContain(
      "- Amy (+61400000009), low urgency: reschedule inspection — wants Saturday, October 17 at 10:00 AM (received Thursday, October 15 at 1:00 PM)"
    );
  });

  it("keeps the newest 10 customer calls after dropping owner and summary-less calls, fetching a wider window first", async () => {
    const customerCalls = Array.from({ length: 12 }, (_, i) => ({
      id: `c-${String(i + 1).padStart(2, "0")}`, // the DB returns newest first: c-01 is the newest
      caller_name: `Caller ${i + 1}`,
      caller_phone: "+61400000100",
      summary: `Summary ${i + 1}`,
      created_at: "2026-10-15T01:00:00+00:00",
      metadata: {},
    }));
    db.queues.callback_requests = [{ data: [], error: null }];
    db.queues.calls = [{
      data: [
        { ...customerCalls[0], id: "c-owner", metadata: { call_type: "owner" } },
        ...customerCalls,
        { ...customerCalls[0], id: "c-nosummary", summary: null },
      ],
      error: null,
    }];

    const r = await handleOwnerListMessages(ORG);

    const cq = db.log.find((o) => o.table === "calls")!;
    expect(filter(cq, "order")).toEqual([["created_at", { ascending: false }]]);
    expect(filter(cq, "limit")).toEqual([[30]]);
    expect((r.data as any).calls.map((c: any) => c.call_id)).toEqual(
      customerCalls.slice(0, 10).map((c) => c.id)
    );
    expect(r.message).toContain("10 customer calls today");
  });

  it("trims summaries and drops blank ones", async () => {
    db.queues.callback_requests = [{ data: [], error: null }];
    db.queues.calls = [{
      data: [
        { id: "c-blank", caller_name: "A", caller_phone: "+61400000001", summary: "  \n ", created_at: "2026-10-15T01:00:00+00:00", metadata: {} },
        { id: "c-pad", caller_name: "B", caller_phone: "+61400000002", summary: "  Leak under the sink \n", created_at: "2026-10-15T01:00:00+00:00", metadata: {} },
      ],
      error: null,
    }];

    const r = await handleOwnerListMessages(ORG);

    expect((r.data as any).calls).toEqual([
      { call_id: "c-pad", at: "Thursday, October 15 at 12:00 PM", caller_name: "B", caller_phone: "+61400000002", summary: "Leak under the sink" },
    ]);
  });

  it("names a caller with no name or number as an unknown caller", async () => {
    db.queues.callback_requests = [{ data: [], error: null }];
    db.queues.calls = [{
      data: [{ id: "c-1", caller_name: null, caller_phone: null, summary: "Hung up after the greeting", created_at: "2026-10-15T01:30:00+00:00", metadata: {} }],
      error: null,
    }];

    const r = await handleOwnerListMessages(ORG);

    expect((r.data as any).calls[0]).toMatchObject({ caller_name: null, caller_phone: null });
    expect(r.message).toContain("- Thursday, October 15 at 12:30 PM: Unknown caller — Hung up after the greeting");
  });

  it("reads out callbacks alone, and calls alone, without implying the other side has items", async () => {
    const callback = { id: "cb-1", caller_name: "Bob", caller_phone: "+61400000001", reason: "quote", requested_time: null, urgency: "high", created_at: "2026-10-15T01:00:00+00:00" };
    db.queues.callback_requests = [{ data: [callback], error: null }];
    db.queues.calls = [{ data: [], error: null }];
    const onlyCallbacks = await handleOwnerListMessages(ORG);
    expect(onlyCallbacks.message).toContain("1 callback waiting:");
    expect(onlyCallbacks.message).toContain("0 customer calls today.");

    db.queues.organizations = [{ data: { timezone: TZ }, error: null }];
    db.queues.callback_requests = [{ data: [], error: null }];
    db.queues.calls = [{ data: [{ id: "c-1", caller_name: "Sue", caller_phone: "+61400000003", summary: "Blocked drain", created_at: "2026-10-15T01:30:00+00:00", metadata: {} }], error: null }];
    const onlyCalls = await handleOwnerListMessages(ORG);
    expect(onlyCalls.message).toContain("0 callbacks waiting.");
    expect(onlyCalls.message).toContain("1 customer call today:");
  });
});

describe("org scoping", () => {
  const OTHER_ORG = "99999999-8888-4777-a666-555555555555";

  it.each([
    ["owner_list_appointments", (org: string) => handleOwnerListAppointments(org, { range: "this_week" }), ["appointments", "organizations"]],
    ["owner_list_messages", (org: string) => handleOwnerListMessages(org), ["callback_requests", "calls", "organizations"]],
  ])("%s filters every query to the caller's organization in the SQL itself", async (_tool, run, tables) => {
    db.queues.appointments = [{ data: [ROW], error: null, count: 1 }];
    db.queues.callback_requests = [{ data: [], error: null }];
    db.queues.calls = [{ data: [], error: null }];

    await run(OTHER_ORG);

    expect(db.log.map((o) => o.table).sort()).toEqual(tables);
    for (const op of db.log) {
      const scope = op.table === "organizations" ? ["id", OTHER_ORG] : ["organization_id", OTHER_ORG];
      expect(filter(op, "eq"), `${op.table} query`).toContainEqual(scope);
    }
  });
});

describe("OWNER_TOOL_NAMES", () => {
  it("is exactly the four tool names the voice server declares (cross-PR contract)", () => {
    expect([...OWNER_TOOL_NAMES]).toEqual([
      "owner_list_appointments",
      "owner_list_messages",
      "owner_reschedule_appointment",
      "owner_cancel_appointment",
    ]);
  });
});
