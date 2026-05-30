import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import crypto from "crypto";
import { analyzeCall, type CallMetadata } from "@/lib/spam/spam-detector";
import { sendMissedCallNotification, sendVoicemailNotification, sendFailedCallNotification } from "@/lib/notifications/notification-service";
import { incrementCallUsage } from "@/lib/stripe/billing-service";
import { withRateLimit } from "@/lib/security/rate-limiter";
import {
  handleBookAppointment,
  handleCheckAvailability,
  handleCancelAppointment,
  handleGetCurrentDatetime,
} from "@/lib/calendar/tool-handlers";
import { deliverWebhooks } from "@/lib/integrations/webhook-delivery";
import { getVapiClient, type VapiCall as VapiCallType } from "@/lib/vapi";

// Verify Vapi webhook using custom header secret
// Vapi sends the secret via the x-webhook-secret header (configured in server.headers)
function verifyWebhookSecret(request: Request): boolean {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) return false;

  const headerSecret = request.headers.get("x-webhook-secret");
  if (!headerSecret) return false;

  const secretBuffer = Buffer.from(secret);
  const headerBuffer = Buffer.from(headerSecret);
  if (secretBuffer.length !== headerBuffer.length) return false;

  return crypto.timingSafeEqual(secretBuffer, headerBuffer);
}

interface VapiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface VapiCall {
  id: string;
  orgId: string;
  assistantId?: string;
  phoneNumberId?: string;
  type: string;
  status: string;
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  customer?: {
    number?: string;
  };
  transcript?: string;
  recordingUrl?: string;
  summary?: string;
  cost?: number;
  metadata?: Record<string, unknown>;
  analysis?: {
    summary?: string;
    structuredData?: Record<string, unknown>;
    successEvaluation?: string;
  };
}

interface VapiCallEvent {
  message: {
    type: string;
    status?: string;
    endedReason?: string;
    call?: VapiCall;
    toolCallList?: VapiToolCall[];
    transcript?: string;
    artifact?: {
      transcript?: string;
      recordingUrl?: string;
      summary?: string;
      messages?: unknown[];
    };
    analysis?: {
      summary?: string;
    };
    costBreakdown?: {
      total?: number;
    };
    cost?: number;
  };
}

// Map Vapi status to our status
function mapStatus(vapiStatus: string): string {
  const statusMap: Record<string, string> = {
    queued: "queued",
    ringing: "ringing",
    "in-progress": "in-progress",
    forwarding: "in-progress",
    ended: "completed",
  };
  return statusMap[vapiStatus] || "completed";
}

// Map Vapi endedReason to our internal call status.
// Unrecognized reasons are logged and default to "completed".
function mapEndedReason(endedReason: string | undefined): string {
  switch (endedReason) {
    case "customer-ended-call":
    case "assistant-ended-call":
    case "customer-ended":
    case "assistant-ended":
      return "completed";
    case "no-answer":
      return "no-answer";
    case "busy":
      return "busy";
    case "silence-timed-out":
    case "pipeline-error-openai-llm-failed":
    case "pipeline-error-openai-voice-failed":
    case "pipeline-error-deepgram-transcriber-failed":
    case "server-error":
    case "assistant-error":
      return "failed";
    case undefined:
      return "completed";
    default:
      console.warn("Unrecognized endedReason, defaulting to completed:", endedReason);
      return "completed";
  }
}

// Human-readable failure reasons for notification emails
function humanizeEndedReason(endedReason: string | undefined): string {
  switch (endedReason) {
    case "pipeline-error-openai-llm-failed":
      return "The AI assistant encountered a technical error and couldn't respond.";
    case "assistant-error":
      return "The AI assistant had an internal error during the call.";
    case "silence-timed-out":
      return "The call was disconnected due to prolonged silence.";
    case "pipeline-error-openai-voice-failed":
      return "The voice system failed during the call.";
    case "pipeline-error-deepgram-transcriber-failed":
      return "The speech recognition system failed during the call.";
    case "server-error":
      return "Our server encountered an error processing the call.";
    default:
      return endedReason
        ? `The call ended unexpectedly (${endedReason.substring(0, 100)}).`
        : "The call ended unexpectedly for an unknown reason.";
  }
}

