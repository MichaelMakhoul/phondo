import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeLapseState,
  DEFAULT_RECLAIM_DAYS,
  type LapseResult,
} from "@/lib/subscriptions/lapse-state";
import {
  sendSubscriptionLapseNotification,
  NotificationDeliveryError,
  type NotificationSendResult,
  type SubscriptionDunningMilestone,
  type SubscriptionLapseContext,
} from "@/lib/notifications/notification-service";
import * as Sentry from "@sentry/nextjs";

// SCRUM-478: up to MAX_SUBSCRIPTIONS_PER_RUN sequential owner emails per run.
// Vercel's default function duration would cut the loop mid-send — the
// claim-without-confirm crash window cron_send_ledger.delivered_at exists to
// detect. 60s is the Hobby plan ceiling (vercel.json has no overrides).
export const maxDuration = 60;

const DAY_MS = 86_400_000;
const JOB_NAME = "subscription-dunning";

// Statuses that CAN sit off the active path. computeLapseState is the source of
// truth — `trialing` rows still within their trial resolve to `active` and are
// skipped below — so this is just the candidate set to scan.
const TERMINAL_STATUSES = ["trialing", "canceled", "unpaid", "incomplete_expired"];

// Bound the scan (the ticket calls for a LIMIT + next-day recovery). Ordering by
// current_period_end ascending puts the most-overdue rows first and still-active
// trials (future period end) last, so a hit limit drops the least-urgent rows,
// which recover on the next daily run.
const MAX_SUBSCRIPTIONS_PER_RUN = 500;

// grace_ending_soon fires once the grace window is within this lead of ending.
const GRACE_ENDING_LEAD_MS = 2 * DAY_MS;
// release_warning fires once a canceled org is within this lead of the 90-day
// reclaim cutoff (the number-release lead window).
const RELEASE_WARNING_LEAD_MS = 7 * DAY_MS;

/**
 * Pick the single DUE dunning milestone for a lapse-state result, or null when
 * nothing is due (active, or release_pending — past the warning lead; the actual
 * number-release sweep is SCRUM-479, a later PR).
 *
 * The daily cron + cron_send_ledger make this idempotent per (milestone,
 * anchor): each milestone fires at most once per lapse cycle. When the cron
 * misses the early part of a window (e.g. it was down), the most-advanced due
 * milestone wins — an org that is already deep in `lapsed` gets ai_diverting (or
 * release_warning) rather than a stale grace_started.
 */
function pickDueMilestone(result: LapseResult, now: number): SubscriptionDunningMilestone | null {
  switch (result.state) {
    case "in_grace": {
      const graceEndsMs = result.graceEndsAt ? Date.parse(result.graceEndsAt) : null;
      if (graceEndsMs !== null && graceEndsMs - now <= GRACE_ENDING_LEAD_MS) {
        return "grace_ending_soon";
      }
      return "grace_started";
    }
    case "lapsed": {
      // Only canceled subs carry a release timeline (releaseEligibleAt set);
      // unpaid / incomplete_expired stay lapsed indefinitely and only ever get
      // ai_diverting.
      const releaseMs = result.releaseEligibleAt ? Date.parse(result.releaseEligibleAt) : null;
      if (releaseMs !== null && releaseMs - now <= RELEASE_WARNING_LEAD_MS) {
        return "release_warning";
      }
      return "ai_diverting";
    }
    default:
      return null; // active | release_pending → nothing to send
  }
}

/** Whole days from now until `iso`, at least `floor` (so copy never says "0 days"). */
function daysUntil(iso: string | null, now: number, floor = 0): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return Math.max(floor, Math.ceil((ms - now) / DAY_MS));
}

/**
 * Load the org's active number and mask all but the last 4 digits for the
 * release warning. Returns null on any miss — the template falls back to a
 * generic "your phone number".
 */
