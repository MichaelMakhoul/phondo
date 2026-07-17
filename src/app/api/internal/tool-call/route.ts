import { NextResponse } from "next/server";
import crypto from "crypto";
import {
  handleGetCurrentDatetime,
  handleCheckAvailability,
  handleBookAppointment,
  handleCancelAppointment,
  handleUpdateAppointmentAttendee,
  handleUpdateAppointmentDetails,
  handleRescheduleAppointment,
  handleLookupAppointment,
  type TrustedCallContext,
} from "@/lib/calendar/tool-handlers";
import { handleScheduleCallback } from "@/lib/callbacks/tool-handler";
import { getActiveServiceTypes } from "@/lib/service-types";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { resolveCallerId, sanitizeCollectedDetails } from "@/lib/calendar/appointment-verification";

function verifyInternalSecret(request: Request): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error("[ToolCall] INTERNAL_API_SECRET is not configured");
    return false;
  }

  const headerSecret = request.headers.get("X-Internal-Secret");
  if (!headerSecret) return false;

  const secretBuffer = Buffer.from(secret);
  const headerBuffer = Buffer.from(headerSecret);
  if (secretBuffer.length !== headerBuffer.length) return false;

  return crypto.timingSafeEqual(secretBuffer, headerBuffer);
}

interface ToolCallPayload {
  organizationId: string;
  assistantId: string;
  functionName: string;
  arguments: Record<string, unknown>;
  callId?: string;
  /**
   * SCRUM-438: the call's VERIFIED inbound caller ID, set by the voice server
   * from its session state (the Twilio/Telnyx From) — a top-level payload
   * field the MODEL can never reach (its output only populates `arguments`).
   * Possession factor for cancel/reschedule ownership. Present only when
   * `callerIdState` is "verified".
   */
  callerPhone?: string;
  /**
   * SCRUM-438 (review fix): explicit caller-ID state from the voice server:
   *  - "verified" (with callerPhone): production call with a dialable From
   *  - "withheld": production call with no usable caller ID (withheld/
   *    sentinel/SIP From) — mutations must refuse, never fall back to the
   *    model-controlled phone argument
   *  - absent (and no callerPhone): browser/test sessions only
   */
  callerIdState?: string;
  /**
   * SCRUM-506: the caller's OWN identity details collected earlier in THIS call
   * (name/phone/email/date_of_birth), set by the voice server from its per-call
   * session store — a top-level, model-inaccessible field (NEVER read from
   * `arguments`). Sanitized here, then backfills a missing verification factor
   * so cancel/reschedule don't re-ask. Never forwarded to book_appointment.
   */
  collectedDetails?: Record<string, unknown>;
}

/**
 * Internal endpoint called by the self-hosted voice server to execute
 * tool calls (calendar operations). Delegates to existing tool-handlers.
 */
