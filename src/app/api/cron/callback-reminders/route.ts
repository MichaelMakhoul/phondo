import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendCallbackReminderNotification } from "@/lib/notifications/notification-service";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Find pending callbacks with a requested_time that has passed and no reminder sent yet
  const { data: dueCallbacks, error } = await (supabase as any)
    .from("callback_requests")
    .select("id, organization_id, caller_name, caller_phone, reason, requested_time, urgency")
    .eq("status", "pending")
    .not("requested_time", "is", null)
    .lte("requested_time", new Date().toISOString())
    .is("reminder_sent_at", null)
    .limit(50);

  if (error) {
    console.error("[Cron] Failed to query due callbacks:", error);
    return NextResponse.json({ error: "Failed to query callbacks" }, { status: 500 });
  }

  if (!dueCallbacks || dueCallbacks.length === 0) {
    return NextResponse.json({ reminders_sent: 0 });
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

      await (supabase as any)
        .from("callback_requests")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", cb.id);

      sent++;
    } catch (err) {
      console.error(`[Cron] Failed to send reminder for callback ${cb.id}:`, err);
    }
  }

  console.log(`[Cron] Sent ${sent}/${dueCallbacks.length} callback reminders`);

  return NextResponse.json({ reminders_sent: sent });
}