async function loadMaskedNumber(supabase: any, organizationId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("phone_numbers")
    .select("phone_number")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const raw = data[0].phone_number as string | null;
  if (!raw) return null;
  // Mask every digit that still has 4+ digits after it → reveals only the last 4.
  return raw.replace(/\d(?=\d{4})/g, "•");
}

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req, JOB_NAME);
  if (authFail) return authFail;

  const supabase = createAdminClient();
  const now = Date.now();

  const { data: subs, error } = await (supabase as any)
    .from("subscriptions")
    .select("organization_id, status, trial_end, current_period_end, service_ended_at")
    .in("status", TERMINAL_STATUSES)
    .order("current_period_end", { ascending: true })
    .limit(MAX_SUBSCRIPTIONS_PER_RUN);

  if (error) {
    console.error("[SubscriptionDunning] Failed to query subscriptions:", error);
    return NextResponse.json({ error: "Failed to query subscriptions" }, { status: 500 });
  }

  if (subs && subs.length === MAX_SUBSCRIPTIONS_PER_RUN) {
    console.warn(`[SubscriptionDunning] Hit ${MAX_SUBSCRIPTIONS_PER_RUN}-subscription limit — more may be due and will be processed next run`);
  }

  let sent = 0; // owner reached on ≥1 channel (full or partial)
  let skipped = 0; // every channel disabled by preference
  let deduped = 0; // milestone already sent this lapse cycle (idempotent)
  let failed = 0; // claim/send failure (claim released or abandoned per cause)
  const byMilestone: Record<string, number> = {};

  for (const sub of subs ?? []) {
    const organizationId = sub.organization_id;
    try {
      const result = computeLapseState(sub, now);
      const milestone = pickDueMilestone(result, now);
      if (!milestone) continue; // active / nothing due

      // period_key = `${milestone}:${anchorYYYYMMDD}` — the anchor (UTC date)
      // pins the key to THIS lapse cycle, so a re-lapse (new cancellation →
      // new anchor) starts a fresh cycle and re-sends every milestone.
      //
      // The anchor is what makes the key STABLE across runs. A now-based
      // fallback would mint a fresh key every day, so an anchorless milestone
      // would re-email the org on EVERY run (idempotency defeated). Every
      // sending state has an anchor in practice (current_period_end is NOT
      // NULL, and computeLapseState fails open to `active` when no anchor
      // parses), so an anchorless-but-due result is a data anomaly: skip it (no
      // claim, no send) and let a later run handle it once the data is sane.
      if (!result.anchorAt) {
        console.warn(`[SubscriptionDunning] ${milestone} due for org ${organizationId} but lapse anchor is missing — skipping (cannot mint a stable period_key)`);
        continue;
      }
      const anchorKey = result.anchorAt.slice(0, 10).replace(/-/g, "");
      const periodKey = `${milestone}:${anchorKey}`;

      // Build the milestone's display context BEFORE claiming the ledger
      // (mirrors daily-summary). loadMaskedNumber is a DB read that CAN throw;
      // doing it pre-claim means any display-data failure aborts this org with
      // NO claim row, so a later run retries cleanly. Done post-claim, a throw
      // here would orphan a claim whose delivered_at stays NULL — which the
      // reconciliation query (migration 00155) cannot tell apart from a crashed
      // send, i.e. a false 'delivered'. The cost is that a later dedup pays for
      // the (indexed) phone lookup — a fair trade for never faking a delivery.
      const ctx: SubscriptionLapseContext = {};
      if (milestone === "grace_started" || milestone === "grace_ending_soon") {
        ctx.daysRemaining = daysUntil(result.graceEndsAt, now, 1);
      } else if (milestone === "release_warning") {
        ctx.reclaimDays = DEFAULT_RECLAIM_DAYS;
        ctx.releaseInDays = daysUntil(result.releaseEligibleAt, now, 0);
        ctx.maskedNumber = await loadMaskedNumber(supabase, organizationId);
      }

      // Claim BEFORE sending — a 23505 means another (overlapping/re-triggered)
      // run already owns this milestone, so skip instead of double-emailing.
      // Crash-after-claim drops one email rather than doubling it, and is
      // detectable (delivered_at stays NULL — migration 00155 reconciliation).
      const { error: claimError } = await (supabase as any)
        .from("cron_send_ledger")
        .insert({ job_name: JOB_NAME, period_key: periodKey, organization_id: organizationId });
      if (claimError) {
        if (claimError.code === "23505") {
          deduped++;
          continue;
        }
        console.error(`[SubscriptionDunning] Failed to claim ${periodKey} for org ${organizationId} — skipping to avoid a possible double:`, claimError);
        Sentry.captureMessage(`Subscription dunning claim failed for org ${organizationId} — milestone skipped`, "warning");
        failed++;
        continue;
      }

      let sendResult: NotificationSendResult;
      try {
        sendResult = await sendSubscriptionLapseNotification(organizationId, milestone, ctx);
      } catch (notifyErr) {
        const delivery = notifyErr instanceof NotificationDeliveryError ? notifyErr : null;
        if (delivery && delivery.deliveredCount > 0) {
          // PARTIAL: something reached the owner — releasing the claim would
          // double-deliver that channel next run. Keep the claim and confirm so
          // reconciliation doesn't flag it as a crash.
          console.warn(`[SubscriptionDunning] Partial delivery for ${periodKey} org ${organizationId} (${delivery.deliveredCount}/${delivery.wantedCount}) — keeping the claim:`, delivery.message);
          await confirmDelivery(supabase, periodKey, organizationId);
          byMilestone[milestone] = (byMilestone[milestone] ?? 0) + 1;
          sent++;
        } else if (delivery?.permanent && delivery.permanentCause === "org-config") {
          // No working channel for THIS org (e.g. no owner email). A retry
          // can't conjure one, and ai_diverting (lapsed) can persist
          // indefinitely for unpaid orgs — keep the claim so it leaves the
          // queue instead of churning daily (callback-reminders semantics).
          console.error(`[SubscriptionDunning] Abandoning ${periodKey} for org ${organizationId} — permanent org-config failure (no deliverable channel):`, delivery.message);
          failed++;
        } else {
          // Nothing delivered and a retry COULD succeed (credential-absence:
          // an operator restores the env; or a transient provider blip) —
          // RELEASE the claim so the next run retries while the milestone is
          // still due.
          if (delivery?.permanentCause === "credential-absence") {
            console.error(`[SubscriptionDunning] Provider credentials absent — releasing claim ${periodKey} (org ${organizationId}) so it retries once the env is fixed:`, delivery.message);
          } else {
            console.error(`[SubscriptionDunning] Send failed for ${periodKey} org ${organizationId} — releasing claim for retry:`, notifyErr);
            Sentry.captureMessage(`Subscription dunning send failed — claim released for retry (org ${organizationId})`, "warning");
          }
          await releaseClaim(supabase, periodKey, organizationId);
          failed++;
        }
        continue;
      }

      if (sendResult === "skipped") {
        // Every channel disabled by preference — a legitimate no-op. Keep the
        // claim (a retry would skip identically) but DON'T confirm delivered_at:
        // nothing reached an inbox, so recording a delivery would be a false
        // positive.
        skipped++;
        continue;
      }

      await confirmDelivery(supabase, periodKey, organizationId);
      byMilestone[milestone] = (byMilestone[milestone] ?? 0) + 1;
      sent++;
    } catch (err) {
      console.error(`[SubscriptionDunning] Error processing org ${organizationId}:`, err);
      failed++;
    }
  }

  console.log(`[SubscriptionDunning] Sent ${sent}, ${skipped} skipped (channels off), ${deduped} deduped (already sent), ${failed} failed`, byMilestone);

  return NextResponse.json({ sent, skipped, deduped, failed, byMilestone });
}

