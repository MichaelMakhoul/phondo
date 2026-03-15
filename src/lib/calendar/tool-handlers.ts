import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getCalComClient,
  formatBookingConfirmation,
  formatAvailabilityForVoice,
} from "@/lib/calendar/cal-com";
import { sendAppointmentNotification } from "@/lib/notifications/notification-service";
import { sendAppointmentConfirmationSMS } from "@/lib/sms/caller-sms";
import {
  sanitizeString,
  isValidPhoneNumber,
  isValidEmail,
} from "@/lib/security/validation";

interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

interface BusinessHours {
  open: string; // "09:00"
  close: string; // "17:00"
}

interface OrgSchedule {
  timezone: string;
  businessHours: Record<string, BusinessHours | null>;
  defaultAppointmentDuration: number;
}

// Fallback slot duration when no org-level default is configured
const DEFAULT_SLOT_DURATION_MINUTES = 30;

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Fetch org business hours, timezone, and default appointment duration.
 * Throws on DB error so callers can surface a user-friendly message
 * instead of silently skipping validation. Returns null only when
 * the org row itself is not found.
 */
async function getOrgSchedule(
  organizationId: string
): Promise<OrgSchedule | null> {
  const supabase = createAdminClient();
  const { data: org, error } = await (supabase as any)
    .from("organizations")
    .select("business_hours, timezone, default_appointment_duration")
    .eq("id", organizationId)
    .single();

  if (error) {
    console.error("Failed to fetch org schedule:", { organizationId, error });
    throw new Error(`Failed to fetch org schedule: ${error.message}`);
  }

  if (!org) return null;

  return {
    timezone: org.timezone || "America/New_York",
    businessHours: org.business_hours ?? {},
    defaultAppointmentDuration: org.default_appointment_duration ?? 30,
  };
}

/**
 * Get the business hours for a specific date, resolving the day name
 * in the org's timezone. Returns null if closed that day.
 */
function getHoursForDate(
  schedule: OrgSchedule,
  date: string
): { open: number; close: number } | null {
  // Use noon to avoid DST-transition ambiguity at midnight boundaries
  const dateObj = new Date(`${date}T12:00:00`);
  const dayName = dateObj
    .toLocaleDateString("en-US", { weekday: "long", timeZone: schedule.timezone })
    .toLowerCase();

  const hours: BusinessHours | null = schedule.businessHours[dayName];
  if (!hours || !hours.open || !hours.close) return null;

  const [openH, openM] = hours.open.split(":").map(Number);
  const [closeH, closeM] = hours.close.split(":").map(Number);
  return { open: openH * 60 + openM, close: closeH * 60 + closeM };
}

/**
 * Extract the hour and minute of a Date in a specific timezone.
 */
function getTimeInTimezone(d: Date, timezone: string): { h: number; m: number } {
  const timeStr = d.toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const [h, m] = timeStr.split(":").map(Number);
  return { h, m };
}

/**
 * Format a Date as "Monday, March 15" and "2:00 PM" in a given timezone.
 */
function formatDateTimeForVoice(
  d: Date,
  timezone: string
): { dateStr: string; timeStr: string } {
  return {
    dateStr: d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: timezone,
    }),
    timeStr: d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    }),
  };
}

function formatTime(h: number, m: number): string {
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  const mins = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
  return `${hour12}${mins} ${period}`;
}

// ─── Pure slot helpers (exported for testing) ────────────────────────────────

/**
 * Generate slot start-time strings for a given date and business-hours window.
 * Pure function with no DB calls.
 */
export function generateSlots(
  date: string,
  hoursOpen: number,
  hoursClose: number,
  durationMinutes: number
): string[] {
  const slots: string[] = [];
  for (let m = hoursOpen; m + durationMinutes <= hoursClose; m += durationMinutes) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    slots.push(`${date}T${hh}:${mm}:00`);
  }
  return slots;
}