export async function POST(request: Request) {
  const { allowed, headers: rlHeaders } = withRateLimit(
    request,
    "/api/internal/tool-call",
    "webhook"
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: rlHeaders }
    );
  }

  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: ToolCallPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { organizationId, functionName, arguments: args } = payload;

  if (!organizationId || typeof organizationId !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid organizationId" },
      { status: 400 }
    );
  }

  if (!functionName || typeof functionName !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid functionName" },
      { status: 400 }
    );
  }

  const parsedArgs = (args || {}) as Record<string, string | undefined>;

  // SCRUM-438: validate the trusted caller-ID fields before threading them
  // into the mutation handlers — sentinels ("anonymous", +266696687) or junk
  // never become a possession factor, and a production call with a withheld
  // caller ID stays EXPLICITLY 'withheld' so mutations refuse instead of
  // falling back to the model-controlled phone argument. NEVER read these
  // from `arguments` (model-controllable). The handlers re-validate through
  // the same resolver (they are the security boundary).
  // A PRODUCTION call always carries `callId` (the voice server's call record);
  // genuine browser/test sessions never do (verified in the codebase — test-mode
  // contexts omit callId). It is the only reliable test-vs-production
  // discriminator the caller-ID fields alone can't give us.
  const isProductionCall = typeof payload.callId === "string" && payload.callId.length > 0;
  // SCRUM-506: sanitized per-call caller details (model-inaccessible top-level field).
  const collectedDetails = sanitizeCollectedDetails(payload.collectedDetails);
  const trusted: TrustedCallContext = (() => {
    const resolved = resolveCallerId({
      // A present-but-malformed state fails secure to 'withheld' in the resolver.
      callerIdState: payload.callerIdState === undefined ? undefined : String(payload.callerIdState),
      verifiedCallerPhone: typeof payload.callerPhone === "string" ? payload.callerPhone : undefined,
    });
    const base: TrustedCallContext =
      resolved.state === "verified"
        ? { callerIdState: "verified", verifiedCallerPhone: resolved.phone }
        : resolved.state === "withheld"
        ? { callerIdState: "withheld" }
        // No caller-ID fields at all. Only a genuine browser/test session (no
        // callId) may use the model-phone fallback downstream. A PRODUCTION call
        // that arrives without caller-ID fields — an older voice server
        // mid-rolling-deploy, or a tampered body — must fail secure to
        // 'withheld', never the model phone.
        : isProductionCall
        ? { callerIdState: "withheld" }
        : {};
    return base;
  })();

  // SCRUM-506: ONLY the mutation handlers (cancel/reschedule) backfill a missing
  // verification factor from the per-call details. lookup + book_appointment do
  // not consume it, so they never receive the PII bag — keeps the surface tight
  // and avoids threading a value the handler ignores.
  const trustedForMutation: TrustedCallContext =
    collectedDetails ? { ...trusted, collectedDetails } : trusted;

  try {
    let result;

    switch (functionName) {
      case "get_current_datetime":
        result = await handleGetCurrentDatetime(organizationId);
        break;

      case "check_availability":
        result = await handleCheckAvailability(organizationId, {
          date: parsedArgs.date,
          service_type_id: parsedArgs.service_type_id,
          // SCRUM-12: honored by the Cliniko path so "when can Dr. X see me?"
          // returns only that practitioner's real times (not a merged clinic
          // view the AI would then fail to book).
          practitioner_id: parsedArgs.practitioner_id,
        });
        break;

      case "book_appointment":
        result = await handleBookAppointment(
          organizationId,
          {
            datetime: parsedArgs.datetime,
            // Support both old (name) and new (first_name + last_name) formats
            name: parsedArgs.name,
            first_name: parsedArgs.first_name,
            last_name: parsedArgs.last_name,
            phone: parsedArgs.phone,
            email: parsedArgs.email,
            notes: parsedArgs.notes,
            service_type_id: parsedArgs.service_type_id,
            practitioner_id: parsedArgs.practitioner_id,
          },
          // SCRUM-514: from the request envelope, never from `arguments` — the
          // model must not be able to claim another call's id and be handed
          // that call's confirmation code.
          isProductionCall ? { callId: payload.callId } : undefined
        );
        break;

      case "update_appointment":
        // SCRUM-558: model-facing corrections for any detail of an appointment
        // created by THIS call (time excluded — reschedule owns it). Same
        // call-anchored handler as the guard-internal name correction.
        result = await handleUpdateAppointmentDetails(
          organizationId,
          {
            datetime: parsedArgs.datetime,
            first_name: parsedArgs.first_name,
            last_name: parsedArgs.last_name,
            phone: parsedArgs.phone,
            email: parsedArgs.email,
            notes: parsedArgs.notes,
          },
          isProductionCall ? { callId: payload.callId } : undefined
        );
        break;

      case "update_appointment_attendee":
        // SCRUM-557: RebookGuard-internal name correction — never in the
        // model's tool list. Anchored to the calling call via the envelope
        // (SCRUM-514 principle: identity never comes from model arguments).
        result = await handleUpdateAppointmentAttendee(
          organizationId,
          {
            datetime: parsedArgs.datetime,
            first_name: parsedArgs.first_name,
            last_name: parsedArgs.last_name,
          },
          isProductionCall ? { callId: payload.callId } : undefined
        );
        break;

      case "list_service_types": {
        const serviceTypes = await getActiveServiceTypes(organizationId);
        if (serviceTypes.length === 0) {
          result = { success: true, message: "This business accepts general appointments. No specific service types are configured." };
        } else {
          const list = serviceTypes.map(st => {
            const safeName = st.name.replace(/[\n\r]/g, " ").trim();
            return `- ${safeName} (${st.duration_minutes} min)`;
          }).join("\n");
          result = { success: true, message: `Available appointment types:\n${list}\n\nPlease ask the caller which type they'd like to book.` };
        }
        break;
      }

      case "cancel_appointment":
        result = await handleCancelAppointment(
          organizationId,
          {
            phone: parsedArgs.phone,
            reason: parsedArgs.reason,
            confirmation_code: parsedArgs.confirmation_code,
            date: parsedArgs.date,
            // SCRUM-381: forward the exact datetime so the handler's ±15-min match
            // can pin ONE appointment when a caller has several. Without this the
            // disambiguation reply ("call again with the exact datetime") can never
            // be satisfied — the model loops and may fabricate a cancellation.
            datetime: parsedArgs.datetime,
            // SCRUM-438: knowledge factors for orgs with configured
            // appointment_verification_fields.
            name: parsedArgs.name,
            email: parsedArgs.email,
          },
          trustedForMutation
        );
        break;

      case "reschedule_appointment":
        // SCRUM-377: atomic move (book new + cancel old, server-verified) so a
        // reschedule can never leave a duplicate the way cancel+book did.
        result = await handleRescheduleAppointment(
          organizationId,
          {
            phone: parsedArgs.phone,
            confirmation_code: parsedArgs.confirmation_code,
            current_date: parsedArgs.current_date,
            current_datetime: parsedArgs.current_datetime,
            new_datetime: parsedArgs.new_datetime,
            first_name: parsedArgs.first_name,
            last_name: parsedArgs.last_name,
            name: parsedArgs.name,
            email: parsedArgs.email,
            notes: parsedArgs.notes,
            service_type_id: parsedArgs.service_type_id,
            practitioner_id: parsedArgs.practitioner_id,
          },
          trustedForMutation,
          // SCRUM-514: the rescheduled booking is created by THIS call, so it
          // needs the same linkage a direct booking gets.
          isProductionCall ? { callId: payload.callId } : undefined
        );
        break;

      case "lookup_appointment":
        // SCRUM-505: pass the trusted caller ID so lookup can pin the caller's
        // OWN appointments by verified possession (like cancel/reschedule),
        // instead of relying on a model-guessed phone the model can't know.
        result = await handleLookupAppointment(
          organizationId,
          {
            confirmation_code: parsedArgs.confirmation_code,
            name: parsedArgs.name,
            phone: parsedArgs.phone,
            email: parsedArgs.email,
            date_of_birth: parsedArgs.date_of_birth,
          },
          trusted
        );
        break;

      case "schedule_callback":
        result = await handleScheduleCallback(
          organizationId,
          payload.assistantId,
          {
            caller_name: parsedArgs.caller_name,
            caller_phone: parsedArgs.caller_phone,
            reason: parsedArgs.reason,
            preferred_time: parsedArgs.preferred_time,
            urgency: parsedArgs.urgency,
          },
          payload.callId
        );
        break;

      default:
        return NextResponse.json(
          { error: `Unknown function: ${functionName}` },
          { status: 400 }
        );
    }

    return NextResponse.json({
      success: result.success,
      message: result.message,
      ...("data" in result && { data: (result as any).data }),
      // SCRUM-509: forward the genuine-error flag so the voice server can emit an
      // [ALERT:error] line — a tool that fails gracefully (200 + success:false)
      // must not be invisible to alerting.
      ...((result as any).error === true && { error: true }),
    });
  } catch (err) {
    console.error("[ToolCall] Unhandled error:", {
      functionName,
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        success: false,
        error: true, // SCRUM-509: also surfaced via the HTTP 500 below.
        message:
          "I'm having trouble with that right now. Would you like me to take your information instead?",
      },
      { status: 500 }
    );
  }
}
