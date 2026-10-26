import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-599 test lens (review round 1): tests that kill the mutants the PR's own suite
// let through — each written from a surviving independent mutant.
// The first block reuses tool-handlers.more-control.test.ts's set-up (a fake that
// records filters but returns whatever is queued). The second block runs the write
// paths over a fake that behaves like PostgREST where that one cannot: a select
// returns ONLY the requested columns, filters and order really apply, and an insert
// or update that never chained .select() resolves data: null (as supabase-js does).

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({ rateLimitDistributed: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn() }));
vi.mock("@/lib/appointments/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/appointments/events")>();
  return { ...actual, recordAppointmentEvent: vi.fn(async () => true) };
});
vi.mock("@/lib/calendar/tool-handlers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/tool-handlers")>();
  return { ...actual, handleBookAppointment: vi.fn(), ownerDiaryProvider: vi.fn(async () => "phondo") };
});
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), withScope: vi.fn() }));
vi.mock("@/lib/sms/caller-sms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/caller-sms")>();
  return { confirmationIdempotencyKey: actual.confirmationIdempotencyKey, sendCancellationSMS: vi.fn(), sendAppointmentConfirmationSMS: vi.fn() };
});
vi.mock("@/lib/observability/page-sentry", () => ({ pageSentry: vi.fn() }));
vi.mock("../customer-call", async (importOriginal) => {
  const real = await importOriginal<typeof import("../customer-call")>();
  return { ...real, checkCustomerCall: vi.fn(), placeCustomerCall: vi.fn() };
});

import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimitDistributed } from "@/lib/security/rate-limiter";
import { runAfterResponse } from "@/lib/utils/after-response";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import { recordAppointmentEvent } from "@/lib/appointments/events";
import { handleBookAppointment, ownerDiaryProvider } from "@/lib/calendar/tool-handlers";
import { sendAppointmentConfirmationSMS } from "@/lib/sms/caller-sms";
import { handleOwnerBookAppointment, handleOwnerBlockTime, handleOwnerMarkCallbackDone } from "../tool-handlers";

type Res = { data: unknown; error: { message?: string; code?: string } | null };
type Op = { table: string; filters: Array<{ name: string; args: unknown[] }>; insert?: Record<string, unknown>; update?: Record<string, unknown> };
const db = { log: [] as Op[], queues: {} as Record<string, Res[]> };
function fakeAdmin() {
  return {
    from: (table: string) => {
      const op: Op = { table, filters: [] };
      const res = () => db.queues[table]?.shift() ?? { data: null, error: null };
      const b: any = {};
      for (const name of ["select", "eq", "in", "order", "limit", "lt", "gt"]) {
        b[name] = (...args: unknown[]) => { op.filters.push({ name, args }); return b; };
      }
      b.insert = (payload: Record<string, unknown>) => { op.insert = payload; return b; };
      b.update = (payload: Record<string, unknown>) => { op.update = payload; return b; };
      b.maybeSingle = async () => { db.log.push(op); return res(); };
      b.single = b.maybeSingle;
      b.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) => {
        db.log.push(op);
        return Promise.resolve(res()).then(resolve, reject);
      };
      return b;
    },
  };
}
const opsOn = (table: string) => db.log.filter((o) => o.table === table);
const filters = (op: Op | undefined, name: string) => (op?.filters ?? []).filter((f) => f.name === name).map((f) => f.args);

const ORG = "11111111-2222-4333-a444-555555555555";
const OTHER_ORG = "22222222-3333-4444-a555-666666666666";
const CALL = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const NEW_ID = "55555555-6666-4777-8888-999999999999";
const CALLBACK = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";
const OWNER_USER = "88888888-9999-4aaa-bbbb-cccccccccccc";
const TZ = "Australia/Sydney";
const NOW = new Date("2026-10-15T03:00:00Z"); // Thu 2026-10-15 14:00 AEDT
const ctx = { callId: CALL };
const AU_ORG = { data: { timezone: TZ, country: "AU" }, error: null };
const START = "2026-10-16T10:00";
const WHEN = "Friday, October 16 at 10:00 AM";
const BOOK = { customer_name: "Jane Smith", customer_phone: "0412 345 678", start: START };
const BOOKED = {
  success: true,
  message: "I've booked your appointment.",
  data: { appointmentId: NEW_ID, confirmationCode: "654321", practitionerName: "Alex" },
};
const DUPLICATE = { success: true, message: "Your appointment is already confirmed…", data: { appointmentId: NEW_ID, confirmationCode: "654321", duplicate: true } };
const BLOCK = { start: "2026-10-16T13:00", end: "2026-10-16T17:00", reason: "Quote visit" };
const PENDING = { id: CALLBACK, caller_name: "Sue Brown", reason: "Blocked drain", created_at: "2026-10-14T22:12:00Z" };

