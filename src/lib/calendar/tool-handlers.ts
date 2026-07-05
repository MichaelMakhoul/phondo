import crypto from "crypto";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getCalComClient,
  formatBookingConfirmation,
  formatAvailabilityForVoice,
} from "@/lib/calendar/cal-com";
import { sendAppointmentNotification } from "@/lib/notifications/notification-service";
import { sendAppointmentConfirmationSMS, sendCancellationSMS } from "@/lib/sms/caller-sms";
import {
  sanitizeString,
  isValidPhoneNumber,
  isValidEmail,
} from "@/lib/security/validation";
import {
  getActiveServiceTypes,
  getServiceType,
  type ServiceType,
} from "@/lib/service-types";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import { runAfterResponse } from "@/lib/utils/after-response";
import { rateLimitDistributed } from "@/lib/security/rate-limiter";
import { hasNonLatinLetters } from "@/lib/calendar/latin-name";
import { resolveRescheduleIdentity, resolveRescheduledBooking } from "@/lib/calendar/reschedule-core";
import {
  getActiveClinikoIntegration,
  clinikoCheckAvailability,
  clinikoBookAppointment,
  clinikoCancelExternal,
} from "@/lib/calendar/cliniko-booking";
import { reconcileClinikoOrg } from "@/lib/calendar/cliniko-reconcile";
import { generateConfirmationCode } from "@/lib/calendar/confirmation-code";
import { namesMatch } from "@/lib/calendar/name-match";
import { validateOrgScopedRefs } from "@/lib/calendar/validate-org-scoped-refs";
import { MAX_BOOKING_HORIZON_MS } from "@/lib/calendar/appointment-lifecycle";
import {
  parseVerificationSettings,
  getVerificationSettings,
  resolveCallerId,
  verifyPhonePossession,
  verifyKnowledgeFactors,
  type CallerIdState,
  type VerificationSettings,
} from "@/lib/calendar/appointment-verification";

/**
 * SCRUM-438: fields the MODEL can never supply. The internal tool-call route
 * populates them from the voice server's session state (top-level payload
 * fields) — NEVER from the LLM tool arguments. They carry the possession
 * factor for cancel/reschedule ownership:
 *  - `callerIdState: "verified"` + `verifiedCallerPhone`: production call
 *    with a real dialable From — possession is compared against THAT only.
 *  - `callerIdState: "withheld"`: production call with no usable caller ID
 *    (withheld/sentinel/SIP From) — possession is unverifiable; mutations
 *    refuse rather than fall back to the model-controlled phone argument.
 *  - both fields absent: browser/test sessions only — the model-supplied
 *    phone is the fallback there (no caller ID can exist).
 */
export interface TrustedCallContext {
  verifiedCallerPhone?: string;
  callerIdState?: CallerIdState;
}

// SCRUM-399: `resolveRescheduleIdentity` moved to reschedule-core (shared with the
// dashboard reschedule path). Re-exported here so existing imports/tests are stable.
export { resolveRescheduleIdentity };

interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

// SCRUM-505: one canonical "nothing found" line, shared by the genuine
// not-found and the knowledge-factor-mismatch cases in lookup. Identical wording
// either way so a caller with a (spoofable) matching phone but the wrong name
// can't tell whether a booking exists under that number — no enumeration oracle.
// It invites the caller to SPELL their name: phone STT routinely mangles unusual
// names ("Makhoul"→"McCool") past the tolerant matcher, and spelled letters
// transcribe reliably, so the retry usually lands. Phrasing never asserts a
// booking exists (preserving the anti-enumeration property).
const LOOKUP_NO_MATCH_MESSAGE =
  "I couldn't find a match under that name. Sometimes a name gets misheard on a call — could you spell your last name for me, letter by letter, so I can check again? If it still doesn't come up, I can arrange a callback from the team.";

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

// SCRUM-431 (finding #51): MAX_BOOKING_HORIZON_MS is shared from
// appointment-lifecycle so the dashboard routes enforce the same horizon.

/** Generate a 6-digit confirmation code (crypto-secure, digits only) */
// SCRUM-12: generateConfirmationCode moved to ./confirmation-code so the
// Cliniko booking path can mint codes without importing this module (cycle).

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
    timezone: org.timezone || "Australia/Sydney",
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

// ─── Phone matching helpers ──────────────────────────────────────────────────

/**
 * SCRUM-438: the end-anchored ilike suffix for a phone lookup (same form PR
 * #346 gave handleLookupAppointment) — last 9 digits, digits-only, so it
 * matches the stored number regardless of formatting (E.164 vs national vs
 * spaced) without a floating `%...%` contains. Callers MUST validate the
 * phone with isValidPhoneNumber first (≥8 digits) so the suffix can never
 * degenerate toward a match-everything '%'.
 */
function phoneSuffixPattern(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const suffix = digits.length > 9 ? digits.slice(-9) : digits;
  return `%${suffix}`;
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
 *
 * Exported for unit testing (see __tests__/round-robin-blocked-times.test.ts).
 */
export async function pickPractitionerRoundRobin(
  organizationId: string,
  practitionerIds: string[],
  slotStart?: Date,
  slotEnd?: Date
): Promise<string | null> {
  if (practitionerIds.length === 0) return null;

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // ── Step 1: Filter out practitioners busy at the requested time ──
  // "Busy" = an overlapping appointment OR an overlapping practitioner-specific
  // blocked time (time off). The DB only enforces appointment overlaps, so the
  // blocked_times check has to happen here or round-robin will book a
  // practitioner on top of their time off (audit finding #16).
  let availableIds = [...practitionerIds];

  if (slotStart && slotEnd) {
    const slotStartIso = slotStart.toISOString();
    const slotEndIso = slotEnd.toISOString();
    const busyIds = new Set<string>();

    const { data: conflicting, error: conflictErr } = await (supabase as any)
      .from("appointments")
      .select("practitioner_id, start_time, end_time, duration_minutes")
      .eq("organization_id", organizationId)
      .in("practitioner_id", practitionerIds)
      .in("status", ["confirmed", "pending"])
      .lt("start_time", slotEndIso)
      .gt("end_time", slotStartIso);

    if (conflictErr) {
      // Fail OPEN here is safe: the per-practitioner EXCLUDE constraint
      // (no_overlapping_practitioner_appointments) rejects the insert if we
      // mis-pick, so a missed appointment conflict can never double-book.
      console.error("Failed to check practitioner slot conflicts:", { organizationId, practitionerIds, slotStartIso, slotEndIso, error: conflictErr });
    } else if (conflicting) {
      for (const a of conflicting as { practitioner_id: string | null }[]) {
        if (a.practitioner_id) busyIds.add(a.practitioner_id);
      }
    }

    // Practitioner-specific time off overlapping the slot (mirrors getBuiltInAvailability).
    const { data: blocks, error: blockErr } = await (supabase as any)
      .from("blocked_times")
      .select("practitioner_id, start_time, end_time")
      .eq("organization_id", organizationId)
      .not("practitioner_id", "is", null)
      .in("practitioner_id", practitionerIds)
      .lt("start_time", slotEndIso)
      .gt("end_time", slotStartIso);

    if (blockErr) {
      // Fail CLOSED — unlike the appointment check above, blocked_times has NO
      // DB backstop, so a missed block would silently book a practitioner on top
      // of their time off (the exact bug #16 this guards against). When we can't
      // verify time off for any candidate, decline to auto-assign and let the
      // caller hit the graceful "pick another time" path instead of over-booking.
      console.error("Failed to check practitioner blocked times — declining auto-assign for this slot:", { organizationId, practitionerIds, slotStartIso, slotEndIso, error: blockErr });
      Sentry.withScope((scope) => {
        scope.setLevel("error");
        scope.setTag("bug", "round_robin_blocked_times_check_failed");
        scope.setExtras({ organizationId, practitionerIds, slotStartIso, slotEndIso });
        Sentry.captureMessage("Round-robin blocked_times check failed — skipped auto-assign to avoid booking over time off");
      });
      return null;
    }
    for (const b of (blocks || []) as { practitioner_id: string | null }[]) {
      if (b.practitioner_id) busyIds.add(b.practitioner_id);
    }

    if (busyIds.size > 0) {
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

// Fixed Intl options for offset computation; formatters are memoised per zone
// because ensureTimezoneOffset runs per-slot in the live availability hot path
// and Intl.DateTimeFormat construction (ICU load) is comparatively expensive.
const _OFFSET_FMT_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // hourCycle h23 (not hour12:false) so midnight is "00", never "24" — some ICU
  // builds (e.g. CI) emit "24" for hour12:false, which would roll Date.UTC to
  // the next day and throw the offset off by 24h when we read parts at midnight.
  hourCycle: "h23",
};
const _offsetFmtCache = new Map<string, Intl.DateTimeFormat>();
function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = _offsetFmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, ..._OFFSET_FMT_OPTS });
    _offsetFmtCache.set(timeZone, f);
  }
  return f;
}

/**
 * The UTC offset (in minutes) for `timezone` AT a specific UTC `instant`.
 * Computed by formatting the instant in the zone vs UTC and differencing — no
 * dependency on the server's local timezone. (Math.round only guards historical
 * sub-minute LMT offsets, which never occur for booking dates.)
 */