/**
 * Set delivered_at on a claimed ledger row after the send returned (fully or
 * partially delivered). Never throws — the send DID happen, so a confirmation
 * failure must not flip into the failed/release path; it only means the
 * reconciliation query shows a false positive, which the Sentry warning explains.
 */
async function confirmDelivery(supabase: any, periodKey: string, organizationId: string): Promise<void> {
  const { error } = await supabase
    .from("cron_send_ledger")
    .update({ delivered_at: new Date().toISOString() })
    .match({ job_name: JOB_NAME, period_key: periodKey, organization_id: organizationId });
  if (error) {
    console.error(`[SubscriptionDunning] Failed to confirm delivery for ${periodKey} (org ${organizationId}) — reconciliation will flag a delivered send:`, error);
    Sentry.captureMessage(`Subscription dunning delivered_at confirmation failed for org ${organizationId} (${periodKey})`, "warning");
  }
}

/**
 * Delete a claim whose send delivered NOTHING, so the next run retries while the
 * milestone is still due. A release failure means the ledger row lies (claimed
 * but never delivered) — Sentry at error level so it's caught.
 */
async function releaseClaim(supabase: any, periodKey: string, organizationId: string): Promise<void> {
  const { error } = await supabase
    .from("cron_send_ledger")
    .delete()
    .match({ job_name: JOB_NAME, period_key: periodKey, organization_id: organizationId });
  if (error) {
    console.error(`[SubscriptionDunning] Failed to release claim ${periodKey} (org ${organizationId}) — milestone will NOT retry:`, error);
    Sentry.captureMessage(`Subscription dunning claim release failed for org ${organizationId} (${periodKey}) — ledger row lies`, "error");
  }
}
