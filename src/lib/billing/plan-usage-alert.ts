// src/lib/billing/plan-usage-alert.ts
// SCRUM-608: a heads-up when a business is well over its plan's calls this billing
// period — the owner at 125%, the owner and the Phondo team at 150%. Usage holds customer
// calls AND the owner's chats with the assistant (call-completed counts both): this
// period's counted calls, never above the dashboard's own counter. Nothing is cut off.
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

/**
 * One ledger key per level per billing period: the period's exact start (SCRUM-609 — not
 * just its date: a trial that converts to paid the day it began starts two periods on one day).
 */
export function planUsagePeriodKey(level: PlanUsageAlertLevel, periodStart: Date): string {
  return `${level}:${periodStart.toISOString()}`;
}

/**
 * SCRUM-609: Sentry never sees console lines, so a lasting fault on a path that only logged
 * (a failing ledger, an unreadable count, a sender that keeps refusing) stopped every alert
 * with no page. One fixed message per reason, so a burst of calls groups into one issue.
 */
function warn(reason: string, extra: Record<string, unknown>): void {
  Sentry.captureMessage(`Plan usage alert: ${reason}`, { level: "warning", tags: { feature: "plan-usage-alert" }, extra });
}

type Claim = "claimed" | "already" | "error";

async function claim(supabase: any, organizationId: string, periodKey: string): Promise<Claim> {
  const { error } = await supabase.from("cron_send_ledger").insert({ job_name: PLAN_USAGE_ALERT_JOB, period_key: periodKey, organization_id: organizationId });
  if (!error) return "claimed";
  if (error.code === "23505") return "already";
  console.error("[PlanUsageAlert] ledger claim failed — skipping to avoid a double:", { organizationId, periodKey, code: error.code });
  warn("ledger claim failed", { organizationId, periodKey, code: error.code });
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
  if (error) {
    console.error("[PlanUsageAlert] delivery confirmation failed — reconciliation will flag a delivered send:", { organizationId, periodKey, code: error.code });
    Sentry.captureMessage(`Plan usage alert delivered_at confirmation failed for org ${organizationId} (${periodKey})`, "warning");
  }
}

/**
 * This billing period's counted calls, from the calls themselves (`usage_counted`, the
 * same flip that bills them — customer calls and owner chats alike). Not `calls_used`:
 * Stripe moves the period up to an hour (or, on a failed charge, days) before the payment
 * webhook resets that counter, and keyed on the NEW period with LAST period's count the
 * alert would fire on stale numbers and spend the new period's slots (silent lens).
 * null when the count can't be read.
 */
async function countedCallsSince(supabase: any, organizationId: string, since: Date): Promise<number | null> {
  const { count, error } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("usage_counted", true)
    .gte("created_at", since.toISOString());
  if (error || typeof count !== "number") {
    console.error("[PlanUsageAlert] counting this period's calls failed — skipping:", { organizationId, code: error?.code });
    warn("counting the period's calls failed", { organizationId, code: error?.code });
    return null;
  }
  return count;
}

/** A fault that isn't a delivery result: logged in full and sent to Sentry (a lasting one would stop the alerts). */
function reportFault(where: string, organizationId: string, err: unknown): void {
  console.error(`[PlanUsageAlert] ${where}:`, { organizationId, error: err instanceof Error ? err.message : String(err) });
  Sentry.captureException(err, { tags: { feature: "plan-usage-alert" }, extra: { organizationId, where } });
}

/**
 * After a call's usage was counted: email the owner (and at 150% the team) the first
 * time this billing period the business passes 125% or 150% of its plan's calls.
 * Never throws — it runs after the response; every fault is logged. (A call counted
 * without a call row — the rare no-callId path — isn't in the period's count.)
 * @returns the level emailed, or null when nothing was sent
 */
