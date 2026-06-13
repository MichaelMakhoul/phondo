import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

// SCRUM-478 suite for the subscription-dunning cron. The cron is exercised
// end-to-end against a stateful fake admin client plus mocked providers
// (Resend/Twilio) — computeLapseState and the real
// sendSubscriptionLapseNotification run unmocked so milestone selection AND the
// SMS double-gate are covered in one file. Mirrors the daily-summary cron test's
// admin-mock style.

// ──────────────────────────────────────────────────────────────────────────
// Stateful fake Supabase admin client. Supports both the awaited query chain
// (.then) used by the cron's ledger/subscription queries and .single() used by
// the notification service's owner-email / prefs lookups. Every op is logged.
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
  for (const name of ["eq", "gte", "lt", "lte", "in", "is", "not", "or", "order", "limit", "match"]) {
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

vi.mock("@/lib/stripe/billing-service", () => ({
  hasFeatureAccess: vi.fn(async () => true),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((fn: (scope: unknown) => void) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() })
  ),
}));

// validation is left REAL: requireCronAuth needs the real timingSafeCompare,
// and the dunning path uses the real escapeHtml (no webhook → no ssrfSafeFetch).

const resendState = vi.hoisted(() => ({
  send: vi.fn(async (_args: { from: string; to: string; subject: string; html: string }) => ({ error: null })),
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendState.send };
  },
}));

const twilioState = vi.hoisted(() => ({ create: vi.fn(async () => ({ sid: "SM1" })) }));
vi.mock("twilio", () => ({
  default: vi.fn(() => ({ messages: { create: twilioState.create } })),
}));

import { hasFeatureAccess } from "@/lib/stripe/billing-service";

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

const state = {
  subs: [] as Array<Record<string, unknown>>,
  prefs: {} as Record<string, unknown>,
  ownerEmail: "owner@biz.com.au" as string | null,
  phoneRows: [{ phone_number: "+61412345678" }] as Array<Record<string, unknown>>,
  claimInsertError: null as unknown,
  confirmError: null as unknown,
};

function installHandlers() {
  db.handlers["subscriptions.select"] = () => ({ data: state.subs, error: null });
  db.handlers["cron_send_ledger.insert"] = () =>
    state.claimInsertError ? { error: state.claimInsertError } : { error: null };
  db.handlers["cron_send_ledger.update"] = () =>
    state.confirmError ? { error: state.confirmError } : { error: null };
  db.handlers["cron_send_ledger.delete"] = () => ({ error: null });
  db.handlers["org_members.select"] = () => ({ data: { user_id: "user-1" }, error: null });
  db.handlers["user_profiles.select"] = () => ({ data: { email: state.ownerEmail }, error: null });
  db.handlers["notification_preferences.select"] = () => ({ data: state.prefs, error: null });
  db.handlers["phone_numbers.select"] = () => ({ data: state.phoneRows, error: null });
}

async function callRoute(headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  const { GET } = await import("../subscription-dunning/route");
  return GET(new NextRequest("http://localhost/api/cron/subscription-dunning", { method: "GET", headers }));
}

const ORIGINAL_EMAIL_KEY = process.env.EMAIL_API_KEY;
const ORIGINAL_DUNNING_SMS = process.env.DUNNING_SMS_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasFeatureAccess).mockResolvedValue(true);
  resendState.send.mockResolvedValue({ error: null });
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.EMAIL_API_KEY = "test-key";
  delete process.env.DUNNING_SMS_ENABLED; // OFF by default
  db.reset();
  state.subs = [];
  state.prefs = { email_on_subscription_dunning: true, sms_on_subscription_dunning: false, sms_phone_number: null };
  state.ownerEmail = "owner@biz.com.au";
  state.phoneRows = [{ phone_number: "+61412345678" }];
  state.claimInsertError = null;
  state.confirmError = null;
  installHandlers();
});

afterAll(() => {
  if (ORIGINAL_EMAIL_KEY === undefined) delete process.env.EMAIL_API_KEY;
  else process.env.EMAIL_API_KEY = ORIGINAL_EMAIL_KEY;
  if (ORIGINAL_DUNNING_SMS === undefined) delete process.env.DUNNING_SMS_ENABLED;
  else process.env.DUNNING_SMS_ENABLED = ORIGINAL_DUNNING_SMS;
});

describe("GET /api/cron/subscription-dunning — sizing & auth", () => {
  it("exports maxDuration=60 (Hobby plan ceiling)", async () => {
    const mod = await import("../subscription-dunning/route");
    expect(mod.maxDuration).toBe(60);
  });

  it("401 without the cron bearer; no work runs", async () => {
    const res = await callRoute({});
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
  });
});

