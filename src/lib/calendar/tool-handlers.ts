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
import {
  getActiveServiceTypes,
  getServiceType,
} from "@/lib/service-types";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";

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

/** Generate a 6-digit confirmation code (crypto-secure, digits only) */
function generateConfirmationCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Get blocked time ranges for an org on a given date.
 * Returns array of { start_time, end_time } in UTC.
 */
async function getBlockedTimes(
  organizationId: string,
  dateStartUtc: string,
  dateEndUtc: string
): Promise<{ start_time: string; end_time: string }[]> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("blocked_times")
    .select("start_time, end_time")
    .eq("organization_id", organizationId)
    .is("practitioner_id", null)
    .lt("start_time", dateEndUtc)   // block starts before day ends
    .gt("end_time", dateStartUtc);  // block ends after day starts

  if (error) {
    console.error("Failed to fetch blocked times:", { organizationId, error });
    throw new Error(`Blocked times query failed: ${error.message}`);
  }
  return data || [];
}

/** Check if a specific datetime falls within any blocked range */
function isTimeBlocked(
  datetime: Date,
  durationMinutes: number,
  blockedRanges: { start_time: string; end_time: string }[]
): boolean {
  const slotStart = datetime.getTime();
  const slotEnd = slotStart + durationMinutes * 60_000;
  return blockedRanges.some((block) => {
    const blockStart = new Date(block.start_time).getTime();
    const blockEnd = new Date(block.end_time).getTime();
    // Overlap: slot starts before block ends AND slot ends after block starts
    return slotStart < blockEnd && slotEnd > blockStart;
  });
}

/** Escape LIKE metacharacters to prevent wildcard injection in ilike queries */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

import { isValidUUID } from "@/lib/security/validation";

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

// ─── Phone normalization helpers ─────────────────────────────────────────────

/**
 * Generate all plausible phone number format variants for a given input,
 * so we can match regardless of how the number was stored.
 *
 * For example, +61414141883 yields:
 *   ["+61414141883", "61414141883", "0414141883"]
 * And 0414141883 yields:
 *   ["0414141883", "414141883"]
 * (We can't infer the country code from a local number alone, so we don't
 *  synthesize +61 from 04... — but the reverse direction works.)
 */
function phoneVariants(phone: string): string[] {
  const variants = new Set<string>();

  // Original input (trimmed)
  const trimmed = phone.trim();
  variants.add(trimmed);

  // Digits-only version
  const digits = trimmed.replace(/\D/g, "");
  if (digits) variants.add(digits);

  // With leading "+" if it had one
  if (trimmed.startsWith("+")) {
    variants.add(`+${digits}`);
  }

  // If E.164-ish (+CC...), also produce the local variant
  // Australia: +61 4xx → 04xx  (replace country code 61 with leading 0)
  if (digits.startsWith("61") && digits.length === 11) {
    variants.add(`0${digits.slice(2)}`);       // 0414141883
    variants.add(digits.slice(2));             // 414141883
    variants.add(`+61${digits.slice(2)}`);     // +61414141883
  }
  // US/CA: +1 xxx → xxx  (10-digit national)
  if (digits.startsWith("1") && digits.length === 11) {
    variants.add(digits.slice(1));             // 4145551234
    variants.add(`+1${digits.slice(1)}`);      // +14145551234
  }

  // If local AU format (starts with 0, 10 digits), produce E.164
  if (digits.startsWith("0") && digits.length === 10) {
    const national = digits.slice(1);
    variants.add(national);                    // 414141883
    variants.add(`61${national}`);             // 61414141883
    variants.add(`+61${national}`);            // +61414141883
  }

  // If local US format (10 digits, no leading 0 or 1)
  if (digits.length === 10 && !digits.startsWith("0") && !digits.startsWith("1")) {
    variants.add(`1${digits}`);                // 14145551234
    variants.add(`+1${digits}`);               // +14145551234
  }

  return Array.from(variants);
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

// ─── Practitioner helpers ────────────────────────────────────────────────────

interface PractitionerInfo {
  id: string;
  name: string;
}

/**
 * Get active practitioners assigned to a service type.
 * Returns empty array if no practitioners are configured for this service.
 */
async function getPractitionersForService(
  organizationId: string,
  serviceTypeId: string
): Promise<PractitionerInfo[]> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("practitioners")
    .select("id, name, practitioner_services!inner(service_type_id)")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .eq("practitioner_services.service_type_id", serviceTypeId);

  if (error) {
    console.error("Failed to fetch practitioners for service:", { serviceTypeId, organizationId, error });
    throw new Error(`Failed to fetch practitioners for service: ${error.message}`);
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    name: row.name,
  }));
}

/**
 * Pick the practitioner with the fewest upcoming appointments (round-robin).
 * Falls back to first practitioner if counts are equal.
 */
