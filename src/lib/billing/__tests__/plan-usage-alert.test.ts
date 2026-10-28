import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-608: when the alert fires. The subscription's own count (calls_used) — customer calls
// and the owner's chats both count — against the plan's calls; the owner at 125%, owner + team
// at 150%; ONCE per level per billing period through the cron send ledger; a send that
// delivered nothing is released so the next counted call retries; never throws.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ getSubscriptionInfo: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/notification-service")>();
  return { NotificationDeliveryError: actual.NotificationDeliveryError, sendPlanUsageAlertNotification: vi.fn(async () => "sent") };
});

import { createAdminClient } from "@/lib/supabase/admin";
import { getSubscriptionInfo } from "@/lib/stripe/billing-service";
import { sendPlanUsageAlertNotification, NotificationDeliveryError } from "@/lib/notifications/notification-service";
import { checkPlanUsageAlert, planUsagePeriodKey, PLAN_USAGE_ALERT_JOB } from "@/lib/billing/plan-usage-alert";

const ORG = "11111111-2222-4333-a444-555555555555";
const START = new Date("2026-10-20T13:00:00.000Z");
const END = new Date("2026-11-20T13:00:00.000Z");

type Op = { op: "insert" | "delete" | "update"; row?: Record<string, unknown>; match?: Record<string, unknown> };
let ops: Op[] = [];
/** The ledger: a Set of claimed keys; an insert of a claimed key is a unique violation. */
let ledger = new Set<string>();
let insertError: { code: string } | null = null;
/** This period's counted calls (the `calls` count the checker reads), and the filters it used. */
let callsCount = 0;
let callsError: { code: string } | null = null;
let callsFilters: Array<[string, unknown]> = [];
function fakeAdmin() {
  return {
    from: (table: string) => {
      if (table === "calls") {
        const q: any = {
          select: (_cols: string, opts: unknown) => { callsFilters.push(["select", opts]); return q; },
          eq: (col: string, val: unknown) => { callsFilters.push([`eq:${col}`, val]); return q; },
          gte: (col: string, val: unknown) => { callsFilters.push([`gte:${col}`, val]); return Promise.resolve(callsError ? { count: null, error: callsError } : { count: callsCount, error: null }); },
        };
        return q;
      }
      expect(table).toBe("cron_send_ledger");
      return {
        insert: async (row: Record<string, unknown>) => {
          ops.push({ op: "insert", row });
          if (insertError) return { error: insertError };
          const k = `${row.job_name}|${row.period_key}|${row.organization_id}`;
          if (ledger.has(k)) return { error: { code: "23505" } };
          ledger.add(k);
          return { error: null };
        },
        delete: () => ({ match: async (match: Record<string, unknown>) => { ops.push({ op: "delete", match }); ledger.delete(`${match.job_name}|${match.period_key}|${match.organization_id}`); return { error: null }; } }),
        update: (row: Record<string, unknown>) => ({ match: async (match: Record<string, unknown>) => { ops.push({ op: "update", row, match }); return { error: null }; } }),
      };
    },
  };
}
/** The subscription; `callsUsed` is the billing counter — the checker reads this period's calls instead. */
const sub = (extra: Record<string, unknown> = {}) => ({ plan: "starter", status: "active", callsLimit: 150, callsUsed: 0, currentPeriodStart: START, currentPeriodEnd: END, cancelAtPeriodEnd: false, trialEnd: null, ...extra });
/** this period's counted calls (the billing counter agrees unless a test says otherwise), then run the check */
const withCalls = (n: number, extra: Record<string, unknown> = {}) => { callsCount = n; vi.mocked(getSubscriptionInfo).mockResolvedValue(sub({ callsUsed: n, ...extra }) as any); };

beforeEach(() => {
  vi.clearAllMocks();
  ops = [];
  ledger = new Set();
  insertError = null;
  callsCount = 0;
  callsError = null;
  callsFilters = [];
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin() as any);
  vi.mocked(sendPlanUsageAlertNotification).mockResolvedValue("sent");
});

