import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendDailySummaryNotification,
  NotificationDeliveryError,
  type NotificationSendResult,
} from "@/lib/notifications/notification-service";
import * as Sentry from "@sentry/nextjs";

// SCRUM-447: every org × up to 3 lookback days of sequential queries + email
// sends. Vercel's default function duration would cut the run mid-loop —
// which is exactly the claim-without-confirm crash window delivered_at exists
// to detect. 60s is the Hobby plan ceiling (vercel.json has no overrides).
export const maxDuration = 60;

const DEFAULT_TIMEZONE = "Australia/Sydney";

// SCRUM-447 (missed-day recovery): how many local dates each run attempts —
// yesterday, day-2, day-3. A fully-failed day used to be unrecoverable
// because the next scheduled run only ever computed "yesterday". The ledger
// claim dedupes days that already went out, so the steady-state extra cost is
// one PK-index read per org (see the pre-check below).
const PERIOD_LOOKBACK_DAYS = 3;

function getDailyRange(
  timezone: string,
  daysAgo: number
): { start: string; end: string; periodKey: string } {
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // e.g. "2026-03-02"

  // Walk back from today at noon UTC (avoids boundary issues), one day per
  // step — daysAgo=1 is yesterday in the org's timezone.
  const todayNoon = new Date(`${todayStr}T12:00:00Z`);
  const targetNoon = new Date(todayNoon.getTime() - daysAgo * 86_400_000);
  const dayAfterNoon = new Date(targetNoon.getTime() + 86_400_000);
  const fmtUtc = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const targetStr = fmtUtc.format(targetNoon);
  const dayAfterStr = fmtUtc.format(dayAfterNoon);

  return {
    start: toUtcMidnight(targetStr, timezone),
    end: toUtcMidnight(dayAfterStr, timezone),
    periodKey: targetStr, // the local date being summarized — idempotency key
  };
}

/**
 * Find the UTC instant when it's midnight on `dateStr` in `timezone`.
 * Uses two-step offset correction to handle DST transitions correctly.
 */
function toUtcMidnight(dateStr: string, timezone: string): string {
  const midnightUtc = new Date(`${dateStr}T00:00:00Z`);
  // Step 1: approximate offset from midnight UTC
  const offset1 = tzOffsetMs(midnightUtc, timezone);
  const approx = new Date(midnightUtc.getTime() - offset1);
  // Step 2: refine using offset at the approximate local midnight
  const offset2 = tzOffsetMs(approx, timezone);
  return new Date(midnightUtc.getTime() - offset2).toISOString();
}

