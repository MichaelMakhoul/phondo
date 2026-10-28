// src/lib/billing/plan-usage-alert.ts
// SCRUM-608: a heads-up when a business is well over its plan's calls this billing
// period — the owner at 125%, the owner and the Phondo team at 150%. Usage is the
// subscription's own count (`calls_used`), which already holds customer calls AND the
// owner's chats with the assistant (call-completed counts both). Nothing is cut off.
//
// Once per level per billing period, through the cron send ledger (claim → send →
// confirm, released when nothing was delivered — the daily-summary pattern), so a burst
// of calls that all cross the line sends one email.

import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSubscriptionInfo } from "@/lib/stripe/billing-service";
import { PLANS } from "@/lib/stripe/client";
import {
  sendPlanUsageAlertNotification,
  NotificationDeliveryError,
  type PlanUsageAlertLevel,
} from "@/lib/notifications/notification-service";

export const PLAN_USAGE_ALERT_JOB = "plan-usage-alert";
/** The levels, highest first: crossing both at once sends only the higher one. */
const LEVELS: ReadonlyArray<{ level: PlanUsageAlertLevel; ratio: number }> = [
  { level: 150, ratio: 1.5 },
  { level: 125, ratio: 1.25 },
];

/** One ledger key per level per billing period (the period's start date). */
export function planUsagePeriodKey(level: PlanUsageAlertLevel, periodStart: Date): string {
  return `${level}:${periodStart.toISOString().slice(0, 10)}`;
}

type Claim = "claimed" | "already" | "error";

async function claim(supabase: any, organizationId: string, periodKey: string): Promise<Claim> {
  const { error } = await supabase.from("cron_send_ledger").insert({ job_name: PLAN_USAGE_ALERT_JOB, period_key: periodKey, organization_id: organizationId });
  if (!error) return "claimed";
  if (error.code === "23505") return "already";
  console.error("[PlanUsageAlert] ledger claim failed — skipping to avoid a double:", { organizationId, periodKey, code: error.code });
  return "error";
}

async function release(supabase: any, organizationId: string, periodKey: string): Promise<void> {
  const { error } = await supabase.from("cron_send_ledger").delete().match({ job_name: PLAN_USAGE_ALERT_JOB, period_key: periodKey, organization_id: organizationId });
  if (error) {
    console.error("[PlanUsageAlert] ledger release failed — this alert is lost for the period:", { organizationId, periodKey, code: error.code });
    Sentry.captureMessage(`Plan usage alert claim release failed for org ${organizationId} (${periodKey})`, "error");
  }
}

async function confirm(supabase: any, organizationId: string, periodKey: string): Promise<void> {
  const { error } = await supabase.from("cron_send_ledger").update({ delivered_at: new Date().toISOString() }).match({ job_name: PLAN_USAGE_ALERT_JOB, period_key: periodKey, organization_id: organizationId });
  if (error) console.error("[PlanUsageAlert] delivery confirmation failed:", { organizationId, periodKey, code: error.code });
}

/**
 * After a call's usage was counted: email the owner (and at 150% the team) the first
 * time this billing period the business passes 125% or 150% of its plan's calls.
 * Never throws — it runs after the response; every fault is logged.
 * @returns the level emailed, or null when nothing was sent
 */
export async function checkPlanUsageAlert(organizationId: string): Promise<PlanUsageAlertLevel | null> {
  try {
    const sub = await getSubscriptionInfo(organizationId);
    if (!sub || sub.callsLimit <= 0) return null; // no subscription, or unlimited (agency plans)
    if (Number.isNaN(sub.currentPeriodStart.getTime())) {
      console.warn("[PlanUsageAlert] subscription has no billing period start — skipping:", { organizationId });
      return null;
    }
    const ratio = sub.callsUsed / sub.callsLimit;
    const crossed = LEVELS.find((l) => ratio >= l.ratio);
    if (!crossed) return null;

    const supabase = createAdminClient();
    const key = planUsagePeriodKey(crossed.level, sub.currentPeriodStart);
    const claimed = await claim(supabase, organizationId, key);
    if (claimed !== "claimed") return null;
    // Crossing 150% straight past 125% (a plan change, a burst): the 125% email is
    // spent too, so it never arrives after the more urgent one.
    if (crossed.level === 150) await claim(supabase, organizationId, planUsagePeriodKey(125, sub.currentPeriodStart));

    let result;
    try {
      result = await sendPlanUsageAlertNotification({
        organizationId,
        level: crossed.level,
        callsUsed: sub.callsUsed,
        callsLimit: sub.callsLimit,
        planName: PLANS[sub.plan]?.name ?? String(sub.plan),
        periodEnd: sub.currentPeriodEnd,
      });
    } catch (err) {
      const delivered = err instanceof NotificationDeliveryError && err.deliveredCount > 0;
      if (delivered) {
        await confirm(supabase, organizationId, key); // something reached an inbox — never re-send
      } else {
        await release(supabase, organizationId, key); // nothing went out — the next counted call retries
      }
      console.error("[PlanUsageAlert] send failed:", { organizationId, level: crossed.level, delivered, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
    if (result === "sent") await confirm(supabase, organizationId, key);
    return result === "sent" ? crossed.level : null;
  } catch (err) {
    console.error("[PlanUsageAlert] check failed:", { organizationId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
