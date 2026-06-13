import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";

// SCRUM-447 suite for the daily-summary cron: claim/release/partial-delivery
// semantics from SCRUM-429 (previously only enforced by code review), plus
// the new behaviors — typed NotificationDeliveryError branching, delivered_at
// claim-vs-confirm, 3-day missed-day recovery, and the maxDuration export.

// ──────────────────────────────────────────────────────────────────────────
// Stateful fake Supabase admin client. Each awaited query chain resolves via
// a per-table+operation handler; every operation is logged with its filters
// and payload so tests can assert order/shape.
// ──────────────────────────────────────────────────────────────────────────

type LoggedOp = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: Record<string, unknown>;
  filters: Array<{ name: string; args: unknown[] }>;
};

const db = vi.hoisted(() => ({
  handlers: {} as Record<string, (op: LoggedOp) => { data?: unknown; error?: unknown }>,
  log: [] as LoggedOp[],
  reset() {
    this.handlers = {};
    this.log = [];
  },
  ops(table: string, op: string) {
    return this.log.filter((o: LoggedOp) => o.table === table && o.op === op);
  },
}));

function getFilter(ctx: LoggedOp, name: string) {
  return ctx.filters.find((f) => f.name === name);
}

function makeBuilder(table: string) {
  const ctx: LoggedOp & { opSet?: boolean } = { table, op: "select", filters: [] };
  const b: Record<string, unknown> = {
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      db.log.push(ctx);
      const handler = db.handlers[`${ctx.table}.${ctx.op}`];
      const result = handler
        ? handler(ctx)
        : { data: ctx.op === "select" ? [] : null, error: null };
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  for (const name of ["eq", "gte", "lt", "lte", "in", "is", "not", "order", "limit", "match"]) {
    (b as Record<string, unknown>)[name] = (...args: unknown[]) => {
      ctx.filters.push({ name, args });
      return b;
    };
  }
  (b as Record<string, unknown>).select = (...args: unknown[]) => {
    // .select() after .insert()/.update() is a returning-clause, not a new op
    if (!ctx.opSet) ctx.op = "select";
    ctx.filters.push({ name: "select", args });
    return b;
  };
  for (const op of ["insert", "update", "delete"] as const) {
    (b as Record<string, unknown>)[op] = (payload?: Record<string, unknown>) => {
      ctx.op = op;
      ctx.opSet = true;
      ctx.payload = payload;
      return b;
    };
  }
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((fn: (scope: unknown) => void) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() })
  ),
}));

// Keep NotificationDeliveryError REAL — the route's instanceof branch is the
// contract under test. Only the sender is stubbed.
vi.mock("@/lib/notifications/notification-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/notification-service")>();
  return {
    ...actual,
    sendDailySummaryNotification: vi.fn(async () => "sent" as const),
  };
});

import {
  sendDailySummaryNotification,
  NotificationDeliveryError,
} from "@/lib/notifications/notification-service";

// ──────────────────────────────────────────────────────────────────────────
// Scenario state: offsets are daysAgo (1 = yesterday … 3 = oldest lookback).
// Period keys are whatever the route computes — captured from the ledger
// pre-check's .in() filter so tests never duplicate the route's date math.
// ──────────────────────────────────────────────────────────────────────────

const TZ = "Australia/Sydney";

const state = {
  claimedOffsets: new Set<number>(),
  callsByOffset: {} as Record<number, Array<Record<string, unknown>>>,
  capturedKeys: [] as string[], // ascending — oldest first
  ledgerReadError: null as unknown,
  claimInsertError: null as unknown,
  confirmError: null as unknown,
};

function offsetOfKey(key: string): number {
  // capturedKeys ascending: index 0 = oldest (offset 3) … last = yesterday (1)
  return state.capturedKeys.length - state.capturedKeys.indexOf(key);
}

function keyOfOffset(offset: number): string {
  return state.capturedKeys[state.capturedKeys.length - offset];
}

function localDateOf(utcIso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcIso));
}

function installHandlers() {
  db.handlers["organizations.select"] = () => ({
    data: [{ id: "org-1", timezone: TZ }],
    error: null,
  });
  db.handlers["cron_send_ledger.select"] = (ctx) => {
    const keys = [...(getFilter(ctx, "in")!.args[1] as string[])].sort();
    state.capturedKeys = keys;
    if (state.ledgerReadError) return { data: null, error: state.ledgerReadError };
    const rows = keys
      .filter((k) => state.claimedOffsets.has(offsetOfKey(k)))
      .map((k) => ({ period_key: k }));
    return { data: rows, error: null };
  };
  db.handlers["calls.select"] = (ctx) => {
    const start = getFilter(ctx, "gte")!.args[1] as string;
    const offset = offsetOfKey(localDateOf(start));
    return { data: state.callsByOffset[offset] ?? [], error: null };
  };
  db.handlers["cron_send_ledger.insert"] = () =>
    state.claimInsertError ? { error: state.claimInsertError } : { error: null };
  db.handlers["cron_send_ledger.update"] = () =>
    state.confirmError ? { error: state.confirmError } : { error: null };
  db.handlers["cron_send_ledger.delete"] = () => ({ error: null });
}

