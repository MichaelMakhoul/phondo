import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendCallbackReminderNotification } from "@/lib/notifications/notification-service";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req, "callback-reminders");
  if (authFail) return authFail;

  const supabase = createAdminClient();

  // Find pending callbacks with a requested_time that has passed and no reminder sent yet
  const { data: dueCallbacks, error } = await (supabase as any)
    .from("callback_requests")
    .select("id, organization_id, caller_name, caller_phone, reason, requested_time, urgency")
    .eq("status", "pending")
    .not("requested_time", "is", null)
    .lte("requested_time", new Date().toISOString())
    .is("reminder_sent_at", null)
    // Oldest first — without an explicit order, retried failures at the head
    // of an unspecified ordering could starve newly-due reminders behind the
    // 50-row limit (SCRUM-419 review).
    .order("requested_time", { ascending: true })
    .limit(50);

  if (error) {
    console.error("[Cron] Failed to query due callbacks:", error);
    return NextResponse.json({ error: "Failed to query callbacks" }, { status: 500 });
  }

  if (!dueCallbacks || dueCallbacks.length === 0) {
    return NextResponse.json({ reminders_sent: 0 });
  }

  if (dueCallbacks.length === 50) {
    console.warn("[Cron] Hit 50-callback limit — more may be due and will be processed next run");
  }

  let sent = 0;

  for (const cb of dueCallbacks) {
    // SCRUM-429 (finding #55): CLAIM the reminder atomically BEFORE sending —
    // a conditional update that only wins while reminder_sent_at is still
    // NULL. An overlapping run loses the claim and skips; the old
    // send-then-mark order double-texted on overlap/crash. A transient send
    // failure releases the claim below so the next run retries.
    const { data: claimed, error: claimError } = await (supabase as any)
      .from("callback_requests")
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq("id", cb.id)
      .eq("status", "pending") // re-verify atomically — it may have been completed/cancelled since the SELECT
      .is("reminder_sent_at", null)
      .select("id");
    if (claimError) {
      console.error(`[Cron] Failed to claim reminder ${cb.id} — skipping this run:`, claimError);
      continue;
    }
    if (!claimed || claimed.length === 0) {
      console.log(`[Cron] Reminder ${cb.id} already claimed by another run — skipping`);
      continue;
    }

    try {
      await sendCallbackReminderNotification({
        organizationId: cb.organization_id,
        callerName: cb.caller_name,
        callerPhone: cb.caller_phone,
        reason: cb.reason,
        preferredTime: cb.requested_time,
        urgency: cb.urgency,
      });
    } catch (notifyErr) {
      // "0 notification channels delivered" (SCRUM-419) is a PERMANENT org
      // configuration problem (e.g. owner-email lookup failing with email the
      // only wanted channel) — retrying next run can't succeed and would loop
      // this row forever, crowding the 50-row window. Mark it abandoned so it
      // leaves the queue; the failure is already logged + Sentry-reported by
      // the notification service. Transient send failures still retry.
      const isPermanentChannelFailure =
        notifyErr instanceof Error && notifyErr.message.includes("0 notification channels delivered");
      if (isPermanentChannelFailure) {
        // Keep the claim (reminder_sent_at already set) — retrying an org
        // with no working channels can't succeed (SCRUM-419 semantics).
        console.error(`[Cron] Abandoning reminder for callback ${cb.id} — org has no working notification channels:`, notifyErr.message);
      } else {
        // Transient failure: RELEASE the claim so the next run retries.
        // Sentry so a fleet-wide send outage (e.g. mis-set EMAIL_API_KEY,
        // which presents as "1/1 channels failed", not the permanent marker)
        // alerts before the 48h expire-callbacks cron silently discards
        // every queued reminder.
        console.error(`[Cron] Failed to send reminder for callback ${cb.id} — releasing claim for retry:`, notifyErr);
        Sentry.captureMessage(`Callback reminder send failed — claim released for retry (callback ${cb.id})`, "warning");
        const { error: releaseError } = await (supabase as any)
          .from("callback_requests")
          .update({ reminder_sent_at: null })
          .eq("id", cb.id);
        if (releaseError) {
          console.error(`[Cron] Failed to release claim for ${cb.id} — reminder will NOT retry:`, releaseError);
        }
      }
      continue;
    }

    // Already marked by the atomic claim above — nothing further to write.
    sent++;
  }

  console.log(`[Cron] Sent ${sent}/${dueCallbacks.length} callback reminders`);

  return NextResponse.json({ reminders_sent: sent });
}