export async function checkPlanUsageAlert(organizationId: string): Promise<PlanUsageAlertLevel | null> {
  try {
    const sub = await getSubscriptionInfo(organizationId);
    if (!sub || sub.callsLimit <= 0) return null; // no subscription, or unlimited (agency plans)
    // A lapsed or past-due account hears from billing already; this is for paying and trial accounts
    // (not a trial that has run out — calls are blocked there, as canMakeCall does).
    if (sub.status !== "active" && sub.status !== "trialing") return null;
    if (sub.status === "trialing" && sub.trialEnd && sub.trialEnd.getTime() < Date.now()) return null;
    // The billing counter first, as a cheap gate: the usage below is never above it, so
    // under 125% on the counter there is nothing to count.
    if (sub.callsUsed < sub.callsLimit * LEVELS[LEVELS.length - 1].ratio) return null;
    if (Number.isNaN(sub.currentPeriodStart.getTime())) {
      console.warn("[PlanUsageAlert] subscription has no billing period start — skipping:", { organizationId });
      return null;
    }
    const supabase = createAdminClient();
    const counted = await countedCallsSince(supabase, organizationId, sub.currentPeriodStart);
    if (counted === null) return null;
    // This period's calls, never above the dashboard's counter (SCRUM-609). The count since the
    // period start can't carry LAST period's calls (Stripe moves the period before the payment
    // webhook resets calls_used), and the counter drops the calls of a late reset's gap (counted,
    // then wiped) — so a stale counter never alerts, and the email never shows more than the dashboard.
    const used = Math.min(counted, sub.callsUsed);
    const crossed = LEVELS.find((l) => used / sub.callsLimit >= l.ratio);
    if (!crossed) return null;

    const key = planUsagePeriodKey(crossed.level, sub.currentPeriodStart);
    if ((await claim(supabase, organizationId, key)) !== "claimed") return null;
    // Crossing 150% straight past 125% (a plan change, a burst): the 125% email is
    // spent too, so it never arrives after the more urgent one — confirmed or released
    // with this send, so the ledger never shows it as a crashed send.
    const extra = crossed.level === 150 ? planUsagePeriodKey(125, sub.currentPeriodStart) : null;
    const keys = extra && (await claim(supabase, organizationId, extra)) === "claimed" ? [key, extra] : [key];

    let result;
    try {
      result = await sendPlanUsageAlertNotification({
        organizationId,
        level: crossed.level,
        callsUsed: used,
        callsLimit: sub.callsLimit,
        planName: PLANS[sub.plan]?.name ?? String(sub.plan),
        periodEnd: sub.currentPeriodEnd,
        trial: sub.status === "trialing",
      });
    } catch (err) {
      if (!(err instanceof NotificationDeliveryError)) {
        // A bug or an outage (the owner lookup's database read included), not a delivery
        // result: release, and say what it was.
        for (const k of keys) await release(supabase, organizationId, k);
        reportFault("send threw", organizationId, err);
        return null;
      }
      const failure = err;
      const delivered = failure.deliveredCount > 0;
      // No address to send to (no owner email, and no team one): retrying on every
      // counted call would only repeat this — the period's alert is spent.
      const noAddress = failure.permanent === true && failure.permanentCause === "org-config";
      if (delivered) for (const k of keys) await confirm(supabase, organizationId, k);
      else if (!noAddress) for (const k of keys) await release(supabase, organizationId, k); // nothing went out — the next counted call retries
      // Never the error's text: a missing-credential error carries the address it was for.
      const facts = { organizationId, level: crossed.level, delivered, permanent: failure.permanent, permanentCause: failure.permanentCause };
      console.error("[PlanUsageAlert] send failed:", facts);
      // A missing credential pages on its own and a missing owner email is reported by the
      // lookup; anything else would otherwise repeat on every counted call, unseen.
      if (delivered) warn("partly delivered — a recipient missed it and it won't be resent", facts);
      else if (!noAddress && failure.permanentCause !== "credential-absence") warn("nothing delivered — the next counted call retries", facts);
      return null;
    }
    if (result === "sent") for (const k of keys) await confirm(supabase, organizationId, k);
    return result === "sent" ? crossed.level : null;
  } catch (err) {
    reportFault("check failed", organizationId, err);
    return null;
  }
}
