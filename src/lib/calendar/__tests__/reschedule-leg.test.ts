import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-586: the reschedule-leg orchestration lifted out of the dashboard PATCH
// route so the owner assistant moves jobs through the SAME free → insert →
// link → rollback sequence. Pinned here once; both callers only map outcomes.
// An orphaned old leg is paged HERE for every caller (pageSentry's [ALERT:error]
// line; @sentry/nextjs has no DSN in production), and a free that errored is
// re-read so a free that committed behind a lost response is undone.

// Records each Sentry scope and the messages captured while it is active, so a
// test can assert the page's level/tag (not just that some message was sent).
const sentryState = vi.hoisted(() => {
  type Page = { level: string | null; tags: Record<string, string>; extras: Record<string, unknown>; messages: string[] };
  return { pages: [] as Page[], active: null as Page | null };
});

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn((message: string) => { sentryState.active?.messages.push(message); }),
  captureException: vi.fn(),
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
}));

import * as Sentry from "@sentry/nextjs";
import { performRescheduleLeg } from "../reschedule-leg";

type Op = { table: string; op: "select" | "insert" | "update"; payload?: any; filters: Array<{ name: string; args: unknown[] }> };
type Res = { data: unknown; error: { message?: string; code?: string } | null };

const db = {
  log: [] as Op[],
  // Call-ordered results per "<table>.<op>".
  queues: {} as Record<string, Res[]>,
  reset() { this.log = []; this.queues = {}; },
  next(key: string): Res { return this.queues[key]?.shift() ?? { data: null, error: null }; },
};

function builder(table: string) {
  const ctx: Op = { table, op: "select", filters: [] };
  const b: any = {};
  for (const name of ["eq", "in", "gte", "lt", "order", "limit"]) {
    b[name] = (...args: unknown[]) => { ctx.filters.push({ name, args }); return b; };
  }
  b.select = (...args: unknown[]) => { ctx.filters.push({ name: "select", args }); return b; };
  b.update = (payload: unknown) => { ctx.op = "update"; ctx.payload = payload; return b; };
  b.insert = (payload: unknown) => { ctx.op = "insert"; ctx.payload = payload; return b; };
  // supabase-js returns NO rows for an update()/insert() that never chained .select() (data:null).
  // Model that, so dropping .select("id") from the free or the rollback step reads as "0 rows
  // freed" / "0 rows restored", exactly as it would in production.
  const settle = (): Res => {
    const res = db.next(`${table}.${ctx.op}`);
    const returnsRows = ctx.op === "select" || ctx.filters.some((f) => f.name === "select");
    return returnsRows ? res : { data: null, error: res.error };
  };
  b.single = async () => { db.log.push(ctx); return settle(); };
  b.maybeSingle = b.single;
  b.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) => {
    db.log.push(ctx);
    return Promise.resolve(settle()).then(resolve, reject);
  };
  return b;
}
const supabase = { from: (t: string) => builder(t) };

const ORG = "11111111-2222-4333-a444-555555555555";
const OLD = "44444444-5555-4666-8777-888888888888";
const NEW = "55555555-6666-4777-8888-999999999999";
const CALL = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f";

const before = {
  id: OLD, status: "confirmed",
  attendee_name: "Jane Smith", attendee_first_name: "Jane", attendee_last_name: "Smith",
  attendee_phone: "+61412345678", attendee_email: null, notes: "gate code 1234",
  start_time: "2026-10-15T03:00:00+00:00", end_time: "2026-10-15T04:00:00+00:00", duration_minutes: 60,
  service_type_id: "svc-1", practitioner_id: null,
};
const updates = { start_time: "2026-10-16T03:00:00.000Z", end_time: "2026-10-16T04:00:00.000Z" };
const ownerLeg = { provider: "internal" as const, metadata: { source: "owner_voice", call_id: CALL, rescheduled_from: OLD }, callId: CALL };

function updatesOf(op: Op) { return Object.fromEntries(op.filters.filter((f) => f.name === "eq").map((f) => f.args)); }

