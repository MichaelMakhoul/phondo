import { createAdminClient } from "@/lib/supabase/admin";
import {
  sanitizeString,
  isValidPhoneNumber,
} from "@/lib/security/validation";
import { sendCallbackNotification } from "@/lib/notifications/notification-service";

interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

interface ScheduleCallbackArgs {
  caller_name?: string;
  caller_phone?: string;
  reason?: string;
  preferred_time?: string;
  urgency?: string;
}

/**
 * Handle the schedule_callback tool call from the voice server.
 * Validates input, inserts into callback_requests, and sends a notification.
 */
export async function handleScheduleCallback(
  organizationId: string,
  assistantId: string,
  args: ScheduleCallbackArgs,
  callId?: string
): Promise<ToolResult> {
  const { caller_name, caller_phone, reason, preferred_time, urgency } = args;

  if (!caller_name) {
    return {
      success: false,
      message: "I need your name to schedule a callback. What's your name?",
    };
  }

  if (!caller_phone) {
    return {
      success: false,
      message:
        "I need a phone number so we can call you back. What's the best number to reach you?",
    };
  }

  if (!isValidPhoneNumber(caller_phone)) {
    return {
      success: false,
      message:
        "I didn't catch that phone number correctly. Could you please repeat it?",
    };
  }

  if (!reason) {
    return {
      success: false,
      message:
        "Could you let me know the reason for the callback so the team can be prepared?",
    };
  }

  const sanitizedName = sanitizeString(caller_name, 100);
  const sanitizedPhone = sanitizeString(caller_phone, 20);
  const sanitizedReason = sanitizeString(reason, 500);
  const validUrgency = ["low", "medium", "high"].includes(urgency || "")
    ? urgency!
    : "medium";

  // Best-effort ISO parse of preferred_time
  let requestedTime: string | null = null;
  let notes: string | null = null;
  if (preferred_time) {
    const parsed = new Date(preferred_time);
    if (!isNaN(parsed.getTime())) {
      requestedTime = parsed.toISOString();
    } else {
      // Store as free-text in notes
      notes = `Preferred callback time: ${sanitizeString(preferred_time, 200)}`;
    }
  }

  const supabase = createAdminClient();

  const { data: callback, error } = await (supabase as any)
    .from("callback_requests")
    .insert({
      organization_id: organizationId,
      assistant_id: assistantId,
      call_id: callId || null,
      caller_name: sanitizedName,
      caller_phone: sanitizedPhone,
      reason: sanitizedReason,
      requested_time: requestedTime,
      urgency: validUrgency,
      notes,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[Callback] Failed to insert callback request:", {
      organizationId,
      error: error.message || error.code,
    });
    return {
      success: false,
      message:
        "I'm having trouble scheduling that callback right now. Let me take your information and someone will reach out to you.",
    };
  }

  // Send notification (fire-and-forget)
  sendCallbackNotification({
    organizationId,
    callerName: sanitizedName,
    callerPhone: sanitizedPhone,
    reason: sanitizedReason,
    preferredTime: preferred_time,
    urgency: validUrgency,
  }).catch((err) => {
    console.error("[Callback] Notification failed (non-fatal):", err);
  });

  const timeNote = preferred_time
    ? ` We'll aim to call you back ${preferred_time}.`
    : "";

  return {
    success: true,
    message: `I've scheduled a callback for you, ${sanitizedName}. Someone from our team will call you back at ${sanitizedPhone}.${timeNote} Is there anything else I can help with?`,
    data: { callbackId: callback.id },
  };
}
