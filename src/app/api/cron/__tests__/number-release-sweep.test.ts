import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

// SCRUM-479 suite for the DESTRUCTIVE number-release-sweep cron. The cron is
// exercised end-to-end against a stateful fake admin client; computeLapseState
// runs REAL (subs are built with real anchors) and releaseNumber (the carrier
// call) is mocked. Every test asserts on the carrier call + the soft-release
// DB mutation, because both are irreversible. Mirrors the subscription-dunning
// cron test's admin-mock style.

// ──────────────────────────────────────────────────────────────────────────
// Stateful fake Supabase admin client. Dispatches per `${table}.${op}`; every
// op is logged so tests can assert exact carrier/DB effects.
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

function makeBuilder(table: string) {
  const ctx: LoggedOp & { opSet?: boolean } = { table, op: "select", filters: [] };
  const run = () => {
    db.log.push(ctx);
    const handler = db.handlers[`${ctx.table}.${ctx.op}`];
    return handler ? handler(ctx) : { data: ctx.op === "select" ? [] : null, error: null };
  };
  const b: Record<string, unknown> = {
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(resolve, reject);
    },
    single: () => Promise.resolve(run()),
    maybeSingle: () => Promise.resolve(run()),
  };
  // `like` + `not` + `is` are required by the release-warning ledger query.
  for (const name of ["eq", "gte", "lt", "lte", "in", "is", "not", "or", "like", "order", "limit", "match"]) {
    (b as Record<string, unknown>)[name] = (...args: unknown[]) => {
      ctx.filters.push({ name, args });
      return b;
    };
  }
  (b as Record<string, unknown>).select = (...args: unknown[]) => {
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

// The carrier call is mocked — tests assert on whether/how it is invoked.
const releaseState = vi.hoisted(() => ({ releaseNumber: vi.fn(async (_sid: string) => undefined) }));
vi.mock("@/lib/twilio/client", () => ({
  releaseNumber: releaseState.releaseNumber,
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

// computeLapseState runs REAL — subs are constructed with real anchors so the
// state transitions (release_pending vs lapsed) are exercised honestly.

import { releaseNumber } from "@/lib/twilio/client";

// ──────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const CRON_SECRET = "test-cron-secret";

/** ISO timestamp `deltaDays` from now (negative = past). */
function at(deltaDays: number): string {
  return new Date(Date.now() + deltaDays * DAY).toISOString();
}

/** A canceled subscription whose paid access ended `daysAgo` days ago. */
function canceledSub(orgId: string, daysAgo: number) {
  return {
    organization_id: orgId,
    status: "canceled",
    trial_end: null,
    current_period_end: at(-daysAgo),
    service_ended_at: at(-daysAgo),
  };
}

/** A fully-eligible purchased Twilio phone row. */
function eligiblePhone(overrides: Record<string, unknown> = {}) {
  return {
    id: "phone-1",
    phone_number: "+61412345678",
    twilio_sid: "PN_sid_1",
    source_type: "purchased",
    is_active: true,
    ...overrides,
  };
}

const state = {
  subs: [] as Array<Record<string, unknown>>,
  phones: [] as Array<Record<string, unknown>>,
  // Non-empty = a CONFIRMED release_warning ledger row exists for the org.
  warningRows: [] as Array<Record<string, unknown>>,
  // Non-empty = the number had an inbound call in the veto window.
  inboundRows: [] as Array<Record<string, unknown>>,
  updateError: null as unknown,
  warningError: null as unknown,
  phonesError: null as unknown,
  callsError: null as unknown,
};

function installHandlers() {
  db.handlers["subscriptions.select"] = () => ({ data: state.subs, error: null });
  db.handlers["cron_send_ledger.select"] = () =>
    state.warningError ? { data: null, error: state.warningError } : { data: state.warningRows, error: null };
  db.handlers["phone_numbers.select"] = () =>
    state.phonesError ? { data: null, error: state.phonesError } : { data: state.phones, error: null };
  db.handlers["phone_numbers.update"] = () => (state.updateError ? { error: state.updateError } : { error: null });
  db.handlers["calls.select"] = () =>
    state.callsError ? { data: null, error: state.callsError } : { data: state.inboundRows, error: null };
}

async function callRoute(headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  const { GET } = await import("../number-release-sweep/route");
  return GET(new NextRequest("http://localhost/api/cron/number-release-sweep", { method: "GET", headers }));
}

const ORIGINAL_ENABLE = process.env.ENABLE_NUMBER_RELEASE_SWEEP;
const ORIGINAL_RECLAIM = process.env.RECLAIM_WINDOW_DAYS;

beforeEach(() => {
  vi.clearAllMocks();
  releaseState.releaseNumber.mockReset();
  releaseState.releaseNumber.mockResolvedValue(undefined);
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.ENABLE_NUMBER_RELEASE_SWEEP; // dormant by default
  delete process.env.RECLAIM_WINDOW_DAYS; // default 90
  db.reset();
  // Default world: one canceled org, 100d past anchor (> 90d reclaim →
  // release_pending), one eligible purchased number, warning delivered, no
  // recent inbound calls. i.e. fully eligible.
  state.subs = [canceledSub("org-1", 100)];
  state.phones = [eligiblePhone()];
  state.warningRows = [{ period_key: "release_warning:20260101" }];
  state.inboundRows = [];
  state.updateError = null;
  state.warningError = null;
  state.phonesError = null;
  state.callsError = null;
  installHandlers();
});

afterAll(() => {
  if (ORIGINAL_ENABLE === undefined) delete process.env.ENABLE_NUMBER_RELEASE_SWEEP;
  else process.env.ENABLE_NUMBER_RELEASE_SWEEP = ORIGINAL_ENABLE;
  if (ORIGINAL_RECLAIM === undefined) delete process.env.RECLAIM_WINDOW_DAYS;
  else process.env.RECLAIM_WINDOW_DAYS = ORIGINAL_RECLAIM;
});

describe("GET /api/cron/number-release-sweep — sizing & auth", () => {
  it("exports maxDuration=60 (Hobby plan ceiling)", async () => {
    const mod = await import("../number-release-sweep/route");
    expect(mod.maxDuration).toBe(60);
  });

  it("401 without the cron bearer; no work runs", async () => {
    const res = await callRoute({});
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
    expect(releaseNumber).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/number-release-sweep — master guardrail (dry-run by default)", () => {
  it("DRY-RUN by default: a fully-eligible number is NOT released and the row is NOT mutated", async () => {
    const res = await callRoute(); // ENABLE_NUMBER_RELEASE_SWEEP unset
    const body = await res.json();

    expect(releaseNumber).not.toHaveBeenCalled(); // no carrier call
    expect(db.ops("phone_numbers", "update")).toHaveLength(0); // no soft-release
    expect(body).toMatchObject({ enabled: false, released: 0, wouldRelease: 1 });
  });

  it('only the exact string "true" arms the sweep ("TRUE"/"1" stay dry-run)', async () => {
    process.env.ENABLE_NUMBER_RELEASE_SWEEP = "TRUE";
    let body = await (await callRoute()).json();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(body).toMatchObject({ enabled: false, wouldRelease: 1 });

    process.env.ENABLE_NUMBER_RELEASE_SWEEP = "1";
    body = await (await callRoute()).json();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(body).toMatchObject({ enabled: false, wouldRelease: 1 });
  });

  it("masks the number in the DRY-RUN log (last 4 only)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callRoute();
      const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("DRY-RUN would release");
      expect(logged).toContain("•5678"); // last 4 visible, preceded by a mask char
      expect(logged).not.toContain("412345678"); // earlier digits never logged
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("GET /api/cron/number-release-sweep — live release (ENABLE_NUMBER_RELEASE_SWEEP=true)", () => {
  beforeEach(() => {
    process.env.ENABLE_NUMBER_RELEASE_SWEEP = "true";
  });

  it("releases a fully-eligible number AND soft-releases the row (is_active=false, released_at set)", async () => {
    const res = await callRoute();
    const body = await res.json();

    expect(releaseNumber).toHaveBeenCalledTimes(1);
    expect(releaseNumber).toHaveBeenCalledWith("PN_sid_1");

    const updates = db.ops("phone_numbers", "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ is_active: false });
    expect(updates[0].payload).toHaveProperty("released_at");
    // Row is updated, never deleted (calls FK + audit).
    expect(db.ops("phone_numbers", "delete")).toHaveLength(0);
    // Targets the right row.
    expect(updates[0].filters).toContainEqual({ name: "eq", args: ["id", "phone-1"] });

    expect(body).toMatchObject({ enabled: true, released: 1, wouldRelease: 0, failed: 0 });

    // Carrier release happens BEFORE the soft-release DB write.
    const order = db.log.map((o) => `${o.table}.${o.op}`);
    // (the releaseNumber call itself is not in the db log, but the update must
    // come after the phone_numbers.select that loaded the row)
    expect(order.indexOf("phone_numbers.select")).toBeLessThan(order.indexOf("phone_numbers.update"));
  });

  it("masks the number in the RELEASED log (last 4 only)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callRoute();
      const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("RELEASED");
      expect(logged).toContain("•5678");
      expect(logged).not.toContain("412345678");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("GET /api/cron/number-release-sweep — each guard INDIVIDUALLY blocks release", () => {
  // All run with the sweep ARMED, so a failure to block would call releaseNumber.
  beforeEach(() => {
    process.env.ENABLE_NUMBER_RELEASE_SWEEP = "true";
  });

  it("GUARD 1 — canceled but NOT yet release_pending (within reclaim window) → no release", async () => {
    state.subs = [canceledSub("org-1", 10)]; // 10d < 90d → lapsed, not release_pending
    const body = await (await callRoute()).json();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
    expect(body).toMatchObject({ released: 0 });
  });

  it("GUARD 2 — source_type 'forwarded' (customer-owned) → never released", async () => {
    state.phones = [eligiblePhone({ source_type: "forwarded", user_phone_number: "+61400000000" })];
    await callRoute();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
  });

  it("GUARD 2 — missing twilio_sid → no release", async () => {
    state.phones = [eligiblePhone({ twilio_sid: null })];
    await callRoute();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
  });

  it("GUARD 2 — already inactive (is_active=false) → no release", async () => {
    state.phones = [eligiblePhone({ is_active: false })];
    await callRoute();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
  });

  it("GUARD 3 — no CONFIRMED release_warning ledger row → no release", async () => {
    state.warningRows = []; // no delivered warning
    await callRoute();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
    // The per-org phone load never runs when the warning gate fails. (The only
    // phone_numbers.select in armed mode is the migration-00158 preflight, which
    // carries no organization_id filter — assert no per-ORG load specifically.)
    const perOrgPhoneLoads = db
      .ops("phone_numbers", "select")
      .filter((o) => o.filters.some((f) => f.name === "eq" && f.args[0] === "organization_id"));
    expect(perOrgPhoneLoads).toHaveLength(0);
  });

  it("GUARD 3 cycle-binding — a delivered release_warning for a PRIOR anchor does NOT satisfy the guard for the current cycle", async () => {
    // The current release_pending cycle's anchor is ~100d ago.
    const sub = canceledSub("org-1", 100);
    state.subs = [sub];
    const currentAnchorKey = (sub.service_ended_at as string).slice(0, 10).replace(/-/g, "");
    // A leftover delivered warning from a PRIOR cancel cycle (different anchor),
    // e.g. a cancel→resubscribe→re-cancel earlier on. It must NOT unlock release.
    const priorAnchorKey = at(-400).slice(0, 10).replace(/-/g, "");
    expect(priorAnchorKey).not.toBe(currentAnchorKey);
    state.warningRows = [{ period_key: `release_warning:${priorAnchorKey}`, delivered_at: at(-399) }];
    // Filter-aware ledger handler: mirror the real DB `.eq('period_key', …)` so
    // the prior-anchor row is only returned for its OWN key, not the current one.
    db.handlers["cron_send_ledger.select"] = (op) => {
      const wanted = op.filters.find((f) => f.name === "eq" && f.args[0] === "period_key")?.args[1];
      const rows = state.warningRows.filter((r) => r.period_key === wanted);
      return { data: rows, error: null };
    };

    await callRoute();

    // Prior-cycle warning must not satisfy the current cycle → nothing released.
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
    // The guard queried the CURRENT cycle's exact key (eq), and used NO LIKE
    // wildcard (proving the cross-cycle hole is closed).
    const ledgerSelect = db.ops("cron_send_ledger", "select")[0];
    expect(ledgerSelect.filters).toContainEqual({
      name: "eq",
      args: ["period_key", `release_warning:${currentAnchorKey}`],
    });
    expect(ledgerSelect.filters.some((f) => f.name === "like")).toBe(false);
  });

  it("GUARD 4 — an inbound call within 30 days vetoes release (still a live line)", async () => {
    state.inboundRows = [{ id: "call-1" }];
    await callRoute();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
  });

  it("fail-closed: a release_warning ledger query error → no release", async () => {
    state.warningError = { message: "ledger boom" };
    await callRoute();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
  });

  it("fail-closed: an inbound-call query error → no release", async () => {
    state.callsError = { message: "calls boom" };
    await callRoute();
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
  });
});

describe("GET /api/cron/number-release-sweep — resilience", () => {
  beforeEach(() => {
    process.env.ENABLE_NUMBER_RELEASE_SWEEP = "true";
  });

  it("a Twilio release throw on one number is caught and the sweep continues to the next", async () => {
    state.phones = [
      eligiblePhone({ id: "phone-A", phone_number: "+61411111111", twilio_sid: "PN_A" }),
      eligiblePhone({ id: "phone-B", phone_number: "+61422222222", twilio_sid: "PN_B" }),
    ];
    releaseState.releaseNumber.mockRejectedValueOnce(new Error("twilio boom")).mockResolvedValue(undefined);

    const body = await (await callRoute()).json();

    expect(releaseNumber).toHaveBeenCalledTimes(2); // tried both
    const updates = db.ops("phone_numbers", "update");
    expect(updates).toHaveLength(1); // only the second soft-released
    expect(updates[0].filters).toContainEqual({ name: "eq", args: ["id", "phone-B"] });
    expect(body).toMatchObject({ released: 1, failed: 1 });
  });

  it("self-heal: a 404 from releaseNumber on re-run soft-releases the lying row and is NOT a hard failure", async () => {
    // The SID was released at the carrier on a PRIOR run, but that run's
    // soft-release UPDATE failed, so the row still lies (is_active=true). Twilio's
    // bare .remove() now throws a 404 (RestException status 404 / code 20404).
    const notFound = Object.assign(new Error("The requested resource was not found"), {
      status: 404,
      code: 20404,
    });
    releaseState.releaseNumber.mockRejectedValueOnce(notFound);

    const body = await (await callRoute()).json();

    expect(releaseNumber).toHaveBeenCalledTimes(1);
    // The lying row IS healed (soft-released), not re-failed.
    const updates = db.ops("phone_numbers", "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ is_active: false });
    expect(updates[0].payload).toHaveProperty("released_at");
    expect(updates[0].filters).toContainEqual({ name: "eq", args: ["id", "phone-1"] });
    // Reconciled → counted as released, NOT a hard failure.
    expect(body).toMatchObject({ released: 1, failed: 0 });
  });

  it("a soft-release DB update failure after a successful carrier release is counted as failed (not a double-release)", async () => {
    state.updateError = { message: "update boom" };
    const body = await (await callRoute()).json();
    expect(releaseNumber).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ released: 0, failed: 1 });
  });

  it("returns 500 when the subscriptions scan query errors", async () => {
    db.handlers["subscriptions.select"] = () => ({ data: null, error: { message: "subs boom" } });
    const res = await callRoute();
    expect(res.status).toBe(500);
    expect(releaseNumber).not.toHaveBeenCalled();
  });

  it("preflight: armed + the released_at column probe fails (migration 00158 not applied) → aborts (500), releases nothing", async () => {
    // Simulate migration 00158 NOT applied: any select touching released_at
    // errors (column does not exist). The per-org load (which selects other
    // columns) would be fine — but the preflight must abort before we get there.
    db.handlers["phone_numbers.select"] = (op) => {
      const probesReleasedAt = op.filters.some(
        (f) => f.name === "select" && String(f.args[0]).includes("released_at")
      );
      if (probesReleasedAt) {
        return { data: null, error: { code: "42703", message: 'column "released_at" does not exist' } };
      }
      return { data: state.phones, error: null };
    };

    const res = await callRoute();

    // Aborts the WHOLE run: no carrier release (irreversible), no DB mutation.
    expect(res.status).toBe(500);
    expect(releaseNumber).not.toHaveBeenCalled();
    expect(db.ops("phone_numbers", "update")).toHaveLength(0);
  });
});
