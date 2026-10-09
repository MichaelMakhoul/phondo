import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { NextRequest } from "next/server";

// SCRUM-586: the owner ringing their own assistant is not a customer call —
// it must not inflate "calls today" nor trigger a summary on its own.

type LoggedOp = { table: string; op: "select" | "insert" | "update" | "delete"; payload?: Record<string, unknown>; filters: Array<{ name: string; args: unknown[] }> };

const db = vi.hoisted(() => ({
  handlers: {} as Record<string, (op: { table: string; op: string; filters: Array<{ name: string; args: unknown[] }> }) => { data?: unknown; error?: unknown }>,
  log: [] as Array<{ table: string; op: string; filters: Array<{ name: string; args: unknown[] }> }>,
  reset() { this.handlers = {}; this.log = []; },
}));

function makeBuilder(table: string) {
  const ctx: LoggedOp & { opSet?: boolean } = { table, op: "select", filters: [] };
  const b: Record<string, unknown> = {
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      db.log.push(ctx);
      const handler = db.handlers[`${ctx.table}.${ctx.op}`];
      const result = handler ? handler(ctx) : { data: ctx.op === "select" ? [] : null, error: null };
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  for (const name of ["eq", "gte", "lt", "lte", "in", "is", "not", "order", "limit", "match"]) {
    (b as Record<string, unknown>)[name] = (...args: unknown[]) => { ctx.filters.push({ name, args }); return b; };
  }
  (b as Record<string, unknown>).select = (...args: unknown[]) => {
    if (!ctx.opSet) ctx.op = "select";
    ctx.filters.push({ name: "select", args });
    return b;
  };
  for (const op of ["insert", "update", "delete"] as const) {
    (b as Record<string, unknown>)[op] = (payload?: Record<string, unknown>) => { ctx.op = op; ctx.opSet = true; ctx.payload = payload; return b; };
  }
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => makeBuilder(t) }) }));
vi.mock("@/lib/security/cron-auth", () => ({ requireCronAuth: () => null }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/notification-service")>();
  return { ...actual, sendDailySummaryNotification: vi.fn(async () => "sent" as const) };
});

import { sendDailySummaryNotification } from "@/lib/notifications/notification-service";
import { GET } from "../route";

const OWNER_CALL = { id: "c-owner", status: "completed", is_spam: false, duration_seconds: 45, action_taken: null, metadata: { call_type: "owner" } };
const CUSTOMER_CALL = { id: "c-1", status: "completed", is_spam: false, duration_seconds: 120, action_taken: "appointment_booked", metadata: null };

let logSpy: MockInstance;

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  // The route prints a one-line run summary per request; keep this file's output clean.
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  db.handlers["organizations.select"] = () => ({ data: [{ id: "org-1", timezone: "Australia/Sydney" }], error: null });
  db.handlers["cron_send_ledger.select"] = () => ({ data: [], error: null });
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("daily-summary excludes owner calls (SCRUM-586)", () => {
  it("an org-day with ONLY owner calls sends no summary (skipped like a zero-call day)", async () => {
    db.handlers["calls.select"] = () => ({ data: [OWNER_CALL], error: null });
    const res = await GET(new NextRequest("http://localhost/api/cron/daily-summary"));
    expect(await res.json()).toEqual({ sent: 0, recovered: 0, skipped: 3, deduped: 0, failed: 0 });
    expect(sendDailySummaryNotification).not.toHaveBeenCalled();
    expect(db.log.filter((o) => o.table === "cron_send_ledger" && o.op === "insert")).toHaveLength(0);
  });

  it("owner calls are left out of every count", async () => {
    db.handlers["calls.select"] = () => ({ data: [OWNER_CALL, CUSTOMER_CALL], error: null });
    const res = await GET(new NextRequest("http://localhost/api/cron/daily-summary"));
    expect((await res.json()).sent).toBe(1);
    expect(sendDailySummaryNotification).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org-1", totalCalls: 1, answeredCalls: 1, missedCalls: 0, appointmentsBooked: 1, averageCallDuration: 120,
    }));
  });

  it("selects metadata so the flag is available", async () => {
    db.handlers["calls.select"] = () => ({ data: [CUSTOMER_CALL], error: null });
    await GET(new NextRequest("http://localhost/api/cron/daily-summary"));
    const q = db.log.find((o) => o.table === "calls")!;
    expect(q.filters.find((f) => f.name === "select")?.args[0]).toContain("metadata");
  });
});

// ── Beyond the three cases above ────────────────────────────────────────────

// The ledger pre-check reports the two older lookback days as already sent, so only
// yesterday is processed and the response body can be pinned exactly.
function claimOlderLookbackDays() {
  db.handlers["cron_send_ledger.select"] = (ctx) => {
    const keys = [...(ctx.filters.find((f) => f.name === "in")!.args[1] as string[])].sort();
    return { data: keys.slice(0, -1).map((period_key) => ({ period_key })), error: null };
  };
}

async function runCron() {
  const res = await GET(new NextRequest("http://localhost/api/cron/daily-summary"));
  return res.json();
}

