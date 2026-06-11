import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendCallbackReminderNotification } from "@/lib/notifications/notification-service";

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
        console.error(`[Cron] Abandoning reminder for callback ${cb.id} — org has no working notification channels:`, notifyErr.message);
        const { error: abandonError } = await (supabase as any)
          .from("callback_requests")
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq("id", cb.id);
        if (abandonError) {
          console.error(`[Cron] Failed to mark abandoned reminder ${cb.id} — it will retry next run:`, abandonError);
        }
      } else {
        console.error(`[Cron] Failed to send reminder for callback ${cb.id} (will retry next run):`, notifyErr);
      }
      continue;
    }

    // Mark reminder as sent — check for DB errors to prevent duplicate sends
    const { error: updateError } = await (supabase as any)
      .from("callback_requests")
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq("id", cb.id);

    if (updateError) {
      console.error(`[Cron] Reminder sent but failed to mark callback ${cb.id} — may re-send next run:`, updateError);
    }

    sent++;
  }

  console.log(`[Cron] Sent ${sent}/${dueCallbacks.length} callback reminders`);

  return NextResponse.json({ reminders_sent: sent });
}