function zoneOffsetMinutesAt(instant: Date, timezone: string): number {
  const get = (parts: Intl.DateTimeFormatPart[], type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value || "0", 10);
  const tz = offsetFormatter(timezone).formatToParts(instant);
  const utc = offsetFormatter("UTC").formatToParts(instant);
  // Defensive `% 24`: belt-and-suspenders against an ICU build emitting hour 24.
  const tzMs = Date.UTC(get(tz, "year"), get(tz, "month") - 1, get(tz, "day"), get(tz, "hour") % 24, get(tz, "minute"), get(tz, "second"));
  const utcMs = Date.UTC(get(utc, "year"), get(utc, "month") - 1, get(utc, "day"), get(utc, "hour") % 24, get(utc, "minute"), get(utc, "second"));
  return Math.round((tzMs - utcMs) / 60_000);
}

/**
 * If the datetime string lacks a timezone offset (Z or +/-HH:MM), compute the
 * UTC offset for the given IANA timezone and append it, so a naive wall-time is
 * not interpreted as UTC on the server. Correct across DST transitions.
 *
 * e.g. "2026-02-18T10:00:00" + "Australia/Sydney" → "2026-02-18T10:00:00+11:00"
 */
export function ensureTimezoneOffset(datetime: string, timezone: string): string {
  // Already has an offset (Z or +/-HH:MM) — leave it alone.
  if (/[Zz]$/.test(datetime) || /[+-]\d{2}:\d{2}$/.test(datetime)) {
    return datetime;
  }
  // Read the naive wall-time as if it were UTC. This is NOT the real instant —
  // it is ~offset hours away — but it's the starting point for the iteration.
  const naiveUtcMs = new Date(`${datetime}Z`).getTime();
  if (isNaN(naiveUtcMs)) return datetime; // unparseable — let the caller handle it.

  // SCRUM-416: the zone offset depends on the true local instant, but the local
  // instant depends on the offset. Solve by fixed-point iteration: take the
  // offset at the naive-as-UTC instant, refine the UTC guess (naive - offset),
  // re-read the offset there, and repeat until stable. The previous code read
  // the offset at the naive-as-UTC instant ONLY, so a DST transition falling in
  // that ~offset-hour gap produced a +/-1h error (e.g. Sydney spring-forward).
  let offsetMinutes = zoneOffsetMinutesAt(new Date(naiveUtcMs), timezone);
  for (let i = 0; i < 4; i++) {
    const utcGuessMs = naiveUtcMs - offsetMinutes * 60_000;
    const next = zoneOffsetMinutesAt(new Date(utcGuessMs), timezone);
    if (next === offsetMinutes) break;
    offsetMinutes = next;
  }

  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  return `${datetime}${sign}${offH}:${offM}`;
}

// ─── Get current datetime handler ───────────────────────────────────────────