/**
 * Resolve the local phone number record, assistant ID, and org from a Vapi call.
 * Used by both status-update and end-of-call-report handlers.
 */
async function resolveCallContext(
  supabase: ReturnType<typeof createAdminClient>,
  call: VapiCall
): Promise<{
  phoneNumber: { id: string; organization_id: string; assistant_id: string | null } | null;
  assistantId: string | null;
}> {
  const { data: phoneNumber, error: phoneError } = await (supabase
    .from("phone_numbers") as any)
    .select("id, organization_id, assistant_id")
    .eq("vapi_phone_number_id", call.phoneNumberId)
    .single();

  if (phoneError) {
    console.error("Failed to look up phone number:", {
      vapiCallId: call.id,
      phoneNumberId: call.phoneNumberId,
      error: phoneError,
    });
  }

  if (!phoneNumber) return { phoneNumber: null, assistantId: null };

  let assistantId = phoneNumber.assistant_id;
  if (call.assistantId) {
    const { data: assistant, error: assistantError } = await (supabase
      .from("assistants") as any)
      .select("id")
      .eq("vapi_assistant_id", call.assistantId)
      .single();

    if (assistantError && assistantError.code !== "PGRST116") {
      console.error("Failed to look up assistant:", {
        vapiCallId: call.id,
        vapiAssistantId: call.assistantId,
        error: assistantError,
      });
    }
    if (assistant) assistantId = assistant.id;
  }

  return { phoneNumber, assistantId };
}

/**
 * Build the insert payload for a new call record.
 * Shared between status-update (call started) and end-of-call-report (fallback creation).
 */
function buildCallInsertPayload(
  phoneNumber: { id: string; organization_id: string },
  assistantId: string | null,
  call: VapiCall
) {
  return {
    organization_id: phoneNumber.organization_id,
    assistant_id: assistantId,
    phone_number_id: phoneNumber.id,
    vapi_call_id: call.id,
    caller_phone: call.customer?.number,
    direction: call.type === "outbound" ? "outbound" : "inbound",
    status: "in-progress",
    started_at: call.startedAt,
  };
}

function isLikelyVoicemail(recordingUrl: string | undefined, durationSeconds: number | null): boolean {
  return !!recordingUrl && !!durationSeconds && durationSeconds > 10 && durationSeconds < 120;
}