/**
 * Check whether a requested appointment time fits within business hours.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateBookingTime(
  reqStartMinutes: number,
  durationMinutes: number,
  hoursOpen: number,
  hoursClose: number
): string | null {
  const reqEndMinutes = reqStartMinutes + durationMinutes;
  if (reqStartMinutes < hoursOpen || reqEndMinutes > hoursClose) {
    return "outside_business_hours";
  }
  return null;
}

// ─── Built-in availability ──────────────────────────────────────────────────

/**
 * Compute available time slots for a given date using the org's business
 * hours minus any existing (non-cancelled) appointments. Slot duration
 * defaults to 30 minutes but can be overridden via durationMinutes.
 *
 * @returns ISO-like datetime strings in the org's local time (no TZ offset),
 *          e.g., "2025-03-15T09:00:00". Throws on DB errors.
 */
async function getBuiltInAvailability(
  organizationId: string,
  date: string,
  schedule?: OrgSchedule | null,
  durationMinutes: number = DEFAULT_SLOT_DURATION_MINUTES
): Promise<string[]> {
  const resolvedSchedule = schedule ?? (await getOrgSchedule(organizationId));
  if (!resolvedSchedule) return [];

  const hours = getHoursForDate(resolvedSchedule, date);
  if (!hours) return []; // Closed

  const slots = generateSlots(date, hours.open, hours.close, durationMinutes);

  if (slots.length === 0) return [];

  // Get existing appointments for this date
  const supabase = createAdminClient();
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59`;

  const { data: existing, error: apptError } = await (supabase as any)
    .from("appointments")
    .select("start_time, duration_minutes, end_time")
    .eq("organization_id", organizationId)
    .gte("start_time", dayStart)
    .lte("start_time", dayEnd)
    .in("status", ["confirmed", "pending"]);

  if (apptError) {
    console.error("Failed to fetch existing appointments:", { organizationId, date, error: apptError });
    throw new Error(`Failed to fetch appointments: ${apptError.message}`);
  }

  const appointments = (existing || []) as {
    start_time: string;
    duration_minutes: number | null;
    end_time: string | null;
  }[];

  // Filter out slots that overlap with existing appointments.
  // Compare in org-local minutes-since-midnight to avoid server-TZ vs org-TZ mismatch.
  const { timezone } = resolvedSchedule;

  return slots.filter((slotIso) => {
    const [, timeStr] = slotIso.split("T");
    const [slotH, slotM] = timeStr.split(":").map(Number);
    const slotStartMin = slotH * 60 + slotM;
    const slotEndMin = slotStartMin + durationMinutes;

    return !appointments.some((appt) => {
      const { h: aH, m: aM } = getTimeInTimezone(new Date(appt.start_time), timezone);
      const apptStartMin = aH * 60 + aM;

      let apptEndMin: number;
      if (appt.end_time) {
        const { h: eH, m: eM } = getTimeInTimezone(new Date(appt.end_time), timezone);
        apptEndMin = eH * 60 + eM;
      } else {
        apptEndMin = apptStartMin + (appt.duration_minutes || DEFAULT_SLOT_DURATION_MINUTES);
      }

      return slotStartMin < apptEndMin && slotEndMin > apptStartMin;
    });
  });
}

/**
 * Format built-in availability slots for a voice response.
 */
function formatBuiltInAvailabilityForVoice(
  date: string,
  slots: string[],
  timezone: string
): string {
  if (slots.length === 0) {
    return "I'm sorry, there are no available appointments on that date. Would you like to check a different day?";
  }

  const dateObj = new Date(`${date}T12:00:00`);
  const dateStr = dateObj.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });

  const slotsToShow = slots.slice(0, 5);
  const timeStrings = slotsToShow.map((iso) => {
    const t = new Date(iso);
    return t.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    });
  });

  const more = slots.length > 5 ? ` and ${slots.length - 5} more` : "";
  return `On ${dateStr}, I have openings at ${timeStrings.join(", ")}${more}. Which time works best for you?`;
}

// ─── Timezone helpers ────────────────────────────────────────────────────────

/**
 * If the datetime string lacks a timezone offset (Z or +HH:MM), compute the
 * UTC offset for the given IANA timezone and append it. This prevents naive
 * datetimes from being interpreted as UTC on the server.
 *
 * e.g., "2026-02-18T10:00:00" + "Australia/Sydney" → "2026-02-18T10:00:00+11:00"
 */
export function ensureTimezoneOffset(datetime: string, timezone: string): string {
  // Already has offset — leave it alone
  if (/[Zz]$/.test(datetime) || /[+-]\d{2}:\d{2}$/.test(datetime)) {
    return datetime;
  }

  // Quick sanity check: if the datetime string is not parseable at all, bail out.
  // NOTE: `new Date(datetime)` without "Z" is implementation-dependent (may be
  // treated as local or UTC). We only use it for the isNaN guard — the actual
  // offset calculation below uses `new Date(\`${datetime}Z\`)` which is always UTC.
  const naiveDate = new Date(datetime);
  if (isNaN(naiveDate.getTime())) return datetime; // unparseable — let caller handle

  // Use Intl to get the timezone offset parts
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Format the same instant in both UTC and target TZ, then compute difference
  const utcFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Create a reference date at the naive datetime value to determine offset
  // We use a known UTC instant and compare its local representation
  const refDate = new Date(`${datetime}Z`); // treat as UTC temporarily
  const tzParts = formatter.formatToParts(refDate);
  const utcParts = utcFormatter.formatToParts(refDate);

  const getPart = (parts: Intl.DateTimeFormatPart[], type: string) =>
    parts.find((p) => p.type === type)?.value || "0";

  const tzHour = parseInt(getPart(tzParts, "hour"), 10);
  const tzMin = parseInt(getPart(tzParts, "minute"), 10);
  const tzDay = parseInt(getPart(tzParts, "day"), 10);
  const utcHour = parseInt(getPart(utcParts, "hour"), 10);
  const utcMin = parseInt(getPart(utcParts, "minute"), 10);
  const utcDay = parseInt(getPart(utcParts, "day"), 10);

  // Compare full date representations to handle month/year boundaries correctly
  const tzMonth = parseInt(getPart(tzParts, "month"), 10);
  const utcMonth = parseInt(getPart(utcParts, "month"), 10);
  const tzYear = parseInt(getPart(tzParts, "year"), 10);
  const utcYear = parseInt(getPart(utcParts, "year"), 10);

  // Both Date constructors below use the server's local timezone, but since we
  // only care about the *difference*, the server's TZ offset cancels out.
  const tzTotal = new Date(tzYear, tzMonth - 1, tzDay, tzHour, tzMin).getTime();
  const utcTotal = new Date(utcYear, utcMonth - 1, utcDay, utcHour, utcMin).getTime();
  const offsetMinutes = (tzTotal - utcTotal) / 60_000;

  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offH = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const offM = String(absOffset % 60).padStart(2, "0");

  return `${datetime}${sign}${offH}:${offM}`;
}

// ─── Get current datetime handler ───────────────────────────────────────────

export async function handleGetCurrentDatetime(
  organizationId: string
): Promise<ToolResult> {
  let timezone = "America/New_York";
  try {
    const schedule = await getOrgSchedule(organizationId);
    if (schedule?.timezone) timezone = schedule.timezone;
  } catch (error) {
    console.error("Failed to fetch org timezone for get_current_datetime, falling back to America/New_York:", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  });

  // ISO date for tool calls (YYYY-MM-DD)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  return {
    success: true,
    message: `Current date and time: ${dateStr}, ${timeStr} (${timezone}). Today's date in YYYY-MM-DD format: ${parts}.`,
  };
}

