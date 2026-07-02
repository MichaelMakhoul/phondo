/**
 * Cliniko live booking flows (SCRUM-12).
 *
 * When an org has an active Cliniko integration, availability and new bookings
 * run against the practice's real Cliniko diary. Every Cliniko booking also
 * writes a local mirror row (provider 'cliniko', external_id set) so the
 * existing confirmation-code, caller-verification, SMS and dashboard machinery
 * works unchanged.
 *
 * Ordering rules:
 * - Slot verify FIRST (never create patients for a dead slot).
 * - Local mirror insert BEFORE the Cliniko create (reserves the slot locally
 *   via the no-overlap exclusion constraint and mints the confirmation code);
 *   the mirror is deleted if the Cliniko write fails — the caller never heard
 *   a confirmation for it.
 * - Reschedules need no code here: handleRescheduleAppointment books the new
 *   leg through handleBookAppointment (which dispatches back to this module)
 *   and frees the old leg via cancelSingleAppointment, which propagates to
 *   Cliniko through clinikoCancelExternal.
 */

import crypto from "crypto";
import * as Sentry from "@sentry/nextjs";
import { Resend } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeDecrypt } from "@/lib/security/encryption";
import { runAfterResponse } from "@/lib/utils/after-response";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import { sendAppointmentConfirmationSMS } from "@/lib/sms/caller-sms";
import {
  sendAppointmentNotification,
  getOrganizationOwnerEmail,
} from "@/lib/notifications/notification-service";
import {
  ClinikoClient,
  ClinikoAuthError,
  ClinikoRateLimitError,
  ClinikoUnavailableError,
  ClinikoValidationError,
} from "./cliniko";
import { findOrCreateClinikoPatient } from "./cliniko-patients";
import { generateConfirmationCode } from "./confirmation-code";

export interface ClinikoContext {
  client: ClinikoClient;
  businessId: string;
  integrationId: string;
}

interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface ClinikoBookArgs {
  startDate: Date;
  sanitizedName: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  sanitizedNotes?: string;
  serviceTypeId?: string;
  requestedPractitionerId?: string;
}

interface LinkedServiceType {
  id: string;
  name: string;
  duration_minutes: number;
  external_id: string;
  is_active: boolean;
}

interface LinkedPractitioner {
  id: string;
  name: string;
  external_id: string;
}

const OUTAGE_AVAILABILITY_MESSAGE =
  "I'm having trouble checking the calendar right now. Would you like me to take your information instead?";
const OUTAGE_BOOKING_MESSAGE =
  "I'm having trouble completing the booking right now. Let me take your information and have someone call you back to confirm the appointment.";
const SLOT_TAKEN_MESSAGE =
  "I'm sorry, that time slot is no longer available. Would you like me to check for other available times?";

export function isClinikoOutage(err: unknown): boolean {
  return (
    err instanceof ClinikoUnavailableError ||
    err instanceof ClinikoRateLimitError ||
    err instanceof ClinikoAuthError
  );
}

/**
 * Resolve the org's active Cliniko integration into a ready client, or null.
 * Null (never throw) on any miss: absent row, unselected business, undecryptable
 * key, bad shard — callers fall back to the built-in/Cal.com paths.
 */
export async function getActiveClinikoIntegration(organizationId: string): Promise<ClinikoContext | null> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("calendar_integrations")
    .select("id, access_token, settings")
    .eq("organization_id", organizationId)
    .eq("provider", "cliniko")
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.warn("[Cliniko] integration lookup failed:", error.message || error.code);
    return null;
  }
  if (!data?.access_token) return null;

  const settings = (data.settings || {}) as { shard?: string; businessId?: string };
  if (!settings.shard || !settings.businessId) return null;

  const apiKey = safeDecrypt(data.access_token);
  if (!apiKey) {
    console.error("[Cliniko] stored API key could not be decrypted", { organizationId, integrationId: data.id });
    return null;
  }

  let client: ClinikoClient;
  try {
    client = new ClinikoClient({ apiKey, shard: settings.shard });
  } catch (err) {
    console.error("[Cliniko] invalid stored shard", { organizationId, error: err instanceof Error ? err.message : err });
    return null;
  }

  return { client, businessId: settings.businessId, integrationId: data.id };
}