const CRON_SECRET = "test-cron-secret";
const COMPLETED_CALL = { id: "c1", status: "completed", is_spam: false, duration_seconds: 60, action_taken: null };

async function callRoute(headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  const { GET } = await import("../route");
  return GET(new NextRequest("http://localhost/api/cron/daily-summary", { method: "GET", headers }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendDailySummaryNotification).mockResolvedValue("sent");
  process.env.CRON_SECRET = CRON_SECRET;
  db.reset();
  state.claimedOffsets = new Set();
  state.callsByOffset = {};
  state.capturedKeys = [];
  state.ledgerReadError = null;
  state.claimInsertError = null;
  state.confirmError = null;
  installHandlers();
});

describe("GET /api/cron/daily-summary — sizing & auth", () => {
  it("exports maxDuration=60 (Hobby plan ceiling — SCRUM-447)", async () => {
    const mod = await import("../route");
    expect(mod.maxDuration).toBe(60);
  });

  it("401 without the cron bearer; no org work runs", async () => {
    const res = await callRoute({});
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
  });
});

describe("GET /api/cron/daily-summary — steady state (claim + confirm)", () => {
  it("sends yesterday only, claims before sending, confirms delivered_at after", async () => {
    state.claimedOffsets = new Set([2, 3]); // recovery days already sent on their own day
    state.callsByOffset = { 1: [COMPLETED_CALL] };

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 1, recovered: 0, skipped: 0, deduped: 0, failed: 0 });

    // Pre-claimed days are skipped WITHOUT touching the calls table.
    expect(db.ops("calls", "select")).toHaveLength(1);

    const inserts = db.ops("cron_send_ledger", "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toEqual({
      job_name: "daily-summary",
      period_key: keyOfOffset(1),
      organization_id: "org-1",
    });

    expect(sendDailySummaryNotification).toHaveBeenCalledTimes(1);

    // SCRUM-447 claim-vs-confirm: delivered_at written after the send.
    const confirms = db.ops("cron_send_ledger", "update");
    expect(confirms).toHaveLength(1);
    expect(confirms[0].payload).toHaveProperty("delivered_at");
    expect(getFilter(confirms[0], "match")!.args[0]).toMatchObject({ period_key: keyOfOffset(1) });

    // Claim precedes send precedes confirm (claim-first ordering).
    const order = db.log.map((o) => `${o.table}.${o.op}`);
    expect(order.indexOf("cron_send_ledger.insert")).toBeLessThan(order.indexOf("cron_send_ledger.update"));
  });

  it("zero-call day is skipped with no claim", async () => {
    state.claimedOffsets = new Set([2, 3]);
    state.callsByOffset = {}; // nothing yesterday either

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 0, recovered: 0, skipped: 1, deduped: 0, failed: 0 });
    expect(db.ops("cron_send_ledger", "insert")).toHaveLength(0);
    expect(sendDailySummaryNotification).not.toHaveBeenCalled();
  });

  it("claim conflict (23505) on yesterday counts as deduped, sends nothing", async () => {
    state.claimedOffsets = new Set([2, 3]);
    state.callsByOffset = { 1: [COMPLETED_CALL] };
    state.claimInsertError = { code: "23505", message: "duplicate key" };

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 0, recovered: 0, skipped: 0, deduped: 1, failed: 0 });
    expect(sendDailySummaryNotification).not.toHaveBeenCalled();
    expect(db.ops("cron_send_ledger", "update")).toHaveLength(0);
  });

  it("a 'skipped' send (all channels off by preference) keeps the claim, skips delivered_at, counts as skipped", async () => {
    state.claimedOffsets = new Set([2, 3]);
    state.callsByOffset = { 1: [COMPLETED_CALL] };
    vi.mocked(sendDailySummaryNotification).mockResolvedValue("skipped");

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 0, recovered: 0, skipped: 1, deduped: 0, failed: 0 });
    expect(db.ops("cron_send_ledger", "delete")).toHaveLength(0); // claim kept — retry would skip identically
    expect(db.ops("cron_send_ledger", "update")).toHaveLength(0); // nothing reached an inbox
  });
});