// ─── Public handlers ────────────────────────────────────────────────────────

export async function handleBookAppointment(
  organizationId: string,
  args: {
    datetime?: string;
    name?: string;
    phone?: string;
    email?: string;
    notes?: string;
  }
): Promise<ToolResult> {
  const { datetime, name, phone, email, notes } = args;

  if (!datetime) {
    return {
      success: false,
      message:
        "I need to know what date and time you'd like to book. What time works for you?",
    };
  }

  if (!name) {
    return {
      success: false,
      message:
        "I need your name to complete the booking. What name should I put this under?",
    };
  }

  if (!phone) {
    return {
      success: false,
      message:
        "I need a phone number to confirm the booking. What's the best number to reach you?",
    };
  }

  if (!isValidPhoneNumber(phone)) {
    return {
      success: false,
      message:
        "I didn't catch that phone number correctly. Could you please repeat it?",
    };
  }

  if (email && !isValidEmail(email)) {
    return {
      success: false,
      message:
        "That email address doesn't look quite right. Could you please repeat it?",
    };
  }

  const sanitizedName = sanitizeString(name, 100);
  const sanitizedNotes = notes ? sanitizeString(notes, 500) : undefined;

  // ── Try Cal.com first ─────────────────────────────────────────────────
  const calClient = await getCalComClient(organizationId);

  if (calClient) {
    return bookViaCal(
      calClient,
      organizationId,
      datetime,
      sanitizedName,
      phone,
      email,
      sanitizedNotes
    );
  }

  // ── Built-in booking (no Cal.com configured) ──────────────────────────
  console.log("Using built-in booking (no Cal.com client):", { organizationId });
  return bookInternal(
    organizationId,
    datetime,
    sanitizedName,
    phone,
    email,
    sanitizedNotes
  );
}

