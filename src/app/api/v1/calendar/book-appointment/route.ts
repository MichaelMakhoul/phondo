import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getCalComClient,
  formatBookingConfirmation,
} from "@/lib/calendar/cal-com";
import { sendAppointmentNotification } from "@/lib/notifications/notification-service";
import { sendAppointmentConfirmationSMS } from "@/lib/sms/caller-sms";
import {
  verifyWebhookSecret,
  isValidUUID,
  isValidPhoneNumber,
  isValidEmail,
  sanitizeString,
} from "@/lib/security/validation";

// Verify Vapi tool request (shared secret)
function verifyVapiRequest(request: NextRequest): { valid: boolean; error?: string } {
  const vapiSecret = process.env.VAPI_TOOL_SECRET;
  const requestSecret = request.headers.get("x-vapi-secret");

  // Only skip verification in explicit test mode
  const skipVerification = process.env.TEST_MODE === "true" && process.env.NODE_ENV !== "production";

  if (skipVerification) {
    return { valid: true };
  }

  return verifyWebhookSecret(requestSecret, vapiSecret, true);
}

/**
 * POST /api/v1/calendar/book-appointment
 *
 * Book an appointment for a caller
 * Called by Vapi as a tool during calls
 *
 * Body:
 * - organizationId: string (from Vapi call metadata)
 * - datetime: string (ISO format)
 * - name: string
 * - email?: string
 * - phone: string
 * - notes?: string
 */
export async function POST(request: NextRequest) {
  try {
    // Verify request is from Vapi
    const verification = verifyVapiRequest(request);
    if (!verification.valid) {
      console.error("Vapi request verification failed:", verification.error);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { organizationId, datetime, name, email, phone, notes } = body;

    // Validate required fields and format
    if (!organizationId) {
      return NextResponse.json(
        { error: "Organization ID is required" },
        { status: 400 }
      );
    }

    if (!isValidUUID(organizationId)) {
      return NextResponse.json(
        { error: "Invalid organization ID format" },
        { status: 400 }
      );
    }

    if (!datetime) {
      return NextResponse.json({
        success: false,
        message: "I need to know what date and time you'd like to book. What time works for you?",
      });
    }

    if (!name) {
      return NextResponse.json({
        success: false,
        message: "I need your name to complete the booking. What name should I put this under?",
      });
    }

    if (!phone) {
      return NextResponse.json({
        success: false,
        message: "I need a phone number to confirm the booking. What's the best number to reach you?",
      });
    }

    // Validate phone number format
    if (!isValidPhoneNumber(phone)) {
      return NextResponse.json({
        success: false,
        message: "I didn't catch that phone number correctly. Could you please repeat it?",
      });
    }

    // Validate email format if provided
    if (email && !isValidEmail(email)) {
      return NextResponse.json({
        success: false,
        message: "That email address doesn't look quite right. Could you please repeat it?",
      });
    }

    // Sanitize inputs
    const sanitizedName = sanitizeString(name, 100);
    const sanitizedNotes = notes ? sanitizeString(notes, 500) : undefined;

    // Get Cal.com client
    const calClient = await getCalComClient(organizationId);

    if (!calClient) {
      return NextResponse.json({
        success: false,
        message: "I'm sorry, I'm unable to book appointments right now. Can I take your information and have someone call you back to schedule?",
      });
    }

    // Get calendar integration to find the event type ID
    const supabase = createAdminClient();
    const { data: integration } = await (supabase as any)
      .from("calendar_integrations")
      .select("calendar_id, settings")
      .eq("organization_id", organizationId)
      .eq("provider", "cal_com")
      .eq("is_active", true)
      .single();

    if (!integration || !integration.calendar_id) {
      return NextResponse.json({
        success: false,
        message: "I'm sorry, the calendar system isn't fully set up yet. Can I take your information and have someone call you back?",
      });
    }

    const eventTypeId = parseInt(integration.calendar_id, 10);
    if (isNaN(eventTypeId)) {
      return NextResponse.json({
        success: false,
        message: "I'm sorry, there's a configuration issue with the calendar. Let me take your information and have someone call you back.",
      });
    }

    // Generate secure email if not provided (using UUID instead of phone-based)
    const bookingEmail = email || `booking-${crypto.randomUUID()}@noreply.phondo.ai`;

    // Create the booking
    const booking = await calClient.createBooking({
      eventTypeId,
      start: datetime,
      name: sanitizedName,
      email: bookingEmail,
      phone,
      notes: sanitizedNotes,
      metadata: {
        source: "ai_receptionist",
        organizationId,
      },
    });

    // Record the booking in our database
    const appointmentDate = new Date(datetime);

    await (supabase as any).from("appointments").insert({
      organization_id: organizationId,
      external_id: booking.uid,
      provider: "cal_com",
      attendee_name: sanitizedName,
      attendee_phone: phone,
      attendee_email: bookingEmail,
      start_time: datetime,
      end_time: booking.endTime,
      status: "confirmed",
      notes: sanitizedNotes,
      metadata: {
        calComBookingId: booking.id,
        eventTypeId,
      },
    }).catch((err: Error) => {
      // Don't fail if we can't record locally - the booking still exists in Cal.com
      console.error("Failed to record appointment locally:", err);
    });

    // Send notification to business owner
    await sendAppointmentNotification({
      organizationId,
      callerPhone: phone,
      callerName: sanitizedName,
      appointmentDate,
      appointmentTime: appointmentDate.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
    }).catch((err) => {
      console.error("Failed to send appointment notification:", err);
    });

    // SMS confirmation to the caller
    sendAppointmentConfirmationSMS(organizationId, phone, appointmentDate, integration.settings?.timezone)
      .catch((err) => console.error("Appointment confirmation SMS failed:", { organizationId, error: err }));

    // Format confirmation message for voice
    const voiceResponse = formatBookingConfirmation(booking);

    return NextResponse.json({
      success: true,
      message: voiceResponse,
      data: {
        bookingId: booking.id,
        bookingUid: booking.uid,
        startTime: booking.startTime,
        endTime: booking.endTime,
      },
    });
  } catch (error: any) {
    console.error("Book appointment error:", error);

    // Check for specific error types
    if (error.message?.includes("slot is not available")) {
      return NextResponse.json({
        success: false,
        message: "I'm sorry, that time slot is no longer available. Would you like me to check for other available times?",
      });
    }

    // Log error server-side but don't expose details to client
    console.error("Book appointment error details:", error.message);

    // Return a friendly message for voice
    return NextResponse.json({
      success: false,
      message: "I'm having trouble completing the booking right now. Let me take your information and have someone call you back to confirm the appointment. Is that okay?",
    });
  }
}
