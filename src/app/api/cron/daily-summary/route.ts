import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDailySummaryNotification } from "@/lib/notifications/notification-service";

const DEFAULT_TIMEZONE = "Australia/Sydney";

function getYesterdayRange(timezone: string): { start: string; end: string } {
  const now = new Date();
  // Format current date in the org's timezone to find "today"
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayStr = formatter.format(now); // e.g. "2026-03-02"

  // Start of today in the org's timezone
  const todayLocal = new Date(`${todayStr}T00:00:00`);
  // Yesterday = today - 1 day
  const yesterdayLocal = new Date(todayLocal);
  yesterdayLocal.setDate(yesterdayLocal.getDate() - 1);
  const yesterdayStr = formatter.format(yesterdayLocal);

  // Convert local midnight boundaries to UTC using timezone offset calculation
  const startUtc = localMidnightToUtc(yesterdayStr, timezone);
  const endUtc = localMidnightToUtc(todayStr, timezone);

  return { start: startUtc, end: endUtc };
}

function localMidnightToUtc(dateStr: string, timezone: string): string {
  // Create a date at midnight UTC, then adjust for timezone offset
  const utcDate = new Date(`${dateStr}T00:00:00Z`);
  // Get the offset by comparing how the timezone formats vs UTC
  const testDate = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(testDate);

  const tzHour = parseInt(parts.find((p) => p.type === "hour")!.value);
  const tzMinute = parseInt(parts.find((p) => p.type === "minute")!.value);
  const utcHour = testDate.getUTCHours();
  const utcMinute = testDate.getUTCMinutes();

  const offsetMinutes = (tzHour * 60 + tzMinute) - (utcHour * 60 + utcMinute);
  // Subtract offset to go from local midnight to UTC
  const result = new Date(utcDate.getTime() - offsetMinutes * 60 * 1000);
  return result.toISOString();
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[DailySummary] CRON_SECRET not configured");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
  let skipped = 0;
  let failed = 0;

  for (const org of orgs ?? []) {
    try {
      const timezone = org.timezone || DEFAULT_TIMEZONE;
      const { start, end } = getYesterdayRange(timezone);

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

      // Build yesterday's date for display
      const yesterdayDate = new Date(start);

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

      sent++;
    } catch (err) {
      console.error(`[DailySummary] Error processing org ${org.id}:`, err);
      failed++;
    }
  }

  console.log(
    `[DailySummary] Sent ${sent} summaries, ${skipped} skipped (no calls), ${failed} failed`
  );

  return NextResponse.json({ sent, skipped, failed });
}