export async function handleCheckAvailability(
  organizationId: string,
  args: { date?: string }
): Promise<ToolResult> {
  const { date } = args;

  if (!date) {
    return {
      success: false,
      message: "What date would you like me to check availability for?",
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      success: false,
      message: "I need the date in a standard format. Could you say the date again?",
    };
  }

  // ── Try Cal.com first ─────────────────────────────────────────────────
  const calClient = await getCalComClient(organizationId);

  if (calClient) {
    return checkAvailabilityViaCal(calClient, organizationId, date);
  }

  // ── Built-in availability (no Cal.com configured) ─────────────────────
  console.log("Using built-in availability (no Cal.com client):", { organizationId });
  try {
    const schedule = await getOrgSchedule(organizationId);
    const timezone = schedule?.timezone || "America/New_York";
    const durationMinutes = schedule?.defaultAppointmentDuration ?? DEFAULT_SLOT_DURATION_MINUTES;
    const slots = await getBuiltInAvailability(organizationId, date, schedule, durationMinutes);
    return {
      success: true,
      message: formatBuiltInAvailabilityForVoice(date, slots, timezone),
    };
  } catch (error: any) {
    console.error("Built-in availability error:", { organizationId, date, message: error.message, stack: error.stack });
    return {
      success: false,
      message:
        "I'm having trouble checking the calendar right now. Would you like me to take your information instead?",
    };
  }
}

export async function handleCancelAppointment(
  organizationId: string,
  args: { phone?: string; reason?: string }
): Promise<ToolResult> {
  const { phone, reason } = args;

  if (!phone) {
    return {
      success: false,
      message:
        "I need your phone number to look up your appointment. What's the phone number you booked with?",
    };
  }

  const supabase = createAdminClient();

  const { data: appointments, error: queryError } = await (supabase as any)
    .from("appointments")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("attendee_phone", phone)
    .in("status", ["confirmed", "pending"])
    .order("start_time", { ascending: true })
    .limit(1);

  if (queryError) {
    console.error("Failed to query appointments for cancellation:", { organizationId, phone, error: queryError });
    return {
      success: false,
      message:
        "I'm having trouble looking up your appointment right now. Would you like me to have someone call you back?",
    };
  }

  const appointment = appointments?.[0] ?? null;

  if (!appointment) {
    return {
      success: false,
      message:
        "I wasn't able to find an upcoming appointment with that phone number. Could you double-check the number you booked with?",
    };
  }

  try {
    if (appointment.external_id) {
      const calClient = await getCalComClient(organizationId);
      if (calClient && appointment.metadata?.calComBookingId) {
        await calClient.cancelBooking(
          appointment.metadata.calComBookingId,
          reason || "Cancelled by caller"
        );
      } else {
        console.error("Cannot cancel Cal.com booking: missing client or booking ID", {
          organizationId,
          appointmentId: appointment.id,
          externalId: appointment.external_id,
          hasCalClient: !!calClient,
          hasBookingId: !!appointment.metadata?.calComBookingId,
        });
        return {
          success: false,
          message:
            "I'm having trouble cancelling the external calendar booking. Let me have someone follow up with you to make sure this is fully cancelled.",
        };
      }
    }

    const { error: cancelDbError } = await (supabase as any)
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", appointment.id);

    if (cancelDbError) {
      console.error("Failed to update appointment status locally:", cancelDbError);
      return {
        success: false,
        message:
          "I'm having trouble cancelling the appointment right now. Would you like me to have someone call you back to help with this?",
      };
    }

    const schedule = await getOrgSchedule(organizationId).catch(() => null);
    const timezone = schedule?.timezone || "America/New_York";
    const { dateStr, timeStr } = formatDateTimeForVoice(
      new Date(appointment.start_time),
      timezone
    );

    return {
      success: true,
      message: `Your appointment on ${dateStr} at ${timeStr} has been cancelled. Would you like to reschedule or is there anything else I can help with?`,
    };
  } catch (error: any) {
    console.error("Cancel appointment error:", { organizationId, message: error.message, stack: error.stack });
    return {
      success: false,
      message:
        "I'm having trouble cancelling the appointment right now. Would you like me to have someone call you back to help with this?",
    };
  }
}

