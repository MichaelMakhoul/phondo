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
    expect(ops[0]).toEqual({ op: "insert", row: { job_name: PLAN_USAGE_ALERT_JOB, period_key: "125:2026-10-20T13:00:00.000Z", organization_id: ORG } });
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledWith({ organizationId: ORG, level: 125, callsUsed: 188, callsLimit: 150, planName: "Starter", periodEnd: END, trial: false });
    expect(ops.at(-1)).toMatchObject({ op: "update", match: { job_name: PLAN_USAGE_ALERT_JOB, period_key: "125:2026-10-20T13:00:00.000Z", organization_id: ORG } });
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
    expect(ops.filter((o) => o.op === "insert").map((o) => o.row?.period_key)).toEqual(["150:2026-10-20T13:00:00.000Z", "125:2026-10-20T13:00:00.000Z"]);
    expect(ops.filter((o) => o.op === "update").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20T13:00:00.000Z", "125:2026-10-20T13:00:00.000Z"]);
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
    expect(ops.filter((o) => o.op === "update").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20T13:00:00.000Z"]);
  });

  it("a new billing period is a new slot: the alert can come again", async () => {
    withCalls(188);
    await checkPlanUsageAlert(ORG);
    withCalls(188, { currentPeriodStart: new Date("2026-11-20T13:00:00.000Z") });
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    expect(planUsagePeriodKey(125, new Date("2026-11-20T13:00:00.000Z"))).toBe("125:2026-11-20T13:00:00.000Z");
  });

  it("a send that delivered NOTHING releases every claim it made, so the next counted call retries; one that reached an inbox keeps and confirms them", async () => {
    withCalls(225);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("0 delivered", { deliveredCount: 0, wantedCount: 2, permanent: false }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.filter((o) => o.op === "delete").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20T13:00:00.000Z", "125:2026-10-20T13:00:00.000Z"]);
    expect(await checkPlanUsageAlert(ORG)).toBe(150); // retried
    ops = [];
    ledger = new Set();
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("1/2 failed", { deliveredCount: 1, wantedCount: 2, permanent: false }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.some((o) => o.op === "delete")).toBe(false);
    expect(ops.filter((o) => o.op === "update").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20T13:00:00.000Z", "125:2026-10-20T13:00:00.000Z"]);
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
    expect(ops.at(-1)).toMatchObject({ op: "delete", match: { period_key: "125:2026-10-20T13:00:00.000Z" } });
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

// SCRUM-608 review (independent mutation run on 6c08e31f): paths the tests above leave open.
// Each passes on the real code and fails on the mutant named in the comment above it.
describe("checkPlanUsageAlert (SCRUM-608) — review killers", () => {
  /** The fake above, with one ledger write failing (the calls count and the other writes untouched). */
  const failingLedger = (op: "delete" | "update") => {
    const admin = fakeAdmin();
    return { from: (table: string) => ({ ...admin.from(table), [op]: () => ({ match: async () => ({ error: { code: "08006" } }) }) }) };
  };

  // kills: the billing-counter gate's < turned <= (a 150-call plan can't land on exactly 125%; a 400-call plan can)
  it("exactly 125% alerts: 500 calls on a 400-call plan", async () => {
    withCalls(500, { callsLimit: 400 });
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
  });

  // kills: the expired-trial skip applied to any status (a converted subscription keeps its past trial_end)
  it("a paying account whose trial ended long ago (status active, trialEnd in the past) still gets the alert", async () => {
    withCalls(188, { status: "active", trialEnd: new Date(Date.now() - 30 * 86_400_000) });
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
  });

  // kills: a send that threw at 150% releasing only the 150 slot (the 125 slot it spent would stay claimed, unconfirmed)
  it("a send that threw at 150% releases both slots it claimed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withCalls(225);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new TypeError("cannot read x of undefined"));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.filter((o) => o.op === "delete").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20T13:00:00.000Z", "125:2026-10-20T13:00:00.000Z"]);
  });

  // kills: any permanent failure kept like org-config — the credential-absence contract says RELEASE
  it("a send that failed on ABSENT provider credentials releases its claims — once the env is fixed the next counted call delivers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withCalls(225);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("EMAIL_API_KEY absent", { deliveredCount: 0, wantedCount: 2, permanent: true, permanentCause: "credential-absence" }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.filter((o) => o.op === "delete").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20T13:00:00.000Z", "125:2026-10-20T13:00:00.000Z"]);
    expect(await checkPlanUsageAlert(ORG)).toBe(150); // retried
  });

  // kills: the org-config keep also writing delivered_at
  it("no address to send to: the claim is kept but never confirmed — nothing was delivered", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withCalls(188);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("0 channels", { deliveredCount: 0, wantedCount: 1, permanent: true, permanentCause: "org-config" }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.map((o) => o.op)).toEqual(["insert"]);
  });

  // kills: "skipped" handled like "sent" (delivered_at written, the level reported as emailed)
  it("a 'skipped' send keeps its claim unconfirmed and reports nothing sent — nothing reached an inbox", async () => {
    withCalls(188);
    vi.mocked(sendPlanUsageAlertNotification).mockResolvedValueOnce("skipped");
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.map((o) => o.op)).toEqual(["insert"]);
  });

  // kills: a release that also frees the 125 slot an earlier, delivered send holds
  it("a 150 send that delivered nothing frees only the slots it claimed — the delivered 125 alert keeps its ledger row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withCalls(188);
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    ops = [];
    withCalls(225);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("0 delivered", { deliveredCount: 0, wantedCount: 2, permanent: false }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.filter((o) => o.op === "delete").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20T13:00:00.000Z"]);
    expect(ledger.has(`${PLAN_USAGE_ALERT_JOB}|125:2026-10-20T13:00:00.000Z|${ORG}`)).toBe(true);
  });

  // kills: the Sentry page dropped from a failed release
  it("a release that fails is paged to Sentry at error level — the alert is lost for the period", async () => {
    const Sentry = await import("@sentry/nextjs");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue(failingLedger("delete") as any);
    withCalls(188);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("0 delivered", { deliveredCount: 0, wantedCount: 1, permanent: false }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining(ORG), "error");
  });

  // kills: the Sentry warning dropped from a failed confirmation
  it("a confirmation that fails is reported to Sentry as a warning — reconciliation would flag a delivered send as crashed", async () => {
    const Sentry = await import("@sentry/nextjs");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createAdminClient).mockReturnValue(failingLedger("update") as any);
    withCalls(188);
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining(ORG), "warning");
  });

  // kills: a renamed ledger job (the tests above compare against the constant itself)
  it("the ledger job name is persisted state — it stays 'plan-usage-alert' (a rename re-sends this period's alerts)", async () => {
    withCalls(188);
    await checkPlanUsageAlert(ORG);
    expect(ops[0].row?.job_name).toBe("plan-usage-alert");
  });
});