export async function handleGetCurrentDatetime(
  organizationId: string
): Promise<ToolResult> {
  let timezone = "Australia/Sydney";
  try {
    const schedule = await getOrgSchedule(organizationId);
    if (schedule?.timezone) timezone = schedule.timezone;
  } catch (error) {
    console.error("Failed to fetch org timezone for get_current_datetime, falling back to Australia/Sydney:", {
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
  },
  // SCRUM-444 review: INTERNAL-ONLY, never sourced from request/tool-call input.
  // Set ONLY by handleRescheduleAppointment for refs carried over from the
  // existing booking (the caller did not supply them). Carried refs are
  // validated org-scope-only — a since-deactivated service/practitioner must
  // not dead-end a time-only move; caller-supplied refs still must be active.
  // Kept OUT of `args` (which is populated from the LLM tool-call payload) so
  // the model can never claim a freshly-supplied ref is "carried" to bypass the
  // is_active gate — the isolation is structural, not comment-enforced.
  internal?: { carriedRefs?: { service_type?: boolean; practitioner?: boolean } }
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

  // SCRUM-367: gate non-Latin names server-side. Gemini Live in a non-English
  // call passes the caller's name in their own script (e.g. Arabic) straight
  // through; nothing else stops it reaching the DB. Reject so the model
  // transliterates into English letters first (it does this well). Accented
  // Latin (José, Müller) is allowed — only non-Latin scripts are rejected.
  if (hasNonLatinLetters(name)) {
    return {
      success: false,
      message:
        "To book this I need the name written with English letters. Could you give me the English spelling of the first and last name?",
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

  // ── Validate practitioner_id format too (SCRUM-425 — parity with
  // service_type_id; org ownership is enforced in bookInternal) ───────────
  if (args.practitioner_id && !isValidUUID(args.practitioner_id)) {
    return {
      success: false,
      message: "I didn't catch which practitioner you'd like. Could you tell me their name again?",
    };
  }

  // ── Resolve service type duration if provided ─────────────────────────
  let serviceTypeDuration: number | undefined;
  const serviceTypes = await getActiveServiceTypes(organizationId);

  if (service_type_id) {
    // SCRUM-444 review: getServiceType returns null ONLY for a true not-found
    // (unknown/cross-org id) and THROWS on a real DB error — a transient blip
    // must offer the callback path, not tell the caller their appointment type
    // doesn't exist.
    let st: ServiceType | null;
    try {
      st = await getServiceType(service_type_id, organizationId);
    } catch {
      // Already logged with full context inside getServiceType.
      return {
        success: false,
        message:
          "I'm having trouble verifying those appointment details right now. Let me take your information and have someone call you back.",
      };
    }
    // SCRUM-444: a null here means the id is unknown/cross-org — reject NOW
    // instead of falling through with a default duration and relying on
    // bookInternal's validator as a backstop.
    if (!st) {
      return {
        success: false,
        message:
          "I couldn't match that appointment type to this business. Could you tell me again what type of appointment you'd like to book?",
      };
    }
    serviceTypeDuration = st.duration_minutes;
  }

  // ── SCRUM-12: a connected Cliniko diary owns booking — dispatch before the
  // built-in/Cal.com forks. Datetime parsing + horizon guards mirror
  // bookInternal exactly (same copy, same tz-aware interpretation); org-scoped
  // ref enforcement happens inside the Cliniko path via cliniko-linked lookups.
  const clinikoResolution = await getActiveClinikoIntegration(organizationId);
  if (clinikoResolution.kind === "error") {
    // Transient DB/decrypt fault — do NOT fall through to built-in booking, or
    // we'd confirm an appointment the practice's Cliniko diary never receives.
    return {
      success: false,
      message:
        "I'm having trouble completing the booking right now. Let me take your information and have someone call you back to confirm the appointment.",
    };
  }
  if (clinikoResolution.kind === "ok") {
    const clinikoCtx = clinikoResolution.ctx;
    // Resolve the timezone with the SAME loud-failure contract as bookInternal —
    // guessing Australia/Sydney on a DB blip could shift a non-AU booking by hours.
    let clinikoSchedule: OrgSchedule | null;
    try {
      clinikoSchedule = await getOrgSchedule(organizationId);
    } catch (error) {
      console.error("Failed to get org schedule for Cliniko booking:", { organizationId, error });
      return {
        success: false,
        message:
          "I'm having trouble accessing our schedule right now. Let me take your information and have someone call you back.",
      };
    }
    const clinikoTimezone = clinikoSchedule?.timezone || "Australia/Sydney";
    const clinikoStart = new Date(ensureTimezoneOffset(datetime, clinikoTimezone));
    if (isNaN(clinikoStart.getTime())) {
      return {
        success: false,
        message: "I didn't understand that date and time. Could you say it again?",
      };
    }
    if (clinikoStart.getTime() > Date.now() + MAX_BOOKING_HORIZON_MS) {
      return {
        success: false,
        message: "I can only book appointments up to a year in advance. Would you like to pick a closer date?",
      };
    }
    if (clinikoStart.getTime() < Date.now()) {
      return {
        success: false,
        message: "That time has already passed. Would you like to book a later time today or a different day?",
      };
    }
    return clinikoBookAppointment(clinikoCtx, organizationId, {
      startDate: clinikoStart,
      timezone: clinikoTimezone,
      sanitizedName,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      phone,
      email,
      sanitizedNotes,
      serviceTypeId: service_type_id,
      requestedPractitionerId: args.practitioner_id || undefined,
    });
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
      args.practitioner_id || undefined,
      internal?.carriedRefs
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
    args.practitioner_id || undefined,
    internal?.carriedRefs
  );
}

export async function handleCheckAvailability(
  organizationId: string,
  args: { date?: string; service_type_id?: string; practitioner_id?: string }
): Promise<ToolResult> {
  const { date, service_type_id, practitioner_id } = args;

  // ── Validate service_type_id format before DB query ────────────────────
  if (service_type_id && !isValidUUID(service_type_id)) {
    return {
      success: false,
      message: "That appointment type doesn't seem right. Could you tell me which type of appointment you'd like?",
    };
  }
  if (practitioner_id && !isValidUUID(practitioner_id)) {
    return {
      success: false,
      message: "I didn't catch which practitioner you'd like. Could you tell me their name again?",
    };
  }

  // ── SCRUM-12: a connected Cliniko practice diary owns availability — it must
  // come from the real appointment book, not the built-in calendar or Cal.com.
  const clinikoAvailResolution = await getActiveClinikoIntegration(organizationId);
  if (clinikoAvailResolution.kind === "error") {
    // Don't fall through to built-in availability — that would quote an
    // empty local calendar as if it were the practice's real diary.
    return {
      success: false,
      message:
        "I'm having trouble checking the calendar right now. Would you like me to take your information instead?",
    };
  }
  if (clinikoAvailResolution.kind === "ok") {
    return clinikoCheckAvailability(clinikoAvailResolution.ctx, organizationId, { date, service_type_id, practitioner_id });
  }

  // ── Resolve service type duration if provided ─────────────────────────
  let serviceTypeDuration: number | undefined;
  // Fetch service types once and reuse throughout this handler
  const cachedServiceTypes = service_type_id ? [] : await getActiveServiceTypes(organizationId);

  if (service_type_id) {
    // SCRUM-444 review: getServiceType now THROWS on a real DB error (instead of
    // returning null). Availability can still answer using the org default
    // duration — the same fallback the old null-on-error behavior produced.
    let st: ServiceType | null = null;
    try {
      st = await getServiceType(service_type_id, organizationId);
    } catch {
      // Already logged inside getServiceType; proceed with the default duration.
    }
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
      const timezone = schedule?.timezone || "Australia/Sydney";
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
    const timezone = schedule?.timezone || "Australia/Sydney";
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

/**
 * Render an instant as its local wall-clock time in the given IANA timezone,
 * formatted as `YYYY-MM-DDTHH:mm` (minute precision, 24-hour, no offset).
 *
 * This is the inverse of {@link ensureTimezoneOffset}: it produces exactly the
 * naive datetime string the cancel/reschedule tools accept back. Used to hand
 * the model each disambiguation option's exact datetime so it can re-call
 * cancel_appointment with a value that pins one specific row (±15-min match).
 *
 * e.g., a 12:00 PM Sydney appointment stored as "2026-02-18T01:00:00Z"
 *       → toLocalIsoMinute(date, "Australia/Sydney") → "2026-02-18T12:00"
 */
export function toLocalIsoMinute(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc: Record<string, string>, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  // Some engines emit "24" for midnight under hour12:false — normalise to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/**
 * From a list of appointments, return the one whose `start_time` is closest to
 * `targetMs` (epoch ms). Used to pin a single appointment when the caller gave a
 * datetime that lands several rows inside the cancel/reschedule ±15-min match
 * window (e.g. two appointments less than 15 minutes apart) — so disambiguation
 * converges instead of looping.
 *
 * Returns null when the result would be a GUESS — an empty list, or a tie where
 * two rows are equidistant from the target (e.g. two appointments in the same
 * wall-clock minute, which `toLocalIsoMinute` can't tell apart — possible for one
 * caller across two practitioners, since the no-overlap constraint is per
 * practitioner). Callers MUST treat null as "cannot safely pick — disambiguate"
 * and never fall back to array order: this function gates a destructive
 * cancel/cancel-and-move, so a non-deterministic tiebreak could cancel the wrong
 * appointment. Rows with an unparseable `start_time` are ignored.
 */
export function pickClosestAppointment<T extends { start_time: string }>(
  appointments: T[],
  targetMs: number
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  let tied = false;
  for (const a of appointments ?? []) {
    const dist = Math.abs(new Date(a.start_time).getTime() - targetMs);
    if (Number.isNaN(dist)) continue; // skip rows with an unparseable start_time
    if (dist < bestDist) {
      best = a;
      bestDist = dist;
      tied = false;
    } else if (dist === bestDist) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * Format the cancel/reschedule "which one did you mean?" option lines, shared
 * so the two replies stay structurally in lock-step. Each option carries the
 * human date/time (+ service when resolvable) PLUS the exact datetime the
 * model needs to pin a specific row (SCRUM-381/382).
 *
 * SCRUM-438: these rows were matched by PHONE alone, and caller ID is
 * spoofable on the PSTN — so the lines deliberately carry NO attendee_name and
 * NO confirmation_code (both previously echoed). A number-spoofer must not be
 * able to extract the victim's identity or a code that doubles as a lookup/
 * mutation key. Same-minute ties (which only a code can separate — SCRUM-384)
 * are resolved by asking the CALLER for the code from their confirmation SMS,
 * not by reading codes out to them.
 */
async function describeDisambigOptions(
  rows: any[],
  tz: string,
  supabase: any,
  organizationId: string
): Promise<string> {
  const serviceIds = Array.from(
    new Set(rows.map((r: any) => r.service_type_id).filter(Boolean))
  );
  const serviceNames: Record<string, string> = {};
  if (serviceIds.length > 0) {
    const { data: serviceRows, error } = await supabase
      .from("service_types")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("id", serviceIds);
    if (error) {
      // Non-fatal — options fall back to date/time only.
      console.warn("Disambiguation service-name lookup failed:", { organizationId, error: error.message ?? error });
    }
    for (const st of serviceRows || []) serviceNames[st.id] = st.name;
  }

  return rows
    .map((a: any) => {
      const d = new Date(a.start_time);
      const dateStr = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
      const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
      const svc = a.service_type_id && serviceNames[a.service_type_id] ? ` for a ${serviceNames[a.service_type_id]}` : "";
      return `${dateStr} at ${timeStr}${svc} (datetime: ${toLocalIsoMinute(d, tz)})`;
    })
    .join("; ");
}

/**
 * SCRUM-415: bound repeated cancel/reschedule attempts (per org + caller phone)
 * so a confirmation code can't be brute-forced at scale. Fail-open — never block
 * a legitimate change on a rate-limiter hiccup. Returns a ToolResult when over
 * the limit, or null to proceed.
 */
async function enforceApptMutationRateLimit(
  supabase: ReturnType<typeof createAdminClient>,
  organizationId: string,
  phone: string | undefined
): Promise<ToolResult | null> {
  try {
    // Keyed per org + caller phone. Phone-less attempts share an "anon" bucket,
    // which is fine: a phone-less caller can never complete a code mutation
    // anyway (verifyPhonePossession treats an empty caller phone as
    // unverifiable), so the shared bucket only ever holds already-doomed
    // attempts.
    const digits = (phone || "").replace(/\D/g, "").slice(-9) || "anon";
    const rl = await rateLimitDistributed(supabase, `${organizationId}:${digits}`, "appt-mutate", "auth");
    if (!rl.allowed) {
      return {
        success: false,
        message:
          "There have been several attempts to change appointments from this number just now — please try again in a minute, or I can arrange a callback.",
      };
    }
  } catch {
    // Fail-open.
  }
  return null;
}

// SCRUM-438: identical wording whether a confirmation code matched or not — a
// voice attacker enumerating 6-digit codes must not get a different reply for
// "code exists but I can't verify the phone" vs "code doesn't exist" (oracle).
const CANCEL_NEEDS_BOOKING_PHONE_MSG =
  "For security, I need the phone number on the booking before I can change an appointment. Could you confirm that number?";

// SCRUM-438 (review fix): a production caller who withheld their caller ID
// cannot prove possession at all on this call — and the model-phone fallback
// must never apply outside test sessions (an attacker dials with #31# and
// echoes the victim's number). Generic refusal + the callback path, shared by
// cancel and reschedule, returned BEFORE any lookup so nothing is enumerable.
const WITHHELD_CALLER_ID_REFUSAL: ToolResult = {
  success: false,
  message:
    "For security, I can't make changes to appointments when the call comes from a private or blocked number. If you call back with your number showing, I can help right away — or I can arrange a callback from the team.",
};

export async function handleCancelAppointment(
  organizationId: string,
  args: { phone?: string; reason?: string; confirmation_code?: string; date?: string; datetime?: string; name?: string; email?: string },
  trusted?: TrustedCallContext
): Promise<ToolResult> {
  const { phone, confirmation_code } = args;
  const reason = args.reason ? sanitizeString(args.reason, 500) : undefined;
  const date = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : undefined;
  // SCRUM-259: accept exact datetime for precise cancel ("cancel the 10:15 AM one").
  // Sophie knows the exact time from the booking she just made.
  const datetime = args.datetime && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(args.datetime) ? args.datetime : undefined;

  // SCRUM-438: the trusted caller-ID state — re-validated here even though
  // the route checks it too (the handler is the security boundary).
  const callerId = resolveCallerId(trusted);

  // Withheld caller ID on a production call: possession is unverifiable and
  // the model-phone fallback must not apply — refuse before any lookup.
  if (callerId.state === "withheld") return WITHHELD_CALLER_ID_REFUSAL;

  if (!phone && !confirmation_code) {
    return {
      success: false,
      message:
        "I need your phone number to find your appointment.",
    };
  }

  const supabase = createAdminClient();

  // Key the rate limit by the verified caller ID when present — the model
  // can rotate its phone argument, but not the call's real From.
  const rlResult = await enforceApptMutationRateLimit(
    supabase,
    organizationId,
    callerId.state === "verified" ? callerId.phone : phone
  );
  if (rlResult) return rlResult;

  // SCRUM-438: the org's configured verification fields apply to mutations too.
  const verification = await getVerificationSettings(supabase, organizationId);

  // Try confirmation code first (exact match)
  if (confirmation_code) {
    const code = confirmation_code.trim();
    const { data: codeMatch, error: codeErr } = await (supabase as any)
      .from("appointments")
      .select("id, start_time, attendee_name, attendee_phone, attendee_email, service_type_id, external_id, provider, metadata, confirmation_code, status")
      .eq("organization_id", organizationId)
      .eq("confirmation_code", code)
      .in("status", ["confirmed", "pending"])
      .single();

    if (codeErr && codeErr.code !== "PGRST116") {
      // SCRUM-339: log the code's presence/length only — the value is a usable
      // mutation token and must never land in logs.
      console.error("Cancel: confirmation code lookup error:", { organizationId, codeLength: code.length, error: codeErr });
      return { success: false, message: "I'm having trouble looking up that code right now. Would you like me to have someone call you back?" };
    }
    if (codeMatch) {
      // SCRUM-415/438: a code match is not enough — the caller must hold the
      // booking's phone number (verified caller ID only on production calls;
      // the model-supplied argument only on test sessions).
      const possession = verifyPhonePossession(codeMatch, phone, callerId);
      if (possession === "match") {
        const factorFail = verifyKnowledgeFactors(codeMatch, { name: args.name, email: args.email }, verification);
        if (factorFail) return factorFail;
        return cancelSingleAppointment(supabase, organizationId, codeMatch, reason);
      }
      const hasCandidatePhone = callerId.state === "verified" || Boolean(phone?.trim());
      if (possession === "unverifiable" && !hasCandidatePhone) {
        // No phone available on the call at all — ask for it. Same reply the
        // no-code branch below gives, so a code hit stays indistinguishable.
        return { success: false, message: CANCEL_NEEDS_BOOKING_PHONE_MSG };
      }
      // "mismatch", or "unverifiable" because the BOOKING has no phone on file
      // while the caller supplied one: fall through EXACTLY like a wrong code —
      // any distinct reply (including NEEDS_BOOKING_PHONE for the phone-less
      // booking) would be a code-enumeration oracle. Logged for ops visibility
      // (no code/phone in the log — they're usable tokens, SCRUM-339).
      console.warn("[Cancel] Confirmation code matched but caller failed phone possession — treating as not found", { organizationId });
    }
  }

  if (!phone) {
    return { success: false, message: CANCEL_NEEDS_BOOKING_PHONE_MSG };
  }

  // SCRUM-438: reject degenerate phones ("anonymous", "8") before they reach
  // the DB — parity with the lookup guard PR #346 added. Required for the
  // anchored suffix match below to never degenerate toward '%'.
  if (!isValidPhoneNumber(phone)) {
    return {
      success: false,
      message:
        "That phone number doesn't look complete. Could you give me the full phone number the appointment was booked under?",
    };
  }

  // Fall back to phone lookup — only future appointments. SCRUM-438: end-
  // anchored last-9-digit suffix match (the form PR #346 gave lookup) instead
  // of an exact IN over synthesized format variants — it tolerates any stored
  // formatting, and the possession gate below re-verifies each row anyway.
  let query = (supabase as any)
    .from("appointments")
    .select("id, start_time, attendee_name, attendee_phone, attendee_email, service_type_id, external_id, provider, metadata, confirmation_code, status, created_at")
    .eq("organization_id", organizationId)
    .ilike("attendee_phone", phoneSuffixPattern(phone))
    .in("status", ["confirmed", "pending"])
    .gte("start_time", new Date().toISOString())
    .order("start_time", { ascending: true });

  // Consistent with rest of file — catch DB errors gracefully.
  const schedule = await getOrgSchedule(organizationId).catch(() => null);
  const tz = schedule?.timezone || "Australia/Sydney";

  // SCRUM-259: exact datetime match takes priority — used when cancelling
  // an appointment just booked in the same call ("cancel the 10:15 one").
  // Wrapped in try-catch to guard against malformed datetime strings that
  // pass the regex (e.g., "9999-99-99T99:99") but produce Invalid Date.
  try {
    if (datetime) {
      const dtUtc = ensureTimezoneOffset(datetime, tz);
      const dtMs = new Date(dtUtc).getTime();
      if (isNaN(dtMs)) throw new Error("Invalid datetime");
      const dtStart = new Date(dtMs - 15 * 60 * 1000).toISOString();
      const dtEnd = new Date(dtMs + 15 * 60 * 1000).toISOString();
      query = query.gte("start_time", dtStart).lte("start_time", dtEnd);
    } else if (date) {
      const dayStartUtc = ensureTimezoneOffset(`${date}T00:00:00`, tz);
      const dayEndUtc = ensureTimezoneOffset(`${date}T23:59:59`, tz);
      query = query.gte("start_time", dayStartUtc).lte("start_time", dayEndUtc);
    }
  } catch (dateErr) {
    console.warn("cancel_appointment: invalid date/datetime, skipping date filter:", { date, datetime, error: dateErr });
    // Fall through without date filter — phone-only lookup is still valid.
  }

  // Fetch up to 5 matches — if there are multiple, ask Sophie to disambiguate.
  query = query.limit(5);

  const { data: appointments, error: queryError } = await query;

  if (queryError) {
    console.error("Failed to query appointments for cancellation:", { organizationId, phone, error: queryError });
    return {
      success: false,
      message:
        "I'm having trouble looking up your appointment right now. Would you like me to have someone call you back?",
    };
  }

  // SCRUM-438: possession gate BEFORE anything is listed or cancelled. Each
  // candidate row's attendee_phone must match the verified caller ID (or the
  // model phone when there is no caller ID — browser test calls). This blocks
  // a model echoing a victim's number from cancelling — or even ENUMERATING —
  // a stranger's appointments, and weeds out NANP last-9 suffix collisions.
  const owned = ((appointments || []) as any[]).filter(
    (a) => verifyPhonePossession(a, phone, callerId) === "match"
  );

  if (!owned.length) {
    // Same message whether nothing matched or matches failed possession —
    // a non-owner learns nothing about the victim's schedule.
    return {
      success: false,
      message:
        "I wasn't able to find an upcoming appointment with that phone number. Could you double-check the number, or tell me the date of the appointment?",
    };
  }

  // SCRUM-438: org-configured knowledge factors (name/email) on the SPECIFIC
  // row about to be cancelled — rows sharing a phone can carry different
  // names (e.g. family members on one number).
  const knowledgeGate = (appt: any): ToolResult | null =>
    verifyKnowledgeFactors(appt, { name: args.name, email: args.email }, verification);

  // Single match — cancel directly.
  if (owned.length === 1) {
    const factorFail = knowledgeGate(owned[0]);
    if (factorFail) return factorFail;
    return cancelSingleAppointment(supabase, organizationId, owned[0], reason);
  }

  // SCRUM-381: the model passed an exact datetime but several rows fall inside
  // the ±15-min window (e.g. two appointments less than 15 min apart). Pin the
  // CLOSEST one rather than looping on disambiguation forever. The disambiguation
  // reply hands the model each option's exact stored time, so the value it sends
  // back lands nearest the intended row.
  if (datetime) {
    let dtMs = NaN;
    try {
      dtMs = new Date(ensureTimezoneOffset(datetime, tz)).getTime();
    } catch {
      dtMs = NaN;
    }
    if (!Number.isNaN(dtMs)) {
      const closest = pickClosestAppointment(owned, dtMs);
      if (closest) {
        const factorFail = knowledgeGate(closest);
        if (factorFail) return factorFail;
        return cancelSingleAppointment(supabase, organizationId, closest, reason);
      }
    }
  }

  // SCRUM-381: multiple matches and no exact datetime to pin one — NEVER guess
  // which to cancel. A previous "auto-cancel the most recently-created match"
  // heuristic mis-fired badly: after the caller rescheduled appointment A
  // (creating a fresh row), then asked to cancel a DIFFERENT appointment B, it
  // cancelled the just-rescheduled A and thrashed in a rebook/cancel loop. Always
  // disambiguate, and hand the model each option's EXACT datetime to pass back.
  // ("Cancel the one I just booked" still works: the model knows that
  // appointment's datetime and passes it → exact ±15-min match → the single-match
  // branch above cancels it directly, no disambiguation needed.)
  // SCRUM-438: the options deliberately carry NO names and NO confirmation
  // codes (see describeDisambigOptions) — same-minute ties (SCRUM-384) are
  // resolved by asking the CALLER for the code from their confirmation SMS.
  const options = await describeDisambigOptions(owned, tz, supabase, organizationId);
  return {
    success: false,
    message: `This caller has ${owned.length} upcoming appointments: ${options}. Confirm with the caller which ONE they mean, then call cancel_appointment again with that appointment's exact datetime. If two are at the same time, ask the caller for the 6-digit confirmation code from their booking confirmation and pass it as confirmation_code — do NOT cancel without pinning exactly one appointment.`,
  };
}

async function cancelSingleAppointment(
  supabase: any,
  organizationId: string,
  appointment: any,
  reason?: string,
  // SCRUM-388: a reschedule frees the OLD row through this same path but wants it
  // marked `rescheduled` (a distinct lifecycle state, not a cancellation) and must
  // NOT send the caller a "your appointment is cancelled" SMS for what is a move —
  // the new booking's confirmation already covers it.
  opts?: { terminalStatus?: "cancelled" | "rescheduled"; suppressSms?: boolean }
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

    // SCRUM-12: propagate to the practice's Cliniko diary BEFORE freeing the
    // local row — cancelling only locally would silently desync the real
    // appointment book (a failure here falls to the outer catch, so the caller
    // hears the trouble message and the appointment stays intact on both sides).
    if (appointment.provider === "cliniko") {
      const clinikoResolution = await getActiveClinikoIntegration(organizationId);
      if (clinikoResolution.kind === "error") {
        // Transient fault — must NOT cancel locally (that would free the slot
        // while the real Cliniko appointment stands). Surface trouble instead.
        return {
          success: false,
          message:
            "I'm having trouble cancelling the appointment right now. Would you like me to have someone call you back to help with this?",
        };
      }
      if (clinikoResolution.kind === "ok") {
        // clinikoCancelExternal throws on a lost external_id (a row whose link
        // patch failed at booking → the Cliniko appointment still exists) so the
        // outer catch surfaces trouble rather than falsely reporting "cancelled".
        await clinikoCancelExternal(clinikoResolution.ctx, organizationId, appointment, reason || "Cancelled by caller via Phondo");
      } else {
        // kind === "none": org genuinely disconnected — they manage the diary
        // manually now, so a local-only cancel is correct.
        console.warn("[Cliniko] cancel: integration disconnected — cancelling locally only", {
          appointmentId: appointment.id,
        });
      }
    }

    // Update DB status to the requested terminal state (default: cancelled). Either
    // way the row leaves the confirmed/pending allowlist, so its slot frees.
    const { error: cancelDbError } = await (supabase as any)
      .from("appointments")
      .update({ status: opts?.terminalStatus ?? "cancelled" })
      .eq("id", appointment.id);

    if (cancelDbError) {
      console.error("Failed to update appointment status:", cancelDbError);
      return {
        success: false,
        message:
          "I'm having trouble cancelling the appointment right now. Would you like me to have someone call you back to help with this?",
      };
    }

    // Invalidate voice server schedule cache after the response (SCRUM-410: bare
    // fire-and-forget can be dropped when Vercel freezes the function).
    runAfterResponse(async () => {
      try {
        await invalidateVoiceScheduleCache(organizationId);
      } catch (err) {
        console.warn("[VoiceCacheInvalidate] after-response failed:", err instanceof Error ? err.message : err);
      }
    });

    const schedule = await getOrgSchedule(organizationId).catch(() => null);
    const timezone = schedule?.timezone || "Australia/Sydney";
    const { dateStr, timeStr } = formatDateTimeForVoice(
      new Date(appointment.start_time),
      timezone
    );

    // SCRUM-240 Phase 1: send cancellation SMS to the caller (fire-and-forget).
    // User explicitly decided we should send one. SCRUM-388: skipped on a reschedule
    // (suppressSms) — a "cancelled" text for a move is misleading.
    if (appointment.attendee_phone && !opts?.suppressSms) {
      // after() so the cancellation SMS survives Vercel's post-response freeze (SCRUM-410).
      runAfterResponse(async () => {
        try {
          await sendCancellationSMS(
            organizationId,
            appointment.attendee_phone,
            new Date(appointment.start_time),
            timezone,
            appointment.id
          );
        } catch (err) {
          console.error("Cancellation SMS failed:", { organizationId, error: err });
        }
      });
    }

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

/**
 * SCRUM-377: ATOMIC reschedule — move an existing appointment to a new time in
 * ONE verified server-side operation.
 *
 * Why this exists: the LLM was rescheduling by emitting cancel_appointment +
 * book_appointment in one turn. The SCRUM-372 cancel-confirmation gate (rightly)
 * holds the cancel, the book succeeds, and the model never completes the held
 * cancel — leaving the OLD appointment in place (a duplicate, observed on real
 * calls 2026-06-05). Doing it server-side removes the two-tool race entirely.
 *
 * Ordering is deliberate: we BOOK THE NEW SLOT FIRST and only cancel the old one
 * after the new is secured. If the new slot is unavailable, the caller keeps
 * their original appointment (we never strand them). If the new books but the old
 * cancel fails, we report the new booking honestly AND flag that the old wasn't
 * removed — never a silent duplicate.
 */
// SCRUM-438: identical wording whether a confirmation code matched or not
// (code-enumeration oracle — see CANCEL_NEEDS_BOOKING_PHONE_MSG).
const RESCHEDULE_NEEDS_BOOKING_PHONE_MSG =
  "For security, I need the phone number on the booking before I can move an appointment. Could you confirm that number?";

export async function handleRescheduleAppointment(
  organizationId: string,
  args: {
    phone?: string;
    confirmation_code?: string;
    current_date?: string;
    current_datetime?: string;
    new_datetime?: string;
    first_name?: string;
    last_name?: string;
    name?: string;
    email?: string;
    notes?: string;
    service_type_id?: string;
    practitioner_id?: string;
  },
  trusted?: TrustedCallContext
): Promise<ToolResult> {
  const { phone, confirmation_code, new_datetime } = args;

  // SCRUM-438: the trusted caller-ID state — re-validated here even though
  // the route checks it too (the handler is the security boundary).
  const callerId = resolveCallerId(trusted);

  // Withheld caller ID on a production call: possession is unverifiable and
  // the model-phone fallback must not apply — refuse before any lookup.
  if (callerId.state === "withheld") return WITHHELD_CALLER_ID_REFUSAL;

  if (!new_datetime) {
    return { success: false, message: "What date and time would you like to move the appointment to?" };
  }
  if (!phone && !confirmation_code) {
    return { success: false, message: "I need the phone number on the booking to find the appointment you'd like to reschedule." };
  }

  try {
    const supabase = createAdminClient();

    const rlResult = await enforceApptMutationRateLimit(
      supabase,
      organizationId,
      callerId.state === "verified" ? callerId.phone : phone
    );
    if (rlResult) return rlResult;

    // SCRUM-438: the org's configured verification fields apply to mutations too.
    const verification = await getVerificationSettings(supabase, organizationId);

    const schedule = await getOrgSchedule(organizationId).catch(() => null);
    const tz = schedule?.timezone || "Australia/Sydney";

    // SCRUM-390: include practitioner_id / attendee_email / notes so a reschedule
    // can carry them over — a move must only change what the caller asked for.
    const selectCols =
      "id, start_time, attendee_name, attendee_phone, attendee_email, service_type_id, practitioner_id, notes, external_id, provider, metadata, confirmation_code, status, created_at";
    const fmtWhen = (iso: string) => {
      const d = new Date(iso);
      const dateStr = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
      const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
      return `${dateStr} at ${timeStr}`;
    };
    // SCRUM-382: build a disambiguation reply that the model can actually
    // resolve — each option carries its exact datetime to pass back as
    // current_datetime. SCRUM-438: the options deliberately carry NO
    // attendee_name and NO confirmation_code (these rows were matched by a
    // spoofable phone — see describeDisambigOptions); same-minute ties
    // (SCRUM-384) are resolved by asking the CALLER for their code.
    const buildRescheduleDisambig = async (rows: any[]): Promise<ToolResult> => {
      const options = await describeDisambigOptions(rows, tz, supabase, organizationId);
      return {
        success: false,
        message: `I found more than one upcoming appointment for this caller: ${options}. Which one would you like to move? Confirm with the caller, then call reschedule_appointment again with that appointment's exact current_datetime. If two are at the same time, ask the caller for the 6-digit confirmation code from their booking confirmation and pass it as confirmation_code.`,
      };
    };

    // ── 1. Find the EXISTING appointment (do NOT cancel yet) ──
    let existing: any = null;

    // (a) Confirmation code — most precise. Handle 0/1/many explicitly: a code
    // that matches multiple rows must NOT silently fall through to a fuzzy phone
    // match (it would discard the precise identifier the caller gave).
    if (confirmation_code) {
      const { data: codeRows, error: codeErr } = await (supabase as any)
        .from("appointments")
        .select(selectCols)
        .eq("organization_id", organizationId)
        .eq("confirmation_code", confirmation_code.trim())
        .in("status", ["confirmed", "pending"])
        .limit(2);
      if (codeErr) {
        console.error("Reschedule: confirmation code lookup error:", { organizationId, error: codeErr });
        return { success: false, message: "I'm having trouble looking up that appointment right now. Would you like me to have someone call you back?" };
      }
      if (codeRows && codeRows.length === 1) {
        // SCRUM-415/438: a code match is not enough — the caller must hold the
        // booking's phone number (verified caller ID only on production calls;
        // selectCols includes attendee_phone).
        const possession = verifyPhonePossession(codeRows[0], phone, callerId);
        const hasCandidatePhone = callerId.state === "verified" || Boolean(phone?.trim());
        if (possession === "match") {
          existing = codeRows[0];
        } else if (possession === "unverifiable" && !hasCandidatePhone) {
          // No phone available on the call at all — ask for it. Same reply the
          // phone-less branch below gives, so a code hit stays indistinguishable.
          return { success: false, message: RESCHEDULE_NEEDS_BOOKING_PHONE_MSG };
        } else {
          // "mismatch", or "unverifiable" because the BOOKING has no phone on
          // file while the caller supplied one: fall through EXACTLY like a
          // wrong code (no enumeration oracle) — the phone lookup below
          // proceeds with the caller's own number. Logged without the
          // code/phone (usable tokens, SCRUM-339).
          console.warn("[Reschedule] Confirmation code matched but caller failed phone possession — treating as not found", { organizationId });
        }
      } else if (codeRows && codeRows.length > 1) {
        console.warn("Reschedule: confirmation code matched multiple appointments:", { organizationId });
        return { success: false, message: "That confirmation code matches more than one appointment. Could you tell me the date and time of the one you'd like to move?" };
      }
      // 0 rows → fall through to phone lookup.
    }

    // (b) Phone lookup. This tool cancels the old appointment WITHOUT the
    // SCRUM-372 cancel-confirmation gate, so precision is the only safeguard:
    // auto-select ONLY when an exact current_datetime matches a single row, OR
    // the caller has exactly ONE upcoming appointment. With multiple upcoming and
    // no exact time, never guess which to cancel — ask for the exact time.
    if (!existing) {
      if (!phone) {
        return { success: false, message: RESCHEDULE_NEEDS_BOOKING_PHONE_MSG };
      }
      // SCRUM-438: degenerate-phone guard + end-anchored suffix match —
      // parity with the cancel path and lookup (PR #346).
      if (!isValidPhoneNumber(phone)) {
        return {
          success: false,
          message:
            "That phone number doesn't look complete. Could you give me the full phone number the appointment was booked under?",
        };
      }
      const { data: upcoming, error: qErr } = await (supabase as any)
        .from("appointments")
        .select(selectCols)
        .eq("organization_id", organizationId)
        .ilike("attendee_phone", phoneSuffixPattern(phone))
        .in("status", ["confirmed", "pending"])
        .gte("start_time", new Date().toISOString())
        .order("start_time", { ascending: true })
        .limit(5);
      if (qErr) {
        console.error("Reschedule: appointment lookup error:", { organizationId, error: qErr });
        return { success: false, message: "I'm having trouble finding your appointment right now. Would you like me to have someone call you back?" };
      }
      // SCRUM-438: possession gate BEFORE anything is listed or moved — each
      // row's attendee_phone must match the verified caller ID (or the model
      // phone when there is no caller ID). A model echoing a victim's number
      // can no longer move or enumerate a stranger's appointments.
      const upcomingOwned = ((upcoming || []) as any[]).filter(
        (a) => verifyPhonePossession(a, phone, callerId) === "match"
      );
      if (!upcomingOwned.length) {
        // Same message whether nothing matched or matches failed possession.
        return { success: false, message: "I couldn't find an upcoming appointment with that phone number. Could you double-check the number, or tell me the date and time of your current appointment?" };
      }

      const currentDatetime = args.current_datetime && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(args.current_datetime) ? args.current_datetime : undefined;
      const date = args.current_date && /^\d{4}-\d{2}-\d{2}$/.test(args.current_date) ? args.current_date : undefined;

      if (currentDatetime) {
        let dtMs = NaN;
        try { dtMs = new Date(ensureTimezoneOffset(currentDatetime, tz)).getTime(); } catch { dtMs = NaN; }
        const matches = isNaN(dtMs) ? [] : upcomingOwned.filter((a: any) => Math.abs(new Date(a.start_time).getTime() - dtMs) <= 15 * 60 * 1000);
        if (matches.length === 1) {
          existing = matches[0];
        } else if (matches.length > 1) {
          // SCRUM-382: two appointments <15 min apart both fall in the window —
          // pin the CLOSEST to the exact time the model passed (it echoed the
          // option's exact datetime from the disambiguation message) instead of
          // bailing, which would loop forever. Mirrors the cancel path (SCRUM-381).
          const closest = pickClosestAppointment(matches, dtMs);
          if (closest) {
            existing = closest;
          } else {
            // SCRUM-384: equidistant tie (e.g. two same-minute appointments across
            // two practitioners) — pinning would cancel-and-move a NON-DETERMINISTIC
            // guess. Disambiguate by confirmation_code instead of guessing.
            return buildRescheduleDisambig(matches);
          }
        } else {
          return { success: false, message: "I couldn't find an appointment at that exact time. Could you tell me the day and time of the appointment you'd like to move?" };
        }
      } else if (upcomingOwned.length === 1) {
        existing = upcomingOwned[0]; // unambiguous — only one upcoming appointment
      } else {
        // Multiple upcoming, no exact time — never guess. Ask for the exact time,
        // narrowing the list to the given date when one was provided.
        let list = upcomingOwned;
        if (date) {
          try {
            const dayStart = new Date(ensureTimezoneOffset(`${date}T00:00:00`, tz)).getTime();
            const dayEnd = new Date(ensureTimezoneOffset(`${date}T23:59:59`, tz)).getTime();
            const onDate = upcomingOwned.filter((a: any) => { const t = new Date(a.start_time).getTime(); return t >= dayStart && t <= dayEnd; });
            if (onDate.length) list = onDate;
          } catch { /* keep full list */ }
        }
        // SCRUM-382: hand the model each option's exact datetime so it can pin
        // one row instead of looping (same-minute ties → ask the caller for
        // their code, per SCRUM-438).
        return buildRescheduleDisambig(list);
      }
    }

    // SCRUM-438: org-configured knowledge factors (name/email) on the pinned
    // appointment — single choke point for both the code and phone paths,
    // BEFORE anything is booked or freed.
    const factorFail = verifyKnowledgeFactors(existing, { name: args.name, email: args.email }, verification);
    if (factorFail) return factorFail;

    // ── 2. Book the NEW appointment FIRST (never cancel before the new slot is
    // secured — a failed book then leaves the caller's original intact).
    // NOTE (SCRUM-377 follow-up): because the old appointment is still live here,
    // the DB no-overlap constraint rejects a move INTO the old appointment's own
    // slot (same time, or a sub-slot shift). That case currently fails SAFE
    // ("that time isn't available", original kept) rather than duplicating; an
    // in-place UPDATE would handle it and is tracked as a follow-up.
    // SCRUM-386/390: a reschedule MOVES a known booking — it must change ONLY what
    // the caller asked for. Every field of the new booking defaults to the existing
    // appointment unless the caller explicitly supplied a new value. So a time-only
    // move keeps the same practitioner/service/name/email/notes; a "change my dentist"
    // request changes only the practitioner; etc. (`new_datetime` is the one field
    // the reschedule always sets.)
    // SCRUM-438: `args.name` and `args.email` are now VERIFICATION slots (the
    // details on the existing booking — see the tool schema), not edits.
    // Passing them through would let a partial verification name ("Jane"
    // passing a contains-check against "Jane Smith") or a model-collected
    // verification email silently overwrite the carried-over contact details.
    // Renames still work via a complete first_name + last_name.
    // SCRUM-444: also split carried_refs OUT of the booking args into the
    // internal-only parameter — it must never travel inside `args` (the
    // LLM-populated shape) or a model could mark a freshly-supplied deactivated
    // ref as "carried" to bypass the is_active gate.
    const { carried_refs, ...rescheduledBooking } = resolveRescheduledBooking(
      { ...args, name: undefined, email: undefined },
      existing
    );
    const bookResult = await handleBookAppointment(
      organizationId,
      { datetime: new_datetime, ...rescheduledBooking },
      { carriedRefs: carried_refs }
    );

    if (!bookResult.success) {
      return { success: false, message: bookResult.message };
    }

    // ── 3. New is secured — now free the OLD one. SCRUM-388: mark it `rescheduled`
    // (a distinct lifecycle state, not a cancellation) and suppress the misleading
    // "your appointment is cancelled" SMS — this was a move, and the new booking's
    // confirmation already covers it. Either status frees the slot (allowlist). ──
    const oldWhen = fmtWhen(existing.start_time);
    const newAppointmentId = (bookResult.data as any)?.appointmentId;
    const cancelResult = await cancelSingleAppointment(
      supabase,
      organizationId,
      existing,
      "Rescheduled by caller",
      { terminalStatus: "rescheduled", suppressSms: true }
    );
    if (!cancelResult.success) {
      // New booked but old NOT freed — a real duplicate now exists. This is the
      // exact event SCRUM-377 exists to prevent, so it must page on-call, not just
      // hit the logs. We still return success:true (a real new appointment exists)
      // and tell the caller honestly the old one wasn't removed.
      // Telemetry carries only opaque DB ids (org + appointment UUIDs) — NOT the
      // confirmation code, which is a usable token a caller could cancel/look up
      // with, so it must not land in Sentry/logs (SCRUM-339). The team finds the
      // orphan by org + appointment id.
      console.error("[Reschedule] New appointment booked but failed to free the old one — duplicate created", {
        organizationId, oldAppointmentId: existing.id, newAppointmentId, newDatetime: new_datetime,
      });
      Sentry.withScope((scope) => {
        scope.setLevel("error");
        scope.setTag("bug", "reschedule_orphan_old_appointment");
        scope.setExtras({ organizationId, oldAppointmentId: existing.id, newAppointmentId, newDatetime: new_datetime });
        Sentry.captureMessage("Reschedule left an un-cancelled old appointment (duplicate risk)");
      });
      return {
        success: true, // a new appointment genuinely exists
        message: `${bookResult.message} I couldn't automatically remove your earlier appointment on ${oldWhen} — I've flagged it for the team to clear, so please disregard that one.`,
        data: { ...(bookResult.data || {}), oldCancelled: false, oldAppointmentId: existing.id },
      };
    }

    // SCRUM-388: link the new row to the one it superseded — the chain that drives
    // the appointment-history view. Best-effort: the reschedule already succeeded, so
    // a failed link is metadata only; log and continue, never fail the move.
    if (newAppointmentId) {
      const { error: linkErr } = await (supabase as any)
        .from("appointments")
        .update({ rescheduled_from_id: existing.id })
        .eq("id", newAppointmentId)
        .eq("organization_id", organizationId);
      if (linkErr) {
        console.warn("[Reschedule] Failed to set rescheduled_from_id link (non-fatal)", {
          organizationId, newAppointmentId, oldAppointmentId: existing.id, error: linkErr.message ?? linkErr,
        });
      }
    }

    return {
      success: true,
      message: `Done — I've moved your appointment from ${oldWhen}. ${bookResult.message}`,
      data: { ...(bookResult.data || {}), oldCancelled: true, oldAppointmentId: existing.id, newAppointmentId },
    };
  } catch (err: any) {
    console.error("Reschedule appointment error:", { organizationId, message: err?.message, stack: err?.stack });
    return {
      success: false,
      message: "I'm having trouble rescheduling that right now. Would you like me to have someone call you back to help with this?",
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
    const timezone = calSchedule?.timezone || "Australia/Sydney";
    const tzAwareDatetime = ensureTimezoneOffset(datetime, timezone);

    // Reject bookings in the past
    if (new Date(tzAwareDatetime).getTime() < Date.now()) {
      return {
        success: false,
        message: "That time has already passed. Would you like to book a later time today or a different day?",
      };
    }

    // Reject bookings too far in the future (finding #51)
    if (new Date(tzAwareDatetime).getTime() > Date.now() + MAX_BOOKING_HORIZON_MS) {
      return {
        success: false,
        message:
          "I can only book appointments up to a year in advance. Would you like to pick a closer date?",
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

    // Record in our database — rollback Cal.com booking if this fails.
    // SCRUM-431 (finding #49): retry confirmation-code collisions here too.
    let calConfirmationCode = generateConfirmationCode();
    let dbError: { code?: string; message?: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await (supabase as any)
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
      dbError = error;
      if (!dbError) break;
      if (dbError.code === "23505" && /confirmation_code/i.test(dbError.message || "")) {
        console.warn(`[Booking] Cal.com record code collision (attempt ${attempt + 1}) — regenerating`);
        calConfirmationCode = generateConfirmationCode();
        continue;
      }
      break; // non-collision error → rollback below
    }

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

    if (error.message?.includes("timed out after 10s")) {
      // SCRUM-432 review: a timed-out createBooking may have COMPLETED on
      // Cal.com's side — there may be an orphaned booking on the business's
      // calendar with no local record (findable: metadata.source =
      // "ai_receptionist" + organizationId). Flag loudly for reconciliation.
      console.error("[Booking] Cal.com timeout — POSSIBLE ORPHANED Cal.com booking needing manual reconciliation:", { organizationId });
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
    const timezone = schedule?.timezone || "Australia/Sydney";

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
  requestedPractitionerId?: string,
  // SCRUM-444 review: refs carried over from an existing booking by a reschedule
  // (vs supplied by the caller) — see handleBookAppointment's internal param.
  carriedRefs?: { service_type?: boolean; practitioner?: boolean }
): Promise<ToolResult> {
  const supabase = createAdminClient();

  // 0. SCRUM-425 (finding #43): service_type_id / practitioner_id are
  // LLM/caller-supplied — verify both belong to THIS organization before any
  // use. This is the single choke point in front of the appointments INSERT
  // (direct booking AND reschedule route through here), reusing the same
  // validator as the dashboard routes. Previously a cross-org id flowed
  // straight into the insert (getServiceType's null result was ignored, and
  // a requested practitioner was only checked when a service-type
  // practitioner list happened to resolve).
  // SCRUM-444: `requireActive` — a caller must never be booked with a
  // deactivated practitioner or service. This closes the empty-practitioner-
  // list gap below, where neither per-service nor standalone is_active
  // checks used to run.
  // SCRUM-444 review: per-ref — a ref CARRIED from the appointment being
  // rescheduled (not supplied by the caller) is validated org-scope-only,
  // matching the dashboard's carried-ref semantics. Otherwise a time-only
  // reschedule of a booking whose service/practitioner was since deactivated
  // dead-ends unrecoverably (every retry re-carries the ref).
  if (serviceTypeId || requestedPractitionerId) {
    try {
      const refError = await validateOrgScopedRefs(
        supabase,
        organizationId,
        { serviceTypeId, practitionerId: requestedPractitionerId },
        {
          requireActive: {
            serviceType: !carriedRefs?.service_type,
            practitioner: !carriedRefs?.practitioner,
          },
        },
      );
      if (refError) {
        console.error("[Booking] Rejected cross-org/unknown reference:", {
          organizationId, serviceTypeId, requestedPractitionerId, refError,
        });
        return {
          success: false,
          message:
            "I couldn't match that appointment type or practitioner to what this business currently offers. Could you tell me again what you'd like to book?",
        };
      }
    } catch (error) {
      // Fail CLOSED: an unverified reference must never reach the insert.
      // The caller gets the graceful callback offer, same as other DB-error
      // paths in this flow. Sentry because this gate actively refuses
      // BOOKINGS (revenue events) — a systematic validator failure must page,
      // not hide in function logs (SCRUM-425 review).
      console.error("[Booking] Org-ref validation failed — refusing to book:", { organizationId, error });
      Sentry.withScope((scope) => {
        scope.setLevel("error");
        scope.setTag("bug", "org_ref_validation_db_error");
        scope.setExtras({ organizationId });
        Sentry.captureMessage("Booking org-ref validation failed — booking refused (fail-closed)");
      });
      return {
        success: false,
        message:
          "I'm having trouble verifying those appointment details right now. Let me take your information and have someone call you back.",
      };
    }
  }

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

  const internalTimezone = schedule?.timezone || "Australia/Sydney";
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

  // Reject bookings too far in the future (finding #51)
  if (startDate.getTime() > Date.now() + MAX_BOOKING_HORIZON_MS) {
    return {
      success: false,
      message:
        "I can only book appointments up to a year in advance. Would you like to pick a closer date?",
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

    // Org ownership AND is_active are both guaranteed by the step-0
    // validateOrgScopedRefs gate (SCRUM-425 + SCRUM-444 requireActive), so
    // the standalone is_active re-query that used to live here is gone.

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

  // SCRUM-431 (finding #49): the 6-digit confirmation code is UNIQUE
  // TABLE-WIDE (appointments_confirmation_code_key) and codes never recycle,
  // so collision odds grow with lifetime rows (N/900k per attempt) — a
  // collision previously failed the whole booking. Retry with a fresh code;
  // only 23505s naming the code constraint retry. Per-org uniqueness is the
  // long-term fix (SCRUM-450).
  let appointment: { id: string; confirmation_code: string } | null = null;
  let confirmationCode = generateConfirmationCode();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error: dbError } = await (supabase as any)
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

    if (!dbError) {
      appointment = data;
      break;
    }
    if (dbError.code === "23505" && /confirmation_code/i.test(dbError.message || "")) {
      console.warn(`[Booking] Confirmation-code collision (attempt ${attempt + 1}) — regenerating`);
      confirmationCode = generateConfirmationCode();
      continue;
    }
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

  if (!appointment) {
    console.error("[Booking] Confirmation-code collision retries exhausted");
    return {
      success: false,
      message:
        "I'm having trouble completing the booking right now. Let me take your information and have someone call you back to confirm the appointment.",
    };
  }

  // 4. Send notification (SCRUM-240 Phase 1: pass appointment.id so the SMS
  // is tracked in appointment_confirmations and Twilio status callbacks can
  // update delivery state)
  const timezone = schedule?.timezone || "Australia/Sydney";
  sendNotification(organizationId, phone, sanitizedName, startDate, timezone, confirmationCode, appointment.id);
  const { dateStr, timeStr } = formatDateTimeForVoice(startDate, timezone);

  const practitionerNote = assignedPractitionerName
    ? ` with ${assignedPractitionerName}`
    : "";

  // Invalidate voice server schedule cache after the response (SCRUM-410: bare
  // fire-and-forget can be dropped when Vercel freezes the function).
  runAfterResponse(async () => {
    try {
      await invalidateVoiceScheduleCache(organizationId);
    } catch (err) {
      console.warn("[VoiceCacheInvalidate] after-response failed:", err instanceof Error ? err.message : err);
    }
  });

  return {
    success: true,
    message: `I've booked your appointment for ${dateStr} at ${timeStr}${practitionerNote}. The appointment is confirmed. Is there anything else I can help you with?`,
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
  confirmationCode?: string,
  // SCRUM-240 Phase 1: optional appointment.id so the confirmation SMS is
  // tracked in the new appointment_confirmations table.
  appointmentId?: string
) {
  // SCRUM-410: sendNotification is invoked un-awaited from bookInternal and the
  // Cal.com path, so these were bare fire-and-forget and could be dropped when
  // Vercel freezes the function after the response. Schedule both via after()
  // (independently, so one failing doesn't skip the other). The customer-facing
  // confirmation SMS in particular is a flagship feature — it must not vanish.
  runAfterResponse(async () => {
    try {
      await sendAppointmentNotification({
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
        timezone,
        confirmationCode,
      });
    } catch (err) {
      console.error("Failed to send appointment notification:", err);
    }
  });

  // SMS confirmation to the caller (include confirmation code)
  runAfterResponse(async () => {
    try {
      await sendAppointmentConfirmationSMS(organizationId, phone, appointmentDate, timezone, confirmationCode, appointmentId);
    } catch (err) {
      console.error("Appointment confirmation SMS failed:", { organizationId, error: err });
    }
  });
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
  },
  trusted?: TrustedCallContext
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

  // SCRUM-482: a lookup reads the local mirror, so for a Cliniko org reconcile it
  // first — otherwise "is my appointment still on?" can confirm a slot the
  // practice already cancelled in Cliniko. Freshness-gated + never fatal: the
  // whole block is guarded so a resolution/reconcile failure degrades to reading
  // the mirror as-is (a no-op if availability/book already reconciled this call).
  try {
    const clinikoLookupResolution = await getActiveClinikoIntegration(organizationId);
    if (clinikoLookupResolution.kind === "ok") {
      await reconcileClinikoOrg(clinikoLookupResolution.ctx).catch(() => {});
    }
  } catch {
    // ignore — never let mirror-reconciliation break a lookup
  }

  // Parse verification settings (structured object or legacy array) — shared
  // with the mutation handlers since SCRUM-438.
  const settings: VerificationSettings = parseVerificationSettings(org.appointment_verification_fields);
  const verificationMethod = settings.method;
  const verificationFields = settings.fields;
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

  // 2a½. SCRUM-505: VERIFIED-CALLER-ID LOOKUP.
  // On a real inbound call the voice server threads the VERIFIED caller ID as a
  // trusted, model-inaccessible field — a possession PROOF, unlike the
  // model-supplied `args.phone`, which the model can only guess (this exact gap
  // made a caller's own upcoming appointment un-findable). When the org uses the
  // phone factor and we hold a verified caller ID, pin the caller's OWN upcoming
  // appointments by it, then confirm the org's knowledge factor TOLERANTLY so an
  // STT-mangled name ("Makhoul" heard as "Macool") still confirms. Test/browser
  // sessions (no trusted caller ID) and non-phone-factor orgs fall through to the
  // legacy field-based path below, unchanged.
  const callerId = resolveCallerId(trusted);
  const verifiedCallerPhone = callerId.state === "verified" ? callerId.phone : undefined;
  const usesNameFactor = verificationFields.includes("name");
  const usesEmailFactor = verificationFields.includes("email");
  // A `date_of_birth` factor is NOT enforced here — appointments have no DOB
  // column yet (SCRUM-506). Safe: this branch still gates on VERIFIED possession
  // (strictly stronger than the legacy path's spoofable model phone) and pulls
  // no identity when there's no name/email factor. SCRUM-506 adds the column +
  // exact DOB check + the settings UI.

  if (verificationFields.includes("phone") && verifiedCallerPhone) {
    // A required knowledge factor not yet captured — ask for it before revealing
    // anything, rather than listing appointments off caller ID alone.
    if (usesNameFactor && !args.name?.trim()) {
      return { success: false, message: "To find your appointment, what's the full name it's booked under?" };
    }
    if (usesEmailFactor && !args.email?.trim()) {
      return { success: false, message: "To find your appointment, what's the email address it's booked under?" };
    }

    // Only fetch the stored name when a name/email factor will consume it
    // (SCRUM-437: never pull identity for a phone-only match).
    const includeIdentity = usesNameFactor || usesEmailFactor;
    const suffix = verifiedCallerPhone.replace(/\D/g, "").slice(-9);
    const { data: pinnedRows, error: pinError } = await (supabase as any)
      .from("appointments")
      .select(
        `id, ${includeIdentity ? "attendee_name, " : ""}attendee_phone, attendee_email, start_time, end_time, duration_minutes, status, service_type_id, practitioner_id`
      )
      .eq("organization_id", organizationId)
      .in("status", ["confirmed", "pending"])
      .gte("start_time", new Date().toISOString()) // Only future appointments
      .ilike("attendee_phone", `%${suffix}`)
      .order("start_time", { ascending: true })
      .limit(10);

    if (pinError) {
      console.error("Appointment lookup (verified caller ID) error:", pinError);
      return { success: false, message: "I'm having trouble looking up appointments right now. Would you like me to arrange a callback instead?" };
    }

    // The ilike suffix is a cheap prefilter; verifyPhonePossession is the precise
    // (NANP-aware) ownership check, against the VERIFIED caller ID only.
    let owned = (pinnedRows || []).filter(
      (a: any) => verifyPhonePossession(a, undefined, callerId) === "match"
    );
    // Knowledge factor(s) on the possessed appointments: name is TOLERANT
    // (STT/spelling drift), email is exact when supplied.
    if (usesNameFactor) {
      owned = owned.filter((a: any) => namesMatch(args.name, a.attendee_name));
    }
    if (usesEmailFactor && args.email?.trim()) {
      const givenEmail = args.email.trim().toLowerCase();
      owned = owned.filter((a: any) => (a.attendee_email || "").toLowerCase() === givenEmail);
    }

    // Anti-enumeration: a factor mismatch returns the SAME line as a genuine
    // not-found, so a spoofed caller ID can't probe who holds a booking.
    if (owned.length === 0) {
      return { success: true, message: LOOKUP_NO_MATCH_MESSAGE };
    }
    return formatAppointmentResult(owned, timezone, supabase);
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

  // SCRUM-437: caller ID is trivially spoofable on the PSTN, so a match
  // anchored ONLY by the phone number must never hand the stored identity back
  // to the model. Of the verification fields, only name/email actually
  // constrain the DB match (date_of_birth is collected above but has no
  // appointments column to verify against), so attendee_name is selected ONLY
  // when a name/email filter applies. A phone-only lookup still confirms
  // logistics (date/time/service/practitioner) but the stored name never
  // leaves the database for a potential number-spoofer to extract.
  const matchesByName = verificationFields.includes("name") && !!args.name?.trim();
  const matchesByEmail = verificationFields.includes("email") && !!args.email?.trim();
  const includeIdentity = matchesByName || matchesByEmail;

  // SCRUM-437 (review): a digit-less or too-short phone ("anonymous", "n/a",
  // "8") must never reach the query — an empty suffix degenerates the ilike
  // filter to '%', which matches EVERY upcoming appointment, and a 1-2 digit
  // suffix barely narrows it. Reuse the booking-path validator (8-15 digits).
  if (verificationFields.includes("phone") && args.phone && !isValidPhoneNumber(args.phone)) {
    return {
      success: false,
      message:
        "That phone number doesn't look complete. Could you please give me the full phone number the appointment was booked under?",
    };
  }

  // 3. Build the query — match ALL required fields
  let query = (supabase as any)
    .from("appointments")
    .select(
      `id, ${includeIdentity ? "attendee_name, " : ""}attendee_phone, attendee_email, start_time, end_time, duration_minutes, status, service_type_id, practitioner_id`
    )
    .eq("organization_id", organizationId)
    .in("status", ["confirmed", "pending"])
    .gte("start_time", new Date().toISOString()) // Only future appointments
    .order("start_time", { ascending: true })
    .limit(5);

  // Apply verification filters
  if (matchesByName && args.name) {
    query = query.ilike("attendee_name", `%${escapeLike(args.name.trim())}%`);
  }
  if (verificationFields.includes("phone") && args.phone) {
    const cleanPhone = args.phone.replace(/\D/g, "");
    // Match last 9 digits to handle different country code formats.
    // SCRUM-437: anchored ends-with (no trailing %) — a floating `%suffix%`
    // would also match the digits buried anywhere inside a longer stored value.
    const phoneSuffix = cleanPhone.length > 9 ? cleanPhone.slice(-9) : cleanPhone;
    query = query.ilike("attendee_phone", `%${phoneSuffix}`);
  }
  if (matchesByEmail && args.email) {
    query = query.ilike("attendee_email", `%${escapeLike(args.email.trim())}%`);
  }

  const { data: appointments, error: queryError } = await query;

  if (queryError) {
    console.error("Appointment lookup error:", queryError);
    return { success: false, message: "I'm having trouble looking up appointments right now. Would you like me to arrange a callback instead?" };
  }

  if (!appointments || appointments.length === 0) {
    return { success: true, message: LOOKUP_NO_MATCH_MESSAGE };
  }

  return formatAppointmentResult(appointments, timezone, supabase as any);
}