// ─── Cal.com helpers ────────────────────────────────────────────────────────

async function bookViaCal(
  calClient: NonNullable<Awaited<ReturnType<typeof getCalComClient>>>,
  organizationId: string,
  datetime: string,
  sanitizedName: string,
  phone: string,
  email: string | undefined,
  sanitizedNotes: string | undefined
): Promise<ToolResult> {
  const supabase = createAdminClient();

  const { data: integration, error: integrationError } = await (supabase as any)
    .from("calendar_integrations")
    .select("calendar_id, settings")
    .eq("organization_id", organizationId)
    .eq("provider", "cal_com")
    .eq("is_active", true)
    .single();

  if (integrationError && integrationError.code !== "PGRST116") {
    console.error("Failed to fetch calendar integration:", { organizationId, error: integrationError });
    return {
      success: false,
      message:
        "I'm having trouble accessing the calendar system right now. Would you like me to take your information instead?",
    };
  }

  if (!integration || !integration.calendar_id) {
    return {
      success: false,
      message:
        "I'm sorry, the calendar system isn't fully set up yet. Can I take your information and have someone call you back?",
    };
  }

  const eventTypeId = parseInt(integration.calendar_id, 10);
  if (isNaN(eventTypeId)) {
    return {
      success: false,
      message:
        "I'm sorry, there's a configuration issue with the calendar. Let me take your information and have someone call you back.",
    };
  }

  try {
    // Fetch org timezone to ensure naive datetime gets proper offset
    const calSchedule = await getOrgSchedule(organizationId).catch(() => null);
    const timezone = calSchedule?.timezone || "America/New_York";
    const tzAwareDatetime = ensureTimezoneOffset(datetime, timezone);

    const bookingEmail =
      email || `booking-${crypto.randomUUID()}@noreply.phondo.ai`;

    const booking = await calClient.createBooking({
      eventTypeId,
      start: tzAwareDatetime,
      name: sanitizedName,
      email: bookingEmail,
      phone,
      notes: sanitizedNotes,
      metadata: {
        source: "ai_receptionist",
        organizationId,
      },
    });

    // Record in our database — rollback Cal.com booking if this fails
    const { error: dbError } = await (supabase as any)
      .from("appointments")
      .insert({
        organization_id: organizationId,
        external_id: booking.uid,
        provider: "cal_com",
        attendee_name: sanitizedName,
        attendee_phone: phone,
        attendee_email: bookingEmail,
        start_time: tzAwareDatetime,
        end_time: booking.endTime,
        status: "confirmed",
        notes: sanitizedNotes,
        metadata: {
          calComBookingId: booking.id,
          eventTypeId,
        },
      });

    if (dbError) {
      console.error("Failed to record appointment locally, rolling back Cal.com booking:", dbError);
      try {
        await calClient.cancelBooking(booking.id, "Internal system error - rollback");
      } catch (rollbackErr) {
        console.error("CRITICAL: Failed to rollback Cal.com booking after DB failure:", rollbackErr);
      }
      return {
        success: false,
        message:
          "I'm having trouble completing the booking right now. Let me take your information and have someone call you back to confirm the appointment.",
      };
    }

    // Send notification
    const appointmentDate = new Date(tzAwareDatetime);
    sendNotification(organizationId, phone, sanitizedName, appointmentDate, timezone);

    return {
      success: true,
      message: formatBookingConfirmation(booking, timezone),
      data: {
        bookingId: booking.id,
        bookingUid: booking.uid,
        startTime: booking.startTime,
        endTime: booking.endTime,
      },
    };
  } catch (error: any) {
    if (error.message?.includes("slot is not available")) {
      return {
        success: false,
        message:
          "I'm sorry, that time slot is no longer available. Would you like me to check for other available times?",
      };
    }

    console.error("Book appointment error:", { organizationId, message: error.message, stack: error.stack });
    return {
      success: false,
      message:
        "I'm having trouble completing the booking right now. Let me take your information and have someone call you back to confirm the appointment.",
    };
  }
}