// POST /api/webhooks/vapi - Handle Vapi webhook events
export async function POST(request: Request) {
  try {
    // Rate limit - webhook endpoints (high volume)
    const { allowed, headers } = withRateLimit(request, "/api/webhooks/vapi", "webhook");
    if (!allowed) {
      console.error("Vapi webhook rate limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers }
      );
    }

    const payload = await request.text();

    // SECURITY: Verify webhook using shared secret header
    // Only skip in explicit test mode with TEST_MODE=true
    const skipVerification = process.env.TEST_MODE === "true" && process.env.NODE_ENV !== "production";

    if (!skipVerification) {
      if (!process.env.VAPI_WEBHOOK_SECRET) {
        console.error("VAPI_WEBHOOK_SECRET not configured - rejecting webhook");
        return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
      }

      if (!verifyWebhookSecret(request)) {
        console.error("Invalid webhook secret");
        return NextResponse.json({ error: "Invalid webhook secret" }, { status: 401 });
      }
    }

    const event: VapiCallEvent = JSON.parse(payload);
    const supabase = createAdminClient();

    console.log("Vapi webhook received:", event.message.type);

    // Vapi sends: status-update, end-of-call-report, tool-calls, transcript, etc.
    switch (event.message.type) {
      case "status-update": {
        const call = event.message.call;
        const status = event.message.status || call?.status;
        if (!call) break;

        if (status === "in-progress") {
          // Call started — create the call record
          const { phoneNumber, assistantId } = await resolveCallContext(supabase, call);

          if (!phoneNumber) {
            console.error("Phone number not found for Vapi ID:", call.phoneNumberId);
            break;
          }

          // Check if call record already exists, create if not
          const { data: existingCall, error: lookupErr } = await (supabase
            .from("calls") as any)
            .select("id")
            .eq("vapi_call_id", call.id)
            .single();

          if (lookupErr && lookupErr.code !== "PGRST116") {
            console.error("Failed to check for existing call record:", {
              vapiCallId: call.id,
              error: lookupErr,
            });
          }

          if (!existingCall) {
            const { error: insertError } = await (supabase.from("calls") as any)
              .insert(buildCallInsertPayload(phoneNumber, assistantId, call));

            if (insertError) {
              console.error("Failed to create call record:", {
                vapiCallId: call.id,
                organizationId: phoneNumber.organization_id,
                error: insertError,
              });
              return NextResponse.json(
                { error: "Failed to record call" },
                { status: 500 }
              );
            }
          } else {
            const { error: updateError } = await (supabase.from("calls") as any)
              .update({ status: "in-progress", started_at: call.startedAt })
              .eq("vapi_call_id", call.id);

            if (updateError) {
              console.error("Failed to update call to in-progress:", {
                vapiCallId: call.id,
                error: updateError,
              });
            }
          }

          // Fire call.started webhook
          deliverWebhooks(phoneNumber.organization_id, "call.started", {
            callId: existingCall?.id || call.id,
            caller: call.customer?.number || "Unknown",
            outcome: "in-progress",
          }).catch((err) => console.error("[Webhooks] Failed to deliver call.started:", err));
        } else {
          // Other status updates (queued, ringing, forwarding, ended)
          const { error: statusError } = await (supabase
            .from("calls") as any)
            .update({ status: mapStatus(status || call.status) })
            .eq("vapi_call_id", call.id);

          if (statusError) {
            console.error("Failed to update call status:", {
              vapiCallId: call.id,
              targetStatus: mapStatus(status || call.status),
              error: statusError,
            });
          }
        }

        break;
      }

      case "end-of-call-report": {
        const call = event.message.call;
        if (!call) break;

        // Vapi's end-of-call-report webhook often omits startedAt/endedAt and
        // analysis data. Fetch the full call from the API as a fallback.
        let vapiCallData: VapiCallType | null = null;
        if (!call.startedAt || !call.endedAt || !call.analysis) {
          try {
            vapiCallData = await getVapiClient().getCall(call.id);
          } catch (err) {
            console.error("Failed to fetch call from Vapi API (fallback):", {
              vapiCallId: call.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Calculate duration — prefer webhook data, fall back to API data
        let durationSeconds: number | null = null;
        const startedAt = call.startedAt || vapiCallData?.startedAt;
        const endedAt = call.endedAt || vapiCallData?.endedAt;
        if (startedAt && endedAt) {
          const start = new Date(startedAt).getTime();
          const end = new Date(endedAt).getTime();
          durationSeconds = Math.round((end - start) / 1000);
        }

        // Merge analysis from webhook and API fallback
        const analysis = call.analysis || vapiCallData?.analysis || null;

        // Get transcript and summary from various places in the event
        const transcript =
          call.transcript ||
          event.message.artifact?.transcript ||
          event.message.transcript;
        const summary =
          call.summary ||
          event.message.artifact?.summary ||
          analysis?.summary ||
          event.message.analysis?.summary;
        const recordingUrl =
          call.recordingUrl || event.message.artifact?.recordingUrl;
        const cost =
          call.cost || event.message.cost || event.message.costBreakdown?.total;
        const endedReason =
          event.message.endedReason || call.endedReason;

        // Get or create the call record
        const { data: foundCall, error: lookupError } = await (supabase
          .from("calls") as any)
          .select("id, organization_id, caller_phone")
          .eq("vapi_call_id", call.id)
          .single();

        if (lookupError && lookupError.code !== "PGRST116") {
          console.error("Failed to look up call record:", {
            vapiCallId: call.id,
            error: lookupError,
          });
        }

        let existingCall = foundCall;

        // If the call record doesn't exist, it means the status-update webhook
        // was not received (network failure, timeout, etc.). Create the record
        // here to ensure we never lose call data.
        if (!existingCall) {
          const { phoneNumber, assistantId } = await resolveCallContext(supabase, call);

          if (!phoneNumber) {
            console.error("Cannot create call record: phone number not found", {
              vapiCallId: call.id,
              vapiPhoneNumberId: call.phoneNumberId,
            });
            return NextResponse.json(
              { error: "Phone number not found" },
              { status: 500 }
            );
          }

          const { data: newCall, error: insertError } = await (supabase.from("calls") as any)
            .insert(buildCallInsertPayload(phoneNumber, assistantId, call))
            .select("id, organization_id, caller_phone")
            .single();

          if (insertError) {
            console.error("Failed to create call record in end-of-call-report fallback:", {
              vapiCallId: call.id,
              organizationId: phoneNumber.organization_id,
              error: insertError,
            });
            return NextResponse.json(
              { error: "Failed to record call" },
              { status: 500 }
            );
          }

          existingCall = newCall;
        }

        // Run spam analysis
        let spamAnalysis = null;
        if (existingCall && call.customer?.number) {
          const spamMetadata: CallMetadata = {
            callerPhone: call.customer.number,
            organizationId: existingCall.organization_id,
            timestamp: startedAt ? new Date(startedAt) : new Date(),
            duration: durationSeconds ?? undefined,
            transcript: transcript ?? undefined,
          };

          try {
            spamAnalysis = await analyzeCall(spamMetadata);
            console.log("Spam analysis result:", {
              callId: call.id,
              isSpam: spamAnalysis.isSpam,
              score: spamAnalysis.spamScore,
              recommendation: spamAnalysis.recommendation,
            });
          } catch (error) {
            console.error("Spam analysis failed:", error);
          }
        }

        const callStatus = mapEndedReason(endedReason);

        // Extract structured caller data from Vapi analysis (uses merged analysis)
        const collectedData = analysis?.structuredData ?? null;
        const successEvaluation = analysis?.successEvaluation ?? null;

        // Extract caller_name from structured data if available
        const callerName =
          (collectedData as Record<string, unknown> | null)?.full_name as string | undefined ??
          (collectedData as Record<string, unknown> | null)?.name as string | undefined ??
          null;

        // Update call record with full end-of-call data
        const { error: updateError } = await (supabase
          .from("calls") as any)
          .update({
            status: callStatus,
            ended_at: endedAt,
            duration_seconds: durationSeconds,
            transcript,
            recording_url: recordingUrl,
            summary,
            cost_cents: cost ? Math.round(cost * 100) : null,
            is_spam: spamAnalysis?.isSpam ?? false,
            spam_score: spamAnalysis?.spamScore ?? null,
            ...(collectedData && { collected_data: collectedData }),
            ...(callerName && { caller_name: callerName }),
            metadata: {
              endedReason,
              analysis,
              successEvaluation,
              spamAnalysis: spamAnalysis ? {
                reasons: spamAnalysis.reasons,
                confidence: spamAnalysis.confidence,
                recommendation: spamAnalysis.recommendation,
              } : null,
            },
          })
          .eq("vapi_call_id", call.id);

        if (updateError) {
          console.error("Failed to update call record:", {
            vapiCallId: call.id,
            error: updateError,
          });
        }

        // Increment call usage for billing (skip for spam calls)
        const shouldTrackUsage = callStatus === "completed" &&
          (!spamAnalysis?.isSpam || spamAnalysis?.recommendation !== "block");

        if (shouldTrackUsage && existingCall) {
          // SCRUM-361: count usage at most once per call. Atomically flip the
          // call's usage_counted false→true; a Vapi at-least-once redelivery of
          // this end-of-call-report finds it already true and skips, so usage is
          // never double-billed. Only increment when we win the flip.
          const { data: claimed, error: claimError } = await (supabase.from("calls") as any)
            .update({ usage_counted: true })
            .eq("id", existingCall.id)
            .eq("usage_counted", false)
            .select("id");
          if (claimError) {
            // Fail CLOSED on the claim error (skip the increment) — a dropped
            // count on a rare DB blip is recoverable; a double-bill is not.
            console.error("Failed to claim usage_counted (skipping increment to avoid double-bill):", {
              vapiCallId: call.id,
              organizationId: existingCall.organization_id,
              error: claimError,
            });
          } else if (claimed && claimed.length > 0) {
            const { success, shouldUpgrade } = await incrementCallUsage(existingCall.organization_id);
            if (!success) {
              console.error("Failed to increment call usage:", {
                organizationId: existingCall.organization_id,
                vapiCallId: call.id,
              });
            }
            if (shouldUpgrade) {
              console.log(`Organization ${existingCall.organization_id} approaching call limit`);
            }
          } else {
            console.log("Vapi usage already counted for call — skipping (redelivery):", call.id);
          }
        }

        // Send notifications based on call outcome (skip for spam)
        if (existingCall && !spamAnalysis?.isSpam) {
          try {
            if (callStatus === "failed") {
              await sendFailedCallNotification({
                organizationId: existingCall.organization_id,
                callId: existingCall.id,
                callerPhone: call.customer?.number || "Unknown",
                callerName: callerName ?? undefined,
                timestamp: startedAt ? new Date(startedAt) : new Date(),
                duration: durationSeconds ?? undefined,
                summary: summary ?? undefined,
                failureReason: humanizeEndedReason(endedReason),
                endedReason: endedReason ?? undefined,
              });
            } else if (callStatus === "no-answer" || (durationSeconds !== null && durationSeconds < 10)) {
              await sendMissedCallNotification({
                organizationId: existingCall.organization_id,
                callId: existingCall.id,
                callerPhone: call.customer?.number || "Unknown",
                timestamp: startedAt ? new Date(startedAt) : new Date(),
                duration: durationSeconds ?? undefined,
                summary: summary ?? undefined,
              });
            } else if (isLikelyVoicemail(recordingUrl, durationSeconds)) {
              await sendVoicemailNotification({
                organizationId: existingCall.organization_id,
                callId: existingCall.id,
                callerPhone: call.customer?.number || "Unknown",
                timestamp: startedAt ? new Date(startedAt) : new Date(),
                duration: durationSeconds!,
                voicemailUrl: recordingUrl!,
                voicemailTranscript: transcript ?? undefined,
              });
            }
          } catch (err) {
            console.error("Failed to send call notification:", {
              organizationId: existingCall.organization_id,
              callId: existingCall.id,
              callStatus,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Fire-and-forget webhook delivery to user integrations
        if (existingCall) {
          let assistantName: string | null = null;
          const { data: assistantRecord, error: assistantLookupError } = await (supabase.from("assistants") as any)
            .select("name")
            .eq("vapi_assistant_id", call.assistantId)
            .single();
          if (assistantLookupError && assistantLookupError.code !== "PGRST116") {
            console.error("Failed to look up assistant name for webhook:", assistantLookupError);
          }
          if (assistantRecord) assistantName = assistantRecord.name;

          const voicemail = isLikelyVoicemail(recordingUrl, durationSeconds);
          const isMissed = callStatus === "no-answer" || callStatus === "busy";

          type WebhookEvent = "call.completed" | "call.missed" | "voicemail.received";
          let webhookEvent: WebhookEvent = "call.completed";
          if (voicemail) {
            webhookEvent = "voicemail.received";
          } else if (isMissed) {
            webhookEvent = "call.missed";
          }

          deliverWebhooks(existingCall.organization_id, webhookEvent, {
            callId: existingCall.id,
            caller: call.customer?.number || "Unknown",
            callerName: callerName ?? undefined,
            summary: summary ?? undefined,
            transcript: transcript ?? undefined,
            duration: durationSeconds ?? undefined,
            assistantName,
            outcome: callStatus,
            recordingUrl: recordingUrl ?? undefined,
            collectedData: collectedData as Record<string, unknown> | undefined,
          }).catch((err) => console.error("[Webhooks] Failed to deliver webhooks:", err));
        }

        break;
      }

      case "transcript": {
        const call = event.message.call;
        const transcript = event.message.transcript;
        if (!call || !transcript) break;

        const { error: transcriptError } = await (supabase
          .from("calls") as any)
          .update({ transcript })
          .eq("vapi_call_id", call.id);

        if (transcriptError) {
          console.error("Failed to update transcript:", {
            vapiCallId: call.id,
            transcriptLength: transcript?.length,
            error: transcriptError,
          });
        }

        break;
      }

      case "tool-calls": {
        const toolCallList = event.message.toolCallList;
        const call = event.message.call;
        if (!toolCallList || !call) {
          return NextResponse.json({ results: [] });
        }

        // Get organizationId from call metadata or DB lookup
        let organizationId =
          (call.metadata?.organizationId as string) || null;

        if (!organizationId) {
          const { data: existingCall, error: callError } = await (supabase
            .from("calls") as any)
            .select("organization_id")
            .eq("vapi_call_id", call.id)
            .single();

          if (callError) {
            console.error("DB error looking up call for org ID:", callError);
          }
          organizationId = existingCall?.organization_id || null;
        }

        if (!organizationId) {
          // Last resort: look up via phone number
          const { data: phoneNumber, error: phoneError } = await (supabase
            .from("phone_numbers") as any)
            .select("organization_id")
            .eq("vapi_phone_number_id", call.phoneNumberId)
            .single();

          if (phoneError) {
            console.error("DB error looking up phone number for org ID:", phoneError);
          }
          organizationId = phoneNumber?.organization_id || null;
        }

        if (!organizationId) {
          console.error("Could not determine organization for tool call, call ID:", call.id);
          return NextResponse.json({
            results: toolCallList.map((tc) => ({
              toolCallId: tc.id,
              result: "I'm sorry, I'm having a technical issue right now. Please try again.",
            })),
          });
        }

        const results = [];

        for (const toolCall of toolCallList) {
          let args: Record<string, unknown>;
          try {
            args =
              typeof toolCall.function.arguments === "string"
                ? JSON.parse(toolCall.function.arguments)
                : toolCall.function.arguments;
          } catch (parseError) {
            console.error("Failed to parse tool call arguments:", {
              toolCallId: toolCall.id,
              functionName: toolCall.function.name,
              error: parseError,
            });
            results.push({
              toolCallId: toolCall.id,
              result: "I'm sorry, I had trouble understanding that request. Could you try again?",
            });
            continue;
          }

          let result: { success: boolean; message: string };

          switch (toolCall.function.name) {
            case "book_appointment":
              result = await handleBookAppointment(organizationId, args);
              break;
            case "check_availability":
              result = await handleCheckAvailability(organizationId, args);
              break;
            case "cancel_appointment":
              result = await handleCancelAppointment(organizationId, args);
              break;
            case "get_current_datetime":
              result = await handleGetCurrentDatetime(organizationId);
              break;
            default:
              console.log("Unknown tool call:", toolCall.function.name);
              result = {
                success: false,
                message: "I'm sorry, I can't perform that action right now.",
              };
          }

          results.push({
            toolCallId: toolCall.id,
            result: result.message,
          });
        }

        return NextResponse.json({ results });
      }

      case "conversation-update":
      case "speech-update":
      case "assistant-started":
        // Known Vapi events we don't need to act on — ignore silently
        break;

      default:
        console.log("Unhandled event type:", event.message.type);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