/**
 * Mark the integration auth-broken and email the org owner ONCE (deduped via
 * settings.errorState). Cleared by a successful reconnect/sync in the routes.
 */
async function markClinikoAuthFailure(organizationId: string, integrationId: string): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { data } = await (supabase as any)
      .from("calendar_integrations")
      .select("settings")
      .eq("id", integrationId)
      .maybeSingle();
    const settings = (data?.settings || {}) as Record<string, unknown>;
    if (settings.errorState === "auth_failed") return; // already flagged + emailed

    await (supabase as any)
      .from("calendar_integrations")
      .update({ settings: { ...settings, errorState: "auth_failed" }, updated_at: new Date().toISOString() })
      .eq("id", integrationId);

    Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("integration", "cliniko");
      scope.setExtras({ organizationId, integrationId });
      Sentry.captureMessage("Cliniko API key rejected — integration marked auth_failed");
    });

    const ownerEmail = await getOrganizationOwnerEmail(organizationId);
    const apiKey = process.env.RESEND_API_KEY;
    if (ownerEmail && apiKey) {
      const resend = new Resend(apiKey);
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "Phondo <notifications@phondo.ai>",
        to: ownerEmail,
        subject: "Action needed: your Cliniko connection stopped working",
        text: [
          "Hi,",
          "",
          "Phondo could no longer authenticate with your Cliniko account, so the AI receptionist has stopped booking into your Cliniko diary and is taking messages instead.",
          "",
          "This usually means the API key was revoked or regenerated. To fix it, open Phondo → Settings → Integrations → Cliniko and paste a fresh API key.",
          "",
          "— Phondo",
        ].join("\n"),
      });
    }
  } catch (err) {
    // Never let alerting break the caller-facing flow.
    console.error("[Cliniko] failed to record auth failure:", err instanceof Error ? err.message : err);
  }
}

async function getOrgTimezone(organizationId: string): Promise<string> {
  try {
    const supabase = createAdminClient();
    const { data } = await (supabase as any)
      .from("organizations")
      .select("timezone")
      .eq("id", organizationId)
      .single();
    return data?.timezone || "Australia/Sydney";
  } catch {
    return "Australia/Sydney";
  }
}

async function getLinkedServiceType(organizationId: string, serviceTypeId: string): Promise<LinkedServiceType | null> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("service_types")
    .select("id, name, duration_minutes, external_id, is_active")
    .eq("id", serviceTypeId)
    .eq("organization_id", organizationId)
    .eq("external_provider", "cliniko")
    .maybeSingle();
  if (error || !data?.external_id) return null;
  return data as LinkedServiceType;
}

async function listLinkedServiceTypes(organizationId: string): Promise<LinkedServiceType[]> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("service_types")
    .select("id, name, duration_minutes, external_id, is_active")
    .eq("organization_id", organizationId)
    .eq("external_provider", "cliniko")
    .eq("is_active", true);
  if (error) return [];
  return (data || []) as LinkedServiceType[];
}

async function getLinkedPractitionersForService(organizationId: string, serviceTypeId: string): Promise<LinkedPractitioner[]> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("practitioners")
    .select("id, name, external_id, practitioner_services!inner(service_type_id)")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .eq("external_provider", "cliniko")
    .eq("practitioner_services.service_type_id", serviceTypeId);
  if (error) {
    throw new Error(`Failed to fetch Cliniko practitioners for service: ${error.message || error.code}`);
  }
  return ((data || []) as Array<Record<string, unknown>>)
    .filter((row) => row.external_id)
    .map((row) => ({ id: String(row.id), name: String(row.name), external_id: String(row.external_id) }));
}

/** Org-local calendar date (YYYY-MM-DD) of an instant — Cliniko's from/to are dates in the account's timezone. */
function localDateOf(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function localHourMinute(iso: string, timezone: string): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { h, m };
}