async function checkAvailabilityViaCal(
  calClient: NonNullable<Awaited<ReturnType<typeof getCalComClient>>>,
  organizationId: string,
  date: string
): Promise<ToolResult> {
  const supabase = createAdminClient();

  const { data: integration, error: integrationError } = await (supabase as any)
    .from("calendar_integrations")
    .select("calendar_id")
    .eq("organization_id", organizationId)
    .eq("provider", "cal_com")
    .eq("is_active", true)
    .single();

  if (integrationError && integrationError.code !== "PGRST116") {
    console.error("Failed to fetch calendar integration:", { organizationId, error: integrationError });
    return {
      success: false,
      message: "I'm having trouble accessing the calendar right now. Would you like me to take your information instead?",
    };
  }

  if (!integration || !integration.calendar_id) {
    return {
      success: false,
      message: "The calendar system isn't fully set up yet.",
    };
  }

  const eventTypeId = parseInt(integration.calendar_id, 10);
  if (isNaN(eventTypeId)) {
    return {
      success: false,
      message: "There's a configuration issue with the calendar.",
    };
  }

  try {
    // Fetch org timezone so we can pass timezone-aware boundaries and format output
    const schedule = await getOrgSchedule(organizationId).catch(() => null);
    const timezone = schedule?.timezone || "America/New_York";

    const startTime = ensureTimezoneOffset(`${date}T00:00:00`, timezone);
    const endTime = ensureTimezoneOffset(`${date}T23:59:59`, timezone);

    const availability = await calClient.getAvailability({
      eventTypeId,
      startTime,
      endTime,
    });

    return { success: true, message: formatAvailabilityForVoice(availability, timezone) };
  } catch (error: any) {
    console.error("Check availability error:", { organizationId, date, message: error.message, stack: error.stack });
    return {
      success: false,
      message:
        "I'm having trouble checking the calendar right now. Would you like me to take your information instead?",
    };
  }
}

// ─── Built-in booking helper ────────────────────────────────────────────────