describe("only an explicit call_type 'owner' leaves a call out (SCRUM-586)", () => {
  // calls.metadata is a nullable JSONB column with no default, and call_type is only ever
  // stamped on owner calls — so NULL, missing or anything else must stay a customer call
  // (the `call_type IS DISTINCT FROM 'owner'` reading). The exact-value cases mirror
  // call-completed, which also runs the customer pipeline for anything but 'owner'.
  it.each<[string, unknown]>([
    ["the row carries no metadata key", undefined],
    ["metadata is NULL", null],
    ["metadata is an empty object", {}],
    ["metadata has no call_type key", { voice_provider: "self_hosted", owner_auth: "locked" }],
    ["call_type is NULL", { call_type: null }],
    ["call_type is some other string", { call_type: "outbound" }],
    ["call_type differs only in case", { call_type: "Owner" }],
    ["call_type is not a string", { call_type: true }],
  ])("%s: still counted as a customer call", async (_label, metadata) => {
    claimOlderLookbackDays();
    db.handlers["calls.select"] = () => ({ data: [{ ...CUSTOMER_CALL, metadata }], error: null });

    expect(await runCron()).toEqual({ sent: 1, recovered: 0, skipped: 0, deduped: 0, failed: 0 });
    expect(sendDailySummaryNotification).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org-1", totalCalls: 1, answeredCalls: 1, appointmentsBooked: 1,
    }));
  });

  it("an owner call next to NULL-metadata customer calls drops only the owner call", async () => {
    claimOlderLookbackDays();
    db.handlers["calls.select"] = () => ({
      data: [
        { ...CUSTOMER_CALL, id: "c-null", metadata: null },
        OWNER_CALL,
        { ...CUSTOMER_CALL, id: "c-empty", metadata: {} },
      ],
      error: null,
    });

    expect(await runCron()).toEqual({ sent: 1, recovered: 0, skipped: 0, deduped: 0, failed: 0 });
    expect(sendDailySummaryNotification).toHaveBeenCalledWith(expect.objectContaining({ totalCalls: 2, answeredCalls: 2 }));
  });
});

describe("owner calls are left out of every figure (SCRUM-586)", () => {
  // Each owner call here would move a figure if it were counted: o-1 would inflate the
  // total, answered, booked and average-duration figures; o-2 would inflate missed.
  const calls = {
    customerBooked: { id: "c-a", status: "completed", is_spam: false, duration_seconds: 100, action_taken: "appointment_booked", metadata: null },
    customerSpam: { id: "c-b", status: "completed", is_spam: true, duration_seconds: 200, action_taken: null, metadata: {} },
    customerMissed: { id: "c-m", status: "no-answer", is_spam: false, duration_seconds: null, action_taken: null, metadata: { owner_auth: "locked" } },
    ownerBooked: { id: "o-1", status: "completed", is_spam: false, duration_seconds: 1000, action_taken: "appointment_booked", metadata: { call_type: "owner", owner_auth: "verified" } },
    ownerBusy: { id: "o-2", status: "busy", is_spam: false, duration_seconds: null, action_taken: null, metadata: { call_type: "owner" } },
  };

  it("total, answered, missed, booked and average duration are computed from customer calls only", async () => {
    claimOlderLookbackDays();
    db.handlers["calls.select"] = () => ({
      data: [calls.ownerBooked, calls.customerBooked, calls.ownerBusy, calls.customerSpam, calls.customerMissed],
      error: null,
    });

    expect(await runCron()).toEqual({ sent: 1, recovered: 0, skipped: 0, deduped: 0, failed: 0 });
    expect(sendDailySummaryNotification).toHaveBeenCalledTimes(1);
    expect(sendDailySummaryNotification).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org-1",
      totalCalls: 3,
      answeredCalls: 1, // the booked call; the spam call is not "answered"
      missedCalls: 1, // the no-answer call; the owner's busy call is not a miss
      appointmentsBooked: 1, // the owner's booking is not a customer booking
      averageCallDuration: 150, // (100 + 200) / 2 — the owner's 1000s call is out
      topCallerIntents: [],
    }));
  });

  it("an org-day of nothing but owner calls claims nothing and sends nothing", async () => {
    claimOlderLookbackDays();
    db.handlers["calls.select"] = () => ({ data: [calls.ownerBooked, calls.ownerBusy], error: null });

    expect(await runCron()).toEqual({ sent: 0, recovered: 0, skipped: 1, deduped: 0, failed: 0 });
    expect(sendDailySummaryNotification).not.toHaveBeenCalled();
    expect(db.log.filter((o) => o.table === "cron_send_ledger" && o.op !== "select")).toHaveLength(0);
  });
});

describe("the calls query stays what the figures depend on (SCRUM-586)", () => {
  it("still selects every column the figures are computed from", async () => {
    db.handlers["calls.select"] = () => ({ data: [CUSTOMER_CALL], error: null });
    await runCron();

    const q = db.log.find((o) => o.table === "calls")!;
    const columns = String(q.filters.find((f) => f.name === "select")?.args[0]).split(",").map((c) => c.trim());
    expect(columns).toEqual(expect.arrayContaining(["status", "is_spam", "duration_seconds", "action_taken", "metadata"]));
  });

  it("is still scoped to the organization and to the local day", async () => {
    db.handlers["calls.select"] = () => ({ data: [], error: null });
    await runCron();

    const q = db.log.find((o) => o.table === "calls")!;
    expect(q.filters).toContainEqual({ name: "eq", args: ["organization_id", "org-1"] });
    expect(q.filters.some((f) => f.name === "gte" && f.args[0] === "created_at")).toBe(true);
    expect(q.filters.some((f) => f.name === "lt" && f.args[0] === "created_at")).toBe(true);
  });
});
