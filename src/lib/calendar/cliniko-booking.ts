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
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import {
  ClinikoClient,
  ClinikoAuthError,
  ClinikoRateLimitError,
  ClinikoUnavailableError,
  ClinikoValidationError,
  type ClinikoIntegrationSettings,
} from "./cliniko";
import { findOrCreateClinikoPatient } from "./cliniko-patients";
import { generateConfirmationCode } from "./confirmation-code";

export interface ClinikoContext {
  readonly client: ClinikoClient;
  readonly businessId: string;
  readonly integrationId: string;
}

/**
 * Result of resolving an org's Cliniko integration. The distinction matters at
 * dispatch: `none` means genuinely not connected (fall through to built-in
 * booking), but `error` means a transient DB/decrypt failure — the caller must
 * NOT silently fall through (that would confirm a booking the practice never
 * receives, or cancel locally while the real diary keeps the appointment).
 */
export type ClinikoResolution =
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "ok"; ctx: ClinikoContext };

interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface ClinikoBookArgs {
  startDate: Date;
  /** Org timezone, resolved once at the dispatch and passed through to avoid a
   *  second lookup (and a second silent-failure surface) here. */
  timezone?: string;
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
 * Resolve the org's Cliniko integration.
 * - `none`: no active row, unselected business, or the org lost entitlement
 *   (downgraded below Professional) — genuinely "not using Cliniko now".
 * - `error`: the lookup failed, or a stored key won't decrypt (an
 *   ENCRYPTION_KEY problem) — a transient/operational fault the caller must
 *   surface, never treat as "not connected".
 * - `ok`: a ready client.
 */
export async function getActiveClinikoIntegration(organizationId: string): Promise<ClinikoResolution> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("calendar_integrations")
    .select("id, access_token, settings")
    .eq("organization_id", organizationId)
    .eq("provider", "cliniko")
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("[Cliniko] integration lookup failed:", error.message || error.code);
    return { kind: "error" };
  }
  if (!data?.access_token) return { kind: "none" };

  const settings = (data.settings || {}) as ClinikoIntegrationSettings;
  if (!settings.shard || !settings.businessId) return { kind: "none" };

  // Entitlement is re-checked at call time: an org that connected on
  // Professional+ and later downgraded must stop live-diary booking. Fails
  // OPEN (hasFeatureAccess returns true on a DB blip) so an outage can't wrongly
  // disable a paying customer's booking.
  if (!(await hasFeatureAccess(organizationId, "crmIntegrations"))) {
    return { kind: "none" };
  }

  const apiKey = safeDecrypt(data.access_token);
  if (!apiKey) {
    // A stored key that won't decrypt is an operational fault (rotated
    // ENCRYPTION_KEY), NOT a disconnected org — page it and treat as error so
    // callers don't silently revert every Cliniko org to built-in booking.
    console.error("[Cliniko] stored API key could not be decrypted", { organizationId, integrationId: data.id });
    Sentry.captureMessage("Cliniko stored API key failed to decrypt — check ENCRYPTION_KEY");
    return { kind: "error" };
  }

  try {
    const client = new ClinikoClient({ apiKey, shard: settings.shard });
    return { kind: "ok", ctx: { client, businessId: settings.businessId, integrationId: data.id } };
  } catch (err) {
    console.error("[Cliniko] invalid stored shard", { organizationId, error: err instanceof Error ? err.message : err });
    return { kind: "error" };
  }
}

/**
 * Mark the integration auth-broken and email the org owner ONCE (deduped via
 * settings.errorState). Cleared by a successful reconnect/sync in the routes.
 */