beforeEach(() => {
  db.log = [];
  db.queues = { organizations: [AU_ORG] };
  vi.resetAllMocks();
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin() as any);
  vi.mocked(rateLimitDistributed).mockResolvedValue({ allowed: true } as any);
  vi.mocked(ownerDiaryProvider).mockResolvedValue("phondo");
  vi.mocked(handleBookAppointment).mockResolvedValue(BOOKED as any);
  vi.mocked(recordAppointmentEvent).mockResolvedValue(true);
  vi.mocked(sendAppointmentConfirmationSMS).mockResolvedValue({ sent: true, status: "sent" } as any);
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  delete process.env.CALLER_SMS_ENABLED;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("killers — owner_book_appointment", () => {
  it("K07: a three-word name keeps the whole surname", async () => {
    await handleOwnerBookAppointment(ORG, { ...BOOK, customer_name: "Mary Ann Smith", confirmed: true, notify_customer: "none" }, ctx);
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ first_name: "Mary", last_name: "Ann Smith" });
  });

  it("K08: a same-call duplicate whose row can't be read back (no row, no error) is never 'already booked'", async () => {
    vi.mocked(handleBookAppointment).mockResolvedValueOnce(DUPLICATE as any);
    // The same-call pre-check finds nothing; the re-read of the diary's duplicate finds no row.
    db.queues.appointments = [{ data: [], error: null }, { data: null, error: null }];
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
    expect(r).toMatchObject({ success: false, data: { outcome: "not_booked" } });
    expect(r.message).not.toMatch(/already booked/);
  });

  it("K12: a time a few minutes gone is refused like any past time", async () => {
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, start: "2026-10-15T13:45" }, ctx);
    expect(r).toEqual({ success: false, message: "That time has already passed. When should the job be?", data: { outcome: "invalid_time", customer_notified: false } });
  });

  it("K13 + K15: the diary gets the read-back's notes — one line, capped at 200", async () => {
    await handleOwnerBookAppointment(ORG, { ...BOOK, notes: "Leaking\ntap\u200b", confirmed: true, notify_customer: "none" }, ctx);
    expect(vi.mocked(handleBookAppointment).mock.calls[0][1]).toMatchObject({ notes: "Leaking tap" });
    db.queues.organizations = [AU_ORG];
    await handleOwnerBookAppointment(ORG, { ...BOOK, notes: "n".repeat(300), confirmed: true, notify_customer: "none" }, ctx);
    expect(Array.from(vi.mocked(handleBookAppointment).mock.calls[1][1].notes as string).length).toBeLessThanOrEqual(200);
  });
});