// SCRUM-609: /review-and-fix on the merged #459 (silent-failure + code lenses).
describe("checkPlanUsageAlert (SCRUM-609) — review-and-fix", () => {
  const pages = async () => {
    const Sentry = await import("@sentry/nextjs");
    return vi.mocked(Sentry.captureMessage).mock.calls
      .filter(([m]) => typeof m === "string" && m.startsWith("Plan usage alert: "))
      .map(([m, ctx]) => ({ message: m as string, ctx: ctx as { level?: string; extra?: Record<string, unknown> } }));
  };
  const deliveryError = (facts: { deliveredCount: number; wantedCount: number; permanent: boolean; permanentCause?: "org-config" | "credential-absence" }) =>
    new NotificationDeliveryError("send failed", facts);

  it("the key is the period's exact start — two periods that start on the same day get their own slots", () => {
    expect(planUsagePeriodKey(125, new Date("2026-10-20T13:00:00.000Z"))).toBe("125:2026-10-20T13:00:00.000Z");
    expect(planUsagePeriodKey(125, new Date("2026-10-20T01:00:00.000Z"))).not.toBe(planUsagePeriodKey(125, new Date("2026-10-20T13:00:00.000Z")));
  });

  // Code lens: calls_used resets on invoice.payment_succeeded, an hour (or, on a declined card,
  // days) after the period moves — the gap's calls are counted as rows, then wiped from the counter.
  it("the email never shows more than the dashboard: a late reset's gap calls don't push the level or the number", async () => {
    withCalls(240, { callsUsed: 190 }); // rows say 160%, the dashboard 127%
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 125, callsUsed: 190 }));
    expect(ops[0].row?.period_key).toBe("125:2026-10-20T13:00:00.000Z");
  });

  it("and the other way: fewer calls this period than the counter (a stale counter) uses this period's count", async () => {
    withCalls(230, { callsUsed: 260 });
    expect(await checkPlanUsageAlert(ORG)).toBe(150);
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 150, callsUsed: 230 }));
  });

  // Silent lens: Sentry never sees console lines — each of these used to stop the alerts unseen.
  it("a ledger claim fault is paged (warning, with the org and slot) — a lasting one would stop every alert", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    insertError = { code: "08006" };
    withCalls(188);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(sendPlanUsageAlertNotification).not.toHaveBeenCalled();
    expect(await pages()).toEqual([{ message: "Plan usage alert: ledger claim failed", ctx: expect.objectContaining({ level: "warning", extra: { organizationId: ORG, periodKey: "125:2026-10-20T13:00:00.000Z", code: "08006" } }) }]);
  });

  it("an unreadable count is paged (warning) and nothing is claimed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    callsError = { code: "57014" };
    withCalls(188);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops).toEqual([]);
    expect(await pages()).toEqual([{ message: "Plan usage alert: counting the period's calls failed", ctx: expect.objectContaining({ level: "warning", extra: { organizationId: ORG, code: "57014" } }) }]);
  });

  it("a send that delivered nothing (not permanent) is released AND paged — a sender that keeps refusing fails every call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withCalls(188);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(deliveryError({ deliveredCount: 0, wantedCount: 1, permanent: false }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.map((o) => o.op)).toEqual(["insert", "delete"]);
    expect((await pages()).map((p) => p.message)).toEqual(["Plan usage alert: nothing delivered — the next counted call retries"]);
  });

  it("a partial delivery is confirmed (never re-sent) AND paged — a recipient missed it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withCalls(230);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(deliveryError({ deliveredCount: 1, wantedCount: 2, permanent: false }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.filter((o) => o.op === "update").map((o) => o.match?.period_key)).toEqual(["150:2026-10-20T13:00:00.000Z", "125:2026-10-20T13:00:00.000Z"]);
    expect(ops.some((o) => o.op === "delete")).toBe(false);
    const p = await pages();
    expect(p.map((x) => x.message)).toEqual(["Plan usage alert: partly delivered — a recipient missed it and it won't be resent"]);
    expect(p[0].ctx.extra).toEqual({ organizationId: ORG, level: 150, delivered: true, permanent: false, permanentCause: null });
  });

  it("missing credentials page on their own, and no address was reported by the lookup — neither pages twice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withCalls(188);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(deliveryError({ deliveredCount: 0, wantedCount: 1, permanent: true, permanentCause: "credential-absence" }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.map((o) => o.op)).toEqual(["insert", "delete"]); // released: a fixed deployment retries
    ops = []; ledger = new Set();
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(deliveryError({ deliveredCount: 0, wantedCount: 1, permanent: true, permanentCause: "org-config" }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.map((o) => o.op)).toEqual(["insert"]); // kept: no address to retry to
    expect(await pages()).toEqual([]);
  });
});