async function bookInternal(
  organizationId: string,
  datetime: string,
  sanitizedName: string,
  phone: string,
  email: string | undefined,
  sanitizedNotes: string | undefined
): Promise<ToolResult> {
  const supabase = createAdminClient();

  // 1. Validate against business hours (fetch schedule first so we can apply TZ offset)
  let schedule: OrgSchedule | null;
  try {
    schedule = await getOrgSchedule(organizationId);
  } catch (error) {
    console.error("Failed to get org schedule for booking:", { organizationId, error });
    return {
      success: false,
      message:
        "I'm having trouble accessing our schedule right now. Let me take your information and have someone call you back.",
    };
  }

  const internalTimezone = schedule?.timezone || "America/New_York";
  const durationMinutes = schedule?.defaultAppointmentDuration ?? DEFAULT_SLOT_DURATION_MINUTES;
  // Ensure naive datetimes are interpreted in the org's timezone, not UTC
  const tzAwareDatetime = ensureTimezoneOffset(datetime, internalTimezone);

  const startDate = new Date(tzAwareDatetime);
  if (isNaN(startDate.getTime())) {
    return {
      success: false,
      message:
        "I didn't understand that date and time. Could you say it again?",
    };
  }

  const endDate = new Date(startDate.getTime() + durationMinutes * 60_000);

  if (schedule) {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: schedule.timezone,
    }).formatToParts(startDate);
    const yr = parts.find((p) => p.type === "year")!.value;
    const mo = parts.find((p) => p.type === "month")!.value;
    const da = parts.find((p) => p.type === "day")!.value;
    const localDate = `${yr}-${mo}-${da}`;

    const hours = getHoursForDate(schedule, localDate);

    if (!hours) {
      return {
        success: false,
        message:
          "I'm sorry, we're closed on that day. Would you like to pick a different date?",
      };
    }

    // Extract hour:minute in the org's timezone, not the server's
    const { h: reqH, m: reqM } = getTimeInTimezone(startDate, schedule.timezone);
    const reqMinutes = reqH * 60 + reqM;

    if (validateBookingTime(reqMinutes, durationMinutes, hours.open, hours.close)) {
      const openStr = formatTime(Math.floor(hours.open / 60), hours.open % 60);
      const closeStr = formatTime(Math.floor(hours.close / 60), hours.close % 60);
      return {
        success: false,
        message: `That time is outside our business hours. We're open from ${openStr} to ${closeStr}. Would you like to pick a time within those hours?`,
      };
    }
  }

  // 2. Insert appointment — the DB exclusion constraint (no_overlapping_appointments)
  //    prevents double-bookings atomically, so we rely on INSERT failure for conflicts.
  const bookingEmail =
    email || `booking-${crypto.randomUUID()}@noreply.phondo.ai`;

  const { data: appointment, error: dbError } = await (supabase as any)
    .from("appointments")
    .insert({
      organization_id: organizationId,
      provider: "internal",
      attendee_name: sanitizedName,
      attendee_phone: phone,
      attendee_email: bookingEmail,
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      duration_minutes: durationMinutes,
      status: "confirmed",
      notes: sanitizedNotes,
      metadata: { source: "ai_receptionist" },
    })
    .select("id")
    .single();

  if (dbError) {
    // Exclusion constraint violation = overlapping appointment
    if (dbError.code === "23P01") {
      return {
        success: false,
        message:
          "I'm sorry, that time slot is no longer available. Would you like me to check for other available times?",
      };
    }
    console.error("Failed to insert internal appointment:", dbError);
    return {
      success: false,
      message:
        "I'm having trouble completing the booking right now. Let me take your information and have someone call you back to confirm the appointment.",
    };
  }

  // 3. Send notification
  const timezone = schedule?.timezone || "America/New_York";
  sendNotification(organizationId, phone, sanitizedName, startDate, timezone);
  const { dateStr, timeStr } = formatDateTimeForVoice(startDate, timezone);

  return {
    success: true,
    message: `I've booked your appointment for ${dateStr} at ${timeStr}. Is there anything else I can help you with?`,
    data: {
      appointmentId: appointment.id,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
    },
  };
}

// ─── Notification helper ────────────────────────────────────────────────────

function sendNotification(
  organizationId: string,
  phone: string,
  name: string,
  appointmentDate: Date,
  timezone?: string
) {
  sendAppointmentNotification({
    organizationId,
    callerPhone: phone,
    callerName: name,
    appointmentDate,
    appointmentTime: appointmentDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...(timezone && { timeZone: timezone }),
    }),
  }).catch((err) => {
    console.error("Failed to send appointment notification:", err);
  });

  // SMS confirmation to the caller
  sendAppointmentConfirmationSMS(organizationId, phone, appointmentDate, timezone)
    .catch((err) => console.error("Appointment confirmation SMS failed:", { organizationId, error: err }));
}