describe("killers — owner_block_time", () => {
  it("K24: midnight to noon is NOT an all-day row", async () => {
    db.queues.blocked_times = [{ data: [], error: null }, { data: { id: "block-1" }, error: null }];
    await handleOwnerBlockTime(ORG, { start: "2026-10-17T00:00", end: "2026-10-17T12:00", confirmed: true }, ctx);
    expect(opsOn("blocked_times")[1].insert).toMatchObject({ all_day: false });
  });

  it("K25: only the JSON boolean true confirms a block", async () => {
    for (const confirmed of ["true", 1, "yes"]) {
      db.queues.organizations = [AU_ORG];
      const r = await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed }, ctx);
      expect(r.data, String(confirmed)).toMatchObject({ outcome: "needs_confirmation" });
    }
    expect(opsOn("blocked_times").some((o) => o.insert)).toBe(false);
    expect(rateLimitDistributed).not.toHaveBeenCalled();
  });

  it("K27: the after-response work really refreshes the voice server's schedule cache", async () => {
    db.queues.blocked_times = [{ data: [], error: null }, { data: { id: "block-1" }, error: null }];
    await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx);
    expect(runAfterResponse).toHaveBeenCalledTimes(1);
    await vi.mocked(runAfterResponse).mock.calls[0][0]();
    expect(invalidateVoiceScheduleCache).toHaveBeenCalledWith(ORG);
  });

  it("K95 + K97: one job in the way reads in the singular on success; the jobs are read earliest first", async () => {
    db.queues.appointments = [{ data: [{ attendee_name: "Bob Lee", start_time: "2026-10-16T02:30:00+00:00" }], error: null }];
    db.queues.blocked_times = [{ data: [], error: null }, { data: { id: "block-1" }, error: null }];
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx);
    expect(r.message).toBe("Blocked out Friday, October 16 from 1:00 PM to 5:00 PM for everyone. The job already booked then is still booked.");
    expect(filters(opsOn("appointments")[0], "order")).toEqual([["start_time", { ascending: true }]]);
  });
});

describe("killers — owner_mark_callback_done", () => {
  it("K31: only the JSON boolean true confirms marking a callback done", async () => {
    for (const confirmed of ["true", 1, "yes"]) {
      db.queues.organizations = [AU_ORG];
      db.queues.callback_requests = [{ data: PENDING, error: null }];
      const r = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, confirmed }, ctx);
      expect(r.data, String(confirmed)).toMatchObject({ outcome: "needs_confirmation" });
    }
    expect(opsOn("callback_requests").some((o) => o.update)).toBe(false);
  });

  it("K37: the owner's note is one line capped at 200", async () => {
    db.queues.callback_requests = [{ data: PENDING, error: null }, { data: [{ id: CALLBACK }], error: null }];
    await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, note: "n".repeat(300), confirmed: true }, ctx);
    expect(Array.from(opsOn("callback_requests")[1].update!.completion_notes as string).length).toBeLessThanOrEqual(200);
  });
});

// ─── The same handlers over a PostgREST-like fake ───────────────────────────────
type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
let nextId = 1;
function project(row: Row, cols: string | null): Row {
  if (cols === null || cols.trim() === "*") return { ...row };
  const out: Row = {};
  for (const c of cols.split(",").map((s) => s.trim()).filter(Boolean)) out[c] = row[c];
  return out;
}
function postgrestAdmin() {
  return {
    from(table: string) {
      let kind: "select" | "insert" | "update" = "select";
      let payload: Row | undefined;
      let cols: string | null = null;
      let selected = false;
      let mode: "many" | "single" | "maybe" = "many";
      let order: [string, boolean] | null = null;
      let limit: number | null = null;
      const preds: Array<(r: Row) => boolean> = [];
      const run = (): { data: unknown; error: unknown } => {
        const rows = tables[table] ?? (tables[table] = []);
        let hit: Row[];
        if (kind === "insert") {
          const row = { id: `row-${nextId++}`, ...payload };
          rows.push(row);
          hit = [row];
        } else {
          hit = rows.filter((r) => preds.every((p) => p(r)));
          if (order) {
            const [k, asc] = order;
            hit = [...hit].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
          }
          if (limit !== null) hit = hit.slice(0, limit);
          if (kind === "update") for (const r of hit) Object.assign(r, payload);
        }
        // supabase-js: a write that never chained .select() returns no rows.
        if (kind !== "select" && !selected) return { data: null, error: null };
        const out = hit.map((r) => project(r, cols));
        if (mode === "many") return { data: out, error: null };
        if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "more than one row" } };
        if (out.length === 0) return mode === "maybe" ? { data: null, error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
        return { data: out[0], error: null };
      };
      const b: any = {
        select(c?: string) { selected = true; cols = c ?? "*"; return b; },
        insert(p: Row) { kind = "insert"; payload = p; return b; },
        update(p: Row) { kind = "update"; payload = p; return b; },
        eq(k: string, v: unknown) { preds.push((r) => r[k] === v); return b; },
        in(k: string, vs: unknown[]) { preds.push((r) => vs.includes(r[k])); return b; },
        lt(k: string, v: string) { preds.push((r) => new Date(r[k]).getTime() < new Date(v).getTime()); return b; },
        gt(k: string, v: string) { preds.push((r) => new Date(r[k]).getTime() > new Date(v).getTime()); return b; },
        order(k: string, o: { ascending: boolean }) { order = [k, o.ascending]; return b; },
        limit(n: number) { limit = n; return b; },
        single() { mode = "single"; return Promise.resolve(run()); },
        maybeSingle() { mode = "maybe"; return Promise.resolve(run()); },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return b;
    },
  };
}

