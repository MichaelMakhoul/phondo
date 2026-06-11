import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDailySummaryNotification } from "@/lib/notifications/notification-service";
import * as Sentry from "@sentry/nextjs";

const DEFAULT_TIMEZONE = "Australia/Sydney";

function getYesterdayRange(timezone: string): { start: string; end: string; periodKey: string } {
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // e.g. "2026-03-02"

  // Get yesterday's date string by subtracting 1 day at noon UTC (avoids boundary issues)
  const todayNoon = new Date(`${todayStr}T12:00:00Z`);
  const yesterdayNoon = new Date(todayNoon.getTime() - 86_400_000);
  const yesterdayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(yesterdayNoon);

  return {
    start: toUtcMidnight(yesterdayStr, timezone),
    end: toUtcMidnight(todayStr, timezone),
    periodKey: yesterdayStr, // the local date being summarized — idempotency key
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

  let sent = 0;
  let skipped = 0; // zero-call orgs
  let deduped = 0; // idempotent skips (claim already held)
  let failed = 0;

  for (const org of orgs ?? []) {
    try {
      let timezone = org.timezone || DEFAULT_TIMEZONE;
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch {
        console.error(`[DailySummary] Invalid timezone "${timezone}" for org ${org.id} — falling back to ${DEFAULT_TIMEZONE}`);
        timezone = DEFAULT_TIMEZONE;
      }
      const { start, end, periodKey } = getYesterdayRange(timezone);

      // Query calls for yesterday in the org's timezone
      const { data: calls, error: callsError } = await (supabase as any)
        .from("calls")
        .select("id, status, is_spam, duration_seconds, action_taken")
        .eq("organization_id", org.id)
        .gte("created_at", start)
        .lt("created_at", end);

      if (callsError) {
        console.error(`[DailySummary] Failed to query calls for org ${org.id}:`, callsError);
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
      // one summary instead of doubling it ("skip > double").
      const { error: claimError } = await (supabase as any)
        .from("cron_send_ledger")
        .insert({ job_name: "daily-summary", period_key: periodKey, organization_id: org.id });
      if (claimError) {
        if (claimError.code === "23505") {
          console.log(`[DailySummary] Already sent for org ${org.id} on ${periodKey} — skipping (idempotent)`);
          deduped++;
          continue;
        }
        console.error(`[DailySummary] Failed to claim send for org ${org.id} — skipping to avoid a possible double:`, claimError);
        Sentry.captureMessage(`Daily summary claim failed for org ${org.id} — summary skipped`, "warning");
        failed++;
        continue;
      }

      // Build yesterday's date for display
      const yesterdayDate = new Date(start);

      try {
        await sendDailySummaryNotification({
          organizationId: org.id,
          date: yesterdayDate,
          totalCalls,
          answeredCalls,
          missedCalls,
          appointmentsBooked,
          averageCallDuration,
          topCallerIntents: [],
        });
      } catch (sendErr) {
        // PARTIAL delivery ("1/2 notification channels failed") means the
        // email may already be in an inbox — releasing the claim would
        // re-enable the exact double this ledger prevents. Only release when
        // NOTHING was delivered, so a same-day manual re-run or overlapping
        // run can retry. (The next *scheduled* run summarizes a different
        // day — automatic recovery of a lost day is follow-up scope.)
        const msg = sendErr instanceof Error ? sendErr.message : "";
        const partial = /^(\d+)\/(\d+) notification channels failed/.exec(msg);
        const somethingDelivered = !!partial && partial[1] !== partial[2];
        if (!somethingDelivered) {
          await (supabase as any)
            .from("cron_send_ledger")
            .delete()
            .match({ job_name: "daily-summary", period_key: periodKey, organization_id: org.id })
            .then(({ error }: { error: unknown }) => {
              if (error) {
                console.error(`[DailySummary] Failed to release claim for org ${org.id} — this day's summary is lost:`, error);
                Sentry.captureMessage(`Daily summary claim release failed for org ${org.id} — day lost (ledger row lies)`, "error");
              }
            });
        } else {
          console.warn(`[DailySummary] Partial delivery for org ${org.id} — keeping the claim (no re-send):`, msg);
        }
        throw sendErr; // outer catch counts it as failed
      }

      sent++;
    } catch (err) {
      console.error(`[DailySummary] Error processing org ${org.id}:`, err);
      failed++;
    }
  }

  console.log(
    `[DailySummary] Sent ${sent} summaries, ${skipped} skipped (no calls), ${deduped} deduped (already sent), ${failed} failed`
  );

  return NextResponse.json({ sent, skipped, deduped, failed });
}
