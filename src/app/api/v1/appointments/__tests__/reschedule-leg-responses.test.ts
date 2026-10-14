import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-586: characterization pins for the dashboard's reschedule-LEG contract
// (PATCH that moves the time → free old row → insert new leg → roll back on
// failure). The DB sequence moved into performRescheduleLeg so the owner
// assistant shares it; these pins were written against the pre-refactor inline
// route and must hold unchanged after it — every outcome keeps its HTTP status
// and body, the leg row keeps its manual/dashboard provenance, and an orphaned
// rollback keeps its Sentry page identity (Sentry groups the page by its
// message; alert rules may filter on the tag). Ruled change (final review S2): the
// core now raises that page through pageSentry, so the dashboard's orphan finally
// reaches the [ALERT:error] pager (Sentry has no DSN in production), and a free
// that errored is re-read so one that committed anyway is restored.

const sentryState = vi.hoisted(() => {
  type Page = {
    level: string | null;
    tags: Record<string, string>;
    extras: Record<string, unknown>;
    messages: string[];
  };
  return { pages: [] as Page[], active: null as Page | null };
});

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  // after() throws outside a real request scope; the deferred work it wraps
  // (cache invalidation, audit emit, SMS) is not under test here.
  return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@sentry/nextjs", () => ({
  // Records each scope AND the messages captured while it is active, so a test
  // can tell a tagged page from a bare captureMessage outside the scope.
  withScope: vi.fn((fn: (scope: unknown) => void) => {
    const page = {
      level: null as string | null,
      tags: {} as Record<string, string>,
      extras: {} as Record<string, unknown>,
      messages: [] as string[],
    };
    sentryState.active = page;
    try {
      fn({
        setLevel: (l: string) => { page.level = l; },
        setTag: (k: string, v: string) => { page.tags[k] = v; },
        setExtras: (e: Record<string, unknown>) => { Object.assign(page.extras, e); },
      });
    } finally {
      sentryState.active = null;
    }
    sentryState.pages.push(page);
  }),
  captureMessage: vi.fn((message: string) => { sentryState.active?.messages.push(message); }),
  captureException: vi.fn(),
}));
vi.mock("@/lib/voice-cache/invalidate", () => ({ invalidateVoiceScheduleCache: vi.fn() }));
vi.mock("@/lib/sms/caller-sms", () => ({ sendAppointmentConfirmationSMS: vi.fn() }));
vi.mock("@/lib/clients/client-history", () => ({ getClientHistory: vi.fn() }));

import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { PATCH } from "../[id]/route";

const ORG = "org-1";
const USER = "user-1";
const APPT_ID = "44444444-5555-4666-8777-888888888888";
const NEW_LEG_ID = "55555555-6666-4777-8888-999999999999";

// Future instants relative to "now" so the past-time / horizon guards never rot.
const OLD_START = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
const OLD_END = new Date(Date.now() + 3 * 24 * 3600_000 + 60 * 60_000).toISOString();
const NEW_START = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
const NEW_END = new Date(Date.now() + 7 * 24 * 3600_000 + 60 * 60_000).toISOString();

type Res = { data: unknown; error: { message?: string; code?: string } | null };
interface Op {
  table: string;
  op: "select" | "update" | "insert";
  payload?: any;
  eqs: Array<[string, unknown]>;
  ins: Array<[string, unknown]>;
}

const db = {
  log: [] as Op[],
  // Call-ordered results per "<table>.<op>".
  queues: {} as Record<string, Res[]>,
};

function makeBuilder(table: string) {
  const op: Op = { table, op: "select", eqs: [], ins: [] };
  const b: Record<string, unknown> = {};
  const chain = () => b;
  let selected = false; // did the chain ask PostgREST for rows back?
  const resolve = (): Res => {
    db.log.push(op);
    if (table === "org_members") return { data: { organization_id: ORG }, error: null };
    const res = db.queues[`${table}.${op.op}`]?.shift() ?? { data: null, error: null };
    // supabase-js returns no rows for an update()/insert() that never chained .select() (data:null).
    return op.op === "select" || selected ? res : { data: null, error: res.error };
  };
  Object.assign(b, {
    select: () => { selected = true; return b; }, order: chain, limit: chain, is: chain, not: chain, or: chain,
    eq: (col: string, val: unknown) => { op.eqs.push([col, val]); return b; },
    in: (col: string, val: unknown) => { op.ins.push([col, val]); return b; },
    update: (payload: unknown) => { op.op = "update"; op.payload = payload; return b; },
    insert: (payload: unknown) => { op.op = "insert"; op.payload = payload; return b; },
    single: async () => resolve(),
    maybeSingle: async () => resolve(),
    then: (onF: (v: Res) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(onF, onR),
  });
  return b;
}

function beforeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPT_ID,
    attendee_name: "Jane Smith",
    attendee_first_name: "Jane",
    attendee_last_name: "Smith",
    attendee_phone: "+61412345678",
    attendee_email: null,
    notes: "gate code 1234",
    start_time: OLD_START,
    end_time: OLD_END,
    duration_minutes: 60,
    status: "confirmed",
    service_type_id: null,
    practitioner_id: null,
    service_types: null,
    practitioners: null,
    ...overrides,
  };
}

