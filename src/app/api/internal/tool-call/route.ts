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
  errorResult,
  type ToolResult,
  type TrustedCallContext,
} from "@/lib/calendar/tool-handlers";
import { handleScheduleCallback } from "@/lib/callbacks/tool-handler";
import { getActiveServiceTypes } from "@/lib/service-types";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { resolveCallerId, sanitizeCollectedDetails } from "@/lib/calendar/appointment-verification";
import * as Sentry from "@sentry/nextjs";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import {
  OWNER_TOOL_NAMES,
  handleOwnerListAppointments,
  handleOwnerListMessages,
  handleOwnerRescheduleAppointment,
  handleOwnerCancelAppointment,
  type OwnerCallContext,
  type OwnerToolName,
} from "@/lib/owner-assistant/tool-handlers";

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
  /**
   * SCRUM-586: the voice server sets this ONLY on a session that passed the
   * owner PIN gate (`session.ownerMode`), never in test mode — a top-level
   * envelope field the model can never reach. Together with a production
   * callId it is the sole authority for the owner_* tools.
   */
  ownerVerified?: boolean;
}

/**
 * SCRUM-586: what the owner hears when an owner handler THROWS (e.g. an invalid
 * IANA zone stored on the org) — never the customer-worded catch-all below.
 */
const OWNER_FAULT_MESSAGE = "Something went wrong on our side — please try again or check the dashboard.";

/** A model argument as a string; anything else reads as absent. */
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
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
    // SCRUM-586: owner tools. Authority is the ENVELOPE flag + a production
    // call — never anything in `arguments`. A customer session can't reach
    // these (they're not declared to its model), but the route refuses anyway.
    // Every owner_* name returns from this block, so none reaches the customer
    // switch below (which plucks explicit fields and never forwards `ownerVerified`).
    if ((OWNER_TOOL_NAMES as readonly string[]).includes(functionName)) {
      if (payload.ownerVerified !== true || !isProductionCall) {
        console.error("[ToolCall] owner tool REFUSED — no owner authority on this call", {
          functionName, organizationId, ownerVerified: payload.ownerVerified === true, isProductionCall,
        });
        // A refusal is a security signal, so the route pages it itself: pageSentry's
        // [ALERT:error] line is the alertable one (@sentry/nextjs is off in
        // production, SCRUM-320). Never put the model's `arguments` in the extras.
        pageSentry({
          service: "next-api",
          reason: SENTRY_REASONS.OWNER_TOOL_REFUSED,
          level: "error",
          message: "owner tool called without owner authority",
          // The two halves of the authority check, exactly as the gate evaluated them.
          extras: {
            functionName,
            organizationId,
            isProductionCall,
            ownerVerified: payload.ownerVerified === true,
          },
        });
        return NextResponse.json(
          { success: false, error: true, message: "That isn't available on this call." },
          { status: 403 }
        );
      }
      const ownerCtx: OwnerCallContext = { callId: payload.callId as string };
      const raw = (args || {}) as Record<string, unknown>;
      let ownerResult: ToolResult;
      try {
        // No default: the switch is exhaustive over OwnerToolName, so a new
        // OWNER_TOOL_NAMES entry without a case here fails to compile instead
        // of silently landing on another tool.
        switch (functionName as OwnerToolName) {
          case "owner_list_appointments":
            ownerResult = await handleOwnerListAppointments(organizationId, { range: str(raw.range), date: str(raw.date) });
            break;
          case "owner_list_messages":
            ownerResult = await handleOwnerListMessages(organizationId);
            break;
          case "owner_reschedule_appointment":
            ownerResult = await handleOwnerRescheduleAppointment(
              organizationId,
              { appointment_id: str(raw.appointment_id), new_datetime: str(raw.new_datetime), confirmed: raw.confirmed === true },
              ownerCtx
            );
            break;
          case "owner_cancel_appointment":
            ownerResult = await handleOwnerCancelAppointment(
              organizationId,
              { appointment_id: str(raw.appointment_id), confirmed: raw.confirmed === true, reason: str(raw.reason) },
              ownerCtx
            );
            break;
        }
      } catch (err) {
        // A throw gets the owner's wording at HTTP 200 + error:true: the voice
        // server swaps ANY non-2xx body for its customer-worded fallback, and
        // error:true still raises its [ALERT:error] (SCRUM-509).
        console.error("[ToolCall] owner tool threw:", {
          functionName,
          organizationId,
          error: err instanceof Error ? err.message : String(err),
        });
        Sentry.captureException(err, { extra: { functionName, organizationId } });
        ownerResult = errorResult(OWNER_FAULT_MESSAGE);
      }
      return NextResponse.json({
        success: ownerResult.success,
        message: ownerResult.message,
        ...(ownerResult.data && { data: ownerResult.data }),
        ...(ownerResult.error === true && { error: true }),
      });
    }

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
          isProductionCall
            ? {
                callId: payload.callId,
                // SCRUM-558: lets the handler warn when a corrected phone no
                // longer matches the possession gates' verified caller ID.
                verifiedCallerPhone:
                  trusted.callerIdState === "verified" ? trusted.verifiedCallerPhone : undefined,
              }
            : undefined
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
          trustedForMutation,
          // SCRUM-560: call authority — from the request envelope, never from
          // `arguments`. Lets the caller cancel the booking THIS call made
          // even after correcting its contact phone away from the caller ID.
          isProductionCall ? { callId: payload.callId } : undefined
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