function formatTimeForVoice(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  });
}

/** Same voice copy as the built-in availability formatter, driven by UTC slots + org tz. */
function formatClinikoAvailabilityForVoice(date: string, slots: string[], timezone: string): string {
  if (slots.length === 0) {
    return "I'm sorry, there are no available appointments on that date. Would you like to check a different day?";
  }
  const dateStr = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });

  const morning = slots.filter((iso) => localHourMinute(iso, timezone).h < 12);
  const afternoon = slots.filter((iso) => localHourMinute(iso, timezone).h >= 12);

  const parts: string[] = [];
  if (morning.length > 0) {
    const first = formatTimeForVoice(morning[0], timezone);
    const last = formatTimeForVoice(morning[morning.length - 1], timezone);
    parts.push(morning.length === 1 ? `${first} in the morning` : `mornings between ${first} and ${last}`);
  }
  if (afternoon.length > 0) {
    const first = formatTimeForVoice(afternoon[0], timezone);
    const last = formatTimeForVoice(afternoon[afternoon.length - 1], timezone);
    parts.push(afternoon.length === 1 ? `${first} in the afternoon` : `afternoons between ${first} and ${last}`);
  }

  return `On ${dateStr}, I have ${slots.length} available slots — ${parts.join(" and ")}. Would you prefer morning or afternoon?`;
}

/**
 * Fan out available_times across practitioners. Partial failures are tolerated
 * (one practitioner's error must not blank the whole answer); if EVERY call
 * fails, the first outage-class error is rethrown for the outer handler.
 */
async function collectAvailability(
  ctx: ClinikoContext,
  practitioners: LinkedPractitioner[],
  appointmentTypeExternalId: string,
  fromDate: string,
  toDate: string
): Promise<Map<string, Set<string>>> {
  const results = await Promise.allSettled(
    practitioners.map((p) =>
      ctx.client.availableTimes(ctx.businessId, p.external_id, appointmentTypeExternalId, fromDate, toDate)
    )
  );
  const byPractitioner = new Map<string, Set<string>>();
  let firstError: unknown = null;
  results.forEach((res, i) => {
    if (res.status === "fulfilled") {
      byPractitioner.set(practitioners[i].id, new Set(res.value));
    } else if (firstError === null) {
      firstError = res.reason;
    }
  });
  if (byPractitioner.size === 0 && firstError) throw firstError;
  return byPractitioner;
}

function serviceTypePrompt(types: LinkedServiceType[]): ToolResult {
  if (types.length === 0) {
    return {
      success: false,
      message:
        "I'm not able to see any bookable appointment types right now. Would you like me to take your information and have someone call you back?",
    };
  }
  const list = types.map((t) => `- ${t.name} (${t.duration_minutes} min)`).join("\n");
  return {
    success: true,
    message: `Before I check availability, what type of appointment would you like to book?\n\nAvailable appointment types:\n${list}\n\nPlease ask the caller which type they'd like to book.`,
  };
}

export async function clinikoCheckAvailability(
  ctx: ClinikoContext,
  organizationId: string,
  args: { date?: string; service_type_id?: string }
): Promise<ToolResult> {
  try {
    if (!args.service_type_id) {
      return serviceTypePrompt(await listLinkedServiceTypes(organizationId));
    }
    const serviceType = await getLinkedServiceType(organizationId, args.service_type_id);
    if (!serviceType) {
      return serviceTypePrompt(await listLinkedServiceTypes(organizationId));
    }
    if (!args.date) {
      return { success: false, message: "What date would you like me to check availability for?" };
    }

    const timezone = await getOrgTimezone(organizationId);
    const practitioners = await getLinkedPractitionersForService(organizationId, serviceType.id);
    if (practitioners.length === 0) {
      return {
        success: false,
        message:
          "I'm sorry, there's no one available for that appointment type at the moment. Would you like me to take your information instead?",
      };
    }

    const byPractitioner = await collectAvailability(ctx, practitioners, serviceType.external_id, args.date, args.date);
    const merged = Array.from(new Set(Array.from(byPractitioner.values()).flatMap((s) => Array.from(s)))).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime()
    );

    return { success: true, message: formatClinikoAvailabilityForVoice(args.date, merged, timezone) };
  } catch (err) {
    return handleClinikoFlowError(err, ctx, organizationId, OUTAGE_AVAILABILITY_MESSAGE, "check_availability");
  }
}