const FREED: Res = { data: [{ id: APPT_ID }], error: null };
const RESTORED: Res = { data: [{ id: APPT_ID }], error: null };

const writes = () => db.log.filter((o) => o.table === "appointments" && o.op !== "select");
/** The [ALERT:*] lines pageSentry printed — what pages on-call in production. */
const alertLines = () =>
  vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith("[ALERT:"));
const DASHBOARD_PAGE = {
  level: "error",
  tags: { service: "next-api", reason: "reschedule-leg-orphaned", bug: "dashboard_reschedule_rollback_failed" },
  messages: ["Dashboard reschedule rollback failed (orphaned old leg)"],
};

async function moveAppointment() {
  const res = await PATCH(
    new Request(`http://localhost/api/v1/appointments/${APPT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_time: NEW_START, end_time: NEW_END }),
    }) as never,
    { params: Promise.resolve({ id: APPT_ID }) },
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.log = [];
  db.queues = { "appointments.select": [{ data: beforeRow(), error: null }] };
  sentryState.pages = [];
  sentryState.active = null;
  // The failure paths log by design; keep the run output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(createClient).mockImplementation(async () =>
    ({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })) },
      from: (table: string) => makeBuilder(table),
    }) as never,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PATCH /appointments/[id] — reschedule-leg responses (SCRUM-586 characterization)", () => {
  it("moves the appointment as a manual dashboard leg and returns it with the re-point marker", async () => {
    const inserted = { ...beforeRow({ id: NEW_LEG_ID, start_time: NEW_START, end_time: NEW_END }), rescheduled_from_id: APPT_ID };
    db.queues["appointments.update"] = [FREED];
    db.queues["appointments.insert"] = [{ data: inserted, error: null }];

    const { status, body } = await moveAppointment();

    expect(status).toBe(200);
    expect(body).toEqual({ ...inserted, rescheduled: { fromId: APPT_ID, toId: NEW_LEG_ID } });
    const [free, insert, ...rest] = writes();
    expect(rest).toHaveLength(0); // no rollback on success
    expect(free.op).toBe("update");
    expect(free.payload).toEqual({ status: "rescheduled" });
    expect(free.eqs).toEqual([["id", APPT_ID], ["organization_id", ORG]]);
    expect(free.ins).toEqual([["status", ["confirmed", "pending"]]]);
    expect(insert.op).toBe("insert");
    // Exact row: the old row's fields with the edit applied, manual provenance,
    // a fresh code, the supersede link — and no call_id (not a call).
    expect(insert.payload).toEqual({
      attendee_name: "Jane Smith",
      attendee_first_name: "Jane",
      attendee_last_name: "Smith",
      attendee_phone: "+61412345678",
      attendee_email: null,
      start_time: NEW_START,
      end_time: NEW_END,
      duration_minutes: 60,
      status: "confirmed",
      notes: "gate code 1234",
      service_type_id: null,
      practitioner_id: null,
      organization_id: ORG,
      provider: "manual",
      confirmation_code: expect.stringMatching(/^\d{6}$/),
      rescheduled_from_id: APPT_ID,
      metadata: { source: "dashboard_reschedule", created_by: USER, rescheduled_from: APPT_ID },
    });
    expect(sentryState.pages).toHaveLength(0);
  });

  it("retries a confirmation-code collision (23505) once with a fresh code, then returns the new leg", async () => {
    db.queues["appointments.update"] = [FREED];
    db.queues["appointments.insert"] = [
      { data: null, error: { message: 'duplicate key value violates unique constraint "appointments_confirmation_code_key"', code: "23505" } },
      { data: { id: NEW_LEG_ID }, error: null },
    ];

    const { status, body } = await moveAppointment();

    expect(status).toBe(200);
    expect(body).toEqual({ id: NEW_LEG_ID, rescheduled: { fromId: APPT_ID, toId: NEW_LEG_ID } });
    expect(writes().map((o) => o.op)).toEqual(["update", "insert", "insert"]);
  });

  it("a DB error freeing the old row → 500, nothing inserted", async () => {
    db.queues["appointments.update"] = [{ data: null, error: { message: "boom", code: "08006" } }];

    const { status, body } = await moveAppointment();

    expect(status).toBe(500);
    expect(body).toEqual({ error: "Failed to reschedule appointment" });
    expect(writes().map((o) => o.op)).toEqual(["update"]);
  });

  it("an appointment no longer confirmed/pending (0 rows freed) → 409, nothing inserted", async () => {
    db.queues["appointments.update"] = [{ data: [], error: null }];

    const { status, body } = await moveAppointment();

    expect(status).toBe(409);
    expect(body).toEqual({ error: "This appointment can no longer be edited (it may have been cancelled or moved)." });
    expect(writes().map((o) => o.op)).toEqual(["update"]);
  });

  it("a slot conflict (23P01) restores the old row to its prior status → 409 time-conflict", async () => {
    db.queues["appointments.select"] = [{ data: beforeRow({ status: "pending" }), error: null }];
    db.queues["appointments.update"] = [FREED, RESTORED];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "overlap", code: "23P01" } }];

    const { status, body } = await moveAppointment();

    expect(status).toBe(409);
    expect(body).toEqual({ error: "This time conflicts with another appointment" });
    const [, , rollback, ...rest] = writes();
    expect(rest).toHaveLength(0);
    expect(rollback.op).toBe("update");
    expect(rollback.payload).toEqual({ status: "pending" });
    // Only revive a row WE froze.
    expect(rollback.eqs).toEqual([["id", APPT_ID], ["organization_id", ORG], ["status", "rescheduled"]]);
    expect(sentryState.pages).toHaveLength(0);
  });

  it("any other insert error restores the old row → 500", async () => {
    db.queues["appointments.update"] = [FREED, RESTORED];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "nope", code: "XX000" } }];

    const { status, body } = await moveAppointment();

    expect(status).toBe(500);
    expect(body).toEqual({ error: "Failed to reschedule appointment" });
    expect(writes().map((o) => o.op)).toEqual(["update", "insert", "update"]);
    expect(sentryState.pages).toHaveLength(0);
  });

  it("a rollback that restores 0 rows → 500 manual-review + the dashboard's error-level page, never the look-alike 409 (even on 23P01)", async () => {
    db.queues["appointments.update"] = [FREED, { data: [], error: null }];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "overlap", code: "23P01" } }];

    const { status, body } = await moveAppointment();

    expect(status).toBe(500);
    expect(body).toEqual({
      error: "We couldn't complete the move and couldn't restore the original appointment — it needs manual review.",
    });
    expect(sentryState.pages).toEqual([
      { ...DASHBOARD_PAGE, extras: expect.objectContaining({ orgId: ORG, oldId: APPT_ID, source: "dashboard_reschedule" }) },
    ]);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    // The page that actually reaches on-call in production.
    const lines = alertLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[ALERT:error] [next-api] Dashboard reschedule rollback failed (orphaned old leg)");
    expect(lines[0]).toContain("reason=reschedule-leg-orphaned");
    expect(lines[0]).toContain("bug=dashboard_reschedule_rollback_failed");
    expect(lines[0]).toContain(`oldId=${APPT_ID}`);
    expect(lines[0]).toContain("source=dashboard_reschedule");
  });

  it("a rollback that errors → the same manual-review response and page", async () => {
    db.queues["appointments.update"] = [FREED, { data: null, error: { message: "conn reset", code: "08006" } }];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "nope", code: "XX000" } }];

    const { status, body } = await moveAppointment();

    expect(status).toBe(500);
    expect(body.error).toMatch(/needs manual review/);
    expect(sentryState.pages).toHaveLength(1);
    expect(sentryState.pages[0].tags).toEqual(DASHBOARD_PAGE.tags);
    expect(sentryState.pages[0].messages).toEqual(DASHBOARD_PAGE.messages);
    expect(alertLines()).toHaveLength(1);
  });

  it("a free that errored but committed (lost response) is restored → the same 500 'Failed to reschedule', no page", async () => {
    db.queues["appointments.update"] = [{ data: null, error: { message: "TypeError: fetch failed" } }, RESTORED];
    db.queues["appointments.select"].push(
      { data: { status: "rescheduled" }, error: null }, // the re-read: the free DID land
      { data: [], error: null }, // and no newer leg points at it
    );

    const { status, body } = await moveAppointment();

    expect(status).toBe(500);
    expect(body).toEqual({ error: "Failed to reschedule appointment" });
    const [free, restore, ...rest] = writes();
    expect(rest).toHaveLength(0); // nothing inserted
    expect(free.payload).toEqual({ status: "rescheduled" });
    expect(restore.payload).toEqual({ status: "confirmed" });
    expect(restore.eqs).toEqual([["id", APPT_ID], ["organization_id", ORG], ["status", "rescheduled"]]);
    expect(sentryState.pages).toHaveLength(0);
    expect(alertLines()).toEqual([]);
  });

  it("a committed-but-lost free whose restore fails → 500 manual-review + the dashboard's page", async () => {
    db.queues["appointments.update"] = [{ data: null, error: { message: "TypeError: fetch failed" } }, { data: [], error: null }];
    db.queues["appointments.select"].push({ data: { status: "rescheduled" }, error: null }, { data: [], error: null });

    const { status, body } = await moveAppointment();

    expect(status).toBe(500);
    expect(body).toEqual({
      error: "We couldn't complete the move and couldn't restore the original appointment — it needs manual review.",
    });
    expect(sentryState.pages).toEqual([
      { ...DASHBOARD_PAGE, extras: expect.objectContaining({ orgId: ORG, oldId: APPT_ID, source: "dashboard_reschedule" }) },
    ]);
    expect(alertLines()).toHaveLength(1);
  });
});