describe("killers — over a PostgREST-like fake", () => {
  beforeEach(() => {
    nextId = 1;
    tables = {
      organizations: [{ id: ORG, timezone: TZ, country: "AU" }, { id: OTHER_ORG, timezone: TZ, country: "AU" }],
      org_members: [
        { id: "m-1", organization_id: ORG, user_id: "staff-user", role: "member" },
        { id: "m-2", organization_id: ORG, user_id: OWNER_USER, role: "owner" },
      ],
    };
    vi.mocked(createAdminClient).mockReturnValue(postgrestAdmin() as any);
  });

  it("K28 + K115 + K116: a confirmed block is ONE row, reported with its own id, by the org's owner; the read-back names jobs with their times", async () => {
    tables.appointments = [
      { id: "a1", organization_id: ORG, status: "confirmed", attendee_name: "Bob Lee", start_time: "2026-10-16T02:30:00+00:00", end_time: "2026-10-16T03:00:00+00:00" },
      { id: "a2", organization_id: OTHER_ORG, status: "confirmed", attendee_name: "Not Ours", start_time: "2026-10-16T02:30:00+00:00", end_time: "2026-10-16T03:00:00+00:00" },
    ];
    const readBack = await handleOwnerBlockTime(ORG, BLOCK, ctx);
    expect(readBack.message).toContain("One job is already booked then and will stay booked unless the owner moves or cancels it: Bob Lee on Friday, October 16 at 1:30 PM.");
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, confirmed: true }, ctx);
    expect(tables.blocked_times).toHaveLength(1);
    expect(r).toMatchObject({ success: true, data: { outcome: "blocked", block_id: tables.blocked_times[0].id } });
    expect(tables.blocked_times[0]).toMatchObject({ organization_id: ORG, created_by: OWNER_USER, created_on_call_id: CALL, all_day: false });
  });

  it("K97: more than five jobs in the way — the five named are the EARLIEST", async () => {
    tables.appointments = [6, 1, 4, 2, 5, 3].map((n) => ({
      id: `a${n}`, organization_id: ORG, status: "confirmed", attendee_name: `C${n}`,
      start_time: `2026-10-16T0${1 + n}:00:00+00:00`.replace("T010", "T10"), end_time: "2026-10-16T09:00:00+00:00",
    }));
    const r = await handleOwnerBlockTime(ORG, { start: "2026-10-16T10:00", end: "2026-10-16T20:00" }, ctx);
    expect(r.message).toContain("C1 on");
    expect(r.message).not.toContain("C6 on");
    expect(r.message).toContain(", and 1 more.");
  });

  it("K33 + K113: a confirmed mark-done updates ONLY that org's pending row, is reported done, and the read-back says when it came in", async () => {
    // Test lens r2: rows the id, org and status filters must each keep out (the same id in
    // another org, and done already) — not only another callback of this org's.
    tables.callback_requests = [
      { ...PENDING, organization_id: ORG, status: "pending" },
      { id: "cb-other", organization_id: ORG, status: "pending", caller_name: "Ann", reason: "Quote", created_at: "2026-10-14T23:00:00Z" },
      { ...PENDING, organization_id: OTHER_ORG, status: "pending" },
      { ...PENDING, organization_id: ORG, status: "completed" },
    ];
    const readBack = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK }, ctx);
    expect(readBack.message).toContain("received Thursday, October 15 at 9:12 AM");
    const r = await handleOwnerMarkCallbackDone(ORG, { callback_id: CALLBACK, confirmed: true }, ctx);
    expect(r).toMatchObject({ success: true, data: { outcome: "callback_done" } });
    expect(tables.callback_requests[0]).toMatchObject({ status: "completed", completed_by: OWNER_USER, completed_on_call_id: CALL });
    expect(tables.callback_requests[1].status).toBe("pending");
    expect(tables.callback_requests[2]).toMatchObject({ organization_id: OTHER_ORG, status: "pending" });
    expect(tables.callback_requests[2]).not.toHaveProperty("completed_on_call_id");
  });

  it("K114 / R09: the same booking asked for again on this call is found by its number and handed back — never booked twice", async () => {
    tables.appointments = [
      { id: NEW_ID, organization_id: ORG, call_id: CALL, start_time: "2026-10-15T23:00:00.000Z", status: "confirmed", attendee_name: "Jane Smith", attendee_phone: "+61412345678", confirmation_code: "654321" },
    ];
    const r = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
    expect(handleBookAppointment).not.toHaveBeenCalled();
    expect(r.message).toBe(`Jane Smith is already booked for ${WHEN} — that's the booking from a moment ago. I haven't let Jane Smith know.`);
    expect(r.data).toMatchObject({ outcome: "booked", appointment_id: NEW_ID, confirmation_code: "654321" });
  });

  it("R01 / R02: the diary's own duplicate is this booking only when the row is there with this customer's number", async () => {
    tables.appointments = [{ id: NEW_ID, organization_id: ORG, call_id: "another-call", start_time: "2026-10-15T23:00:00.000Z", status: "confirmed", attendee_phone: "+61498765432" }];
    vi.mocked(handleBookAppointment).mockResolvedValueOnce(DUPLICATE as any);
    const clash = await handleOwnerBookAppointment(ORG, { ...BOOK, customer_name: "Jane Brown", confirmed: true, notify_customer: "none" }, ctx);
    expect(clash).toMatchObject({ success: false, data: { outcome: "not_booked" } });
    tables.appointments = [];
    vi.mocked(handleBookAppointment).mockResolvedValueOnce(DUPLICATE as any);
    const gone = await handleOwnerBookAppointment(ORG, { ...BOOK, confirmed: true, notify_customer: "none" }, ctx);
    expect(gone).toMatchObject({ success: false, data: { outcome: "not_booked" } });
  });
});