async function pickPractitionerRoundRobin(
  organizationId: string,
  practitionerIds: string[],
  slotStart?: Date,
  slotEnd?: Date
): Promise<string | null> {
  if (practitionerIds.length === 0) return null;

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // ── Step 1: Filter out practitioners already booked at the requested time ──
  let availableIds = [...practitionerIds];

  if (slotStart && slotEnd) {
    const { data: conflicting, error: conflictErr } = await (supabase as any)
      .from("appointments")
      .select("practitioner_id, start_time, end_time, duration_minutes")
      .eq("organization_id", organizationId)
      .in("practitioner_id", practitionerIds)
      .in("status", ["confirmed", "pending"])
      .lt("start_time", slotEnd.toISOString())
      .gt("end_time", slotStart.toISOString());

    if (conflictErr) {
      console.error("Failed to check practitioner slot conflicts:", { organizationId, practitionerIds, error: conflictErr });
      // Fall through — better to attempt the booking and let the DB constraint catch it
    } else if (conflicting) {
      const busyIds = new Set(
        (conflicting as { practitioner_id: string }[]).map((a) => a.practitioner_id)
      );
      availableIds = practitionerIds.filter((id) => !busyIds.has(id));
    }
  }

  if (availableIds.length === 0) return null;
  if (availableIds.length === 1) return availableIds[0];

  // ── Step 2: Round-robin among available practitioners (fewest upcoming) ──
  const counts: Record<string, number> = {};
  for (const pId of availableIds) {
    counts[pId] = 0;
  }

  const { data: upcoming, error } = await (supabase as any)
    .from("appointments")
    .select("practitioner_id")
    .eq("organization_id", organizationId)
    .in("practitioner_id", availableIds)
    .gte("start_time", now)
    .in("status", ["confirmed", "pending"]);

  if (error) {
    console.error("Failed to count upcoming appointments for round-robin:", { organizationId, practitionerIds: availableIds, error });
  }

  if (!error && upcoming) {
    for (const appt of upcoming) {
      if (appt.practitioner_id && counts[appt.practitioner_id] !== undefined) {
        counts[appt.practitioner_id]++;
      }
    }
  }

  // Return the practitioner with fewest upcoming appointments
  let bestId = availableIds[0];
  let bestCount = counts[bestId] ?? 0;
  for (const pId of availableIds) {
    if ((counts[pId] ?? 0) < bestCount) {
      bestId = pId;
      bestCount = counts[pId] ?? 0;
    }
  }

  return bestId;
}

// ─── Built-in availability ──────────────────────────────────────────────────

/**
 * Compute available time slots for a given date using the org's business
 * hours minus any existing (non-cancelled) appointments. Slot duration
 * defaults to 30 minutes but can be overridden via durationMinutes.
 *
 * When practitioners are assigned to the service, a slot is only removed
 * if ALL practitioners for that service are booked at that time.
 *
 * @returns ISO-like datetime strings in the org's local time (no TZ offset),
 *          e.g., "2025-03-15T09:00:00". Throws on DB errors.
 */