async function markClinikoAuthFailure(organizationId: string, integrationId: string): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { data, error: readError } = await (supabase as any)
      .from("calendar_integrations")
      .select("settings")
      .eq("id", integrationId)
      .maybeSingle();
    // A failed read must NOT proceed: writing back a spread of `{}` would wipe
    // shard/businessId/keyLast4 and brick the integration. Bail; the next auth
    // failure retries.
    if (readError) {
      console.error("[Cliniko] auth-failure flag: settings read failed, skipping to avoid wiping settings:", readError.message || readError.code);
      return;
    }
    const settings = (data?.settings || {}) as ClinikoIntegrationSettings;
    if (settings.errorState === "auth_failed") return; // already flagged + emailed

    const { error: writeError } = await (supabase as any)
      .from("calendar_integrations")
      .update({ settings: { ...settings, errorState: "auth_failed" }, updated_at: new Date().toISOString() })
      .eq("id", integrationId);
    // If the flag didn't persist, don't send the email — otherwise the dedupe
    // is defeated and the owner gets an "Action needed" mail on every call.
    if (writeError) {
      console.error("[Cliniko] auth-failure flag: settings write failed, skipping owner email:", writeError.message || writeError.code);
      return;
    }

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
  const supabase = createAdminClient();
  // supabase .single() returns { error } rather than throwing, so log the error
  // explicitly instead of leaving it absorbed by the `|| default`.
  const { data, error } = await (supabase as any)
    .from("organizations")
    .select("timezone")
    .eq("id", organizationId)
    .single();
  if (error) {
    console.warn("[Cliniko] org timezone lookup failed, defaulting to Australia/Sydney:", error.message || error.code);
  }
  return data?.timezone || "Australia/Sydney";
}