function tzOffsetMs(date: Date, timezone: string): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const localStr = date.toLocaleString("en-US", { timeZone: timezone });
  return new Date(localStr).getTime() - new Date(utcStr).getTime();
}

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req, "daily-summary");
  if (authFail) return authFail;

  const supabase = createAdminClient();

  // Fetch all organizations with their timezone
  const { data: orgs, error: orgsError } = await (supabase as any)
    .from("organizations")
    .select("id, timezone");

  if (orgsError) {
    console.error("[DailySummary] Failed to fetch organizations:", orgsError);
    return NextResponse.json({ error: "Failed to fetch organizations" }, { status: 500 });
  }

  // Counters are per org-DAY since the SCRUM-447 lookback (an org can e.g.
  // send yesterday + recover day-3 in one run).
  let sent = 0; // yesterday's summaries
  let recovered = 0; // older lookback days whose summary finally went out
  let skipped = 0; // zero-call org-days + sends skipped by preference (every channel off)
  let deduped = 0; // idempotent skips (yesterday's claim already held)
  let failed = 0;

  for (const org of orgs ?? []) {
    let timezone = org.timezone || DEFAULT_TIMEZONE;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      console.error(`[DailySummary] Invalid timezone "${timezone}" for org ${org.id} — falling back to ${DEFAULT_TIMEZONE}`);
      timezone = DEFAULT_TIMEZONE;
    }

    // Oldest first: day-3 falls out of the lookback window tomorrow (last
    // chance), and recovered emails land in the inbox in chronological order.
    const periods = [];
    for (let daysAgo = PERIOD_LOOKBACK_DAYS; daysAgo >= 1; daysAgo--) {
      periods.push({ daysAgo, ...getDailyRange(timezone, daysAgo) });
    }

    // One ledger read covering every candidate day — already-claimed days
    // (the steady-state for the recovery days) skip without touching the
    // calls table. Purely an optimization: the claim INSERT below still
    // dedupes atomically if this read misses a concurrent claim or errors.
    const claimedKeys = new Set<string>();
    const { data: claimedRows, error: ledgerReadError } = await (supabase as any)
      .from("cron_send_ledger")
      .select("period_key")
      .eq("job_name", "daily-summary")
      .eq("organization_id", org.id)
      .in("period_key", periods.map((p) => p.periodKey));
    if (ledgerReadError) {
      console.warn(`[DailySummary] Ledger pre-check failed for org ${org.id} — relying on per-day claim dedupe:`, ledgerReadError);
    } else {
      for (const row of claimedRows ?? []) claimedKeys.add(row.period_key);
    }

    for (const { daysAgo, start, end, periodKey } of periods) {
      const isRecovery = daysAgo > 1;
      try {
        if (claimedKeys.has(periodKey)) {
          // Recovery days being already-sent is the normal steady state —
          // only yesterday's pre-claim is a notable (overlapping run) event.
          if (!isRecovery) deduped++;
          continue;
        }

        // Query calls for this local date in the org's timezone
        const { data: calls, error: callsError } = await (supabase as any)
          .from("calls")
          .select("id, status, is_spam, duration_seconds, action_taken")
          .eq("organization_id", org.id)
          .gte("created_at", start)
          .lt("created_at", end);

        if (callsError) {
          console.error(`[DailySummary] Failed to query calls for org ${org.id} (${periodKey}):`, callsError);
          failed++;
          continue;
        }

        const allCalls = calls ?? [];
        if (allCalls.length === 0) {
          skipped++;
          continue;
        }

        const totalCalls = allCalls.length;
        const answeredCalls = allCalls.filter(
          (c: any) => c.status === "completed" && !c.is_spam
        ).length;
        const missedCalls = allCalls.filter(
          (c: any) => c.status === "no-answer" || c.status === "busy"
        ).length;
        const appointmentsBooked = allCalls.filter(
          (c: any) => c.action_taken === "appointment_booked"
        ).length;

        const completedWithDuration = allCalls.filter(
          (c: any) => c.status === "completed" && c.duration_seconds != null
        );
        const averageCallDuration =
          completedWithDuration.length > 0
            ? completedWithDuration.reduce((sum: number, c: any) => sum + c.duration_seconds, 0) /
              completedWithDuration.length
            : 0;

        // SCRUM-429 (finding #53): atomically CLAIM this org+day before
        // sending — a 23505 means another (overlapping/re-triggered) run owns
        // it, so we skip instead of double-emailing. Crash-after-claim drops
        // one summary instead of doubling it ("skip > double") — and is now
        // detectable: delivered_at stays NULL (SCRUM-447 reconciliation).
        const { error: claimError } = await (supabase as any)
          .from("cron_send_ledger")
          .insert({ job_name: "daily-summary", period_key: periodKey, organization_id: org.id });
        if (claimError) {
          if (claimError.code === "23505") {
            console.log(`[DailySummary] Already sent for org ${org.id} on ${periodKey} — skipping (idempotent)`);
            if (!isRecovery) deduped++;
            continue;
          }
          console.error(`[DailySummary] Failed to claim send for org ${org.id} (${periodKey}) — skipping to avoid a possible double:`, claimError);
          Sentry.captureMessage(`Daily summary claim failed for org ${org.id} — summary skipped`, "warning");
          failed++;
          continue;
        }

        // Build the summarized date for display
        const summaryDate = new Date(start);

        let sendResult: NotificationSendResult;
        try {
          sendResult = await sendDailySummaryNotification({
            organizationId: org.id,
            date: summaryDate,
            totalCalls,
            answeredCalls,
            missedCalls,
            appointmentsBooked,
            averageCallDuration,
            topCallerIntents: [],
          });
        } catch (sendErr) {
          // PARTIAL delivery (deliveredCount > 0) means the email may already
          // be in an inbox — releasing the claim would re-enable the exact
          // double this ledger prevents. Only release when NOTHING was
          // delivered, so the lookback loop (or a same-day re-run) retries.
          // SCRUM-447: typed fields replace the old "N/M channels failed"
          // regex; the message text is unchanged for logs.
          //
          // DELIBERATE ASYMMETRY with callback-reminders: this cron never
          // consults `permanent`. Permanent failures (org-config or
          // credential-absence) release the claim like any other zero-
          // delivery failure and re-fail on each lookback retry — but the
          // 3-day lookback BOUNDS that to 3 attempts total, after which the
          // day falls out of the window. Callback-reminders has no such
          // bound (a released reminder retries forever, crowding its 50-row
          // window), so it must classify. Here, the bounded retry trades a
          // little Sentry noise for two extra recovery chances.
          const somethingDelivered =
            sendErr instanceof NotificationDeliveryError && sendErr.deliveredCount > 0;
          if (!somethingDelivered) {
            await (supabase as any)
              .from("cron_send_ledger")
              .delete()
              .match({ job_name: "daily-summary", period_key: periodKey, organization_id: org.id })
              .then(({ error }: { error: unknown }) => {
                if (error) {
                  console.error(`[DailySummary] Failed to release claim for org ${org.id} (${periodKey}) — this day's summary is lost:`, error);
                  Sentry.captureMessage(`Daily summary claim release failed for org ${org.id} — day lost (ledger row lies)`, "error");
                }
              });
          } else {
            console.warn(`[DailySummary] Partial delivery for org ${org.id} (${periodKey}) — keeping the claim (no re-send):`, sendErr instanceof Error ? sendErr.message : sendErr);
            // Something reached an inbox — confirm so reconciliation doesn't
            // flag this claim as a crashed send.
            await confirmDelivery(supabase, org.id, periodKey);
          }
          throw sendErr; // counted as failed below
        }

        if (sendResult === "skipped") {
          // Every channel disabled by preference — a legitimate no-op. Keep
          // the claim (a retry would skip identically; without it the
          // lookback would re-query this day every run) but DON'T confirm
          // delivered_at: nothing reached an inbox, so recording a delivery
          // would be a false positive.
          console.log(`[DailySummary] Summary for org ${org.id} (${periodKey}) skipped — all notification channels disabled by preference`);
          skipped++;
          continue;
        }

        // SCRUM-447 (claim-vs-confirm): mark the claim as actually delivered.
        // A claim row with delivered_at NULL = crashed between claim and send
        // — see the reconciliation query in migration 00155.
        await confirmDelivery(supabase, org.id, periodKey);

        if (isRecovery) {
          console.log(`[DailySummary] Recovered missed day ${periodKey} for org ${org.id}`);
          recovered++;
        } else {
          sent++;
        }
      } catch (err) {
        console.error(`[DailySummary] Error processing org ${org.id} (${periodKey}):`, err);
        failed++;
      }
    }
  }

  console.log(
    `[DailySummary] Sent ${sent} summaries, ${recovered} recovered (missed days), ${skipped} skipped (no calls), ${deduped} deduped (already sent), ${failed} failed`
  );

  return NextResponse.json({ sent, recovered, skipped, deduped, failed });
}

/**
 * Set delivered_at on a claimed ledger row after the send call returned
 * (fully or partially delivered). Never throws — the send DID happen, so a
 * confirmation failure must not be recorded as a send failure; it just means
 * the reconciliation query will show a false positive, which the Sentry
 * warning here explains.
 */
async function confirmDelivery(supabase: any, organizationId: string, periodKey: string): Promise<void> {
  const { error } = await supabase
    .from("cron_send_ledger")
    .update({ delivered_at: new Date().toISOString() })
    .match({ job_name: "daily-summary", period_key: periodKey, organization_id: organizationId });
  if (error) {
    console.error(`[DailySummary] Failed to confirm delivery for org ${organizationId} (${periodKey}) — reconciliation will flag a delivered send:`, error);
    Sentry.captureMessage(`Daily summary delivered_at confirmation failed for org ${organizationId} (${periodKey})`, "warning");
  }
}