describe("test lens G10 + G13", () => {
  it("G10: exactly two weeks across the April clock change (337 hours) is still two weeks", async () => {
    const r = await handleOwnerBlockTime(ORG, { start: "2027-04-01T00:00", end: "2027-04-15T00:00" }, ctx);
    expect(r.data).toMatchObject({ outcome: "needs_confirmation" });
    db.queues.organizations = [AU_ORG];
    const over = await handleOwnerBlockTime(ORG, { start: "2027-04-01T00:00", end: "2027-04-15T00:01" }, ctx);
    expect(over.data).toMatchObject({ outcome: "invalid_time" });
  });

  it("G13: a block handed back as a repeat reports the stored block's title, not the new reason", async () => {
    db.queues.blocked_times = [{ data: [{ id: "block-1", title: "Quote visit" }], error: null }];
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, reason: "Something else", confirmed: true }, ctx);
    expect(r.data).toMatchObject({ outcome: "blocked", block_id: "block-1", title: "Quote visit" });
  });
});

// ─── Test lens round 2 (9903416c): the two-week limit and the repeated block's title ───
describe("test lens round 2 — the two-week limit on the org's own calendar", () => {
  it("N04: exactly two weeks from a Friday AFTERNOON is allowed; a minute more is refused (the limit keeps the start's time of day)", async () => {
    const ok = await handleOwnerBlockTime(ORG, { start: "2026-10-16T13:00", end: "2026-10-30T13:00" }, ctx);
    expect(ok.data).toMatchObject({ outcome: "needs_confirmation" });
    db.queues.organizations = [AU_ORG];
    const over = await handleOwnerBlockTime(ORG, { start: "2026-10-16T13:00", end: "2026-10-30T13:01" }, ctx);
    expect(over.data).toMatchObject({ outcome: "invalid_time" });
  });

  it("N10: exactly two weeks across the OCTOBER clock change (335 hours) is two weeks, and the extra hour a millisecond count would allow is refused", async () => {
    const ok = await handleOwnerBlockTime(ORG, { start: "2027-09-30T00:00", end: "2027-10-14T00:00" }, ctx);
    expect(ok.data).toMatchObject({ outcome: "needs_confirmation" });
    db.queues.organizations = [AU_ORG];
    // 336 hours exactly: 14 x 24 h of milliseconds, but an hour past two weeks on the calendar.
    const over = await handleOwnerBlockTime(ORG, { start: "2027-09-30T00:00", end: "2027-10-14T01:00" }, ctx);
    expect(over.data).toMatchObject({ outcome: "invalid_time" });
  });

  it("N09: an org outside Sydney is judged on ITS calendar — a whole day is an all-day row, and two weeks across its clock change is two weeks", async () => {
    db.queues.organizations = [{ data: { timezone: "Australia/Brisbane", country: "AU" }, error: null }];
    db.queues.blocked_times = [{ data: [], error: null }, { data: { id: "block-1" }, error: null }];
    await handleOwnerBlockTime(ORG, { start: "2026-10-17T00:00", end: "2026-10-18T00:00", confirmed: true }, ctx);
    expect(opsOn("blocked_times")[1].insert).toMatchObject({ all_day: true, start_time: "2026-10-16T14:00:00.000Z", end_time: "2026-10-17T14:00:00.000Z" });
    db.queues.organizations = [{ data: { timezone: "America/New_York", country: "US" }, error: null }];
    // New York leaves daylight time on Sunday 1 November 2026: this fortnight is 337 hours.
    const fortnight = await handleOwnerBlockTime(ORG, { start: "2026-10-29T09:00", end: "2026-11-12T09:00" }, ctx);
    expect(fortnight.data).toMatchObject({ outcome: "needs_confirmation" });
  });
});