async function getBuiltInAvailability(
  organizationId: string,
  date: string,
  schedule?: OrgSchedule | null,
  durationMinutes: number = DEFAULT_SLOT_DURATION_MINUTES,
  serviceTypeId?: string
): Promise<string[]> {
  const resolvedSchedule = schedule ?? (await getOrgSchedule(organizationId));
  if (!resolvedSchedule) return [];

  const hours = getHoursForDate(resolvedSchedule, date);
  if (!hours) return []; // Closed

  let slots = generateSlots(date, hours.open, hours.close, durationMinutes);

  // Filter out past time slots when checking today's availability
  const orgTz = resolvedSchedule.timezone;
  const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: orgTz }));
  const todayStr = `${nowInTz.getFullYear()}-${String(nowInTz.getMonth() + 1).padStart(2, "0")}-${String(nowInTz.getDate()).padStart(2, "0")}`;
  if (date === todayStr) {
    const nowMinutes = nowInTz.getHours() * 60 + nowInTz.getMinutes();
    slots = slots.filter((slot) => {
      const [h, m] = slot.split("T")[1].split(":").map(Number);
      return h * 60 + m > nowMinutes;
    });
  }

  if (slots.length === 0) return [];

  // Check if this service has assigned practitioners
  let practitioners: PractitionerInfo[] = [];
  if (serviceTypeId) {
    practitioners = await getPractitionersForService(organizationId, serviceTypeId);
  }

  // Get existing appointments + blocked times for this date.
  // Appointments are stored in UTC — convert date boundaries to UTC using org timezone.
  const supabase = createAdminClient();
  const { timezone } = resolvedSchedule;
  const dayStartLocal = `${date}T00:00:00`;
  const dayEndLocal = `${date}T23:59:59`;
  const dayStartUtc = ensureTimezoneOffset(dayStartLocal, timezone);
  const dayEndUtc = ensureTimezoneOffset(dayEndLocal, timezone);

  // Fetch blocked times for this date — filter slots that overlap.
  // Use ISO strings (Z suffix) for consistent Supabase comparison.
  const dayStartISO = new Date(dayStartUtc).toISOString();
  const dayEndISO = new Date(dayEndUtc).toISOString();
  const blockedRanges = await getBlockedTimes(organizationId, dayStartISO, dayEndISO);
  if (blockedRanges.length > 0) {
    slots = slots.filter((slot) => {
      const slotDate = new Date(ensureTimezoneOffset(slot, timezone));
      return !isTimeBlocked(slotDate, durationMinutes, blockedRanges);
    });
    if (slots.length === 0) return [];
  }

  // If practitioners are configured, fetch per-practitioner appointments
  if (practitioners.length > 0) {
    const practitionerIds = practitioners.map((p) => p.id);

    const { data: existing, error: apptError } = await (supabase as any)
      .from("appointments")
      .select("start_time, duration_minutes, end_time, practitioner_id")
      .eq("organization_id", organizationId)
      .gte("start_time", dayStartUtc)
      .lte("start_time", dayEndUtc)
      .in("status", ["confirmed", "pending"])
      .in("practitioner_id", practitionerIds);

    if (apptError) {
      console.error("Failed to fetch practitioner appointments:", { organizationId, date, error: apptError });
      throw new Error(`Failed to fetch appointments: ${apptError.message}`);
    }

    const appointments = (existing || []) as {
      start_time: string;
      duration_minutes: number | null;
      end_time: string | null;
      practitioner_id: string | null;
    }[];

    // Fetch practitioner-specific blocked times for this date
    const { data: practBlocks } = await (supabase as any)
      .from("blocked_times")
      .select("practitioner_id, start_time, end_time")
      .eq("organization_id", organizationId)
      .not("practitioner_id", "is", null)
      .in("practitioner_id", practitionerIds)
      .lt("start_time", dayEndISO)
      .gt("end_time", dayStartISO);

    const practitionerBlocks = (practBlocks || []) as {
      practitioner_id: string;
      start_time: string;
      end_time: string;
    }[];

    // A slot is available if at least one practitioner is free at that time
    return slots.filter((slotIso) => {
      const [, timeStr] = slotIso.split("T");
      const [slotH, slotM] = timeStr.split(":").map(Number);
      const slotStartMin = slotH * 60 + slotM;
      const slotEndMin = slotStartMin + durationMinutes;

      // For each practitioner, check if they have a conflicting appointment
      const busyPractitioners = new Set<string>();
      for (const appt of appointments) {
        const { h: aH, m: aM } = getTimeInTimezone(new Date(appt.start_time), timezone);
        const apptStartMin = aH * 60 + aM;
        let apptEndMin: number;
        if (appt.end_time) {
          const { h: eH, m: eM } = getTimeInTimezone(new Date(appt.end_time), timezone);
          apptEndMin = eH * 60 + eM;
        } else {
          apptEndMin = apptStartMin + (appt.duration_minutes || DEFAULT_SLOT_DURATION_MINUTES);
        }

        if (slotStartMin < apptEndMin && slotEndMin > apptStartMin && appt.practitioner_id) {
          busyPractitioners.add(appt.practitioner_id);
        }
      }

      // Also mark practitioners busy if they have a blocked time overlapping this slot
      for (const block of practitionerBlocks) {
        const bStart = getTimeInTimezone(new Date(block.start_time), timezone);
        const bEnd = getTimeInTimezone(new Date(block.end_time), timezone);
        const bStartMin = bStart.h * 60 + bStart.m;
        const bEndMin = bEnd.h * 60 + bEnd.m;

        if (slotStartMin < bEndMin && slotEndMin > bStartMin && block.practitioner_id) {
          busyPractitioners.add(block.practitioner_id);
        }
      }

      // Slot available if not all practitioners are busy
      return busyPractitioners.size < practitionerIds.length;
    });
  }

  // No practitioners — original behavior: check all org appointments
  const { data: existing, error: apptError } = await (supabase as any)
    .from("appointments")
    .select("start_time, duration_minutes, end_time")
    .eq("organization_id", organizationId)
    .gte("start_time", dayStartUtc)
    .lte("start_time", dayEndUtc)
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

  // Parse slot times into hours
  const parsedSlots = slots.map((iso) => {
    const [h, m] = iso.split("T")[1].split(":").map(Number);
    return { h, m };
  });

  // Group into morning (before 12) and afternoon (12+)
  const morning = parsedSlots.filter((s) => s.h < 12);
  const afternoon = parsedSlots.filter((s) => s.h >= 12);

  const parts: string[] = [];
  if (morning.length > 0) {
    const first = formatTime(morning[0].h, morning[0].m);
    const last = formatTime(morning[morning.length - 1].h, morning[morning.length - 1].m);
    parts.push(morning.length === 1 ? `${first} in the morning` : `mornings between ${first} and ${last}`);
  }
  if (afternoon.length > 0) {
    const first = formatTime(afternoon[0].h, afternoon[0].m);
    const last = formatTime(afternoon[afternoon.length - 1].h, afternoon[afternoon.length - 1].m);
    parts.push(afternoon.length === 1 ? `${first} in the afternoon` : `afternoons between ${first} and ${last}`);
  }

  return `On ${dateStr}, I have ${slots.length} available slots — ${parts.join(" and ")}. Would you prefer morning or afternoon?`;
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
    name?: string; // Legacy: combined full name
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
    notes?: string;
    service_type_id?: string;
    practitioner_id?: string;
  }
): Promise<ToolResult> {
  const { datetime, phone, email, notes, service_type_id } = args;

  // Build the name from first/last or legacy full name
  const firstName = args.first_name?.trim() || "";
  const lastName = args.last_name?.trim() || "";
  let name: string | undefined;
  if (firstName || lastName) {
    name = [firstName, lastName].filter(Boolean).join(" ");
  } else {
    name = args.name;
  }

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
        "I need your name to complete the booking. Could you tell me your first name and last name please?",
    };
  }

  // Check if business requires both first and last name
  const supabaseForFields = createAdminClient();
  const { data: assistant } = await (supabaseForFields as any)
    .from("assistants")
    .select("prompt_config")
    .eq("organization_id", organizationId)
    .limit(1)
    .single();

  const fields = assistant?.prompt_config?.fields || [];
  const firstNameField = fields.find((f: any) => f.id === "first_name");
  const lastNameField = fields.find((f: any) => f.id === "last_name");
  // Also check legacy full_name for backwards compat
  const fullNameField = fields.find((f: any) => f.id === "full_name");

  if (lastNameField?.required && !lastName) {
    return {
      success: false,
      message: "I also need your last name to complete the booking. What is your last name?",
    };
  }
  if (firstNameField?.required && !firstName && !fullNameField) {
    return {
      success: false,
      message: "I need your first name to complete the booking. What is your first name?",
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

  // ── Validate service_type_id format before DB query ────────────────────
  if (service_type_id && !isValidUUID(service_type_id)) {
    return {
      success: false,
      message: "That appointment type doesn't seem right. Could you tell me which type of appointment you'd like?",
    };
  }

  // ── Resolve service type duration if provided ─────────────────────────
  let serviceTypeDuration: number | undefined;
  const serviceTypes = await getActiveServiceTypes(organizationId);

  if (service_type_id) {
    const st = await getServiceType(service_type_id, organizationId);
    if (st) {
      serviceTypeDuration = st.duration_minutes;
    }
  }

  const useBuiltIn = service_type_id || serviceTypes.length > 0;

  if (useBuiltIn) {
    console.log("Using built-in booking (service types configured):", { organizationId, service_type_id });
    return bookInternal(
      organizationId,
      datetime,
      sanitizedName,
      phone,
      email,
      sanitizedNotes,
      serviceTypeDuration,
      service_type_id,
      firstName,
      lastName,
      args.practitioner_id || undefined
    );
  }

  // ── No service types — try Cal.com ────────────────────────────────────
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

  // ── Fallback: built-in booking (no Cal.com, no service types) ─────────
  console.log("Using built-in booking (no Cal.com client):", { organizationId });
  return bookInternal(
    organizationId,
    datetime,
    sanitizedName,
    phone,
    email,
    sanitizedNotes,
    undefined, // durationOverride
    undefined, // serviceTypeId
    firstName,
    lastName,
    args.practitioner_id || undefined
  );
}

export async function handleCheckAvailability(
  organizationId: string,
  args: { date?: string; service_type_id?: string }
): Promise<ToolResult> {
  const { date, service_type_id } = args;

  // ── Validate service_type_id format before DB query ────────────────────
  if (service_type_id && !isValidUUID(service_type_id)) {
    return {
      success: false,
      message: "That appointment type doesn't seem right. Could you tell me which type of appointment you'd like?",
    };
  }

  // ── Resolve service type duration if provided ─────────────────────────
  let serviceTypeDuration: number | undefined;
  // Fetch service types once and reuse throughout this handler
  const cachedServiceTypes = service_type_id ? [] : await getActiveServiceTypes(organizationId);

  if (service_type_id) {
    const st = await getServiceType(service_type_id, organizationId);
    if (st) {
      serviceTypeDuration = st.duration_minutes;
    }
  } else if (cachedServiceTypes.length > 0) {
    // No service_type_id — org has service types configured, prompt caller to pick
    const list = cachedServiceTypes.map(st => `- ${st.name} (${st.duration_minutes} min)`).join("\n");
    return {
      success: true,
      message: `Before I check availability, what type of appointment would you like to book?\n\nAvailable appointment types:\n${list}\n\nPlease ask the caller which type they'd like to book.`,
    };
  }

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

  // ── Check if org has service types — if so, use built-in first ────────
  const useBuiltIn = service_type_id || cachedServiceTypes.length > 0;

  if (useBuiltIn) {
    console.log("Using built-in availability (service types configured):", { organizationId, service_type_id });
    try {
      const schedule = await getOrgSchedule(organizationId);
      const timezone = schedule?.timezone || "America/New_York";
      const durationMinutes = serviceTypeDuration ?? schedule?.defaultAppointmentDuration ?? DEFAULT_SLOT_DURATION_MINUTES;
      const slots = await getBuiltInAvailability(organizationId, date, schedule, durationMinutes, service_type_id);
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

  // ── No service types — try Cal.com ────────────────────────────────────
  const calClient = await getCalComClient(organizationId);

  if (calClient) {
    return checkAvailabilityViaCal(calClient, organizationId, date);
  }

  // ── Fallback: built-in availability (no Cal.com, no service types) ────
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
  args: { phone?: string; reason?: string; confirmation_code?: string; date?: string }
): Promise<ToolResult> {
  const { phone, confirmation_code } = args;
  const reason = args.reason ? sanitizeString(args.reason, 500) : undefined;
  const date = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : undefined;

  if (!phone && !confirmation_code) {
    return {
      success: false,
      message:
        "I need your phone number or confirmation code to find your appointment.",
    };
  }

  const supabase = createAdminClient();

  // Try confirmation code first (exact match)
  if (confirmation_code) {
    const code = confirmation_code.trim();
    const { data: codeMatch, error: codeErr } = await (supabase as any)
      .from("appointments")
      .select("id, start_time, external_id, provider, metadata, confirmation_code, status")
      .eq("organization_id", organizationId)
      .eq("confirmation_code", code)
      .in("status", ["confirmed", "pending"])
      .single();

    if (codeErr && codeErr.code !== "PGRST116") {
      console.error("Cancel: confirmation code lookup error:", { organizationId, code, error: codeErr });
      return { success: false, message: "I'm having trouble looking up that code right now. Would you like me to have someone call you back?" };
    }
    if (codeMatch) {
      return cancelSingleAppointment(supabase, organizationId, codeMatch, reason);
    }
  }

  if (!phone) {
    return {
      success: false,
      message: "I couldn't find an appointment with that code. Could you provide your phone number instead?",
    };
  }

  // Fall back to phone lookup — only future appointments
  const variants = phoneVariants(phone);

  let query = (supabase as any)
    .from("appointments")
    .select("id, start_time, external_id, provider, metadata, confirmation_code, status")
    .eq("organization_id", organizationId)
    .in("attendee_phone", variants)
    .in("status", ["confirmed", "pending"])
    .gte("start_time", new Date().toISOString())
    .order("start_time", { ascending: true });

  // If a date is specified, filter to that date
  if (date) {
    const dayStart = new Date(date);
    const dayEnd = new Date(date);
    dayEnd.setDate(dayEnd.getDate() + 1);
    query = query.gte("start_time", dayStart.toISOString()).lt("start_time", dayEnd.toISOString());
  }

  query = query.limit(1);

  const { data: appointments, error: queryError } = await query;

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
        "I wasn't able to find an upcoming appointment with that phone number. Could you double-check the number you booked with, or provide the confirmation code?",
    };
  }

  return cancelSingleAppointment(supabase, organizationId, appointment, reason);
}

async function cancelSingleAppointment(
  supabase: any,
  organizationId: string,
  appointment: any,
  reason?: string
): Promise<ToolResult> {
  try {
    // For Cal.com appointments, try external cancellation first
    if (appointment.external_id && appointment.provider === "cal_com") {
      const calClient = await getCalComClient(organizationId);
      if (calClient && appointment.metadata?.calComBookingId) {
        await calClient.cancelBooking(
          appointment.metadata.calComBookingId,
          reason || "Cancelled by caller"
        );
      } else {
        console.warn("Cal.com cancel skipped (no client or booking ID) — cancelling locally only", {
          appointmentId: appointment.id,
        });
        // Don't fail — still cancel locally
      }
    }

    // Always update DB status to cancelled
    const { error: cancelDbError } = await (supabase as any)
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", appointment.id);

    if (cancelDbError) {
      console.error("Failed to update appointment status:", cancelDbError);
      return {
        success: false,
        message:
          "I'm having trouble cancelling the appointment right now. Would you like me to have someone call you back to help with this?",
      };
    }

    // Invalidate voice server schedule cache (fire-and-forget)
    invalidateVoiceScheduleCache(organizationId).catch((err) => console.warn("[VoiceCacheInvalidate] fire-and-forget failed:", err instanceof Error ? err.message : err));

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

    // Reject bookings in the past
    if (new Date(tzAwareDatetime).getTime() < Date.now()) {
      return {
        success: false,
        message: "That time has already passed. Would you like to book a later time today or a different day?",
      };
    }

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
    const calConfirmationCode = generateConfirmationCode();
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
        confirmation_code: calConfirmationCode,
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
    sendNotification(organizationId, phone, sanitizedName, appointmentDate, timezone, calConfirmationCode);

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
  sanitizedNotes: string | undefined,
  durationOverride?: number,
  serviceTypeId?: string,
  firstNameOverride?: string,
  lastNameOverride?: string,
  requestedPractitionerId?: string
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
  const durationMinutes = durationOverride ?? schedule?.defaultAppointmentDuration ?? DEFAULT_SLOT_DURATION_MINUTES;
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

  // Reject bookings in the past
  if (startDate.getTime() < Date.now()) {
    return {
      success: false,
      message:
        "That time has already passed. Would you like to book a later time today or a different day?",
    };
  }

  const endDate = new Date(startDate.getTime() + durationMinutes * 60_000);

  // Reject bookings during blocked times — use a wide 48-hour window around
  // the booking time to catch blocks regardless of timezone offset
  const blockCheckStart = new Date(startDate.getTime() - 24 * 60 * 60_000);
  const blockCheckEnd = new Date(startDate.getTime() + 24 * 60 * 60_000);
  const blockedRanges = await getBlockedTimes(
    organizationId,
    blockCheckStart.toISOString(),
    blockCheckEnd.toISOString()
  );
  if (isTimeBlocked(startDate, durationMinutes, blockedRanges)) {
    return {
      success: false,
      message: "That time is currently blocked and not available for bookings. Would you like to check a different time or day?",
    };
  }

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

  // 2. Assign practitioner — specific request or round-robin auto-assign
  let assignedPractitionerId: string | undefined;
  let assignedPractitionerName: string | undefined;

  if (requestedPractitionerId) {
    // Caller requested a specific practitioner — validate they exist and are available
    const resolvedServiceTypeId = serviceTypeId;
    const practitioners = resolvedServiceTypeId
      ? await getPractitionersForService(organizationId, resolvedServiceTypeId)
      : [];

    if (resolvedServiceTypeId && practitioners.length > 0) {
      const requested = practitioners.find(p => p.id === requestedPractitionerId);
      if (!requested) {
        return {
          success: false,
          message: `The requested practitioner is not available for this service type. I can book with the next available practitioner instead, or you can choose from our team.`,
        };
      }
    }

    // When no service type, validate practitioner belongs to this org
    if (!resolvedServiceTypeId) {
      const { data: practitioner } = await (supabase as any)
        .from("practitioners")
        .select("id")
        .eq("id", requestedPractitionerId)
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .single();

      if (!practitioner) {
        return { success: false, message: "The requested practitioner was not found or is not available." };
      }
    }

    // Check if this practitioner is free at the requested time
    const supabaseAdmin = createAdminClient();
    const { data: conflicts } = await (supabaseAdmin as any)
      .from("appointments")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("practitioner_id", requestedPractitionerId)
      .in("status", ["confirmed", "pending"])
      .lt("start_time", endDate.toISOString())
      .gt("end_time", startDate.toISOString())
      .limit(1);

    if (conflicts && conflicts.length > 0) {
      return {
        success: false,
        message: `That practitioner is already booked at this time. Would you like me to check their next available slot, or book with another practitioner?`,
      };
    }

    // Also check practitioner-specific blocked times
    const { data: blocks } = await (supabaseAdmin as any)
      .from("blocked_times")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("practitioner_id", requestedPractitionerId)
      .lt("start_time", endDate.toISOString())
      .gt("end_time", startDate.toISOString())
      .limit(1);

    if (blocks && blocks.length > 0) {
      return {
        success: false,
        message: `That practitioner is unavailable at this time (they may be on a break or off). Would you like to try a different time or see another practitioner?`,
      };
    }

    assignedPractitionerId = requestedPractitionerId;
    // Try to resolve the name for the confirmation message
    if (serviceTypeId) {
      const allPractitioners = practitioners.length > 0
        ? practitioners
        : await getPractitionersForService(organizationId, serviceTypeId);
      assignedPractitionerName = allPractitioners.find(p => p.id === requestedPractitionerId)?.name;
    }
  } else if (serviceTypeId) {
    // No specific practitioner requested — use round-robin (existing logic)
    const practitioners = await getPractitionersForService(organizationId, serviceTypeId);
    if (practitioners.length > 0) {
      const practitionerIds = practitioners.map((p) => p.id);
      const picked = await pickPractitionerRoundRobin(organizationId, practitionerIds, startDate, endDate);
      if (!picked) {
        return {
          success: false,
          message:
            "I'm sorry, all practitioners for that service are booked at that time. Would you like me to check for other available times?",
        };
      }
      assignedPractitionerId = picked;
      assignedPractitionerName = practitioners.find((p) => p.id === assignedPractitionerId)?.name;
    }
  }

  // 3. Insert appointment — the DB exclusion constraint (no_overlapping_appointments)
  //    prevents double-bookings atomically, so we rely on INSERT failure for conflicts.
  const bookingEmail =
    email || `booking-${crypto.randomUUID()}@noreply.phondo.ai`;

  const confirmationCode = generateConfirmationCode();

  const { data: appointment, error: dbError } = await (supabase as any)
    .from("appointments")
    .insert({
      organization_id: organizationId,
      provider: "internal",
      attendee_name: sanitizedName,
      attendee_first_name: firstNameOverride || sanitizedName.split(" ")[0] || null,
      attendee_last_name: lastNameOverride || (sanitizedName.includes(" ") ? sanitizedName.split(" ").slice(1).join(" ") : null),
      attendee_phone: phone,
      attendee_email: bookingEmail,
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      duration_minutes: durationMinutes,
      status: "confirmed",
      notes: sanitizedNotes,
      confirmation_code: confirmationCode,
      metadata: { source: "ai_receptionist" },
      ...(serviceTypeId && { service_type_id: serviceTypeId }),
      ...(assignedPractitionerId && { practitioner_id: assignedPractitionerId }),
    })
    .select("id, confirmation_code")
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

  // 4. Send notification
  const timezone = schedule?.timezone || "America/New_York";
  sendNotification(organizationId, phone, sanitizedName, startDate, timezone, confirmationCode);
  const { dateStr, timeStr } = formatDateTimeForVoice(startDate, timezone);

  const practitionerNote = assignedPractitionerName
    ? ` with ${assignedPractitionerName}`
    : "";

  // Invalidate voice server schedule cache (fire-and-forget)
  invalidateVoiceScheduleCache(organizationId).catch((err) => console.warn("[VoiceCacheInvalidate] fire-and-forget failed:", err instanceof Error ? err.message : err));

  return {
    success: true,
    message: `I've booked your appointment for ${dateStr} at ${timeStr}${practitionerNote}. Your confirmation code is ${confirmationCode}. Please keep this code — you'll need it if you call back to check or change your appointment. Is there anything else I can help you with?`,
    data: {
      appointmentId: appointment.id,
      confirmationCode,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      ...(assignedPractitionerId && { practitionerId: assignedPractitionerId }),
      ...(assignedPractitionerName && { practitionerName: assignedPractitionerName }),
    },
  };
}

// ─── Notification helper ────────────────────────────────────────────────────

function sendNotification(
  organizationId: string,
  phone: string,
  name: string,
  appointmentDate: Date,
  timezone?: string,
  confirmationCode?: string
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
    confirmationCode,
  }).catch((err) => {
    console.error("Failed to send appointment notification:", err);
  });

  // SMS confirmation to the caller (include confirmation code)
  sendAppointmentConfirmationSMS(organizationId, phone, appointmentDate, timezone, confirmationCode)
    .catch((err) => console.error("Appointment confirmation SMS failed:", { organizationId, error: err }));
}