export async function clinikoBookAppointment(
  ctx: ClinikoContext,
  organizationId: string,
  args: ClinikoBookArgs
): Promise<ToolResult> {
  const supabase = createAdminClient();
  try {
    if (!args.serviceTypeId) {
      return serviceTypePrompt(await listLinkedServiceTypes(organizationId));
    }
    const serviceType = await getLinkedServiceType(organizationId, args.serviceTypeId);
    if (!serviceType) {
      return serviceTypePrompt(await listLinkedServiceTypes(organizationId));
    }

    const timezone = await getOrgTimezone(organizationId);
    const allPractitioners = await getLinkedPractitionersForService(organizationId, serviceType.id);
    if (allPractitioners.length === 0) {
      return {
        success: false,
        message:
          "I'm sorry, there's no one available for that appointment type at the moment. Would you like me to take your information instead?",
      };
    }

    let candidates = allPractitioners;
    if (args.requestedPractitionerId) {
      candidates = allPractitioners.filter((p) => p.id === args.requestedPractitionerId);
      if (candidates.length === 0) {
        return {
          success: false,
          message:
            "That practitioner isn't available for that appointment type. Would you like to book with someone else, or hear the available options?",
        };
      }
    }

    // 1) Verify the requested instant is genuinely free in Cliniko.
    const localDate = localDateOf(args.startDate, timezone);
    const byPractitioner = await collectAvailability(ctx, candidates, serviceType.external_id, localDate, localDate);
    const targetEpoch = args.startDate.getTime();
    const withSlot = candidates.filter((p) => {
      const slots = byPractitioner.get(p.id);
      if (!slots) return false;
      return Array.from(slots).some((iso) => new Date(iso).getTime() === targetEpoch);
    });
    if (withSlot.length === 0) {
      return { success: false, message: SLOT_TAKEN_MESSAGE };
    }

    // 2) Pick the least-loaded practitioner that day (stable order fallback).
    const practitioner = await pickLeastLoaded(supabase, organizationId, withSlot, args.startDate);

    // 3) Patient find-or-create (after slot verify — no patients for dead slots).
    const patient = await findOrCreateClinikoPatient({
      client: ctx.client,
      organizationId,
      firstName: args.firstName || args.sanitizedName.split(" ")[0] || "",
      lastName: args.lastName || args.sanitizedName.split(" ").slice(1).join(" ") || "",
      phone: args.phone,
    });

    // 4) Mirror insert FIRST — mints the confirmation code and locally reserves
    //    the slot (no-overlap exclusion constraint applies to mirror rows too).
    const endDate = new Date(args.startDate.getTime() + serviceType.duration_minutes * 60 * 1000);
    const bookingEmail = args.email || `booking-${crypto.randomUUID()}@noreply.phondo.ai`;
    let mirror: { id: string; confirmation_code: string } | null = null;
    let confirmationCode = generateConfirmationCode();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error: dbError } = await (supabase as any)
        .from("appointments")
        .insert({
          organization_id: organizationId,
          provider: "cliniko",
          attendee_name: args.sanitizedName,
          attendee_first_name: args.firstName || args.sanitizedName.split(" ")[0] || null,
          attendee_last_name:
            args.lastName || (args.sanitizedName.includes(" ") ? args.sanitizedName.split(" ").slice(1).join(" ") : null),
          attendee_phone: args.phone,
          attendee_email: bookingEmail,
          start_time: args.startDate.toISOString(),
          end_time: endDate.toISOString(),
          duration_minutes: serviceType.duration_minutes,
          status: "confirmed",
          notes: args.sanitizedNotes || null,
          confirmation_code: confirmationCode,
          metadata: { source: "ai_receptionist" },
          service_type_id: serviceType.id,
          practitioner_id: practitioner.id,
        })
        .select("id, confirmation_code")
        .single();

      if (!dbError) {
        mirror = data;
        break;
      }
      if (dbError.code === "23505" && /confirmation_code/i.test(dbError.message || "")) {
        console.warn(`[ClinikoBooking] Confirmation-code collision (attempt ${attempt + 1}) — regenerating`);
        confirmationCode = generateConfirmationCode();
        continue;
      }
      if (dbError.code === "23P01") {
        // Local mirror already holds an overlapping row — treat as slot contention.
        return { success: false, message: SLOT_TAKEN_MESSAGE };
      }
      console.error("[ClinikoBooking] mirror insert failed:", dbError);
      return { success: false, message: OUTAGE_BOOKING_MESSAGE };
    }
    if (!mirror) {
      return { success: false, message: OUTAGE_BOOKING_MESSAGE };
    }
    // The DB row is the source of truth for the code (insert echo).
    confirmationCode = mirror.confirmation_code || confirmationCode;

    // 5) The real write: create the appointment in the practice's Cliniko diary.
    const noteLines = [
      ...(args.sanitizedNotes ? [args.sanitizedNotes] : []),
      `Caller: ${args.sanitizedName}${args.phone ? ` ${args.phone}` : ""}`,
      "Booked by Phondo AI receptionist.",
      ...(patient.duplicateWarning ? [patient.duplicateWarning] : []),
    ];
    let clinikoAppointment;
    try {
      clinikoAppointment = await ctx.client.createAppointment({
        businessId: ctx.businessId,
        practitionerId: practitioner.external_id,
        appointmentTypeId: serviceType.external_id,
        patientId: patient.patientId,
        startsAtIso: args.startDate.toISOString(),
        notes: noteLines.join("\n"),
      });
    } catch (err) {
      // The caller never heard a confirmation — remove the local reservation.
      const { error: cleanupError } = await (supabase as any)
        .from("appointments")
        .delete()
        .eq("id", mirror.id)
        .eq("organization_id", organizationId);
      if (cleanupError) {
        console.error("[ClinikoBooking] mirror cleanup failed after cliniko error:", cleanupError);
        Sentry.captureMessage("Cliniko booking failed AND mirror cleanup failed — orphan local row", "error");
      }
      if (err instanceof ClinikoValidationError) {
        // Slot raced away between verify and create, or Cliniko rejected the shape.
        return { success: false, message: SLOT_TAKEN_MESSAGE };
      }
      return handleClinikoFlowError(err, ctx, organizationId, OUTAGE_BOOKING_MESSAGE, "book_appointment");
    }

    // 6) Link mirror -> Cliniko (non-fatal: the booking exists on both sides).
    const { error: patchError } = await (supabase as any)
      .from("appointments")
      .update({
        external_id: clinikoAppointment.id,
        metadata: {
          source: "ai_receptionist",
          clinikoPatientId: patient.patientId,
          clinikoBusinessId: ctx.businessId,
          clinikoAppointmentTypeId: serviceType.external_id,
          clinikoPractitionerId: practitioner.external_id,
        },
      })
      .eq("id", mirror.id)
      .eq("organization_id", organizationId);
    if (patchError) {
      console.error("[ClinikoBooking] failed to link mirror to cliniko appointment (non-fatal):", {
        mirrorId: mirror.id,
        clinikoAppointmentId: clinikoAppointment.id,
        error: patchError.message || patchError.code,
      });
    }

    // 7) Confirmations — after the response, like the internal path (SCRUM-410).
    if (args.phone) {
      const phone = args.phone;
      runAfterResponse(async () => {
        try {
          await sendAppointmentNotification({
            organizationId,
            callerPhone: phone,
            callerName: args.sanitizedName,
            appointmentDate: args.startDate,
            appointmentTime: args.startDate.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
              timeZone: timezone,
            }),
            timezone,
            confirmationCode,
          });
        } catch (err) {
          console.error("[ClinikoBooking] appointment notification failed:", err);
        }
      });
      runAfterResponse(async () => {
        try {
          await sendAppointmentConfirmationSMS(organizationId, phone, args.startDate, timezone, confirmationCode, mirror!.id);
        } catch (err) {
          console.error("[ClinikoBooking] confirmation SMS failed:", { organizationId, error: err });
        }
      });
    }
    runAfterResponse(async () => {
      try {
        await invalidateVoiceScheduleCache(organizationId);
      } catch (err) {
        console.warn("[VoiceCacheInvalidate] after-response failed:", err instanceof Error ? err.message : err);
      }
    });

    const dateStr = args.startDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: timezone,
    });
    const timeStr = args.startDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    });

    return {
      success: true,
      message: `I've booked your appointment for ${dateStr} at ${timeStr} with ${practitioner.name}. The appointment is confirmed. Is there anything else I can help you with?`,
      data: {
        appointmentId: mirror.id,
        confirmationCode,
        startTime: args.startDate.toISOString(),
        endTime: endDate.toISOString(),
        practitionerId: practitioner.id,
        practitionerName: practitioner.name,
        clinikoAppointmentId: clinikoAppointment.id,
      },
    };
  } catch (err) {
    return handleClinikoFlowError(err, ctx, organizationId, OUTAGE_BOOKING_MESSAGE, "book_appointment");
  }
}

