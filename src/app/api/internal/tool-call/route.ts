import { NextResponse } from "next/server";
import crypto from "crypto";
import {
  handleGetCurrentDatetime,
  handleCheckAvailability,
  handleBookAppointment,
  handleCancelAppointment,
  handleLookupAppointment,
} from "@/lib/calendar/tool-handlers";
import { handleScheduleCallback } from "@/lib/callbacks/tool-handler";
import { getActiveServiceTypes } from "@/lib/service-types";
import { withRateLimit } from "@/lib/security/rate-limiter";

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
        });
        break;

      case "book_appointment":
        result = await handleBookAppointment(organizationId, {
          datetime: parsedArgs.datetime,
          name: parsedArgs.name,
          phone: parsedArgs.phone,
          email: parsedArgs.email,
          notes: parsedArgs.notes,
          service_type_id: parsedArgs.service_type_id,
        });
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
        result = await handleCancelAppointment(organizationId, {
          phone: parsedArgs.phone,
          reason: parsedArgs.reason,
        });
        break;

      case "lookup_appointment":
        result = await handleLookupAppointment(organizationId, {
          confirmation_code: parsedArgs.confirmation_code,
          name: parsedArgs.name,
          phone: parsedArgs.phone,
          email: parsedArgs.email,
          date_of_birth: parsedArgs.date_of_birth,
        });
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
        message:
          "I'm having trouble with that right now. Would you like me to take your information instead?",
      },
      { status: 500 }
    );
  }
}
