import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-608: when the alert fires. The subscription's own count (calls_used) — customer calls
// and the owner's chats both count — against the plan's calls; the owner at 125%, owner + team
// at 150%; ONCE per level per billing period through the cron send ledger; a send that
// delivered nothing is released so the next counted call retries; never throws.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/billing-service", () => ({ getSubscriptionInfo: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
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
function fakeAdmin() {
  return {
    from: (table: string) => {
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
const sub = (callsUsed: number, extra: Record<string, unknown> = {}) => ({ plan: "starter", status: "active", callsLimit: 150, callsUsed, currentPeriodStart: START, currentPeriodEnd: END, cancelAtPeriodEnd: false, trialEnd: null, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  ops = [];
  ledger = new Set();
  insertError = null;
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin() as any);
  vi.mocked(sendPlanUsageAlertNotification).mockResolvedValue("sent");
});

describe("checkPlanUsageAlert (SCRUM-608)", () => {
  it("under 125% does nothing — no ledger write, no email", async () => {
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(187) as any); // 124.7%
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops).toEqual([]);
    expect(sendPlanUsageAlertNotification).not.toHaveBeenCalled();
  });

  it("at 125%: claims the period's 125 slot, emails the owner with the plan's numbers, confirms delivery", async () => {
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(188) as any); // 125.3%
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    expect(ops[0]).toEqual({ op: "insert", row: { job_name: PLAN_USAGE_ALERT_JOB, period_key: "125:2026-10-20", organization_id: ORG } });
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledWith({ organizationId: ORG, level: 125, callsUsed: 188, callsLimit: 150, planName: "Starter", periodEnd: END });
    expect(ops.at(-1)).toMatchObject({ op: "update", match: { job_name: PLAN_USAGE_ALERT_JOB, period_key: "125:2026-10-20", organization_id: ORG } });
  });

  it("once per level per period: the next counted call over 125% sends nothing", async () => {
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(188) as any);
    await checkPlanUsageAlert(ORG);
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(190) as any);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledTimes(1);
  });

  it("at 150%: the 150 alert (owner + team) — and the 125 one is spent, so it never arrives after the more urgent one", async () => {
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(225) as any); // exactly 150%
    expect(await checkPlanUsageAlert(ORG)).toBe(150);
    expect(vi.mocked(sendPlanUsageAlertNotification).mock.calls[0][0]).toMatchObject({ level: 150 });
    expect(ops.filter((o) => o.op === "insert").map((o) => o.row?.period_key)).toEqual(["150:2026-10-20", "125:2026-10-20"]);
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(226) as any);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(sendPlanUsageAlertNotification).toHaveBeenCalledTimes(1);
  });

  it("125% then later 150% in the same period: two emails, one each", async () => {
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(188) as any);
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(225) as any);
    expect(await checkPlanUsageAlert(ORG)).toBe(150);
    expect(vi.mocked(sendPlanUsageAlertNotification).mock.calls.map((c) => c[0].level)).toEqual([125, 150]);
  });

  it("a new billing period is a new slot: the alert can come again", async () => {
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(188) as any);
    await checkPlanUsageAlert(ORG);
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(188, { currentPeriodStart: new Date("2026-11-20T13:00:00.000Z") }) as any);
    expect(await checkPlanUsageAlert(ORG)).toBe(125);
    expect(planUsagePeriodKey(125, new Date("2026-11-20T13:00:00.000Z"))).toBe("125:2026-11-20");
  });

  it("a send that delivered NOTHING releases the claim, so the next counted call retries; one that reached an inbox is kept", async () => {
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(188) as any);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("0 delivered", { deliveredCount: 0, wantedCount: 1, permanent: false }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.at(-1)).toMatchObject({ op: "delete", match: { period_key: "125:2026-10-20" } });
    expect(await checkPlanUsageAlert(ORG)).toBe(125); // retried
    ops = [];
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(225) as any);
    vi.mocked(sendPlanUsageAlertNotification).mockRejectedValueOnce(new NotificationDeliveryError("1/2 failed", { deliveredCount: 1, wantedCount: 2, permanent: false }));
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(ops.some((o) => o.op === "delete")).toBe(false);
    expect(ops.at(-1)).toMatchObject({ op: "update", match: { period_key: "150:2026-10-20" } });
  });

  it("a ledger fault (not a duplicate) sends nothing — skip rather than risk a double", async () => {
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(188) as any);
    insertError = { code: "57014" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    expect(sendPlanUsageAlertNotification).not.toHaveBeenCalled();
  });

  it("no subscription, an unlimited plan, or a period with no start: nothing; a fault anywhere never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getSubscriptionInfo).mockResolvedValue(null as any);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    for (const limit of [-1, 0]) {
      vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(9999, { callsLimit: limit }) as any);
      expect(await checkPlanUsageAlert(ORG)).toBeNull();
    }
    vi.mocked(getSubscriptionInfo).mockResolvedValue(sub(225, { currentPeriodStart: new Date("not a date") }) as any);
    expect(await checkPlanUsageAlert(ORG)).toBeNull();
    vi.mocked(getSubscriptionInfo).mockRejectedValue(new Error("db down"));
    await expect(checkPlanUsageAlert(ORG)).resolves.toBeNull();
    expect(sendPlanUsageAlertNotification).not.toHaveBeenCalled();
  });
});