describe("test lens round 2 — a repeated block hands back the title it was STORED with", () => {
  it("T04 + T05 + T07: the stored title comes back as one capped line, and a blank one as 'Time off' — never the new reason", async () => {
    // A title typed in the dashboard can hold anything; it reaches the model in data.title.
    db.queues.blocked_times = [{ data: [{ id: "block-1", title: "Quote\nvisit\u200b" + "x".repeat(200) }], error: null }];
    const r = await handleOwnerBlockTime(ORG, { ...BLOCK, reason: "Something else", confirmed: true }, ctx);
    const title = (r.data as { title: string }).title;
    expect(title.startsWith("Quote visit")).toBe(true);
    expect(title).not.toMatch(/[\n\u200b]/);
    expect(Array.from(title).length).toBeLessThanOrEqual(80);
    db.queues.organizations = [AU_ORG];
    db.queues.blocked_times = [{ data: [{ id: "block-1", title: "   " }], error: null }];
    const blank = await handleOwnerBlockTime(ORG, { ...BLOCK, reason: "Something else", confirmed: true }, ctx);
    expect(blank.data).toMatchObject({ outcome: "blocked", block_id: "block-1", title: "Time off" });
  });

  describe("over the PostgREST-like fake (a column not selected never comes back)", () => {
    beforeEach(() => {
      nextId = 1;
      tables = { organizations: [{ id: ORG, timezone: TZ, country: "AU" }] };
      vi.mocked(createAdminClient).mockReturnValue(postgrestAdmin() as any);
    });

    it("T01 (G13 by behaviour, not by the select string): the repeat reports the title stored on this call's block — still one row", async () => {
      tables.blocked_times = [
        { id: "block-9", organization_id: ORG, created_on_call_id: CALL, start_time: "2026-10-16T02:00:00.000Z", end_time: "2026-10-16T06:00:00.000Z", title: "Quote visit" },
      ];
      const r = await handleOwnerBlockTime(ORG, { ...BLOCK, reason: "Something else", confirmed: true }, ctx);
      expect(r.data).toMatchObject({ outcome: "blocked", block_id: "block-9", title: "Quote visit" });
      expect(tables.blocked_times).toHaveLength(1);
    });
  });
});