async function getLinkedServiceType(organizationId: string, serviceTypeId: string): Promise<LinkedServiceType | null> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("service_types")
    .select("id, name, duration_minutes, external_id, is_active")
    .eq("id", serviceTypeId)
    .eq("organization_id", organizationId)
    .eq("external_provider", "cliniko")
    // Caller-supplied service types must be active — parity with the built-in
    // path's requireActive gate (a deactivated type must not stay bookable from
    // a stale id mid-conversation).
    .eq("is_active", true)
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
    } else {
      // Log every rejection — a practitioner whose availability call keeps
      // failing would otherwise vanish from answers with no trace.
      console.warn("[Cliniko] availability lookup failed for practitioner (excluded from results):", {
        practitionerId: practitioners[i].id,
        externalId: practitioners[i].external_id,
        reason: res.reason instanceof Error ? res.reason.message : String(res.reason),
      });
      if (firstError === null) firstError = res.reason;
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
  args: { date?: string; service_type_id?: string; practitioner_id?: string }
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
      return { success: false, message: "I need the date in a standard format. Could you say the date again?" };
    }

    const timezone = await getOrgTimezone(organizationId);
    let practitioners = await getLinkedPractitionersForService(organizationId, serviceType.id);
    // A specific practitioner request must return only THEIR times — otherwise
    // the AI offers a merged clinic view and then fails to book that slot with
    // the requested practitioner.
    if (args.practitioner_id) {
      practitioners = practitioners.filter((p) => p.id === args.practitioner_id);
      if (practitioners.length === 0) {
        return {
          success: false,
          message:
            "That practitioner isn't available for that appointment type. Would you like to hear the other available options?",
        };
      }
    }
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

    const timezone = args.timezone || (await getOrgTimezone(organizationId));
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

    // Derive first/last ONCE (single rule) so the Cliniko patient and the local
    // mirror row agree — otherwise a one-word name yields last_name:"" in Cliniko
    // but attendee_last_name:null locally.
    const nameParts = args.sanitizedName.split(" ").filter(Boolean);
    const firstName = args.firstName || nameParts[0] || "";
    const lastName = args.lastName || nameParts.slice(1).join(" ") || "";

    // 3) Patient find-or-create (after slot verify — no patients for dead slots).
    const patient = await findOrCreateClinikoPatient({
      client: ctx.client,
      organizationId,
      firstName,
      lastName,
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
          attendee_first_name: firstName || null,
          attendee_last_name: lastName || null,
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
    // The possible-duplicate is referenced by id only — writing the OTHER
    // patient's name into THIS patient's visible note would leak identity
    // across records. The practice looks up the id in their own Cliniko.
    const noteLines = [
      ...(args.sanitizedNotes ? [args.sanitizedNotes] : []),
      `Caller: ${args.sanitizedName}${args.phone ? ` ${args.phone}` : ""}`,
      "Booked by Phondo AI receptionist.",
      ...(patient.duplicatePatientId
        ? [`Possible duplicate of patient #${patient.duplicatePatientId} — please review/merge in Cliniko.`]
        : []),
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
      // A timeout/network error here may mean Cliniko processed the create AFTER
      // we gave up (writes are never retried) — a possible ghost appointment in
      // the diary. Log enough to reconcile it before removing the local row.
      if (err instanceof ClinikoUnavailableError) {
        console.error("[ClinikoBooking] createAppointment failed — possible ghost appointment in Cliniko:", {
          organizationId,
          practitionerExternalId: practitioner.external_id,
          appointmentTypeExternalId: serviceType.external_id,
          startsAt: args.startDate.toISOString(),
        });
      } else if (err instanceof ClinikoValidationError) {
        // A systematic 422 (bad mapping, archived patient, tz format) would
        // otherwise masquerade as slot contention forever with nothing logged.
        console.error("[ClinikoBooking] createAppointment rejected (HTTP 422):", {
          organizationId,
          detail: (err as ClinikoValidationError).detail,
        });
      }
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

    // 6) Link mirror -> Cliniko. The appointment exists on both sides now, so a
    // failure here is non-fatal to the booking — but a LOST link means a later
    // cancel/reschedule can't find the Cliniko appointment (it would strand a
    // booking in the diary the caller thinks is cancelled). Retry once, then page.
    let linked = false;
    for (let attempt = 0; attempt < 2 && !linked; attempt++) {
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
      if (!patchError) {
        linked = true;
      } else {
        console.error("[ClinikoBooking] failed to link mirror to cliniko appointment:", {
          attempt: attempt + 1,
          mirrorId: mirror.id,
          clinikoAppointmentId: clinikoAppointment.id,
          error: patchError.message || patchError.code,
        });
      }
    }
    if (!linked) {
      // Operator can re-link mirror.id ↔ clinikoAppointment.id from this alert.
      Sentry.withScope((scope) => {
        scope.setLevel("error");
        scope.setTag("bug", "cliniko_mirror_link_lost");
        scope.setExtras({ organizationId, mirrorId: mirror.id, clinikoAppointmentId: clinikoAppointment.id });
        Sentry.captureMessage("Cliniko appointment created but mirror link lost — cancel/reschedule will not reach Cliniko");
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
 *
 * A `provider:'cliniko'` row with NO external_id is NOT "nothing to cancel": it
 * means the booking-time link patch failed AFTER the Cliniko appointment was
 * created, so an appointment exists in the diary we can no longer address.
 * Throw so the caller surfaces trouble rather than telling the caller it's
 * cancelled while the practice's diary keeps the booking.
 */
export async function clinikoCancelExternal(
  ctx: ClinikoContext,
  organizationId: string,
  appointment: { id: string; external_id?: string | null },
  reason: string
): Promise<void> {
  if (!appointment.external_id) {
    console.error("[Cliniko] cliniko row has no external_id — cannot reach the Cliniko appointment to cancel", {
      appointmentId: appointment.id,
    });
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("bug", "cliniko_cancel_lost_link");
      scope.setExtras({ appointmentId: appointment.id, integrationId: ctx.integrationId });
      Sentry.captureMessage("Cancel requested for a Cliniko row with no external_id — appointment may be stranded in the diary");
    });
    throw new ClinikoUnavailableError("cliniko appointment link missing");
  }
  try {
    await ctx.client.cancelAppointment(appointment.external_id, reason);
  } catch (err) {
    // A 401 here must flag the integration + alert the owner, same as the
    // booking path — otherwise auth breakage on cancel is invisible.
    if (err instanceof ClinikoAuthError) {
      await markClinikoAuthFailure(organizationId, ctx.integrationId).catch(() => {});
    }
    throw err;
  }
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

async function handleClinikoFlowError(
  err: unknown,
  ctx: ClinikoContext,
  organizationId: string,
  outageMessage: string,
  operation: string
): Promise<ToolResult> {
  if (err instanceof ClinikoAuthError) {
    // Flag the integration + email the owner, then hand the caller to message-taking.
    await markClinikoAuthFailure(organizationId, ctx.integrationId);
    return { success: false, message: outageMessage };
  }
  if (err instanceof ClinikoRateLimitError) {
    // 429s never reached Sentry before — surface the pattern so a too-tight
    // rate limit shows up rather than silently degrading to take-a-message.
    console.warn(`[Cliniko] ${operation} rate-limited:`, err.message);
    Sentry.captureException(err);
    return { success: false, message: outageMessage };
  }
  if (isClinikoOutage(err)) {
    console.warn(`[Cliniko] ${operation} outage:`, err instanceof Error ? err.message : err);
    return { success: false, message: outageMessage };
  }
  console.error(`[Cliniko] ${operation} unexpected error:`, err instanceof Error ? err.message : err);
  Sentry.captureException(err);
  return { success: false, message: outageMessage };
}