beforeEach(() => { db.reset(); vi.clearAllMocks(); });

beforeEach(() => {
  sentryState.pages = [];
  sentryState.active = null;
  // The failure paths log by design; keep the run output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("performRescheduleLeg", () => {
  it("frees the old row (guarded on it being active + org-scoped), inserts the linked new leg, returns it", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }];
    db.queues["appointments.insert"] = [{ data: { id: NEW, start_time: updates.start_time }, error: null }];

    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });

    expect(out).toEqual({ ok: true, inserted: { id: NEW, start_time: updates.start_time } });
    const [free, insert] = db.log;
    // .select("id") is what makes PostgREST return the freed rows; without it a real
    // free reads as 0 rows ("not_active") even when it succeeded.
    expect(free.filters.find((f) => f.name === "select")?.args).toEqual(["id"]);
    expect(free.op).toBe("update");
    expect(free.payload).toEqual({ status: "rescheduled" });
    expect(updatesOf(free)).toEqual({ id: OLD, organization_id: ORG });
    expect(free.filters.find((f) => f.name === "in")?.args).toEqual(["status", ["confirmed", "pending"]]);
    expect(insert.op).toBe("insert");
    expect(insert.payload).toMatchObject({
      organization_id: ORG,
      provider: "internal",
      rescheduled_from_id: OLD,
      call_id: CALL,
      metadata: { source: "owner_voice", call_id: CALL, rescheduled_from: OLD },
      start_time: updates.start_time,
      end_time: updates.end_time,
      attendee_name: "Jane Smith",
      notes: "gate code 1234",
      status: "confirmed",
    });
    expect(insert.payload.confirmation_code).toMatch(/^\d{6}$/);
    expect(insert.filters.find((f) => f.name === "select")?.args).toEqual(["*, service_types(name), practitioners(name)"]);
  });

  it("omits call_id for a dashboard leg (no callId)", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }];
    db.queues["appointments.insert"] = [{ data: { id: NEW }, error: null }];
    await performRescheduleLeg(supabase, {
      orgId: ORG, oldId: OLD, before, updates,
      leg: { provider: "manual", metadata: { source: "dashboard_reschedule", created_by: "u1", rescheduled_from: OLD } },
    });
    expect("call_id" in db.log[1].payload).toBe(false);
    expect(db.log[1].payload.provider).toBe("manual");
  });

  it("returns not_active (and inserts nothing) when the old row is no longer confirmed/pending", async () => {
    db.queues["appointments.update"] = [{ data: [], error: null }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "not_active" });
    expect(db.log.filter((o) => o.op === "insert")).toHaveLength(0);
  });

  it("returns free_failed on a DB error freeing the old row", async () => {
    db.queues["appointments.update"] = [{ data: null, error: { message: "boom", code: "08006" } }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "free_failed", error: { message: "boom", code: "08006" } });
  });

  it("on a slot conflict (23P01) restores the old row to its prior status and returns conflict", async () => {
    db.queues["appointments.update"] = [
      { data: [{ id: OLD }], error: null },     // free
      { data: [{ id: OLD }], error: null },     // rollback
    ];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "overlap", code: "23P01" } }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "conflict" });
    const rollback = db.log[2];
    // Same for the rollback: without .select("id") a real restore would read as orphaned.
    expect(rollback.filters.find((f) => f.name === "select")?.args).toEqual(["id"]);
    expect(rollback.op).toBe("update");
    expect(rollback.payload).toEqual({ status: "confirmed" });
    // Only revive a row WE froze.
    expect(updatesOf(rollback)).toEqual({ id: OLD, organization_id: ORG, status: "rescheduled" });
  });

  it("retries ONCE on a confirmation-code collision (23505), then succeeds", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }];
    db.queues["appointments.insert"] = [
      { data: null, error: { message: 'duplicate key value violates unique constraint "appointments_confirmation_code_key"', code: "23505" } },
      { data: { id: NEW }, error: null },
    ];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: true, inserted: { id: NEW } });
    const inserts = db.log.filter((o) => o.op === "insert");
    expect(inserts).toHaveLength(2);
    expect(inserts[0].payload.confirmation_code).not.toBe(inserts[1].payload.confirmation_code);
  });

  it("returns insert_failed (old row restored) on any other insert error", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: [{ id: OLD }], error: null }];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "nope", code: "XX000" } }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "insert_failed", error: { message: "nope", code: "XX000" } });
  });

  it("pages on-call and returns orphaned when the rollback restores 0 rows", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: [], error: null }];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "nope", code: "XX000" } }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "orphaned", error: { message: "nope", code: "XX000" } });
    expect(Sentry.captureMessage).toHaveBeenCalledWith("Reschedule rollback failed (orphaned old leg)");
  });

  // ── Ordering + rollback pins beyond the outcome mapping ──────────────────────

  it("never touches the old row again once the new leg is in (no rollback on success, nor after a retried collision)", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }];
    db.queues["appointments.insert"] = [{ data: { id: NEW }, error: null }];
    await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(db.log.map((o) => o.op)).toEqual(["update", "insert"]);

    db.reset();
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }];
    db.queues["appointments.insert"] = [
      { data: null, error: { message: 'duplicate key value violates unique constraint "appointments_confirmation_code_key"', code: "23505" } },
      { data: { id: NEW }, error: null },
    ];
    await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(db.log.map((o) => o.op)).toEqual(["update", "insert", "insert"]);
  });

  it("stops at the free step on free_failed: one re-read of the old row, no insert, no rollback", async () => {
    db.queues["appointments.update"] = [{ data: null, error: { message: "boom", code: "08006" } }];
    db.queues["appointments.select"] = [{ data: { status: "confirmed" }, error: null }]; // the free never committed
    await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(db.log.map((o) => o.op)).toEqual(["update", "select"]);
    expect(sentryState.pages).toEqual([]);
  });

  it("restores a pending row to pending — the prior status, not a hard-coded confirmed", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: [{ id: OLD }], error: null }];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "overlap", code: "23P01" } }];
    const out = await performRescheduleLeg(supabase, {
      orgId: ORG, oldId: OLD, before: { ...before, status: "pending" }, updates, leg: ownerLeg,
    });
    expect(out).toEqual({ ok: false, reason: "conflict" });
    expect(db.log[2].payload).toEqual({ status: "pending" });
  });

  it("does not retry a 23505 on another constraint — rolls back and returns insert_failed", async () => {
    const otherUnique = { message: 'duplicate key value violates unique constraint "appointments_pkey"', code: "23505" };
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: [{ id: OLD }], error: null }];
    db.queues["appointments.insert"] = [{ data: null, error: otherUnique }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "insert_failed", error: otherUnique });
    expect(db.log.map((o) => o.op)).toEqual(["update", "insert", "update"]);
  });

  it("classifies the RETRY's error: a retried insert that hits a slot conflict is rolled back as conflict", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: [{ id: OLD }], error: null }];
    db.queues["appointments.insert"] = [
      { data: null, error: { message: 'duplicate key value violates unique constraint "appointments_confirmation_code_key"', code: "23505" } },
      { data: null, error: { message: "overlap", code: "23P01" } },
    ];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "conflict" });
    expect(db.log.map((o) => o.op)).toEqual(["update", "insert", "insert", "update"]);
  });

  it("a conflict whose rollback fails is orphaned — never the look-alike conflict", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: [], error: null }];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "overlap", code: "23P01" } }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "orphaned", error: { message: "overlap", code: "23P01" } });
    expect(sentryState.pages).toHaveLength(1);
  });

  it("a rollback that errors (rather than restoring 0 rows) is orphaned too", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: null, error: { message: "conn reset", code: "08006" } }];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "nope", code: "XX000" } }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "orphaned", error: { message: "nope", code: "XX000" } });
    expect(sentryState.pages).toHaveLength(1);
  });

  // ── The orphan page: one per orphan, for every caller ───────────────────────

  /** The [ALERT:*] lines pageSentry printed — the production page (Sentry is off there). */
  const alertLines = () =>
    vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith("[ALERT:"));

  it("the default orphan page is ONE [ALERT:error] line: reason, bug tag, the leg's source and both error codes", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: null, error: { message: "conn reset", code: "08006" } }];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "nope", code: "XX000" } }];
    await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    const lines = alertLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[ALERT:error\] \[next-api\] Reschedule rollback failed \(orphaned old leg\) \| /);
    for (const pair of [
      "reason=reschedule-leg-orphaned", "bug=reschedule_rollback_failed", `orgId=${ORG}`, `oldId=${OLD}`,
      "source=owner_voice", `callId=${CALL}`, "insErrCode=XX000", "rbErrCode=08006",
    ]) {
      expect(lines[0]).toContain(pair);
    }
    // The Sentry leg carries the same identity (dormant in production, kept for parity).
    expect(sentryState.pages).toEqual([
      {
        level: "error",
        tags: { service: "next-api", reason: "reschedule-leg-orphaned", bug: "reschedule_rollback_failed" },
        extras: { orgId: ORG, oldId: OLD, source: "owner_voice", callId: CALL, insErrCode: "XX000", rbErrCode: "08006" },
        messages: ["Reschedule rollback failed (orphaned old leg)"],
      },
    ]);
  });

  it("orphanPage keeps a caller's own page identity (the dashboard's pre-SCRUM-586 tag + message)", async () => {
    db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: [], error: null }];
    db.queues["appointments.insert"] = [{ data: null, error: { message: "nope", code: "XX000" } }];
    await performRescheduleLeg(supabase, {
      orgId: ORG, oldId: OLD, before, updates,
      leg: { provider: "manual", metadata: { source: "dashboard_reschedule", created_by: "u1", rescheduled_from: OLD } },
      orphanPage: {
        tag: "dashboard_reschedule_rollback_failed",
        message: "Dashboard reschedule rollback failed (orphaned old leg)",
      },
    });
    const lines = alertLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[ALERT:error] [next-api] Dashboard reschedule rollback failed (orphaned old leg) | ");
    expect(lines[0]).toContain("reason=reschedule-leg-orphaned");
    expect(lines[0]).toContain("bug=dashboard_reschedule_rollback_failed");
    expect(lines[0]).toContain("source=dashboard_reschedule");
    expect(lines[0]).not.toContain("callId=");
    expect(sentryState.pages).toEqual([
      {
        level: "error",
        tags: { service: "next-api", reason: "reschedule-leg-orphaned", bug: "dashboard_reschedule_rollback_failed" },
        extras: { orgId: ORG, oldId: OLD, source: "dashboard_reschedule", insErrCode: "XX000", rbErrCode: undefined },
        messages: ["Dashboard reschedule rollback failed (orphaned old leg)"],
      },
    ]);
  });

  it("no page on any outcome that keeps the customer's booking", async () => {
    const runs: Array<() => void> = [
      () => { db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }]; db.queues["appointments.insert"] = [{ data: { id: NEW }, error: null }]; },
      () => { db.queues["appointments.update"] = [{ data: [], error: null }]; },
      () => { db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: [{ id: OLD }], error: null }]; db.queues["appointments.insert"] = [{ data: null, error: { message: "overlap", code: "23P01" } }]; },
      () => { db.queues["appointments.update"] = [{ data: [{ id: OLD }], error: null }, { data: [{ id: OLD }], error: null }]; db.queues["appointments.insert"] = [{ data: null, error: { message: "nope", code: "XX000" } }]; },
    ];
    for (const arrange of runs) {
      db.reset();
      arrange();
      await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    }
    expect(alertLines()).toEqual([]);
    expect(sentryState.pages).toEqual([]);
  });

  // ── A free that errored, but may have committed (lost response) ──────────────

  const FREE_ERR = { message: "TypeError: fetch failed", code: "" };
  const freeFails = () => { db.queues["appointments.update"] = [{ data: null, error: FREE_ERR }]; };

  it("re-reads the old row org-scoped; a free that did NOT commit is plain free_failed (no rollback)", async () => {
    freeFails();
    db.queues["appointments.select"] = [{ data: { status: "confirmed" }, error: null }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "free_failed", error: FREE_ERR });
    const reread = db.log[1];
    expect(reread.op).toBe("select");
    expect(reread.filters.find((f) => f.name === "select")?.args).toEqual(["status"]);
    expect(updatesOf(reread)).toEqual({ id: OLD, organization_id: ORG });
    expect(db.log.map((o) => o.op)).toEqual(["update", "select"]);
  });

  it("a free that committed behind the error (row now `rescheduled`, no newer leg) is restored → free_failed, no page", async () => {
    freeFails();
    db.queues["appointments.select"] = [
      { data: { status: "rescheduled" }, error: null }, // the re-read
      { data: [], error: null }, // no leg points back at it
    ];
    db.queues["appointments.update"].push({ data: [{ id: OLD }], error: null }); // the restore
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before: { ...before, status: "pending" }, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "free_failed", error: FREE_ERR });
    expect(db.log.map((o) => o.op)).toEqual(["update", "select", "select", "update"]);
    const [, , successorLookup, restore] = db.log;
    expect(updatesOf(successorLookup)).toEqual({ rescheduled_from_id: OLD, organization_id: ORG });
    expect(restore.payload).toEqual({ status: "pending" }); // its prior status
    expect(updatesOf(restore)).toEqual({ id: OLD, organization_id: ORG, status: "rescheduled" }); // only a row WE froze
    expect(restore.filters.find((f) => f.name === "select")?.args).toEqual(["id"]);
    expect(db.log.filter((o) => o.op === "insert")).toHaveLength(0);
    expect(alertLines()).toEqual([]);
  });

  it("a committed free whose restore fails is orphaned and paged (free error code, not an insert's)", async () => {
    freeFails();
    db.queues["appointments.select"] = [{ data: { status: "rescheduled" }, error: null }, { data: [], error: null }];
    db.queues["appointments.update"].push({ data: [], error: null }); // the restore finds nothing to restore
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "orphaned", error: FREE_ERR });
    const lines = alertLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=reschedule-leg-orphaned");
    expect(lines[0]).toContain("source=owner_voice");
    expect(lines[0]).not.toContain("insErrCode");
    expect(sentryState.pages).toHaveLength(1);
  });

  it("never revives a row another move superseded: `rescheduled` WITH a newer leg is free_failed, untouched", async () => {
    freeFails();
    db.queues["appointments.select"] = [{ data: { status: "rescheduled" }, error: null }, { data: [{ id: NEW }], error: null }];
    const out = await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg });
    expect(out).toEqual({ ok: false, reason: "free_failed", error: FREE_ERR });
    expect(db.log.map((o) => o.op)).toEqual(["update", "select", "select"]);
    expect(alertLines()).toEqual([]);
  });

  it("a re-read or newer-leg lookup that fails is logged and reported free_failed — nothing restored on a guess", async () => {
    freeFails();
    db.queues["appointments.select"] = [{ data: null, error: { message: "down", code: "08006" } }];
    expect(await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg })).toMatchObject({ reason: "free_failed" });
    expect(db.log.map((o) => o.op)).toEqual(["update", "select"]);

    db.reset();
    freeFails();
    db.queues["appointments.select"] = [{ data: { status: "rescheduled" }, error: null }, { data: null, error: { message: "down", code: "08006" } }];
    expect(await performRescheduleLeg(supabase, { orgId: ORG, oldId: OLD, before, updates, leg: ownerLeg })).toMatchObject({ reason: "free_failed" });
    expect(db.log.map((o) => o.op)).toEqual(["update", "select", "select"]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[reschedule-leg]"), expect.objectContaining({ orgId: ORG, oldId: OLD, error: { message: "down", code: "08006" } }),
    );
  });
});