describe("GET /api/cron/subscription-dunning — milestone selection per state", () => {
  it("claims the right milestone for each lapse state and skips active trials", async () => {
    state.subs = [
      canceledSub("org-grace-start", 1), // in_grace, far from grace end → grace_started
      canceledSub("org-grace-end", 6), // in_grace, within 2d of grace end → grace_ending_soon
      canceledSub("org-lapsed", 10), // lapsed, far from reclaim → ai_diverting
      canceledSub("org-release", 85), // lapsed, within 7d of 90d reclaim → release_warning
      { organization_id: "org-active-trial", status: "trialing", trial_end: at(5), current_period_end: at(5), service_ended_at: null },
    ];

    const res = await callRoute();
    const body = await res.json();

    const claimedKeys = db
      .ops("cron_send_ledger", "insert")
      .map((o) => o.payload!.period_key as string);
    const milestones = claimedKeys.map((k) => k.split(":")[0]).sort();
    expect(milestones).toEqual(["ai_diverting", "grace_ending_soon", "grace_started", "release_warning"]);

    // Active trial → computeLapseState returns active → no claim, no email.
    expect(claimedKeys).toHaveLength(4);
    expect(body.sent).toBe(4);
    // Every claim is anchored to the lapse cycle (period_key = milestone:YYYYMMDD).
    for (const k of claimedKeys) expect(k).toMatch(/^[a-z_]+:\d{8}$/);
  });

  it("release_warning masks the org number (reveals only the last 4 digits)", async () => {
    state.subs = [canceledSub("org-release", 85)];
    await callRoute();
    const sentArg = resendState.send.mock.calls[0][0] as { html: string };
    expect(sentArg.html).toContain("•5678"); // last 4 shown
    expect(sentArg.html).not.toContain("412345678"); // earlier digits masked
  });
});

describe("GET /api/cron/subscription-dunning — claim/confirm orchestration", () => {
  it("claims before sending and confirms delivered_at on success", async () => {
    state.subs = [canceledSub("org-1", 1)]; // grace_started

    const res = await callRoute();
    expect(await res.json()).toMatchObject({ sent: 1, skipped: 0, deduped: 0, failed: 0 });

    expect(db.ops("cron_send_ledger", "insert")).toHaveLength(1);
    expect(resendState.send).toHaveBeenCalledTimes(1);

    const confirms = db.ops("cron_send_ledger", "update");
    expect(confirms).toHaveLength(1);
    expect(confirms[0].payload).toHaveProperty("delivered_at");

    // Claim precedes confirm.
    const order = db.log.map((o) => `${o.table}.${o.op}`);
    expect(order.indexOf("cron_send_ledger.insert")).toBeLessThan(order.indexOf("cron_send_ledger.update"));
  });

  it("idempotent skip on 23505 — no send, no confirm", async () => {
    state.subs = [canceledSub("org-1", 1)];
    state.claimInsertError = { code: "23505", message: "duplicate key" };

    const res = await callRoute();
    expect(await res.json()).toMatchObject({ sent: 0, deduped: 1, failed: 0 });
    expect(resendState.send).not.toHaveBeenCalled();
    expect(db.ops("cron_send_ledger", "update")).toHaveLength(0);
  });

  it("all channels disabled by preference → skipped: claim kept, NOT confirmed", async () => {
    state.subs = [canceledSub("org-1", 1)];
    state.prefs = { email_on_subscription_dunning: false, sms_on_subscription_dunning: false, sms_phone_number: null };

    const res = await callRoute();
    expect(await res.json()).toMatchObject({ sent: 0, skipped: 1, failed: 0 });

    expect(db.ops("cron_send_ledger", "insert")).toHaveLength(1); // claim kept
    expect(db.ops("cron_send_ledger", "delete")).toHaveLength(0); // not released
    expect(db.ops("cron_send_ledger", "update")).toHaveLength(0); // not confirmed
    expect(resendState.send).not.toHaveBeenCalled();
  });

  it("nothing delivered (provider creds absent) → RELEASES the claim for retry", async () => {
    state.subs = [canceledSub("org-1", 1)];
    delete process.env.EMAIL_API_KEY; // sendEmail throws → 0 channels delivered

    const res = await callRoute();
    expect(await res.json()).toMatchObject({ sent: 0, failed: 1 });

    expect(db.ops("cron_send_ledger", "delete")).toHaveLength(1); // claim released
    expect(db.ops("cron_send_ledger", "update")).toHaveLength(0); // never confirmed
  });
});

describe("GET /api/cron/subscription-dunning — SMS double-gate (SCRUM-478)", () => {
  it("SMS suppressed while DUNNING_SMS_ENABLED is off, even with the pref on and an entitled plan", async () => {
    state.subs = [canceledSub("org-1", 1)];
    state.prefs = {
      email_on_subscription_dunning: true,
      sms_on_subscription_dunning: true, // pref ON
      sms_phone_number: "+61499999999", // number configured
    };
    vi.mocked(hasFeatureAccess).mockResolvedValue(true); // entitled
    // DUNNING_SMS_ENABLED stays unset (off) — the global kill switch.

    const res = await callRoute();
    expect(await res.json()).toMatchObject({ sent: 1, failed: 0 });

    expect(resendState.send).toHaveBeenCalledTimes(1); // email still goes out
    expect(twilioState.create).not.toHaveBeenCalled(); // SMS suppressed
    // Kill switch short-circuits before the plan check is even consulted.
    expect(hasFeatureAccess).not.toHaveBeenCalled();
  });

  it("with the kill switch ON, the SMS sends alongside the email (gate opens)", async () => {
    process.env.DUNNING_SMS_ENABLED = "true";
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "tok_test";
    process.env.TWILIO_FROM_NUMBER = "+61400000000";
    state.subs = [canceledSub("org-1", 1)];
    state.prefs = {
      email_on_subscription_dunning: true,
      sms_on_subscription_dunning: true,
      sms_phone_number: "+61499999999",
    };
    vi.mocked(hasFeatureAccess).mockResolvedValue(true);

    try {
      const res = await callRoute();
      expect(await res.json()).toMatchObject({ sent: 1, failed: 0 });

      expect(resendState.send).toHaveBeenCalledTimes(1);
      expect(twilioState.create).toHaveBeenCalledTimes(1);
      expect(hasFeatureAccess).toHaveBeenCalledWith("org-1", "smsNotifications");
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_FROM_NUMBER;
    }
  });
});