describe("GET /api/cron/daily-summary — missed-day recovery (SCRUM-447)", () => {
  it("recovers an unclaimed older day, oldest first", async () => {
    state.claimedOffsets = new Set([3]); // day-2 fully failed when it was 'yesterday'
    state.callsByOffset = { 1: [COMPLETED_CALL], 2: [COMPLETED_CALL] };

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 1, recovered: 1, skipped: 0, deduped: 0, failed: 0 });

    const inserts = db.ops("cron_send_ledger", "insert");
    expect(inserts.map((i) => i.payload!.period_key)).toEqual([keyOfOffset(2), keyOfOffset(1)]);
    expect(sendDailySummaryNotification).toHaveBeenCalledTimes(2);
    expect(db.ops("cron_send_ledger", "update")).toHaveLength(2); // both confirmed
  });

  it("zero-call recovery days are skipped without claims", async () => {
    state.claimedOffsets = new Set([3]);
    state.callsByOffset = { 1: [COMPLETED_CALL] }; // day-2 had no calls

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 1, recovered: 0, skipped: 1, deduped: 0, failed: 0 });
  });

  it("already-claimed recovery days are NOT counted as deduped (steady-state noise)", async () => {
    state.claimedOffsets = new Set([2, 3]);
    state.callsByOffset = { 1: [COMPLETED_CALL] };

    const res = await callRoute();
    const body = await res.json();
    expect(body.deduped).toBe(0);
  });

  it("ledger pre-check failure falls back to per-day claim dedupe (all 3 days attempted)", async () => {
    state.ledgerReadError = { message: "timeout" };
    state.callsByOffset = { 1: [COMPLETED_CALL] };

    const res = await callRoute();
    // Recovery days have no calls → skipped; yesterday still goes out.
    expect(await res.json()).toEqual({ sent: 1, recovered: 0, skipped: 2, deduped: 0, failed: 0 });
    expect(db.ops("calls", "select")).toHaveLength(3);
  });
});

describe("GET /api/cron/daily-summary — typed send-error branching (SCRUM-447)", () => {
  it("nothing-delivered failure RELEASES the claim (retryable by the lookback loop)", async () => {
    state.claimedOffsets = new Set([2, 3]);
    state.callsByOffset = { 1: [COMPLETED_CALL] };
    vi.mocked(sendDailySummaryNotification).mockRejectedValue(
      new NotificationDeliveryError("daily-summary: 0 notification channels delivered — wanted channel(s) unavailable: owner-email", {
        deliveredCount: 0,
        wantedCount: 1,
        permanent: true,
      }),
    );

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 0, recovered: 0, skipped: 0, deduped: 0, failed: 1 });
    expect(db.ops("cron_send_ledger", "delete")).toHaveLength(1); // claim released
    expect(db.ops("cron_send_ledger", "update")).toHaveLength(0); // never confirmed
  });

  it("a non-typed (unexpected) error also releases the claim", async () => {
    state.claimedOffsets = new Set([2, 3]);
    state.callsByOffset = { 1: [COMPLETED_CALL] };
    vi.mocked(sendDailySummaryNotification).mockRejectedValue(new Error("kaboom"));

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 0, recovered: 0, skipped: 0, deduped: 0, failed: 1 });
    expect(db.ops("cron_send_ledger", "delete")).toHaveLength(1);
  });

  it("PARTIAL delivery keeps the claim AND confirms delivered_at (something reached an inbox)", async () => {
    state.claimedOffsets = new Set([2, 3]);
    state.callsByOffset = { 1: [COMPLETED_CALL] };
    vi.mocked(sendDailySummaryNotification).mockRejectedValue(
      new NotificationDeliveryError("1/2 notification channels failed: Error: Webhook returned 500", {
        deliveredCount: 1,
        wantedCount: 2,
        permanent: false,
      }),
    );

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 0, recovered: 0, skipped: 0, deduped: 0, failed: 1 });
    expect(db.ops("cron_send_ledger", "delete")).toHaveLength(0); // claim kept — no double
    expect(db.ops("cron_send_ledger", "update")).toHaveLength(1); // confirmed anyway
  });

  it("delivered_at confirmation failure does not fail the send — Sentry-flagged instead", async () => {
    state.claimedOffsets = new Set([2, 3]);
    state.callsByOffset = { 1: [COMPLETED_CALL] };
    state.confirmError = { message: "update timeout" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callRoute();
    expect(await res.json()).toEqual({ sent: 1, recovered: 0, skipped: 0, deduped: 0, failed: 0 });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/delivered_at confirmation failed/),
      "warning",
    );
    errSpy.mockRestore();
  });
});