// ─── Appointment result formatter ───────────────────────────────────────────

async function formatAppointmentResult(
  appointments: any[],
  timezone: string,
  supabase: any
): Promise<ToolResult> {
  const lines: string[] = [];
  for (const apt of appointments) {
    const date = new Date(apt.start_time);
    const dateStr = date.toLocaleDateString("en-AU", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: timezone });
    const timeStr = date.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: timezone });

    let serviceInfo = "";
    if (apt.service_type_id) {
      const { data: st } = await supabase.from("service_types").select("name").eq("id", apt.service_type_id).single();
      if (st) serviceInfo = ` for a ${st.name}`;
    }

    let practitionerInfo = "";
    if (apt.practitioner_id) {
      const { data: pract } = await supabase.from("practitioners").select("name").eq("id", apt.practitioner_id).single();
      if (pract) practitionerInfo = ` with ${pract.name}`;
    }

    lines.push(`${dateStr} at ${timeStr}${serviceInfo}${practitionerInfo}`);
  }

  if (lines.length === 1) {
    return { success: true, message: `I found your appointment: ${lines[0]}. Is there anything else you'd like to know about it?` };
  }
  return { success: true, message: `I found ${lines.length} upcoming appointments: ${lines.join(". Next, ")}. Which one would you like to know more about?` };
}

