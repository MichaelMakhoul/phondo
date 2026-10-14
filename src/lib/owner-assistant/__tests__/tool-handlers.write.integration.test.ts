import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-586: the owner write tools through the REAL performRescheduleLeg /
// buildRescheduleLegFields / cancelSingleAppointment over an in-memory fake that
// behaves like PostgREST where the unit tests' mocks cannot:
//   - an update/insert that never chained .select() resolves data:null (as supabase-js does),
//   - a select returns ONLY the requested columns (a column missing from the owner's
//     select list comes back undefined, and the new leg would silently lose it),
//   - filters really filter, so a write that loses its row-id or org filter hits the
//     bystander rows (another job in the same org, one in another org),
//   - every runAfterResponse thunk is captured and run, so the customer SMS is really
//     scheduled or really suppressed.

type Row = Record<string, any>;
type DbError = { code: string; message: string };
type Logged = {
  table: string;
  op: "select" | "update" | "insert";
  payload?: any;
  cols: string | null;
  filters: Array<[string, string, unknown]>;
};

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    log: [] as Logged[],
    failNextInsert: null as null | DbError,
    /** One entry per update, in order: null = apply it, an error = refuse it. */
    updateFaults: [] as Array<null | DbError>,
    thunks: [] as Array<() => Promise<unknown>>,
    nextId: 1,
  };
  return { state };
});