describe("checkPlanUsageAlert (SCRUM-608)", () => {
  it("reads THIS period's counted calls for the org — customer calls and owner chats alike (usage_counted)", async () => {
    withCalls(188);
    await checkPlanUsageAlert(ORG);
    expect(callsFilters).toEqual([["select", { count: "exact", head: true }], ["eq:organization_id", ORG], ["eq:usage_counted", true], ["gte:created_at", START.toISOString()]]);
  });

  it("under 125% does nothing — no ledger write, no email, and no count at all while the billing counter is under", async () => {
    withCalls(187); // 124.7%
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops).toEqual([]);
    expect(callsFilters).toEqual([]);
    expect(sendPlanUsageAlertNotification).not.toHaveBeenCalled();
    // The counter over but this period's calls under (the reset landed before the period moved): nothing.
    withCalls(100, { callsUsed: 200 });
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(sendPlanUsageAlertNotification).not.toHaveBeenCalled();
  });

  it("at 125%: claims the period's 125 slot, emails the owner with the plan's numbers, confirms delivery", async () => {
    withCalls(188); // 125.3%
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    expect(ops[0]).toEqual({ op: "insert", row: { job_name: PLAN_USAGE_ALERT_JOB, period_key: "125:2026-10-20", organization_id: ORG } });
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledWith({ organizationId: ORG, level: 125, callsUsed: 188, callsLimit: 150, planName: "Starter", periodEnd: END, trial: false });
    expect(ops.at(-1)).toMatchObject({ op: "update", match: { job_name: PLAN_USAGE_ALERT_JOB, period_key: "125:2026-10-20", organization_id: ORG } });
  });

  // Silent lens: Stripe moves the period up to an hour (days on a failed charge) before the payment
  // webhook resets calls_used. Keyed on the new period with last period's count, the alert fired on
  // stale numbers and spent the new period's slots. The checker counts the new period's calls itself.
  it("the renewal gap: a new period whose billing counter still holds LAST period's 188 sends nothing", async () => {
    const NEW_START = new Date("2026-11-20T13:00:00.000Z");
    withCalls(2, { callsUsed: 188, currentPeriodStart: NEW_START });
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(callsFilters).toContainEqual(["gte:created_at", NEW_START.toISOString()]);
    expect(ops).toEqual([]);
  });

  it("once per level per period: the next counted call over 125% sends nothing", async () => {
    withCalls(188);
    await checkPlanUsageAlert(ORG);
    withCalls(190);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledTimes(1);
  });

  it("at 150%: the 150 alert (owner + team) — and the 125 one is spent with it, confirmed with it, so it never arrives after the more urgent one", async () => {
    withCalls(225); // exactly 150%
    expect(await checkPlanUsageAlert(ORG)).toBe(150);
    expect(vi.mocked(sendPlanUsageAlertNotification).mock.calls[0][0]).toMatchObject({ level: 150 });
    expect(ops.filter((o) => o.op === "insert").map((o) => o.row?.period_key)).toEqual(["150:2026-10-20", "125:2026-10-20"]);
    expect(ops.filter((o) => o.op === "update").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20", "125:2026-10-20"]);
    withCalls(226);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledTimes(1);
  });

  it("125% then later 150% in the same period: two emails, one each — the 125 slot already taken is not confirmed again", async () => {
    withCalls(188);
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    ops = [];
    withCalls(225);
    expect(await checkPlanUsageAlert(ORG)).toBe(150);
    expect(vi.mocked(sendPlanUsageAlertNotification).mock.calls.map((c) => c[0].level)).toEqual([125, 150]);
    expect(ops.filter((o) => o.op === "update").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20"]);
  });

  it("a new billing period is a new slot: the alert can come again", async () => {
    withCalls(188);
    await checkPlanUsageAlert(ORG);
    withCalls(188, { currentPeriodStart: new Date("2026-11-20T13:00:00.000Z") });
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    expect(planUsagePeriodKey(125, new Date("2026-11-20T13:00:00.000Z"))).toBe("125:2026-11-20");
  });

  it("a send that delivered NOTHING releases every claim it made, so the next counted call retries; one that reached an inbox keeps and confirms them", async () => {
    withCalls(225);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("0 delivered", { deliveredCount: 0, wantedCount: 2, permanent: false }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.filter((o) => o.op === "delete").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20", "125:2026-10-20"]);
    expect(await checkPlanUsageAlert(ORG)).toBe(150); // retried
    ops = [];
    ledger = new Set();
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("1/2 failed", { deliveredCount: 1, wantedCount: 2, permanent: false }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.some((o) => o.op === "delete")).toBe(false);
    expect(ops.filter((o) => o.op === "update").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20", "125:2026-10-20"]);
  });

  it("no address to send to (no owner email): the claim is kept — not retried on every counted call", async () => {
    withCalls(188);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("0 channels", { deliveredCount: 0, wantedCount: 1, permanent: true, permanentCause: "org-config" }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.some((o) => o.op === "delete")).toBe(false);
    withCalls(189);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledTimes(1);
    // The log names what failed, never the error's own text (it can hold an address).
    expect(JSON.stringify(logged.mock.calls)).not.toContain("0 channels");
  });

  it("a send that THREW something else (a bug, an outage) releases the claim and reports the fault in full", async () => {
    const Sentry = await import("@sentry/nextjs");
    withCalls(188);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new TypeError("cannot read x of undefined"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.at(-1)).toMatchObject({ op: "delete", match: { period_key: "125:2026-10-20" } });
    expect(JSON.stringify(logged.mock.calls)).toContain("cannot read x of undefined");
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("an expired trial (still 'trialing', trial over) gets nothing", async () => {
    withCalls(188, { status: "trialing", trialEnd: new Date(Date.now() - 60_000) });
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    withCalls(188, { status: "trialing", trialEnd: new Date(Date.now() + 86_400_000) });
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
  });

  it("a ledger fault (not a duplicate) sends nothing — skip rather than risk a double", async () => {
    withCalls(188);
    insertError = { code: "57014" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(sendPlanUsageAlertNotification).not.toHaveBeenCalled();
  });

  it("a trial's email says when the trial ends", async () => {
    withCalls(188, { status: "trialing" });
    await checkPlanUsageAlert(ORG);
    expect(vi.mocked(sendPlanUsageAlertNotification).mock.calls[0][0]).toMatchObject({ trial: true });
  });

  it("nothing for: no subscription, an unlimited plan, a lapsed or past-due account, a period with no start, an unreadable count; a fault anywhere never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getSubscriptionInfo).mockResolvedValue(null as any);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    for (const limit of [-1, 0]) {
      withCalls(9999, { callsLimit: limit });
      expect(await checkPlanUsageAlert(ORG)).toBeNull();
    }
    for (const status of ["past_due", "canceled", "unpaid", "incomplete"]) {
      withCalls(9999, { status });
      expect(await checkPlanUsageAlert(ORG), status).toBeNull();
    }
    withCalls(225, { currentPeriodStart: new Date("not a date") });
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    withCalls(225);
    callsError = { code: "57014" };
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    vi.mocked(getSubscriptionInfo).mockRejectedValue(new Error("db down"));
    await expect(checkPlanUsageAlert(ORG)).resolves.toBeNull();
    expect(sendPlanUsageAlertNotification).not.toHaveBeenCalled();
    const Sentry = await import("@sentry/nextjs");
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