/**
 * Cancel the Cliniko-side appointment for a mirror row. Throws on Cliniko
 * failure — the caller (cancelSingleAppointment) decides the caller-facing
 * fallback; cancelling only locally would silently desync the practice diary.
 * Rows without an external_id (link patch failed at booking time) resolve
 * quietly: there is nothing in Cliniko to cancel.
 */
export async function clinikoCancelExternal(
  ctx: ClinikoContext,
  appointment: { id: string; external_id?: string | null },
  reason: string
): Promise<void> {
  if (!appointment.external_id) {
    console.warn("[Cliniko] mirror row has no external_id — skipping Cliniko cancel", { appointmentId: appointment.id });
    return;
  }
  await ctx.client.cancelAppointment(appointment.external_id, reason);
}

async function pickLeastLoaded(
  supabase: unknown,
  organizationId: string,
  candidates: LinkedPractitioner[],
  startDate: Date
): Promise<LinkedPractitioner> {
  if (candidates.length === 1) return candidates[0];
  try {
    const dayStart = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const { data, error } = await (supabase as any)
      .from("appointments")
      .select("practitioner_id")
      .eq("organization_id", organizationId)
      .in("practitioner_id", candidates.map((c) => c.id))
      .in("status", ["confirmed", "pending"])
      .gte("start_time", dayStart.toISOString())
      .lt("start_time", dayEnd.toISOString());
    if (error) return candidates[0];
    const counts = new Map<string, number>();
    for (const row of (data || []) as Array<{ practitioner_id: string }>) {
      counts.set(row.practitioner_id, (counts.get(row.practitioner_id) || 0) + 1);
    }
    return candidates.reduce((best, c) =>
      (counts.get(c.id) || 0) < (counts.get(best.id) || 0) ? c : best
    );
  } catch {
    return candidates[0];
  }
}

function handleClinikoFlowError(
  err: unknown,
  ctx: ClinikoContext,
  organizationId: string,
  outageMessage: string,
  operation: string
): Promise<ToolResult> | ToolResult {
  if (err instanceof ClinikoAuthError) {
    // Fire the flag+email, then hand the caller to message-taking.
    return markClinikoAuthFailure(organizationId, ctx.integrationId).then(() => ({
      success: false,
      message: outageMessage,
    }));
  }
  if (isClinikoOutage(err)) {
    console.warn(`[Cliniko] ${operation} outage:`, err instanceof Error ? err.message : err);
    return { success: false, message: outageMessage };
  }
  console.error(`[Cliniko] ${operation} unexpected error:`, err instanceof Error ? err.message : err);
  Sentry.captureException(err);
  return { success: false, message: outageMessage };
}