function splitCols(cols: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cols) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// PostgREST embeds a related row through the foreign key: service_types(name) <- service_type_id.
const EMBEDS: Record<string, string> = { service_types: "service_type_id", practitioners: "practitioner_id" };
function embed(row: Row, rel: string): Row | null {
  const fk = EMBEDS[rel];
  if (!fk || row[fk] == null) return null;
  const hit = (h.state.tables[rel] ?? []).find((r) => r.id === row[fk]);
  return hit ? { name: hit.name } : null;
}
function project(row: Row, cols: string): Row {
  const parts = splitCols(cols);
  const out: Row = parts.includes("*") ? { ...row } : {};
  for (const p of parts) {
    if (p === "*") continue;
    const key = p.split("(")[0].trim();
    out[key] = p.includes("(") ? embed(row, key) : row[key];
  }
  return out;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Logged = { table, op: "select", cols: null, filters: [] };
      let single = false;
      let maybe = false;
      const b: any = {
        select: (c?: string) => { q.cols = c ?? "*"; return b; },
        update: (p: unknown) => { q.op = "update"; q.payload = p; return b; },
        insert: (p: unknown) => { q.op = "insert"; q.payload = p; return b; },
        eq: (c: string, v: unknown) => { q.filters.push(["eq", c, v]); return b; },
        in: (c: string, v: unknown) => { q.filters.push(["in", c, v]); return b; },
        order: () => b, limit: () => b, gte: () => b, lt: () => b, not: () => b,
        single: () => { single = true; return b; },
        maybeSingle: () => { single = true; maybe = true; return b; },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          h.state.log.push(q);
          const rows = (h.state.tables[table] ??= []);
          const match = (r: Row) => q.filters.every(([k, c, v]) => (k === "eq" ? r[c] === v : (v as unknown[]).includes(r[c])));
          let result: { data: unknown; error: unknown };
          if (q.op === "select") {
            const hit = rows.filter(match).map((r) => project(r, q.cols ?? "*"));
            result = single
              ? hit[0] ? { data: hit[0], error: null } : maybe ? { data: null, error: null } : { data: null, error: { code: "PGRST116", message: "0 rows" } }
              : { data: hit, error: null };
          } else if (q.op === "update") {
            const fault = h.state.updateFaults.shift();
            if (fault) {
              result = { data: null, error: fault };
            } else {
              const hit = rows.filter(match);
              for (const r of hit) Object.assign(r, q.payload);
              result = { data: q.cols ? hit.map((r) => project(r, q.cols!)) : null, error: null }; // no .select() => no representation
            }
          } else {
            const fail = h.state.failNextInsert;
            if (fail) { h.state.failNextInsert = null; result = { data: null, error: fail }; }
            else {
              const row = { id: `new-leg-${h.state.nextId++}`, ...(q.payload as Row) };
              rows.push(row);
              result = { data: q.cols ? project(row, q.cols) : null, error: null };
            }
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/security/rate-limiter", () => ({ rateLimitDistributed: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn((work: () => Promise<unknown>) => { h.state.thunks.push(work); }) }));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn(async () => {}) }));
vi.mock("@/lib/sms/caller-sms", () => ({ sendCancellationSMS: vi.fn(async () => {}), sendAppointmentConfirmationSMS: vi.fn(async () => ({ sent: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), withScope: vi.fn() }));

import { sendCancellationSMS } from "@/lib/sms/caller-sms";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import { rateLimitDistributed } from "@/lib/security/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";
import { cancelSingleAppointment } from "@/lib/calendar/tool-handlers";
import { handleOwnerRescheduleAppointment, handleOwnerCancelAppointment } from "../tool-handlers";

const ORG = "11111111-2222-4333-a444-555555555555";
const OTHER_ORG = "99999999-8888-4777-a666-555555555555";
const APPT = "44444444-5555-4666-8777-888888888888";
const CALL = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const ctx = { callId: CALL };
const NOW = new Date("2026-10-15T03:00:00Z");

const seedAppointment = (patch: Row = {}): Row => ({
  id: APPT, organization_id: ORG, provider: "internal", external_id: null, metadata: { source: "voice_call" },
  confirmation_code: "123456", attendee_name: "Jane Smith", attendee_first_name: "Jane", attendee_last_name: "Smith",
  attendee_phone: "+61412345678", attendee_email: "jane@example.com", notes: "gate code 1234",
  start_time: "2026-10-15T23:00:00+00:00", end_time: "2026-10-16T00:30:00+00:00", duration_minutes: 90,
  status: "confirmed", service_type_id: "svc-1", practitioner_id: "prac-1", ...patch,
});
const apptRows = () => h.state.tables.appointments;
const untouchedBystanders = () => {
  const [, sameOrg, otherOrg] = h.state.tables.appointments.slice(0, 3);
  expect(sameOrg).toMatchObject({ id: "bystander-same-org", status: "confirmed", start_time: "2026-10-15T23:00:00+00:00" });
  expect(otherOrg).toMatchObject({ id: "bystander-other-org", status: "confirmed", start_time: "2026-10-15T23:00:00+00:00" });
};
const runThunks = async () => { for (const t of h.state.thunks.splice(0)) await t(); };
const writes = () => h.state.log.filter((q) => q.op !== "select");
/** The [ALERT:*] lines pageSentry printed — what pages on-call in production. */
const alertLines = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[ALERT:"));

beforeEach(() => {
  vi.clearAllMocks();
  h.state.log = []; h.state.thunks = []; h.state.failNextInsert = null; h.state.updateFaults = []; h.state.nextId = 1;
  h.state.tables = {
    organizations: [{ id: ORG, timezone: "Australia/Sydney", business_hours: {}, default_appointment_duration: 30 }],
    // Two bystanders: another job in the same org and one in another org. A write that loses its
    // row-id / org filter would move or cancel them too.
    appointments: [
      seedAppointment(),
      seedAppointment({ id: "bystander-same-org", confirmation_code: "222222" }),
      seedAppointment({ id: "bystander-other-org", organization_id: OTHER_ORG, confirmation_code: "333333" }),
    ],
    appointment_events: [],
    service_types: [{ id: "svc-1", name: "Hot water repair" }],
    practitioners: [{ id: "prac-1", name: "Dave" }],
  };
  vi.useFakeTimers({ now: NOW });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("owner_reschedule_appointment through the real reschedule core", () => {
  it("frees the old row, inserts the new leg carrying EVERY field of the booking, and audits it on the call", async () => {
    const r = await handleOwnerRescheduleAppointment(ORG, { appointment_id: APPT, new_datetime: "2026-10-17T09:00", confirmed: true }, ctx);

    expect(r.success).toBe(true);
    const oldRow = apptRows()[0];
    const newLeg = apptRows()[3]; // appended after the two bystanders
    expect(oldRow.status).toBe("rescheduled");
    untouchedBystanders();
    expect(newLeg).toMatchObject({
      organization_id: ORG, provider: "internal", status: "confirmed", rescheduled_from_id: APPT, call_id: CALL,
      metadata: { source: "owner_voice", call_id: CALL, rescheduled_from: APPT },
      start_time: "2026-10-16T22:00:00.000Z", end_time: "2026-10-16T23:30:00.000Z", // 90 minutes kept
      attendee_name: "Jane Smith", attendee_first_name: "Jane", attendee_last_name: "Smith",
      attendee_phone: "+61412345678", attendee_email: "jane@example.com", notes: "gate code 1234",
      service_type_id: "svc-1", practitioner_id: "prac-1", duration_minutes: 90,
    });
    expect(newLeg.confirmation_code).toMatch(/^\d{6}$/);
    expect(newLeg.confirmation_code).not.toBe("123456");
    expect((r.data as any).new_appointment_id).toBe(newLeg.id);
    expect(h.state.tables.appointment_events).toEqual([
      expect.objectContaining({
        appointment_id: newLeg.id, organization_id: ORG, event_type: "rescheduled", actor_type: "staff", actor_id: null, channel: "voice", call_id: CALL,
        changed_fields: [expect.objectContaining({ field: "time" })],
      }),
    ]);
    await runThunks();
    expect(invalidateVoiceScheduleCache).toHaveBeenCalledWith(ORG);
    expect(sendCancellationSMS).not.toHaveBeenCalled();
    expect(alertLines()).toEqual([]);
  });

  it("a slot clash restores the old row to its prior status (pending stays pending) and reports slot_taken", async () => {
    h.state.tables.appointments[0] = seedAppointment({ status: "pending" });
    h.state.failNextInsert = { code: "23P01", message: "overlap" };

    const r = await handleOwnerRescheduleAppointment(ORG, { appointment_id: APPT, new_datetime: "2026-10-17T09:00", confirmed: true }, ctx);

    expect((r.data as any).outcome).toBe("slot_taken");
    expect(apptRows()).toHaveLength(3); // no new leg
    expect(apptRows()[0].status).toBe("pending"); // restored — the customer keeps the job
    untouchedBystanders();
    expect(h.state.tables.appointment_events).toEqual([]);
  });

  it("an orphaned move is paged ONCE, by the core (source owner_voice, the owner's call), and the owner is told to check it", async () => {
    h.state.failNextInsert = { code: "XX000", message: "insert refused" };
    h.state.updateFaults = [null, { code: "08006", message: "conn reset" }]; // the free lands, the restore does not

    const r = await handleOwnerRescheduleAppointment(ORG, { appointment_id: APPT, new_datetime: "2026-10-17T09:00", confirmed: true }, ctx);

    expect(r).toMatchObject({ success: false, error: true });
    expect(r.message).toContain("Jane Smith's Friday, October 16 at 10:00 AM job needs a manual check in the dashboard");
    expect(apptRows()[0].status).toBe("rescheduled"); // stranded, which is what the page is for
    const lines = alertLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[ALERT:error] [next-api] Reschedule rollback failed (orphaned old leg)");
    expect(lines[0]).toContain("reason=reschedule-leg-orphaned");
    expect(lines[0]).toContain("source=owner_voice");
    expect(lines[0]).toContain(`callId=${CALL}`);
    expect(lines[0]).toContain(`oldId=${APPT}`);
    expect(h.state.tables.appointment_events).toEqual([]);
  });

  it("another org's id is 'can't find' and nothing is written", async () => {
    h.state.tables.appointments[0] = seedAppointment({ organization_id: OTHER_ORG });
    const r = await handleOwnerRescheduleAppointment(ORG, { appointment_id: APPT, new_datetime: "2026-10-17T09:00", confirmed: true }, ctx);
    expect((r.data as any).outcome).toBe("not_found");
    expect(writes()).toEqual([]);
  });
});

describe("owner_cancel_appointment through the real cancelSingleAppointment", () => {
  it("cancels the looked-up job (org-scoped, active-only write), audits it, refreshes the voice cache and NEVER texts the customer", async () => {
    const r = await handleOwnerCancelAppointment(ORG, { appointment_id: APPT, confirmed: true, reason: "rang to cancel" }, ctx);

    expect(r.success).toBe(true);
    expect(apptRows()[0].status).toBe("cancelled");
    untouchedBystanders();
    const [cancelWrite] = writes();
    expect(cancelWrite.filters).toEqual([
      ["eq", "id", APPT],
      ["eq", "organization_id", ORG],
      ["in", "status", ["confirmed", "pending"]],
    ]);
    expect(h.state.tables.appointment_events).toEqual([
      expect.objectContaining({ appointment_id: APPT, event_type: "cancelled", actor_type: "staff", channel: "voice", call_id: CALL, note: "rang to cancel" }),
    ]);
    await runThunks(); // run every after-response job the cancel scheduled
    expect(invalidateVoiceScheduleCache).toHaveBeenCalledWith(ORG);
    expect(sendCancellationSMS).not.toHaveBeenCalled();
  });

  it("a move that lands between the lookup and the cancel is not overwritten: 'already changed', no audit, no refresh", async () => {
    // The rate-limit check runs after the lookup and before the write: the job moves then.
    vi.mocked(rateLimitDistributed).mockImplementationOnce(async () => {
      apptRows()[0].status = "rescheduled";
      return { allowed: true } as Awaited<ReturnType<typeof rateLimitDistributed>>;
    });

    const r = await handleOwnerCancelAppointment(ORG, { appointment_id: APPT, confirmed: true }, ctx);

    expect(r).toEqual({
      success: false,
      message: "That booking has already changed — I haven't cancelled anything.",
      data: { outcome: "not_found", appointment_id: APPT, customer_notified: false },
    });
    expect(apptRows()[0].status).toBe("rescheduled"); // the superseded leg is left as the move left it
    untouchedBystanders();
    expect(h.state.tables.appointment_events).toEqual([]);
    expect(h.state.thunks).toEqual([]);
    expect(sendCancellationSMS).not.toHaveBeenCalled();
  });

  it("control: the same row cancelled the CUSTOMER way does schedule the cancellation text (so the assertion above can fail)", async () => {
    await cancelSingleAppointment(createAdminClient(), ORG, apptRows()[0], "caller asked");
    await runThunks();
    expect(sendCancellationSMS).toHaveBeenCalledTimes(1);
    expect(sendCancellationSMS).toHaveBeenCalledWith(ORG, "+61412345678", expect.any(Date), expect.any(String), APPT);
  });

  it("another org's id is 'can't find' and nothing is written", async () => {
    h.state.tables.appointments[0] = seedAppointment({ organization_id: OTHER_ORG });
    const r = await handleOwnerCancelAppointment(ORG, { appointment_id: APPT, confirmed: true }, ctx);
    expect((r.data as any).outcome).toBe("not_found");
    expect(r.error).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(apptRows()[0].status).toBe("confirmed");
  });

  it("a read-back changes nothing and spends no rate limit", async () => {
    await handleOwnerCancelAppointment(ORG, { appointment_id: APPT, confirmed: false }, ctx);
    await handleOwnerRescheduleAppointment(ORG, { appointment_id: APPT, new_datetime: "2026-10-17T09:00", confirmed: false }, ctx);
    expect(rateLimitDistributed).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
});
