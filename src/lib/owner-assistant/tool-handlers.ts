// src/lib/owner-assistant/tool-handlers.ts
// SCRUM-586: the business owner's tools — what the AI can do once a call has
// passed the owner PIN gate (spec: docs/superpowers/specs/2026-10-09-owner-
// assistant-design.md §2-§4). Reached ONLY through the internal tool-call
// route's owner dispatch (envelope `ownerVerified` + production call). Every
// query is org-scoped in SQL; ids come back in `data` so the model never has
// to speak them. Anything a customer wrote (names, numbers, notes, reasons,
// summaries) is flattened to one capped line first (sanitize.ts) — it lands in a
// session that also holds the reschedule/cancel tools. SMS to customers is paused
// (SCRUM-264) — every change says so.
import { createAdminClient, type ServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import {
  errorResult,
  toLocalIsoMinute,
  cancelSingleAppointment,
  handleCheckAvailability,
  type ToolResult,
} from "@/lib/calendar/tool-handlers";
import { pickName, MAX_BOOKING_HORIZON_MS } from "@/lib/calendar/appointment-lifecycle";
import { partitionRescheduleChanges } from "@/lib/calendar/reschedule-core";
import { performRescheduleLeg } from "@/lib/calendar/reschedule-leg";
import { diffAppointmentFields, recordAppointmentEvent, type AppointmentSnapshot } from "@/lib/appointments/events";
import { rateLimitDistributed } from "@/lib/security/rate-limiter";
import { isValidUUID } from "@/lib/security/validation";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { pageSentry } from "@/lib/observability/page-sentry";
import { runAfterResponse } from "@/lib/utils/after-response";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import {
  OWNER_RANGES,
  type OwnerRange,
  ownerRangeBounds,
  localDayRange,
  todayISO,
  parseOwnerLocalDatetime,
  formatWhen,
} from "./time";
import { sanitizeCustomerText } from "./sanitize";

export const OWNER_TOOL_NAMES = [
  "owner_list_appointments",
  "owner_list_messages",
  "owner_reschedule_appointment",
  "owner_cancel_appointment",
] as const;
export type OwnerToolName = (typeof OWNER_TOOL_NAMES)[number];

/** Set by the internal route from the request ENVELOPE (never from model arguments). */
export interface OwnerCallContext {
  callId: string;
}

export interface OwnerAppointmentItem {
  appointment_id: string;
  confirmation_code: string | null;
  /** Org-local "YYYY-MM-DDTHH:mm" — the format `owner_reschedule_appointment` reads back. */
  start_local: string;
  end_local: string | null;
  /** Spoken form, e.g. "Thursday, October 15 at 2:00 PM". */
  when: string;
  customer_name: string;
  customer_phone: string | null;
  service: string | null;
  practitioner: string | null;
  notes: string | null;
  status: "confirmed" | "pending";
}
export interface OwnerListAppointmentsData {
  range: OwnerRange;
  /** First org-local day of the window ("YYYY-MM-DD"). */
  date: string;
  /** Jobs in the window — can exceed `appointments.length` (capped at 20). */
  count: number;
  appointments: OwnerAppointmentItem[];
}
export interface OwnerCallbackItem {
  callback_id: string;
  caller_name: string;
  caller_phone: string;
  reason: string;
  /** Spoken form of the time the caller asked to be rung, if any. */
  requested: string | null;
  urgency: "low" | "medium" | "high";
  /** Spoken form of when the request came in. */
  received: string;
}
export interface OwnerCallItem {
  call_id: string;
  /** Spoken form of when the call came in. */
  at: string;
  caller_name: string | null;
  caller_phone: string | null;
  summary: string;
}
export interface OwnerListMessagesData {
  callbacks: OwnerCallbackItem[];
  calls: OwnerCallItem[];
}

const DEFAULT_TZ = "Australia/Sydney";
const TROUBLE = "I'm having trouble reaching the calendar right now. Try again in a moment.";
const LIST_LIMIT = 20;
const MESSAGES_LIMIT = 10;
/** Calls fetched before the in-process owner/summary filter (≤ MESSAGES_LIMIT survive). */
const CALLS_FETCH_LIMIT = 30;
/**
 * Caps for customer-written text in tool results (see sanitizeCustomerText). Service
 * and practitioner names are org-controlled, but get the same treatment: it is free.
 * Phone numbers are covered too — a booking only has to contain 8-15 digits, so the
 * stored value can carry text around them.
 */
const NAME_MAX = 80;
const PHONE_MAX = 32;
const TEXT_MAX = 240;

const APPOINTMENT_COLS =
  "id, confirmation_code, start_time, end_time, status, attendee_name, attendee_phone, notes, " +
  "service_types(name), practitioners(name)";

/**
 * The org's IANA zone. A NULL/empty column reads as the platform default, like
 * every other calendar path; a failed lookup returns null so the caller reports a
 * fault — guessing a zone on a DB blip would hand the owner the wrong day.
 */
async function getOrgTimezone(supabase: any, organizationId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", organizationId)
    .single();
  if (error) {
    console.error("[owner-assistant] failed to load org timezone:", { organizationId, error });
    return null;
  }
  return data?.timezone || DEFAULT_TZ;
}

function toItem(row: any, tz: string): OwnerAppointmentItem {
  const start = new Date(row.start_time);
  return {
    appointment_id: row.id,
    confirmation_code: row.confirmation_code ?? null,
    start_local: toLocalIsoMinute(start, tz),
    end_local: row.end_time ? toLocalIsoMinute(new Date(row.end_time), tz) : null,
    when: formatWhen(start, tz),
    customer_name: sanitizeCustomerText(row.attendee_name, NAME_MAX) ?? "Unknown",
    customer_phone: sanitizeCustomerText(row.attendee_phone, PHONE_MAX),
    service: sanitizeCustomerText(pickName(row.service_types), NAME_MAX),
    practitioner: sanitizeCustomerText(pickName(row.practitioners), NAME_MAX),
    notes: sanitizeCustomerText(row.notes, TEXT_MAX),
    status: row.status,
  };
}

function describeItem(i: OwnerAppointmentItem): string {
  const parts = [`${i.when}: ${i.customer_name}`];
  if (i.service) parts.push(`— ${i.service}`);
  if (i.practitioner) parts.push(`with ${i.practitioner}`);
  if (i.customer_phone) parts.push(`(${i.customer_phone})`);
  if (i.notes) parts.push(`— notes: ${i.notes}`);
  if (i.status === "pending") parts.push("[pending]");
  return `- ${parts.join(" ")} (id ${i.appointment_id})`;
}

export async function handleOwnerListAppointments(
  organizationId: string,
  args: { range?: string; date?: string }
): Promise<ToolResult> {
  const range = args.range as OwnerRange;
  if (!OWNER_RANGES.includes(range)) {
    return { success: false, message: "Which period: today, tomorrow, this week, or a specific date (year-month-day)?" };
  }
  const supabase = createAdminClient();
  const tz = await getOrgTimezone(supabase, organizationId);
  if (!tz) return errorResult(TROUBLE);

  const bounds = ownerRangeBounds(range, tz, args.date);
  if (!bounds) {
    return { success: false, message: "Which date? Give it as year-month-day, like 2026-10-20." };
  }

  const { data, error, count } = await (supabase as any)
    .from("appointments")
    .select(APPOINTMENT_COLS, { count: "exact" })
    .eq("organization_id", organizationId)
    .in("status", ["confirmed", "pending"])
    .gte("start_time", bounds.start)
    .lt("start_time", bounds.end)
    .order("start_time", { ascending: true })
    .limit(LIST_LIMIT);

  if (error) {
    console.error("[owner-assistant] list_appointments failed:", { organizationId, range, error });
    return errorResult(TROUBLE);
  }

  const items = (data ?? []).map((row: any) => toItem(row, tz));
  const total = typeof count === "number" ? count : items.length;
  const payload: OwnerListAppointmentsData = { range, date: bounds.firstDate, count: total, appointments: items };

  if (total === 0) {
    return { success: true, message: `Nothing booked ${bounds.label}.`, data: payload as unknown as Record<string, unknown> };
  }
  const head = `${total} ${total === 1 ? "job" : "jobs"} ${bounds.label}${total > items.length ? ` (first ${items.length} listed)` : ""}:`;
  return {
    success: true,
    message: [head, ...items.map(describeItem)].join("\n"),
    data: payload as unknown as Record<string, unknown>,
  };
}

export async function handleOwnerListMessages(organizationId: string): Promise<ToolResult> {
  const supabase = createAdminClient();
  const tz = await getOrgTimezone(supabase, organizationId);
  if (!tz) return errorResult(TROUBLE);
  const today = localDayRange(todayISO(tz), tz);

  const { data: cbs, error: cbErr } = await (supabase as any)
    .from("callback_requests")
    .select("id, caller_name, caller_phone, reason, requested_time, urgency, created_at")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(MESSAGES_LIMIT);
  if (cbErr) {
    console.error("[owner-assistant] list_messages callbacks failed:", { organizationId, error: cbErr });
    return errorResult(TROUBLE);
  }

  const { data: calls, error: callErr } = await (supabase as any)
    .from("calls")
    .select("id, caller_name, caller_phone, summary, created_at, metadata")
    .eq("organization_id", organizationId)
    // Spam is not a message. `IS NOT TRUE` (PostgREST `is_spam=not.is.true`) keeps both
    // false and NULL rows, and doing it in SQL stops spam crowding the fetch window.
    .not("is_spam", "is", true)
    .gte("created_at", today.start)
    .lt("created_at", today.end)
    .order("created_at", { ascending: false })
    .limit(CALLS_FETCH_LIMIT);
  if (callErr) {
    console.error("[owner-assistant] list_messages calls failed:", { organizationId, error: callErr });
    return errorResult(TROUBLE);
  }

  const callbacks: OwnerCallbackItem[] = (cbs ?? []).map((c: any) => ({
    callback_id: c.id,
    // These three are `string` in the contract, so nothing printable left reads as a placeholder.
    caller_name: sanitizeCustomerText(c.caller_name, NAME_MAX) ?? "Unknown caller",
    caller_phone: sanitizeCustomerText(c.caller_phone, PHONE_MAX) ?? "Unknown number",
    reason: sanitizeCustomerText(c.reason, TEXT_MAX) ?? "No reason given",
    requested: c.requested_time ? formatWhen(new Date(c.requested_time), tz) : null,
    urgency: c.urgency,
    received: formatWhen(new Date(c.created_at), tz),
  }));
  // The owner's own calls are not messages; a call without a (printable) summary has nothing to relay.
  const customerCalls: OwnerCallItem[] = [];
  for (const c of calls ?? []) {
    if (customerCalls.length === MESSAGES_LIMIT) break;
    if ((c.metadata?.call_type ?? null) === "owner") continue;
    const summary = sanitizeCustomerText(c.summary, TEXT_MAX);
    if (!summary) continue;
    customerCalls.push({
      call_id: c.id,
      at: formatWhen(new Date(c.created_at), tz),
      caller_name: sanitizeCustomerText(c.caller_name, NAME_MAX),
      caller_phone: sanitizeCustomerText(c.caller_phone, PHONE_MAX),
      summary,
    });
  }

  const payload: OwnerListMessagesData = { callbacks, calls: customerCalls };
  if (callbacks.length === 0 && customerCalls.length === 0) {
    return { success: true, message: "No messages waiting and no customer calls yet today.", data: payload as unknown as Record<string, unknown> };
  }
  const lines: string[] = [];
  lines.push(`${callbacks.length} ${callbacks.length === 1 ? "callback" : "callbacks"} waiting${callbacks.length ? ":" : "."}`);
  for (const c of callbacks) {
    lines.push(`- ${c.caller_name} (${c.caller_phone}), ${c.urgency} urgency: ${c.reason}${c.requested ? ` — wants ${c.requested}` : ""} (received ${c.received})`);
  }
  lines.push(`${customerCalls.length} customer ${customerCalls.length === 1 ? "call" : "calls"} today${customerCalls.length ? ":" : "."}`);
  for (const c of customerCalls) {
    lines.push(`- ${c.at}: ${c.caller_name ?? "Unknown caller"}${c.caller_phone ? ` (${c.caller_phone})` : ""} — ${c.summary}`);
  }
  return { success: true, message: lines.join("\n"), data: payload as unknown as Record<string, unknown> };
}

// ─── Write tools ─────────────────────────────────────────────────────────────

export interface OwnerRescheduleData {
  outcome: "rescheduled" | "needs_confirmation" | "not_found" | "slot_taken" | "invalid_time" | "rate_limited";
  /** The id the owner referred to (the old leg). */
  appointment_id?: string;
  /** On success: the new leg — use this id for any further change to the job. */
  new_appointment_id?: string;
  customer_name?: string;
  customer_phone?: string | null;
  /** Spoken form of the current time (formatWhen). */
  from?: string;
  /** Spoken form of the requested time (formatWhen). */
  to?: string;
  /** On slot_taken: the availability message for that day ("" when there is none). */
  alternatives?: string;
  customer_notified: false;
}
export interface OwnerCancelData {
  outcome: "cancelled" | "needs_confirmation" | "not_found" | "rate_limited";
  appointment_id?: string;
  customer_name?: string;
  customer_phone?: string | null;
  /** Spoken form of the job's time (formatWhen). */
  when?: string;
  customer_notified: false;
}

const NOT_FOUND_MSG = "I can't find that job. It may have already been moved or cancelled.";
// SCRUM-264: customer SMS is paused platform-wide, so no change made here reaches
// the customer. Revisit (and the `customer_notified` literal type) when it is enabled.
const NOT_NOTIFIED = " The customer has NOT been notified — I can read you their number if you want to let them know.";
const RATE_LIMITED_MSG = "There have been several changes in a row just now — give it a minute and try again.";
const DEFAULT_CANCEL_REASON = "Cancelled by the business owner by phone";
/** Same bound the customer cancel path puts on a reason (sanitizeString(reason, 500)). */
const REASON_MAX = 500;
/** The column default, for a row that somehow has no duration. */
const DEFAULT_DURATION_MINUTES = 30;

// Everything the reschedule core carries onto the new leg (status included — its
// rollback restores before.status), plus what cancelSingleAppointment reads to
// reach Cal.com / Cliniko (external_id, provider, metadata).
const OWNER_BEFORE_COLS =
  "id, organization_id, external_id, provider, metadata, confirmation_code, " +
  "attendee_name, attendee_first_name, attendee_last_name, attendee_phone, attendee_email, " +
  "notes, start_time, end_time, duration_minutes, status, service_type_id, practitioner_id, " +
  "service_types(name), practitioners(name)";

// ToolResult.data is a plain record; these keep each tool's payload checked against its interface.
const rescheduleData = (d: OwnerRescheduleData) => d as unknown as Record<string, unknown>;
const cancelData = (d: OwnerCancelData) => d as unknown as Record<string, unknown>;

/**
 * SCRUM-415 sibling of enforceApptMutationRateLimit, keyed on the ORG as the
 * owner (there is no caller phone to key on — the owner is the one caller).
 * Fail-open: a limiter hiccup never blocks a legitimate change.
 */
async function ownerMutationAllowed(supabase: ServiceRoleSupabaseClient, organizationId: string): Promise<boolean> {
  try {
    const rl = await rateLimitDistributed(supabase, `${organizationId}:owner`, "appt-mutate", "auth");
    return rl.allowed;
  } catch (err) {
    console.warn("[owner-assistant] rate limiter threw — allowing the change (fail-open):", {
      organizationId,
      error: err instanceof Error ? err.message : err,
    });
    return true;
  }
}

/**
 * The job the owner is talking about — org-scoped AND active-only in the SAME
 * query, so another org's id, a cancelled row and a nonsense id all read the
 * same ("can't find"). Returns `undefined` on a DB fault (caller → errorResult).
 */
async function loadOwnerAppointment(
  supabase: any,
  organizationId: string,
  appointmentId: unknown
): Promise<any | null | undefined> {
  if (typeof appointmentId !== "string" || !isValidUUID(appointmentId)) return null;
  const { data: row, error } = await supabase
    .from("appointments")
    .select(OWNER_BEFORE_COLS)
    .eq("id", appointmentId)
    .eq("organization_id", organizationId)
    .in("status", ["confirmed", "pending"])
    .maybeSingle();
  if (error) {
    console.error("[owner-assistant] appointment lookup failed:", { organizationId, appointmentId, error });
    return undefined;
  }
  return row ?? null;
}

// Same projection as the dashboard PATCH route's toSnapshot: the audit diff input.
function toSnapshot(row: any): AppointmentSnapshot {
  return {
    name: row.attendee_name ?? null,
    phone: row.attendee_phone ?? null,
    email: row.attendee_email ?? null,
    notes: row.notes ?? null,
    startTime: row.start_time ?? null,
    status: row.status ?? null,
    practitioner: pickName(row.practitioners),
    service: pickName(row.service_types),
  };
}

export async function handleOwnerRescheduleAppointment(
  organizationId: string,
  args: { appointment_id?: string; new_datetime?: string; confirmed?: unknown },
  ctx: OwnerCallContext
): Promise<ToolResult> {
  const supabase = createAdminClient();
  const tz = await getOrgTimezone(supabase, organizationId);
  if (!tz) return errorResult(TROUBLE);

  const before = await loadOwnerAppointment(supabase, organizationId, args.appointment_id);
  if (before === undefined) return errorResult(TROUBLE);
  if (before === null) {
    return { success: false, message: NOT_FOUND_MSG, data: rescheduleData({ outcome: "not_found", customer_notified: false }) };
  }

  const oldStart = new Date(before.start_time);
  const newStart = parseOwnerLocalDatetime(args.new_datetime, tz);
  const invalid = (message: string): ToolResult => ({
    success: false,
    message,
    data: rescheduleData({ outcome: "invalid_time", appointment_id: before.id, customer_notified: false }),
  });
  if (!newStart) return invalid("I need the new time as a date and time, like 2026-10-20T09:00.");
  if (newStart.getTime() < Date.now()) return invalid("That time has already passed. What time should it move to?");
  if (newStart.getTime() > Date.now() + MAX_BOOKING_HORIZON_MS) {
    return invalid("That's more than a year away. What time should it move to?");
  }
  // A same-time "move" would only mint a new leg (and a new confirmation code) for nothing.
  if (newStart.getTime() === oldStart.getTime()) {
    return invalid("The job is already booked for that time, so there's nothing to move. What time should it move to?");
  }

  const from = formatWhen(oldStart, tz);
  const to = formatWhen(newStart, tz);
  const customer = sanitizeCustomerText(before.attendee_name, NAME_MAX) ?? "the customer";

  if (args.confirmed !== true) {
    return {
      success: false,
      message: `Read this back and get a clear yes before changing anything: move ${customer}'s job from ${from} to ${to}. If the owner confirms, call owner_reschedule_appointment again with confirmed=true.`,
      data: rescheduleData({ outcome: "needs_confirmation", appointment_id: before.id, customer_name: customer, from, to, customer_notified: false }),
    };
  }

  if (!(await ownerMutationAllowed(supabase, organizationId))) {
    return {
      success: false,
      message: RATE_LIMITED_MSG,
      data: rescheduleData({ outcome: "rate_limited", appointment_id: before.id, customer_notified: false }),
    };
  }

  const durationMs = (before.duration_minutes ?? DEFAULT_DURATION_MINUTES) * 60_000;
  const outcome = await performRescheduleLeg(supabase, {
    orgId: organizationId,
    oldId: before.id,
    before,
    updates: { start_time: newStart.toISOString(), end_time: new Date(newStart.getTime() + durationMs).toISOString() },
    leg: {
      provider: "internal",
      metadata: { source: "owner_voice", call_id: ctx.callId, rescheduled_from: before.id },
      callId: ctx.callId,
    },
  });

  if (!outcome.ok) {
    switch (outcome.reason) {
      case "not_active":
        return {
          success: false,
          message: NOT_FOUND_MSG,
          data: rescheduleData({ outcome: "not_found", appointment_id: before.id, customer_notified: false }),
        };
      case "conflict": {
        let alternatives = "";
        try {
          const avail = await handleCheckAvailability(organizationId, {
            date: toLocalIsoMinute(newStart, tz).slice(0, 10),
            service_type_id: before.service_type_id ?? undefined,
            practitioner_id: before.practitioner_id ?? undefined,
          });
          if (avail.success) alternatives = avail.message;
        } catch (err) {
          console.warn("[owner-assistant] alternatives lookup failed (non-fatal):", {
            organizationId,
            error: err instanceof Error ? err.message : err,
          });
        }
        return {
          success: false,
          message: `${to} clashes with another job, so nothing was changed.${alternatives ? ` ${alternatives}` : ""}`,
          data: rescheduleData({ outcome: "slot_taken", appointment_id: before.id, from, to, alternatives, customer_notified: false }),
        };
      }
      case "orphaned":
        // Old leg freed, new leg not inserted, rollback failed: the customer has no
        // active booking. The core's page reaches Sentry only (no DSN in production),
        // so raise the [ALERT:error] line the Grafana pager keys on here.
        pageSentry({
          service: "next-api",
          reason: SENTRY_REASONS.OWNER_RESCHEDULE_ORPHANED,
          level: "error",
          message: "Owner reschedule rollback failed — the customer has no active booking",
          extras: { organizationId, appointmentId: before.id, callId: ctx.callId, dbErrorCode: outcome.error.code },
        });
        return errorResult(
          `I couldn't move the job and couldn't restore the original either — ${customer}'s ${from} job needs a manual check in the dashboard.`
        );
      case "free_failed":
        // A lost response can leave the old booking freed with no new leg, so this
        // must not claim the booking is unchanged.
        return errorResult("I couldn't move that booking — something went wrong on our side. Please check it in the dashboard.");
      case "insert_failed":
        // The core restored the old booking.
        return errorResult(`I couldn't move that job just now. ${customer} is still booked for ${from}.`);
    }
  }

  const inserted = outcome.inserted;
  runAfterResponse(async () => {
    try {
      await invalidateVoiceScheduleCache(organizationId);
    } catch (err) {
      console.warn("[VoiceCacheInvalidate] after-response failed:", err instanceof Error ? err.message : err);
    }
  });
  // Audit on the NEW leg (the history renders the move from the leg itself).
  const { legWorthy } = partitionRescheduleChanges(diffAppointmentFields(toSnapshot(before), toSnapshot(inserted)));
  await recordAppointmentEvent(supabase, {
    appointmentId: inserted.id,
    organizationId,
    eventType: "rescheduled",
    actorType: "staff",
    actorId: null,
    channel: "voice",
    changedFields: legWorthy,
    callId: ctx.callId,
  });

  return {
    success: true,
    message: `Moved ${customer} from ${from} to ${to}.${NOT_NOTIFIED}`,
    data: rescheduleData({
      outcome: "rescheduled",
      appointment_id: before.id,
      new_appointment_id: inserted.id,
      customer_name: customer,
      customer_phone: sanitizeCustomerText(before.attendee_phone, PHONE_MAX),
      from,
      to,
      customer_notified: false,
    }),
  };
}

export async function handleOwnerCancelAppointment(
  organizationId: string,
  args: { appointment_id?: string; confirmed?: unknown; reason?: string },
  ctx: OwnerCallContext
): Promise<ToolResult> {
  const supabase = createAdminClient();
  const tz = await getOrgTimezone(supabase, organizationId);
  if (!tz) return errorResult(TROUBLE);

  const appt = await loadOwnerAppointment(supabase, organizationId, args.appointment_id);
  if (appt === undefined) return errorResult(TROUBLE);
  if (appt === null) {
    return { success: false, message: NOT_FOUND_MSG, data: cancelData({ outcome: "not_found", customer_notified: false }) };
  }

  const when = formatWhen(new Date(appt.start_time), tz);
  const customer = sanitizeCustomerText(appt.attendee_name, NAME_MAX) ?? "the customer";

  if (args.confirmed !== true) {
    return {
      success: false,
      message: `Read this back and get a clear yes before cancelling: cancel ${customer}'s job on ${when}. If the owner confirms, call owner_cancel_appointment again with confirmed=true.`,
      data: cancelData({ outcome: "needs_confirmation", appointment_id: appt.id, customer_name: customer, when, customer_notified: false }),
    };
  }

  if (!(await ownerMutationAllowed(supabase, organizationId))) {
    return {
      success: false,
      message: RATE_LIMITED_MSG,
      data: cancelData({ outcome: "rate_limited", appointment_id: appt.id, customer_notified: false }),
    };
  }

  // Model-supplied: one bounded line before it reaches Cal.com / Cliniko and the audit log.
  const reason = sanitizeCustomerText(args.reason, REASON_MAX) ?? DEFAULT_CANCEL_REASON;
  // Propagates to Cal.com / Cliniko, frees the row, invalidates the voice cache;
  // its customer SMS path is paused (SCRUM-264). A failure comes back as-is
  // (errorResult for genuine faults) so the model never claims a cancel it didn't get.
  const result = await cancelSingleAppointment(supabase, organizationId, appt, reason);
  if (!result.success) return result;

  await recordAppointmentEvent(supabase, {
    appointmentId: appt.id,
    organizationId,
    eventType: "cancelled",
    actorType: "staff",
    actorId: null,
    channel: "voice",
    note: reason,
    callId: ctx.callId,
  });

  return {
    success: true,
    message: `Cancelled ${customer}'s job on ${when}.${NOT_NOTIFIED}`,
    data: cancelData({
      outcome: "cancelled",
      appointment_id: appt.id,
      customer_name: customer,
      customer_phone: sanitizeCustomerText(appt.attendee_phone, PHONE_MAX),
      when,
      customer_notified: false,
    }),
  };
}