// ─── Appointment Lookup (with privacy verification) ─────────────────────────

/**
 * Look up an existing appointment.
 * Priority: confirmation_code (instant, 100% accurate) > name + phone (fuzzy).
 * The business configures which fallback fields are required via settings.
 */
export async function handleLookupAppointment(
  organizationId: string,
  args: {
    confirmation_code?: string;
    name?: string;
    phone?: string;
    email?: string;
    date_of_birth?: string;
  }
): Promise<ToolResult> {
  const supabase = createAdminClient();

  // 1. Get the org's verification requirements
  const { data: org, error: orgError } = await (supabase as any)
    .from("organizations")
    .select("appointment_verification_fields, timezone")
    .eq("id", organizationId)
    .single();

  if (orgError || !org) {
    return { success: false, message: "I'm having trouble accessing the system right now. Would you like me to arrange a callback instead?" };
  }

  // Parse verification settings (structured object or legacy array)
  const rawSettings = org.appointment_verification_fields;
  let verificationMethod: string;
  let verificationFields: string[];
  if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings) && rawSettings.method) {
    verificationMethod = rawSettings.method; // "code_and_verify" | "code_only" | "details_only"
    verificationFields = Array.isArray(rawSettings.fields) ? rawSettings.fields : ["name"];
  } else if (Array.isArray(rawSettings)) {
    // Legacy: plain array of fields → treat as code_and_verify
    verificationMethod = "code_and_verify";
    verificationFields = rawSettings;
  } else {
    verificationMethod = "code_and_verify";
    verificationFields = ["name"];
  }
  const timezone = org.timezone || "Australia/Sydney";
  const usesCode = verificationMethod !== "details_only";

  // 2a. CODE PATH: lookup by confirmation code
  if (usesCode && args.confirmation_code?.trim()) {
    const code = args.confirmation_code.trim();
    const { data: codeMatch, error: codeError } = await (supabase as any)
      .from("appointments")
      .select("id, attendee_name, attendee_phone, attendee_email, start_time, end_time, duration_minutes, status, service_type_id, practitioner_id, confirmation_code")
      .eq("organization_id", organizationId)
      .eq("confirmation_code", code)
      .in("status", ["confirmed", "pending"])
      .single();

    if (!codeError && codeMatch) {
      // code_only: return immediately, no extra verification
      if (verificationMethod === "code_only") {
        return formatAppointmentResult([codeMatch], timezone, supabase);
      }

      // code_and_verify: code matched, now check verification fields
      const verifyFails: string[] = [];
      for (const field of verificationFields) {
        if (field === "name" && args.name?.trim()) {
          const providedName = args.name.trim().toLowerCase();
          const storedName = (codeMatch.attendee_name || "").toLowerCase();
          if (!storedName.includes(providedName) && !providedName.includes(storedName)) {
            verifyFails.push("name");
          }
        } else if (field === "phone" && args.phone?.trim()) {
          const providedDigits = args.phone.replace(/\D/g, "").slice(-9);
          const storedDigits = (codeMatch.attendee_phone || "").replace(/\D/g, "").slice(-9);
          if (providedDigits !== storedDigits) {
            verifyFails.push("phone number");
          }
        } else if (field === "email" && args.email?.trim()) {
          const providedEmail = args.email.trim().toLowerCase();
          const storedEmail = (codeMatch.attendee_email || "").toLowerCase();
          if (storedEmail && providedEmail !== storedEmail) {
            verifyFails.push("email");
          }
        } else if (field === "name" && !args.name?.trim()) {
          return {
            success: false,
            message: "I found an appointment with that code. For security, could you also confirm the name on the booking?",
          };
        } else if (field === "email" && !args.email?.trim()) {
          return {
            success: false,
            message: "I found an appointment with that code. For security, could you also confirm the email address on the booking?",
          };
        } else if (field === "phone" && !args.phone?.trim()) {
          return {
            success: false,
            message: "I found an appointment with that code. For security, could you also confirm the phone number on the booking?",
          };
        } else if (field === "date_of_birth" && !args.date_of_birth?.trim()) {
          return {
            success: false,
            message: "I found an appointment with that code. For security, could you also confirm your date of birth?",
          };
        }
      }

      if (verifyFails.length > 0) {
        return {
          success: false,
          message: `The ${verifyFails.join(" and ")} you provided doesn't match what we have on file. Would you like to try again, or I can arrange a callback?`,
        };
      }

      return formatAppointmentResult([codeMatch], timezone, supabase);
    }

    // Code not found
    if (args.name || args.phone) {
      // Fall through to field-based lookup
    } else {
      return {
        success: false,
        message: "I couldn't find an appointment with that code. Could you double-check? It's a 6-digit number. If you don't have it, I can look up your appointment by name and phone number instead.",
      };
    }
  }

  // 2b. FIELD-BASED VERIFICATION (details_only mode, or code fallback)
  const missing: string[] = [];
  for (const field of verificationFields) {
    if (field === "name" && !args.name?.trim()) missing.push("full name");
    if (field === "phone" && !args.phone?.trim()) missing.push("phone number");
    if (field === "email" && !args.email?.trim()) missing.push("email address");
    if (field === "date_of_birth" && !args.date_of_birth?.trim()) missing.push("date of birth");
  }

  if (missing.length > 0) {
    return {
      success: false,
      message: `To look up your appointment, I need to verify your identity. Could you please provide your ${missing.join(" and ")}?`,
    };
  }

  // 3. Build the query — match ALL required fields
  let query = (supabase as any)
    .from("appointments")
    .select("id, attendee_name, attendee_phone, attendee_email, start_time, end_time, duration_minutes, status, service_type_id, practitioner_id")
    .eq("organization_id", organizationId)
    .in("status", ["confirmed", "pending"])
    .gte("start_time", new Date().toISOString()) // Only future appointments
    .order("start_time", { ascending: true })
    .limit(5);

  // Apply verification filters
  if (verificationFields.includes("name") && args.name) {
    query = query.ilike("attendee_name", `%${escapeLike(args.name.trim())}%`);
  }
  if (verificationFields.includes("phone") && args.phone) {
    const cleanPhone = args.phone.replace(/\D/g, "");
    // Match last 9 digits to handle different country code formats
    const phoneSuffix = cleanPhone.length > 9 ? cleanPhone.slice(-9) : cleanPhone;
    query = query.ilike("attendee_phone", `%${phoneSuffix}%`);
  }
  if (verificationFields.includes("email") && args.email) {
    query = query.ilike("attendee_email", `%${escapeLike(args.email.trim())}%`);
  }

  const { data: appointments, error: queryError } = await query;

  if (queryError) {
    console.error("Appointment lookup error:", queryError);
    return { success: false, message: "I'm having trouble looking up appointments right now. Would you like me to arrange a callback instead?" };
  }

  if (!appointments || appointments.length === 0) {
    return {
      success: true,
      message: "I couldn't find any upcoming appointments matching your details. It's possible the appointment was booked under a different name or phone number. Would you like me to arrange a callback so someone from the team can help you?",
    };
  }

  return formatAppointmentResult(appointments, timezone, supabase as any);
}
