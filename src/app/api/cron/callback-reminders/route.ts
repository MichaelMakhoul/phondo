import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendCallbackReminderNotification,
  NotificationDeliveryError,
} from "@/lib/notifications/notification-service";
import * as Sentry from "@sentry/nextjs";

// SCRUM-447: up to 50 sequential email+SMS sends per run. Vercel's default
// function duration can cut the loop mid-send (a claim-without-confirm crash
// for whichever reminder was in flight). 60s is the Hobby plan ceiling
// (vercel.json has no overrides).
export const maxDuration = 60;

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
      // SCRUM-447: branch on the typed error's fields instead of regex-
      // matching the message (the old string contract broke on any wording
      // tweak). The message text is unchanged and still goes to logs.
      const delivery = notifyErr instanceof NotificationDeliveryError ? notifyErr : null;
      if (delivery?.permanent) {
        // PERMANENT (SCRUM-419 semantics): either the org has no working
        // channels (owner-email lookup failed with email the only wanted
        // channel) or provider credentials are ABSENT from the deployment
        // (Sentry-paged at error level inside the notification service).
        // Retrying next run can't succeed and would loop this row forever,
        // crowding the 50-row window — keep the claim (reminder_sent_at
        // already set) so it leaves the queue.
        console.error(`[Cron] Abandoning reminder for callback ${cb.id} — permanent delivery failure (${delivery.deliveredCount}/${delivery.wantedCount} channels delivered):`, delivery.message);
      } else if (delivery && delivery.deliveredCount > 0) {
        // PARTIAL delivery: something already reached the owner — releasing
        // the claim would double-deliver that channel next run (the same
        // "keep the claim on partial" call daily-summary makes). Confirm
        // delivery so reconciliation doesn't flag this as a crashed send.
        console.warn(`[Cron] Partial delivery for callback ${cb.id} (${delivery.deliveredCount}/${delivery.wantedCount} channels) — keeping the claim (no re-send):`, delivery.message);
        await confirmReminderDelivery(supabase, cb.id);
      } else {
        // Transient nothing-delivered failure: RELEASE the claim so the next
        // run retries. Sentry so a fleet-wide send outage (e.g. a mis-SET
        // EMAIL_API_KEY — wrong value, present in env — still classifies as
        // transient) alerts before the 48h expire-callbacks cron silently
        // discards every queued reminder.
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

    // SCRUM-447 (claim-vs-confirm): the claim (reminder_sent_at) was written
    // BEFORE the send — confirm the send actually happened so a crash between
    // the two is detectable (reminder_delivered_at NULL — see migration 00155).
    await confirmReminderDelivery(supabase, cb.id);
    sent++;
  }

  console.log(`[Cron] Sent ${sent}/${dueCallbacks.length} callback reminders`);

  return NextResponse.json({ reminders_sent: sent });
}

/**
 * Set reminder_delivered_at after the send call returned (fully or partially
 * delivered). Never throws — the send DID happen, so a confirmation failure
 * must not flip the reminder into the failed/release path; it just means the
 * reconciliation query (migration 00155) will show a false positive, which
 * the log line here explains.
 */
async function confirmReminderDelivery(supabase: any, callbackId: string): Promise<void> {
  const { error } = await supabase
    .from("callback_requests")
    .update({ reminder_delivered_at: new Date().toISOString() })
    .eq("id", callbackId);
  if (error) {
    console.error(`[Cron] Failed to confirm reminder delivery for ${callbackId} — reconciliation will flag a delivered send:`, error);
  }
}
