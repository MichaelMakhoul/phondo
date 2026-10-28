// src/lib/owner-assistant/tool-handlers.ts
// SCRUM-586: the business owner's tools — what the AI can do once a call has
// passed the owner PIN gate (spec: docs/superpowers/specs/2026-10-09-owner-
// assistant-design.md §2-§4). Reached ONLY through the internal tool-call
// route's owner dispatch (envelope `ownerVerified` + production call). Every
// query is org-scoped in SQL; ids come back in `data` so the model never has
// to speak them. Anything a customer wrote (names, numbers, notes, reasons,
// summaries) is flattened to one capped line first (sanitize.ts) — it lands in a
// session that also holds the reschedule/cancel tools. SCRUM-597: every change
// asks whether to let the customer know (customer-contact.ts) and reports what
// actually happened.
import { createAdminClient, type ServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import {
  errorResult,
  toLocalIsoMinute,
  cancelSingleAppointment,
  handleBookAppointment,
  handleCheckAvailability,
  normalizeGivenName,
  ownerDiaryProvider,
  type ToolResult,
} from "@/lib/calendar/tool-handlers";
import { phonesMatchForOwnership } from "@/lib/calendar/appointment-verification";
import { confirmationIdempotencyKey } from "@/lib/sms/caller-sms";
import { parsePhoneToE164 } from "@/lib/phone/normalize";
import { formatPhoneForCountry } from "@/lib/country-config";
import { pickName, snapshotForAudit, MAX_BOOKING_HORIZON_MS } from "@/lib/calendar/appointment-lifecycle";
import { partitionRescheduleChanges } from "@/lib/calendar/reschedule-core";
import { performRescheduleLeg } from "@/lib/calendar/reschedule-leg";
import { isServiceTypeQuestion } from "@/lib/calendar/service-type-question";
import { diffAppointmentFields, recordAppointmentEvent } from "@/lib/appointments/events";
import { rateLimitDistributed } from "@/lib/security/rate-limiter";
import { isValidEmail, isValidPhoneNumber, isValidUUID } from "@/lib/security/validation";
import { bookingFieldsQuery } from "@/lib/calendar/booking-fields";
import { hasNonLatinLetters } from "@/lib/calendar/latin-name";
import { runAfterResponse } from "@/lib/utils/after-response";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import {
  OWNER_RANGES,
  type OwnerRange,
  ownerRangeBounds,
  localDayRange,
  todayISO,
  parseOwnerLocalDatetime,
  formatWhen,
  formatSpan,
  isRealCalendarDate,
} from "./time";
import { addDaysISO } from "@/lib/calendar/tool-handlers";
import { sanitizeCustomerText } from "./sanitize";
import { isOwnerCallMetadata, isCustomerNotifyCallMetadata } from "./owner-call";
import {
  contactCustomer,
  contactOutcomeSentence,
  getContactOptions,
  isCustomerNotified,
  parseContactMethod,
  type ContactKind,
  type ContactMethod,
  type ContactOptions,
  type CustomerContactResult,
} from "./customer-contact";
import { callWhy, checkCustomerCall, placeCustomerCall, TIMES_OF_DAY, type CallBlockReason, type TimeWindow } from "./customer-call";

export { OWNER_TOOL_NAMES, type OwnerToolName } from "./tool-names";

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
  /** SCRUM-607: what this list leaves out — facts for the model, never read out. */
  not_shown: string[];
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
  /** The post-call summary; without one, "On a call right now" while the call is still
   *  in progress, else "No message — short or missed call" (a missed or very short call,
   *  or the post-call analysis failed). */
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
/** Calls fetched before the in-process owner-call filter (≤ MESSAGES_LIMIT are listed). */
const CALLS_FETCH_LIMIT = 30;
/** A customer call with no (printable) summary: missed, too short to analyse, or analysis failed. */
const NO_SUMMARY = "No message — short or missed call";
/** A customer call still under way (calls.status "in-progress"): no summary exists yet. */
const ON_A_CALL = "On a call right now";
/**
 * Caps for customer-written text in tool results (see sanitizeCustomerText). Service
 * and practitioner names are org-controlled, but get the same treatment: it is free.
 * Phone numbers are covered too — a booking only has to contain 8-15 digits, so the
 * stored value can carry text around them.
 */
const NAME_MAX = 80;
/**
 * SCRUM-607: what the jobs list leaves out, as FACTS in `data.not_shown` (the prompt says
 * how to use them) — never instructions in the message: a fallback reads the message out
 * word for word. A real session asked "did anyone call or book on Monday?" and heard
 * "nothing was booked on Monday" (a call and the job it booked, since cancelled, never showed).
 */
export const APPOINTMENTS_NOT_SHOWN: readonly string[] = ["cancelled jobs", "calls", "when bookings were made"];
/**
 * SCRUM-609: the messages read's scope, as a FACT on its calls line. Asked "what calls did I
 * get this week?", Gemini answered with today's call and never said it can't see the rest —
 * the scope sat only in data.not_shown, which it skipped. A plain fact is safe to read out
 * word for word (the fallback does), so it goes where the count is said.
 */
export const CALLS_SCOPE = "I can only see today's calls";
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

/**
 * SCRUM-597: the zone plus the country, for the write tools. A customer's number is
 * normalised in the org's country before deciding whether it can take a text. Same
 * fault rule as getOrgTimezone: a failed read is null (the caller reports a fault).
 */
async function getOrgZoneAndCountry(
  supabase: any,
  organizationId: string
): Promise<{ tz: string; country: string | null } | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("timezone, country")
    .eq("id", organizationId)
    .single();
  if (error) {
    console.error("[owner-assistant] failed to load org timezone/country:", { organizationId, error });
    return null;
  }
  return { tz: data?.timezone || DEFAULT_TZ, country: data?.country ?? null };
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
  const payload: OwnerListAppointmentsData = { range, date: bounds.firstDate, count: total, appointments: items, not_shown: [...APPOINTMENTS_NOT_SHOWN] };

  // SCRUM-607: what this list is — and isn't. A real session asked "did anyone call or
  // book on Monday?" and heard "nothing was booked on Monday": this lists jobs SCHEDULED
  // then, so Monday's call — and the job it booked, since cancelled — never showed.
  if (total === 0) {
    return { success: true, message: `No jobs scheduled ${bounds.label}.`, data: payload as unknown as Record<string, unknown> };
  }
  const head = `${total} ${total === 1 ? "job" : "jobs"} scheduled ${bounds.label}${total > items.length ? ` (first ${items.length} listed)` : ""}:`;
  return {
    success: true,
    message: [head, ...items.map(describeItem)].join("\n"),
    data: payload as unknown as Record<string, unknown>,
  };
}

/**
 * `ctx` is the owner's own call (the route passes the envelope callId, as for the write
 * tools). Its row already exists while the owner is asking — status "in-progress", no
 * summary, and not yet marked call_type "owner" (completeCallRecord writes that when the
 * call ends) — so it is excluded by id in the query; without it, the owner would hear their
 * own call read back as a customer's.
 */
export async function handleOwnerListMessages(organizationId: string, ctx?: OwnerCallContext): Promise<ToolResult> {
  const supabase = createAdminClient();
  const tz = await getOrgTimezone(supabase, organizationId);
  if (!tz) return errorResult(TROUBLE);
  const today = localDayRange(todayISO(tz), tz);

  const { data: cbs, error: cbErr, count: cbCount } = await (supabase as any)
    .from("callback_requests")
    .select("id, caller_name, caller_phone, reason, requested_time, urgency, created_at", { count: "exact" })
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(MESSAGES_LIMIT);
  if (cbErr) {
    console.error("[owner-assistant] list_messages callbacks failed:", { organizationId, error: cbErr });
    return errorResult(TROUBLE);
  }

  let callsQuery = (supabase as any)
    .from("calls")
    .select("id, caller_name, caller_phone, summary, status, created_at, metadata")
    .eq("organization_id", organizationId)
    // Spam is not a message. `IS NOT TRUE` (PostgREST `is_spam=not.is.true`) keeps both
    // false and NULL rows, and doing it in SQL stops spam crowding the fetch window.
    .not("is_spam", "is", true)
    .gte("created_at", today.start)
    .lt("created_at", today.end);
  // The owner's own live call (see the JSDoc), left out in the same query so it never
  // takes a slot in the fetch window either.
  if (typeof ctx?.callId === "string" && ctx.callId.length > 0) {
    callsQuery = callsQuery.neq("id", ctx.callId);
  }
  const { data: calls, error: callErr } = await callsQuery
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
  // The list is capped; the count is the real number waiting.
  const cbTotal = typeof cbCount === "number" ? cbCount : callbacks.length;

  // The owner's own calls are not messages, nor are the calls the assistant placed to
  // customers (SCRUM-598: each has its own email). Every other call today is: a missed
  // or short call (or one whose post-call analysis failed, or one still under way) has
  // no summary but is still a customer who rang, so it is listed and counted rather than dropped.
  const customerRows = (calls ?? []).filter((c: any) => !isOwnerCallMetadata(c.metadata) && !isCustomerNotifyCallMetadata(c.metadata));
  const customerCalls: OwnerCallItem[] = customerRows.slice(0, MESSAGES_LIMIT).map((c: any) => ({
    call_id: c.id,
    at: formatWhen(new Date(c.created_at), tz),
    caller_name: sanitizeCustomerText(c.caller_name, NAME_MAX),
    caller_phone: sanitizeCustomerText(c.caller_phone, PHONE_MAX),
    summary: sanitizeCustomerText(c.summary, TEXT_MAX) ?? (c.status === "in-progress" ? ON_A_CALL : NO_SUMMARY),
  }));
  const callTotal = customerRows.length;
  // A full fetch window means today may hold more calls than were fetched.
  const callsSaturated = (calls ?? []).length >= CALLS_FETCH_LIMIT;

  const payload: OwnerListMessagesData = { callbacks, calls: customerCalls };
  if (cbTotal === 0 && callTotal === 0 && !callsSaturated) {
    return { success: true, message: `No messages waiting and no customer calls yet today (${CALLS_SCOPE}).`, data: payload as unknown as Record<string, unknown> };
  }
  const lines: string[] = [];
  lines.push(
    `${cbTotal} ${cbTotal === 1 ? "callback" : "callbacks"} waiting` +
      `${cbTotal > callbacks.length ? ` (newest ${callbacks.length} listed)` : ""}${callbacks.length ? ":" : "."}`
  );
  for (const c of callbacks) {
    lines.push(`- ${c.caller_name} (${c.caller_phone}), ${c.urgency} urgency: ${c.reason}${c.requested ? ` — wants ${c.requested}` : ""} (received ${c.received})`);
  }
  if (callsSaturated && callTotal === 0) {
    // Every fetched row was the owner's own: older customer calls today may exist beyond
    // the window, so say what was looked at rather than "no customer calls" or "at least 0".
    lines.push(`No customer calls among the latest ${CALLS_FETCH_LIMIT} calls today (${CALLS_SCOPE}).`);
  } else {
    lines.push(
      `${callsSaturated ? "At least " : ""}${callTotal} customer ${callTotal === 1 ? "call" : "calls"} today` +
        ` (${callTotal > customerCalls.length ? `newest ${customerCalls.length} listed; ` : ""}${CALLS_SCOPE})${customerCalls.length ? ":" : "."}`
    );
  }
  for (const c of customerCalls) {
    lines.push(`- ${c.at}: ${c.caller_name ?? "Unknown caller"}${c.caller_phone ? ` (${c.caller_phone})` : ""} — ${c.summary}`);
  }
  return { success: true, message: lines.join("\n"), data: payload as unknown as Record<string, unknown> };
}

// ─── Write tools ─────────────────────────────────────────────────────────────

export interface OwnerRescheduleData {
  outcome:
    | "rescheduled"
    | "needs_confirmation"
    | "not_found"
    | "external_calendar"
    | "slot_taken"
    | "invalid_time"
    | "rate_limited";
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
  /** On slot_taken: the free times that day, when the calendar could list them (absent otherwise). */
  alternatives?: string;
  /** On needs_confirmation: how the customer can be told now ("none" always included). */
  contact_options?: ContactMethod[];
  /** On needs_confirmation: why text isn't offered, when it isn't. */
  contact_note?: string;
  /** After the change: what happened to the owner's choice of telling the customer. */
  customer_contact?: CustomerContactResult;
  /** True only when the customer was actually told (a text went out). */
  customer_notified: boolean;
}
export interface OwnerCancelData {
  outcome: "cancelled" | "needs_confirmation" | "not_found" | "external_calendar" | "rate_limited";
  appointment_id?: string;
  customer_name?: string;
  customer_phone?: string | null;
  /** Spoken form of the job's time (formatWhen). */
  when?: string;
  contact_options?: ContactMethod[];
  contact_note?: string;
  customer_contact?: CustomerContactResult;
  customer_notified: boolean;
}

/**
 * SCRUM-598: owner_call_customer — a call about one booking that changes nothing by
 * itself (so, unlike the change tools, no customer_notified: the call's own email
 * says how it went).
 */
export interface OwnerCallCustomerData {
  outcome: "calling" | "needs_confirmation" | "not_available" | "not_found" | "external_calendar" | "rate_limited";
  appointment_id?: string;
  customer_name?: string;
  /** Spoken form of the booking's time (formatWhen). */
  when?: string;
  purpose?: "confirm" | "find_new_time";
  /** find_new_time: the window for the new time, as validated. */
  window?: TimeWindow;
  /** On not_available: why a call can't be placed. */
  reason?: CallBlockReason;
  /** On calling: the call's own id (its outcome email links to it). */
  call_id?: string;
}

const NOT_FOUND_MSG = "I can't find that job. It may have already been moved or cancelled.";
const RATE_LIMITED_MSG = "There have been several changes in a row just now — give it a minute and try again.";
const SLOT_TAKEN_NO_ALTERNATIVES_MSG = "That time's taken — want to try another time?";
const CANCEL_FAULT_MSG = "I couldn't cancel that booking — something went wrong on our side. Please check it in the dashboard.";
/** A move or cancel landed between the lookup and the cancel: nothing was cancelled. */
const ALREADY_CHANGED_MSG = "That booking has already changed — I haven't cancelled anything.";
const DEFAULT_CANCEL_REASON = "Cancelled by the business owner by phone";
/** Same bound the customer cancel path puts on a reason (sanitizeString(reason, 500)). */
const REASON_MAX = 500;
/** The column default, for a row that somehow has no duration. */
const DEFAULT_DURATION_MINUTES = 30;

/**
 * SCRUM-597: the owner's recap email lists only the changes in appointment_events, so
 * a change whose audit row failed would be missing from it with nobody told — page.
 */
function pageUnaudited(organizationId: string, callId: string, appointmentId: string, change: "cancelled" | "rescheduled" | "created"): void {
  pageSentry({
    service: "next-api",
    reason: SENTRY_REASONS.OWNER_CHANGE_NOT_AUDITED,
    level: "error",
    message: `an owner ${change} change was made but not audited — the owner's recap email will miss it`,
    extras: { organizationId, callId, appointmentId, change },
  });
}

/** The ways this customer can be told right now, spoken ("text", "text or call"); "" when there are none. */
function contactWays(contact: ContactOptions): string {
  return contact.options.filter((m) => m !== "none").map((m) => (m === "text" ? "text" : "call")).join(" or ");
}

/**
 * SCRUM-597: the read-back, with the "let them know?" question in the same breath.
 * Only the ways that work for this customer right now are offered. With none, there
 * is nothing to choose: the model says so and offers the number, and a bare yes
 * confirms (notify_customer "none" is assumed — see the handlers).
 */
function readBackMessage(change: string, customer: string, contact: ContactOptions, tool: string, kind: ContactKind): string {
  const ways = contactWays(contact);
  // Clients lens M8: a call does more than tell them — the owner hears that before choosing.
  const callDoes = !contact.options.includes("call")
    ? ""
    : kind === "cancelled"
      ? " (a call also offers them another time)"
      : kind === "moved"
        ? " (a call also checks the new time suits them)"
        : "";
  if (!ways) {
    const why = contact.note ? ` (${contact.note.replace(/[.!?]+$/, "")})` : "";
    const offerNumber = kind === "booked" ? "" : " and offer to read out their number after the change";
    return `Read this back and get a clear yes before changing anything: ${change}. Telling ${customer} isn't possible from here${why}: say so in a few words (for example "I can't text them")${offerNumber}. If the owner confirms, call ${tool} again with confirmed=true and notify_customer "none".`;
  }
  const note = contact.note ? ` ${contact.note}` : "";
  // Both sides as the example, so "already said" never leans toward one guess.
  const told = contact.options.includes("text") ? "text" : "call";
  return `Read this back and get a clear yes before changing anything: ${change}. In the same question, ask whether to let ${customer} know: by ${ways}${callDoes}, or not tell them — or, if the owner already said, don't ask again: say their choice in the read-back ("…and ${told} them, right?" or "…and not tell them, right?").${note} If the owner confirms, call ${tool} again with confirmed=true and notify_customer set to their answer: ${contact.options.map((m) => `"${m}"`).join(", ")}.`;
}

/**
 * A confirm that came without the owner's answer on telling the customer, when there
 * IS a choice: nothing changes, and the model asks it now (one question — the
 * confirmation gate is re-armed by this result, so the next confirm passes).
 */
function askContactMessage(customer: string, contact: ContactOptions, tool: string): string {
  const note = contact.note ? ` ${contact.note}` : "";
  return `Nothing has changed yet: the owner said yes but not whether to let ${customer} know. Ask them now: should ${customer} get a ${contactWays(contact)}, or not be told?${note} Then call ${tool} again with confirmed=true and notify_customer set to their answer: ${contact.options.map((m) => `"${m}"`).join(", ")}.`;
}

/**
 * The owner tools change only Phondo's own bookings. Anything else lives in a diary
 * Phondo doesn't own — moving or freeing the local copy would leave the real diary
 * out of step — so it is refused and the owner changes it there.
 */
const OWNER_EDITABLE_PROVIDERS: ReadonlySet<string> = new Set(["internal", "manual"]);
/** The external providers allowed by the appointments.provider CHECK (migration 00159). */
const EXTERNAL_DIARY_NAMES: ReadonlyMap<string, string> = new Map([
  ["cliniko", "Cliniko"],
  ["cal_com", "Cal.com"],
  ["google_calendar", "Google Calendar"],
  ["calendly", "Calendly"],
]);

/** Null when the owner tools may change this booking; otherwise what to tell the owner. */
function externalDiaryRefusal(organizationId: string, row: any): string | null {
  if (OWNER_EDITABLE_PROVIDERS.has(row.provider)) return null;
  let diary = EXTERNAL_DIARY_NAMES.get(row.provider);
  if (!diary) {
    // A provider newer than this list: refuse (fail closed) and say so in the logs.
    console.warn("[owner-assistant] unrecognised appointment provider — treated as an external diary:", {
      organizationId,
      appointmentId: row.id,
      provider: row.provider,
    });
    diary = "external calendar";
  }
  return `That booking lives in your ${diary} diary, so I haven't touched it — please change it there.`;
}

// Everything the reschedule core carries onto the new leg (status included — its
// rollback restores before.status); `provider` for externalDiaryRefusal; and the
// external_id / metadata that cancelSingleAppointment reads.
const OWNER_BEFORE_COLS =
  "id, organization_id, external_id, provider, metadata, confirmation_code, " +
  "attendee_name, attendee_first_name, attendee_last_name, attendee_phone, attendee_email, " +
  "notes, start_time, end_time, duration_minutes, status, service_type_id, practitioner_id, " +
  "service_types(name), practitioners(name)";

// ToolResult.data is a plain record; these keep each tool's payload checked against its interface.
const rescheduleData = (d: OwnerRescheduleData) => d as unknown as Record<string, unknown>;
const cancelData = (d: OwnerCancelData) => d as unknown as Record<string, unknown>;
const callData = (d: OwnerCallCustomerData) => d as unknown as Record<string, unknown>;

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

export async function handleOwnerRescheduleAppointment(
  organizationId: string,
  args: { appointment_id?: string; new_datetime?: string; confirmed?: unknown; notify_customer?: string },
  ctx: OwnerCallContext
): Promise<ToolResult> {
  const supabase = createAdminClient();
  const org = await getOrgZoneAndCountry(supabase, organizationId);
  if (!org) return errorResult(TROUBLE);
  const tz = org.tz;

  const before = await loadOwnerAppointment(supabase, organizationId, args.appointment_id);
  if (before === undefined) return errorResult(TROUBLE);
  if (before === null) {
    return { success: false, message: NOT_FOUND_MSG, data: rescheduleData({ outcome: "not_found", customer_notified: false }) };
  }
  const external = externalDiaryRefusal(organizationId, before);
  if (external) {
    return {
      success: false,
      message: external,
      data: rescheduleData({ outcome: "external_calendar", appointment_id: before.id, customer_notified: false }),
    };
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

  // SCRUM-597: a confirm needs the owner's answer on telling the customer too —
  // without one, nothing changes and the question is asked first. With nothing to
  // choose (the customer can't be texted or called), a bare yes is the whole answer.
  const chosen = args.confirmed === true ? parseContactMethod(args.notify_customer) : null;
  let method: ContactMethod;
  if (chosen) {
    method = chosen;
  } else {
    const contact = await getContactOptions(organizationId, before.attendee_phone, org.country, undefined, {
      appointmentId: before.id,
      purpose: "moved",
      requestedByCallId: ctx.callId,
    });
    if (args.confirmed === true && !contactWays(contact)) {
      method = "none";
    } else {
      const change = `move ${customer}'s job from ${from} to ${to}`;
      return {
        success: false,
        message:
          args.confirmed === true
            ? askContactMessage(customer, contact, "owner_reschedule_appointment")
            : readBackMessage(change, customer, contact, "owner_reschedule_appointment", "moved"),
        data: rescheduleData({
          outcome: "needs_confirmation",
          appointment_id: before.id,
          customer_name: customer,
          from,
          to,
          contact_options: contact.options,
          ...(contact.note ? { contact_note: contact.note } : {}),
          customer_notified: false,
        }),
      };
    }
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
        let alternatives: string | undefined;
        let askedForType = false;
        try {
          const avail = await handleCheckAvailability(organizationId, {
            date: toLocalIsoMinute(newStart, tz).slice(0, 10),
            service_type_id: before.service_type_id ?? undefined,
            practitioner_id: before.practitioner_id ?? undefined,
          });
          if (avail.success) {
            // A job with no type (or a type Cliniko doesn't know) gets a "which
            // type?" question back instead of free times — never read that out.
            if (isServiceTypeQuestion(avail.message)) askedForType = true;
            else alternatives = avail.message || undefined;
          }
        } catch (err) {
          console.warn("[owner-assistant] alternatives lookup failed (non-fatal):", {
            organizationId,
            error: err instanceof Error ? err.message : err,
          });
        }
        return {
          success: false,
          message: askedForType
            ? SLOT_TAKEN_NO_ALTERNATIVES_MSG
            : `${to} clashes with another job, so nothing was changed.${alternatives ? ` ${alternatives}` : ""}`,
          data: rescheduleData({
            outcome: "slot_taken",
            appointment_id: before.id,
            from,
            to,
            ...(alternatives ? { alternatives } : {}),
            customer_notified: false,
          }),
        };
      }
      case "orphaned":
        // Old leg freed, no new leg, restore failed: the customer has no active
        // booking. performRescheduleLeg has already paged on-call ([ALERT:error],
        // source owner_voice), so this only tells the owner.
        return errorResult(
          `I couldn't move the job and couldn't restore the original either — ${customer}'s ${from} job needs a manual check in the dashboard.`
        );
      case "free_failed":
        // The core restores a free that committed behind the error, but if it could
        // not even look, the booking may be freed with no new leg — so this must not
        // claim the booking is unchanged.
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
  const { legWorthy } = partitionRescheduleChanges(diffAppointmentFields(snapshotForAudit(before), snapshotForAudit(inserted)));
  const audited = await recordAppointmentEvent(supabase, {
    appointmentId: inserted.id,
    organizationId,
    eventType: "rescheduled",
    actorType: "staff",
    actorId: null,
    channel: "voice",
    changedFields: legWorthy,
    callId: ctx.callId,
  });
  if (!audited) pageUnaudited(organizationId, ctx.callId, inserted.id, "rescheduled");

  // The text (if asked for) is about the NEW time, on the new leg.
  const contact = await contactCustomer({
    orgId: organizationId,
    method,
    kind: "moved",
    appointmentId: inserted.id,
    startTime: newStart,
    phone: inserted.attendee_phone ?? before.attendee_phone,
    country: org.country,
    timezone: tz,
    requestedByCallId: ctx.callId,
  });
  return {
    success: true,
    message: `Moved ${customer} from ${from} to ${to}.${contactOutcomeSentence(contact, customer, "moved")}`,
    data: rescheduleData({
      outcome: "rescheduled",
      appointment_id: before.id,
      new_appointment_id: inserted.id,
      customer_name: customer,
      customer_phone: sanitizeCustomerText(before.attendee_phone, PHONE_MAX),
      from,
      to,
      customer_contact: contact,
      customer_notified: isCustomerNotified(contact),
    }),
  };
}

export async function handleOwnerCancelAppointment(
  organizationId: string,
  args: { appointment_id?: string; confirmed?: unknown; reason?: string; notify_customer?: string },
  ctx: OwnerCallContext
): Promise<ToolResult> {
  const supabase = createAdminClient();
  const org = await getOrgZoneAndCountry(supabase, organizationId);
  if (!org) return errorResult(TROUBLE);
  const tz = org.tz;

  const appt = await loadOwnerAppointment(supabase, organizationId, args.appointment_id);
  if (appt === undefined) return errorResult(TROUBLE);
  if (appt === null) {
    return { success: false, message: NOT_FOUND_MSG, data: cancelData({ outcome: "not_found", customer_notified: false }) };
  }
  const external = externalDiaryRefusal(organizationId, appt);
  if (external) {
    return {
      success: false,
      message: external,
      data: cancelData({ outcome: "external_calendar", appointment_id: appt.id, customer_notified: false }),
    };
  }

  const when = formatWhen(new Date(appt.start_time), tz);
  const customer = sanitizeCustomerText(appt.attendee_name, NAME_MAX) ?? "the customer";

  // SCRUM-597: as for a move, a confirm needs the owner's answer on telling the
  // customer — unless there is nothing to choose.
  const chosen = args.confirmed === true ? parseContactMethod(args.notify_customer) : null;
  let method: ContactMethod;
  if (chosen) {
    method = chosen;
  } else {
    const contact = await getContactOptions(organizationId, appt.attendee_phone, org.country, undefined, {
      appointmentId: appt.id,
      purpose: "cancelled",
      requestedByCallId: ctx.callId,
    });
    if (args.confirmed === true && !contactWays(contact)) {
      method = "none";
    } else {
      const change = `cancel ${customer}'s job on ${when}`;
      return {
        success: false,
        message:
          args.confirmed === true
            ? askContactMessage(customer, contact, "owner_cancel_appointment")
            : readBackMessage(change, customer, contact, "owner_cancel_appointment", "cancelled"),
        data: cancelData({
          outcome: "needs_confirmation",
          appointment_id: appt.id,
          customer_name: customer,
          when,
          contact_options: contact.options,
          ...(contact.note ? { contact_note: contact.note } : {}),
          customer_notified: false,
        }),
      };
    }
  }

  if (!(await ownerMutationAllowed(supabase, organizationId))) {
    return {
      success: false,
      message: RATE_LIMITED_MSG,
      data: cancelData({ outcome: "rate_limited", appointment_id: appt.id, customer_notified: false }),
    };
  }

  // Model-supplied: one bounded line before it reaches the booking row and the audit log.
  const reason = sanitizeCustomerText(args.reason, REASON_MAX) ?? DEFAULT_CANCEL_REASON;
  // Frees the row and refreshes the voice schedule cache (only Phondo's own bookings
  // get this far). suppressSms: the owner's own choice of telling the customer is
  // carried out below (contactCustomer), where who can be texted is checked and the
  // result reported. requireActive: the write is org-scoped and only
  // lands while the row is still confirmed/pending, so a move that slipped in since
  // the lookup is not overwritten (and the owner is not told "Cancelled" while the
  // moved booking stays live). Its failure replies are worded for a caller ("…someone
  // call you back"), so the owner gets their own wording; the cause is already logged
  // inside cancelSingleAppointment.
  const result = await cancelSingleAppointment(supabase, organizationId, appt, reason, { suppressSms: true, requireActive: true });
  if (!result.success) {
    if (result.data?.notActive === true) {
      return {
        success: false,
        message: ALREADY_CHANGED_MSG,
        data: cancelData({ outcome: "not_found", appointment_id: appt.id, customer_notified: false }),
      };
    }
    return errorResult(CANCEL_FAULT_MSG);
  }

  const audited = await recordAppointmentEvent(supabase, {
    appointmentId: appt.id,
    organizationId,
    eventType: "cancelled",
    actorType: "staff",
    actorId: null,
    channel: "voice",
    note: reason,
    callId: ctx.callId,
  });
  if (!audited) pageUnaudited(organizationId, ctx.callId, appt.id, "cancelled");

  const contact = await contactCustomer({
    orgId: organizationId,
    method,
    kind: "cancelled",
    appointmentId: appt.id,
    startTime: new Date(appt.start_time),
    phone: appt.attendee_phone,
    country: org.country,
    timezone: tz,
    requestedByCallId: ctx.callId,
  });
  return {
    success: true,
    message: `Cancelled ${customer}'s job on ${when}.${contactOutcomeSentence(contact, customer, "cancelled")}`,
    data: cancelData({
      outcome: "cancelled",
      appointment_id: appt.id,
      customer_name: customer,
      customer_phone: sanitizeCustomerText(appt.attendee_phone, PHONE_MAX),
      when,
      customer_contact: contact,
      customer_notified: isCustomerNotified(contact),
    }),
  };
}

/** What the call is for, in the read-back's words. */
const CALL_PURPOSE_WORDS = {
  confirm: "check they're still OK for",
  find_new_time: "find a new time for",
} as const;
/** How far ahead find_new_time's window may reach. */
const CALL_WINDOW_MAX_DAYS = 90;

/**
 * find_new_time's window from the model's flat arguments: real calendar days from
 * today (org-local) up to 90 days ahead, earliest before latest, and a time of day
 * from the list. Structured only — the call's prompt words it from these fields, so
 * no owner-session text reaches the customer (security lens F2). null fields = no
 * window; a malformed one is refused whole.
 */
function parseCallWindow(
  args: { earliest_date?: string; latest_date?: string; time_of_day?: string },
  tz: string
): { ok: true; window: TimeWindow | null } | { ok: false } {
  const today = todayISO(tz);
  const last = addDaysISO(today, CALL_WINDOW_MAX_DAYS);
  const day = (v: string | undefined): string | null | undefined => {
    if (v === undefined || v === "") return null;
    return isRealCalendarDate(v) && v >= today && v <= last ? v : undefined;
  };
  const earliest = day(args.earliest_date);
  const latest = day(args.latest_date);
  const timeOfDay =
    args.time_of_day === undefined || args.time_of_day === ""
      ? "any"
      : (TIMES_OF_DAY as readonly string[]).includes(args.time_of_day)
        ? (args.time_of_day as TimeWindow["timeOfDay"])
        : undefined;
  if (earliest === undefined || latest === undefined || timeOfDay === undefined) return { ok: false };
  if (earliest && latest && earliest > latest) return { ok: false };
  if (!earliest && !latest && timeOfDay === "any") return { ok: true, window: null };
  return { ok: true, window: { earliest, latest, timeOfDay } };
}

/** A calendar day in words ("Monday, November 2") — the day itself, in any zone. */
function dayInWords(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

/** The window, read back: " — between Monday, November 2 and Friday, November 6, in the morning". */
function windowPhrase(window: TimeWindow | null): string {
  if (!window) return "";
  const range = window.earliest && window.latest
    ? `between ${dayInWords(window.earliest)} and ${dayInWords(window.latest)}`
    : window.earliest
      ? `from ${dayInWords(window.earliest)}`
      : window.latest
        ? `by ${dayInWords(window.latest)}`
        : "";
  const period = window.timeOfDay === "any" ? "" : `in the ${window.timeOfDay}`;
  const words = [range, period].filter(Boolean).join(", ");
  return words ? ` — ${words}` : "";
}

/**
 * The owner's line when a call isn't placed (the customer's number is offered
 * instead): "can't" at the read-back, before anything was tried; "couldn't" once
 * the placement was refused (clients lens S2).
 */
function callNotPlacedMessage(customer: string, reason: CallBlockReason, tried: boolean): string {
  if (reason === "calls_disabled") return "I can't call customers yet. I can read you their number if you want to ring them yourself.";
  if (reason === "place_unconfirmed") return `I'm not sure the call to ${customer} went out — check Calls in the dashboard before you ring them yourself.`;
  return `I ${tried ? "couldn't" : "can't"} call ${customer}: ${callWhy(reason)}. I can read you their number if you want to ring them yourself.`;
}

/**
 * SCRUM-598: "call the client ... confirm the appointment", "call them and get another
 * time". The assistant phones the customer about ONE booking without changing it:
 * to check they're still OK for it, or to agree a new time and move it (on the
 * call, with the receptionist's own tools). Same two calls as a change: without
 * `confirmed` it places nothing and hands back the read-back (the voice server's
 * confirmation gate arms on it); with confirmed=true after the owner's yes it asks
 * the voice server to place the call, which re-checks everything first. Only
 * Phondo's own bookings, like every owner write.
 */
export async function handleOwnerCallCustomer(
  organizationId: string,
  args: { appointment_id?: string; purpose?: string; earliest_date?: string; latest_date?: string; time_of_day?: string; confirmed?: unknown },
  ctx: OwnerCallContext
): Promise<ToolResult> {
  const supabase = createAdminClient();
  const org = await getOrgZoneAndCountry(supabase, organizationId);
  if (!org) return errorResult(TROUBLE);

  const appt = await loadOwnerAppointment(supabase, organizationId, args.appointment_id);
  if (appt === undefined) return errorResult(TROUBLE);
  if (appt === null) {
    return { success: false, message: NOT_FOUND_MSG, data: callData({ outcome: "not_found" }) };
  }
  const external = externalDiaryRefusal(organizationId, appt);
  if (external) {
    return {
      success: false,
      message: external,
      data: callData({ outcome: "external_calendar", appointment_id: appt.id }),
    };
  }

  const customer = sanitizeCustomerText(appt.attendee_name, NAME_MAX) ?? "the customer";
  const start = new Date(appt.start_time);
  const when = formatWhen(start, org.tz);
  const purpose: "confirm" | "find_new_time" | null =
    args.purpose === "confirm" ? "confirm" : args.purpose === "find_new_time" ? "find_new_time" : null;
  if (!purpose) {
    return {
      success: false,
      message: `Ask the owner what the call is for: to check ${customer} is still OK for ${when}, or to find them a new time. Then call owner_call_customer with purpose "confirm" or "find_new_time".`,
      data: callData({ outcome: "needs_confirmation", appointment_id: appt.id, customer_name: customer, when }),
    };
  }
  const parsedWindow = purpose === "find_new_time" ? parseCallWindow(args, org.tz) : ({ ok: true, window: null } as const);
  if (!parsedWindow.ok) {
    return {
      success: false,
      message: `I need the days for the new time as dates like ${todayISO(org.tz)} (from today, up to ${CALL_WINDOW_MAX_DAYS} days ahead, the first before the last), and the time of day as morning, afternoon, evening or any. Ask the owner if you're not sure, then call owner_call_customer again.`,
      data: callData({ outcome: "needs_confirmation", appointment_id: appt.id, customer_name: customer, when, purpose }),
    };
  }
  const window = parsedWindow.window;
  const base = { appointment_id: appt.id, customer_name: customer, when, purpose, ...(window ? { window } : {}) };
  const notAvailable = (reason: CallBlockReason, message: string): ToolResult => ({
    success: false,
    message,
    data: callData({ outcome: "not_available", ...base, reason }),
  });
  if (start.getTime() <= Date.now()) {
    return notAvailable("wrong_state", `${customer}'s booking on ${when} has already started, so there's nothing to call about.`);
  }

  const request = {
    organizationId,
    appointmentId: appt.id,
    purpose,
    phone: appt.attendee_phone,
    requestedByCallId: ctx.callId,
    window,
  };

  if (args.confirmed !== true) {
    const check = await checkCustomerCall(request);
    if (!check.canCall) return notAvailable(check.reason, callNotPlacedMessage(customer, check.reason, false));
    return {
      success: false,
      message: `Read this back and get a clear yes before calling: call ${customer} now to ${CALL_PURPOSE_WORDS[purpose]} their booking on ${when}${windowPhrase(window)}.${purpose === "find_new_time" ? ` Only those days and that time of day reach the call: if the owner asked for anything else (a day to skip, a time like "after 3", a particular person), say that can't be passed on before they confirm.` : ""} If the owner confirms, call owner_call_customer again with confirmed=true${window ? ", the same purpose, earliest_date, latest_date and time_of_day" : " and the same purpose"}.`,
      data: callData({ outcome: "needs_confirmation", ...base }),
    };
  }

  if (!(await ownerMutationAllowed(supabase, organizationId))) {
    return { success: false, message: RATE_LIMITED_MSG, data: callData({ outcome: "rate_limited", ...base }) };
  }
  const placed = await placeCustomerCall(request);
  if (!placed.placed) return notAvailable(placed.reason, callNotPlacedMessage(customer, placed.reason, true));
  return {
    success: true,
    message: `Calling ${customer} now to ${CALL_PURPOSE_WORDS[purpose]} their booking on ${when}${windowPhrase(window)}. You'll get an email when the call's done.`,
    data: callData({ outcome: "calling", ...base, call_id: placed.callId }),
  };
}

// ─── SCRUM-599: book a new job, block out time, mark a callback done ─────────

export interface OwnerBookData {
  outcome: "booked" | "needs_confirmation" | "invalid_details" | "invalid_time" | "not_booked" | "rate_limited" | "external_calendar";
  customer_name?: string;
  customer_phone?: string;
  /** Spoken form of the booking's time (formatWhen). */
  when?: string;
  /** The service type's name, when one was given. */
  service?: string;
  /** The staff member the diary assigned, when it named one. */
  practitioner?: string;
  /** On booked: the new booking's id — use it for any further change to the job. */
  appointment_id?: string;
  confirmation_code?: string;
  contact_options?: ContactMethod[];
  contact_note?: string;
  customer_contact?: CustomerContactResult;
  /** True only when the customer was actually told (a text went out). */
  customer_notified: boolean;
  /** SCRUM-602: the customer's email, when this business collects one. */
  customer_email?: string;
  /** SCRUM-602: the business's other caller details given for this booking (saved in the job's note). */
  details?: Array<{ id: string; label: string; value: string }>;
  /** On invalid_details: the business's required fields the booking still needs (a hint is the field's own description, e.g. its options). */
  missing_fields?: Array<{ id: string; label: string; hint?: string }>;
}

export interface OwnerBlockData {
  outcome: "blocked" | "needs_confirmation" | "invalid_time" | "rate_limited" | "external_calendar";
  /** Spoken form of the block (formatSpan). It covers everyone (staff choice isn't in v1). */
  when?: string;
  title?: string;
  /** Jobs already booked in that time — they stay booked. */
  jobs_in_the_way?: number;
  /** On blocked: the block's id. */
  block_id?: string;
}

export interface OwnerCallbackDoneData {
  outcome: "callback_done" | "needs_confirmation" | "not_found" | "rate_limited";
  callback_id?: string;
  caller_name?: string;
  reason?: string;
  /** Spoken form of when the callback request came in. */
  received?: string;
  /** The owner's note, as read back. */
  note?: string;
}

const bookData = (d: OwnerBookData) => d as unknown as Record<string, unknown>;
const blockData = (d: OwnerBlockData) => d as unknown as Record<string, unknown>;
const callbackDoneData = (d: OwnerCallbackDoneData) => d as unknown as Record<string, unknown>;

/** The notes the owner gives a new booking: one short line. */
const BOOKING_NOTES_MAX = 200;
const DIGIT_WORDS = ["oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** A run of digits in groups the ear can check: up to four as one, longer in threes (a lone last digit joins the group before). */
function digitGroups(run: string): string[] {
  if (run.length <= 4) return [run];
  const groups = run.match(/\d{1,3}/g) ?? [];
  const last = groups.length - 1;
  if (last > 0 && groups[last].length === 1) groups.splice(last - 1, 2, groups[last - 1] + groups[last]);
  return groups;
}

/**
 * A number as it is said aloud, digit by digit in its groups: "0412 345 678" →
 * "oh-four-one-two, three-four-five, six-seven-eight"; a leading + is "plus", and an
 * unbroken run ("+442079460958") is said in threes.
 */
function digitsAloud(shown: string): string {
  const said = (run: string) => Array.from(run, (d) => DIGIT_WORDS[Number(d)]).join("-");
  return (shown.match(/\+?\d+/g) ?? [])
    .flatMap((part) => {
      const plus = part.startsWith("+");
      const groups = digitGroups(plus ? part.slice(1) : part).map(said);
      return plus ? [`plus ${groups[0]}`, ...groups.slice(1)] : groups;
    })
    .join(", ");
}

/**
 * SCRUM-601: what a booking's read-back must say out loud — the number (its real digits,
 * spelled out here so the model never says them from memory or from an example), the
 * note or that there is none (a note the model dropped is then heard missing), and any
 * name that isn't plain. Only these let the owner catch a mishearing before it is saved:
 * a real session saved a wrong digit, and dropped a note, without either being said.
 */
function bookingReadBackRule(shownPhone: string, notes: string | null, verifications: string[] = []): string {
  const note = notes ? "Say the note." : `There's no job note: say "no job note", so the owner can add one.`;
  const extra = verifications.length ? ` ${verifications.join(" ")}` : "";
  return ` Say the phone number back digit by digit, in its groups: "${digitsAloud(shownPhone)}". ${note}${extra} Spell back letter by letter any name that isn't a common one, or that the owner corrected — once, not again on a repeated read-back unless it changed.`;
}

/**
 * SCRUM-602: a field this business collects from callers (Assistants → Caller Data
 * Collection, `assistants.prompt_config.fields`). Each business sets its own: some need
 * a last name, some an email, a tradie an address and how urgent it is.
 */
type BookingField = { id: string; label: string; required: boolean; verification: string; hint?: string };

/** The fields the booking's own parameters carry — never asked for again through `details`. */
const BOOKING_OWN_FIELD_IDS = new Set(["first_name", "full_name", "last_name", "phone_number", "email_address"]);
/** One detail's value: a few lines of the owner's words at most; longer is refused, never cut. */
const DETAIL_VALUE_MAX = 300;
/** Spoken English runs about six characters a word — "about N words over" means something by voice; "37 characters" doesn't. */
const wordsOver = (chars: number) => Math.max(1, Math.round(chars / 6));
const aboutWordsOver = (chars: number) => {
  const n = wordsOver(chars);
  return `about ${n} word${n === 1 ? "" : "s"} over`;
};
/** The whole `details` string; longer is refused, never cut. */
const DETAILS_MAX = 600;
/** The booking path's own cap on a job's note (`sanitizeString(notes, 500)`) — anything longer would be cut there without a word. */
const DIARY_NOTES_MAX = 500;

/** "service_address", "Service Address" and "service address" are one field. */
function fieldKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** "a", "a and b", "a, b and c". */
function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The business's caller fields — the row the receptionist's booking path reads
 * (handleBookAppointment). No assistant or no config means nothing beyond the name and
 * number; a read fault is a fault, never "nothing required".
 */
async function bookingFields(supabase: any, organizationId: string): Promise<BookingField[] | "error"> {
  const { data, error } = await bookingFieldsQuery(supabase, organizationId);
  if (error) {
    console.error("[owner-assistant] booking fields read failed:", { organizationId, code: error.code });
    return "error";
  }
  const raw = (data?.prompt_config as { fields?: unknown } | null | undefined)?.fields;
  if (!Array.isArray(raw)) return [];
  const fields: BookingField[] = [];
  for (const f of raw) {
    const id = typeof f?.id === "string" ? f.id.trim() : "";
    if (!id || fields.some((k) => k.id === id)) continue;
    const hint = sanitizeCustomerText(f?.description, 80);
    fields.push({
      id,
      label: sanitizeCustomerText(f?.label, 60) ?? id.replace(/_/g, " "),
      required: Boolean(f?.required), // truthy, as the booking path's own check reads it
      verification: typeof f?.verification === "string" ? f.verification : "none",
      ...(hint ? { hint } : {}),
    });
  }
  return fields;
}

/** A line break between details is a separator — on both sides (the gate's key reads it the same way). */
const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;

/**
 * The extra details as the model passes them: `field=value; field=value` (a colon after
 * the field works too; a line break separates like a semicolon). The field can be the id
 * or the label. Exported for the voice-server parity test: what this accepts, the gate's
 * key must be able to confirm, and what this refuses the gate must never arm.
 */
export function parseBookingDetails(raw: unknown): Array<{ key: string; value: string }> | "too_long" | "unreadable" {
  if (raw === undefined || raw === null) return [];
  const joined = String(raw).replace(LINE_BREAKS, ";");
  // Measured after normalisation: a compat character that widens (ﬃ → ffi) must not slip
  // past the cap and be cut with "…" by the sanitiser — nothing here is ever cut.
  if (joined.normalize("NFKC").length > DETAILS_MAX) return "too_long";
  const text = sanitizeCustomerText(joined, DETAILS_MAX);
  if (!text) return [];
  const pairs: Array<{ key: string; value: string }> = [];
  for (const part of text.split(";")) {
    if (!part.trim()) continue;
    const m = /^\s*([^=:]+?)\s*[=:]\s*(.*)$/.exec(part);
    if (!m) return "unreadable";
    pairs.push({ key: m[1], value: m[2].trim() });
  }
  return pairs;
}

/** How a detail is read back, by the field's own verification setting (the receptionist's rule for callers). */
function detailVerificationLine(label: string, verification: string): string {
  const what = label.toLowerCase();
  switch (verification) {
    case "read-back-digits":
      return `Say the ${what} digit by digit.`;
    case "spell-out":
      return `Spell the ${what} out letter by letter.`;
    case "read-back-characters":
      return `Read the ${what} back character by character.`;
    case "none":
      return `Say the ${what}.`;
    default:
      return `Repeat the ${what} back.`;
  }
}

/**
 * A number as it is read back: the national format in its groups ("0412 345 678",
 * "02 9555 1234", "(415) 555-1234"), or null when it isn't one of the org's country's.
 * Exported for the voice-server parity test: the gate must match it to the said form.
 * @param e164OrRaw the number as it will be saved
 */
export function spokenPhone(e164OrRaw: string, country: string | null): string | null {
  if (country === "AU" && /^\+61\d{9}$/.test(e164OrRaw)) return formatPhoneForCountry(`0${e164OrRaw.slice(3)}`, "AU");
  if (country === "US" && /^\+1\d{10}$/.test(e164OrRaw)) return formatPhoneForCountry(e164OrRaw.slice(2), "US");
  return null;
}
/** A block's title, from the owner's reason. */
const BLOCK_TITLE_MAX = 80;
const DEFAULT_BLOCK_TITLE = "Time off";
/** The longest block the assistant makes, in the org's own calendar days (the dashboard does longer). */
const BLOCK_MAX_DAYS = 14;
/** How many of the jobs a block covers the read-back names. */
const BLOCK_JOBS_NAMED = 5;
const CALLBACK_NOTE_MAX = 200;
const DEFAULT_CALLBACK_NOTE = "Marked done on your assistant line";

/**
 * The org owner's user id, for created_by / completed_by (the dashboard shows who did
 * it). Best effort: a failed read leaves them empty — the change itself never waits on it.
 */
async function orgOwnerUserId(supabase: any, organizationId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("org_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[owner-assistant] org owner lookup failed (non-fatal):", { organizationId, error });
    return null;
  }
  return typeof data?.user_id === "string" ? data.user_id : null;
}

/** A service type the owner named, by id, org-scoped and active — its name, null when there's none, undefined on a fault. */
async function activeServiceName(supabase: any, organizationId: string, id: string): Promise<string | null | undefined> {
  const { data, error } = await supabase
    .from("service_types")
    .select("id, name")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.error("[owner-assistant] service type lookup failed:", { organizationId, id, error });
    return undefined;
  }
  return data ? sanitizeCustomerText(data.name, NAME_MAX) ?? "that service" : null;
}

/** The diary isn't Phondo's own: what to tell the owner. */
function externalDiaryMessage(diary: string, what: "booked anything" | "blocked anything"): string {
  return `Your diary is in ${diary}, so I haven't ${what} — please do it there.`;
}

/**
 * SCRUM-599: book a NEW job for a customer. Same two calls as a change: without
 * `confirmed` nothing is booked and the read-back comes back (with the "let them
 * know?" question — a text, or nothing: a call about a new booking isn't offered);
 * with confirmed=true after the owner's yes, the receptionist's own booking path
 * books it (hours, blocks, clashes, staff assignment, the confirmation code) as the
 * owner's booking: neither automatic notice goes out, the owner's choice of telling
 * the customer runs after, and the booking is audited as created on this call (the
 * recap email lists it). Only Phondo's own diary. Choosing who does the job isn't in
 * v1 (the owner prompt has no staff list): the diary assigns, as for any booking.
 */
export async function handleOwnerBookAppointment(
  organizationId: string,
  args: {
    customer_name?: string;
    customer_phone?: string;
    start?: string;
    service_type_id?: string;
    notes?: string;
    customer_email?: string;
    details?: string;
    confirmed?: unknown;
    notify_customer?: string;
  },
  ctx: OwnerCallContext
): Promise<ToolResult> {
  const supabase = createAdminClient();
  const org = await getOrgZoneAndCountry(supabase, organizationId);
  if (!org) return errorResult(TROUBLE);
  const tz = org.tz;

  const invalidDetails = (message: string): ToolResult => ({ success: false, message, data: bookData({ outcome: "invalid_details", customer_notified: false }) });
  const invalidTime = (message: string): ToolResult => ({ success: false, message, data: bookData({ outcome: "invalid_time", customer_notified: false }) });

  // The customer's name and number are the model's words for what the owner said:
  // one bounded line each before they reach the diary.
  const customerSaid = sanitizeCustomerText(args.customer_name, NAME_MAX);
  if (!customerSaid) return invalidDetails("I need the customer's name for the booking. Who's it for?");
  const phone = typeof args.customer_phone === "string" ? args.customer_phone.trim() : "";
  if (!phone || !isValidPhoneNumber(phone)) return invalidDetails(`I need a phone number for ${customerSaid} that the booking can go under. What's their number?`);
  const start = parseOwnerLocalDatetime(args.start, tz);
  if (!start) return invalidTime("I need the time as a date and time, like 2026-10-29T14:00.");
  if (start.getTime() < Date.now()) return invalidTime("That time has already passed. When should the job be?");
  if (start.getTime() > Date.now() + MAX_BOOKING_HORIZON_MS) return invalidTime("That's more than a year away. When should the job be?");
  const serviceTypeId = typeof args.service_type_id === "string" && args.service_type_id ? args.service_type_id : undefined;
  if (serviceTypeId && !isValidUUID(serviceTypeId)) {
    return invalidDetails("I couldn't match that service. Use an ID from the SERVICE TYPES list, or leave it out.");
  }
  const notes = sanitizeCustomerText(args.notes, BOOKING_NOTES_MAX);

  const diary = await ownerDiaryProvider(organizationId);
  if (diary === "error") return errorResult(TROUBLE);
  if (diary !== "phondo") {
    return { success: false, message: externalDiaryMessage(diary, "booked anything"), data: bookData({ outcome: "external_calendar", customer_notified: false }) };
  }
  const service = serviceTypeId ? await activeServiceName(supabase, organizationId, serviceTypeId) : null;
  if (service === undefined) return errorResult(TROUBLE);
  if (serviceTypeId && !service) return invalidDetails("I couldn't find that service type. Check the SERVICE TYPES list, or leave it out.");

  // SCRUM-602: what THIS business collects from callers — asked for before the read-back,
  // so a booking never fails after the owner's yes; nothing it doesn't require is asked.
  const fields = await bookingFields(supabase, organizationId);
  if (fields === "error") return errorResult(TROUBLE);
  const parsed = parseBookingDetails(args.details);
  if (parsed === "too_long") return invalidDetails(`That's too much detail for one booking — keep each detail short (about ${wordsOver(DETAILS_MAX)} words in all).`);
  if (parsed === "unreadable") return invalidDetails(`I couldn't read the details. Pass them as "field=value; field=value", using this business's field names${fields.length ? `: ${listWords(fields.filter((f) => !BOOKING_OWN_FIELD_IDS.has(f.id)).map((f) => f.label))}` : ""}.`);
  const byKey = new Map<string, BookingField>();
  for (const f of fields) {
    byKey.set(fieldKey(f.id), f);
    byKey.set(fieldKey(f.label), f);
  }
  const details: Array<{ field: BookingField; value: string }> = [];
  const fieldsSeen = new Set<string>();
  // Any name given twice — as the gate's key sees it (surname = last name, email address
  // = email), blank, ignored or not — is refused here too: the gate can never confirm it.
  const keysSeen = new Set<string>();
  let surnameGiven: string | null = null;
  const emailParam = typeof args.customer_email === "string" && args.customer_email.trim() ? sanitizeCustomerText(args.customer_email, 120) : null;
  let emailGiven: string | null = emailParam;
  for (const { key, value } of parsed) {
    const k = fieldKey(key);
    const canonical = k === "surname" ? "lastname" : k === "emailaddress" ? "email" : k;
    if (keysSeen.has(canonical)) return invalidDetails(`"${byKey.get(k)?.label ?? sanitizeCustomerText(key, 40)}" is given twice in the details — pass each detail once.`);
    keysSeen.add(canonical);
    if (value.length > DETAIL_VALUE_MAX) {
      return invalidDetails(`The ${sanitizeCustomerText(key, 40)?.toLowerCase() ?? "detail"} is too long for a booking detail — ${aboutWordsOver(value.length - DETAIL_VALUE_MAX)}. Ask the owner for a shorter version, then call again.`);
    }
    const v = sanitizeCustomerText(value, DETAIL_VALUE_MAX) ?? "";
    // The booking's own fields, however the model passed them — once each: picked by
    // position, two spellings of one field could save what the read-back didn't say.
    if (k === "lastname" || k === "surname") {
      surnameGiven = v || null;
      continue;
    }
    if (k === "emailaddress" || k === "email") {
      if (emailParam !== null) return invalidDetails("The email is given twice — pass it once, in customer_email.");
      emailGiven = v || null;
      continue;
    }
    if (k === "firstname" || k === "fullname" || k === "name" || k === "phonenumber" || k === "phone") continue;
    const field = byKey.get(k);
    if (!field || BOOKING_OWN_FIELD_IDS.has(field.id)) {
      const known = fields.filter((f) => !BOOKING_OWN_FIELD_IDS.has(f.id)).map((f) => f.label);
      return invalidDetails(`I don't know a "${sanitizeCustomerText(key, 40)}" detail for this business. ${known.length ? `Its fields are: ${listWords(known)}. Anything else goes in the note.` : "It has no extra fields — put anything else in the note."}`);
    }
    // The same field twice — by id, by label, or one of each, blank or not — is refused
    // rather than picked by position: the gate's key can't tell which one the read-back
    // said (and it refuses any repeat, so accepting one here would loop the read-back).
    if (fieldsSeen.has(field.id)) return invalidDetails(`"${field.label}" is given twice in the details — pass each detail once.`);
    fieldsSeen.add(field.id);
    if (!v) continue; // a blank value is no value
    details.push({ field, value: v });
  }
  details.sort((a, b) => fields.indexOf(a.field) - fields.indexOf(b.field)); // the business's own order, whatever the model's
  const nameParts = customerSaid.split(" ");
  const givenName = nameParts[0];
  const surname = nameParts.slice(1).join(" ") || surnameGiven || "";
  const customer = surname ? (sanitizeCustomerText(`${givenName} ${surname}`, NAME_MAX) ?? customerSaid) : customerSaid;
  if (hasNonLatinLetters(customer)) return invalidDetails(`The diary keeps names in English letters. Ask the owner how ${customer} is spelled in English letters, then call again.`);
  const email = emailGiven ? emailGiven.replace(/\s+/g, "") : null;
  if (email && !isValidEmail(email)) return invalidDetails(`That email address doesn't look right ("${email}"). Ask the owner to spell it out, then call again.`);
  const covered = (f: BookingField): boolean => {
    if (f.id === "last_name") return surname !== "";
    if (f.id === "email_address") return email !== null;
    if (BOOKING_OWN_FIELD_IDS.has(f.id)) return true;
    return details.some((d) => d.field.id === f.id);
  };
  const missing = fields.filter((f) => f.required && !covered(f));
  if (missing.length) {
    const named = missing.map((f) =>
      f.id === "last_name" ? `${givenName}'s last name` : f.id === "email_address" ? `${givenName}'s email address` : `the ${f.label.toLowerCase()}${f.hint ? ` (${f.hint})` : ""}`
    );
    return {
      success: false,
      message:
        `Not booked yet: this business's bookings also need ${listWords(named)}. Pass anything the owner has already said without asking again, and ask for the rest in one question ("I'll also need ${listWords(named)}" — leaving out anything they already told you). ` +
        `Then call again with everything — the surname in customer_name, the email in customer_email, the rest in details ("field=value; field=value") — each once, not in the note as well. ` +
        `If the owner doesn't have one, say their settings require it for every booking, and that they can make that field optional in Assistants → Caller Data Collection (for example ${missing[0].label}).`,
      data: bookData({ outcome: "invalid_details", customer_notified: false, missing_fields: missing.map((f) => ({ id: f.id, label: f.label, ...(f.hint ? { hint: f.hint } : {}) })) }),
    };
  }
  // The job's note: the owner's words, then each detail on its own line (the dashboard
  // shows it). The diary cuts anything over its cap without a word — refuse first.
  const detailLines = details.map((d) => `${d.field.label}: ${d.value}`);
  const diaryNotes = [notes, ...detailLines].filter((l): l is string => Boolean(l)).join("\n") || null;
  if (diaryNotes && diaryNotes.length > DIARY_NOTES_MAX) {
    const parts = [...(notes ? [{ what: "note", length: notes.length }] : []), ...details.map((d) => ({ what: d.field.label.toLowerCase(), length: d.value.length }))];
    const longest = parts.sort((a, b) => b.length - a.length)[0];
    return invalidDetails(`That's too much for the job's note — ${aboutWordsOver(diaryNotes.length - DIARY_NOTES_MAX)}; the ${longest.what} is the longest part. Ask the owner to shorten it, then call again.`);
  }
  const emailField = fields.find((f) => f.id === "email_address");
  const verifications = [
    ...(email ? [detailVerificationLine("email address", emailField?.verification ?? "spell-out")] : []),
    ...details.map((d) => detailVerificationLine(d.field.label, d.field.verification)),
  ];

  const when = formatWhen(start, tz);
  // The owner says the number the way people do ("0412 345 678"); the diary keeps it
  // in E.164 like the receptionist's bookings (caller ID) when it parses in the org's
  // country, and as said otherwise.
  const bookedPhone = (org.country === "AU" || org.country === "US" ? parsePhoneToE164(phone, org.country) : null) ?? phone;
  // SCRUM-601: read back as the number that will be SAVED, in its groups — a misheard
  // digit is heard there (a real session saved 0412 345 378 for a spoken 678).
  const shownPhone = spokenPhone(bookedPhone, org.country) ?? sanitizeCustomerText(phone, PHONE_MAX) ?? phone;
  const base = {
    customer_name: customer,
    customer_phone: shownPhone,
    when,
    ...(service ? { service } : {}),
    ...(email ? { customer_email: email } : {}),
    ...(details.length ? { details: details.map((d) => ({ id: d.field.id, label: d.field.label, value: d.value })) } : {}),
  };

  // As for a change: a confirm needs the owner's answer on telling the customer. A
  // new booking is never offered a call, so "call" is no answer: the question again.
  const chosen = args.confirmed === true ? parseContactMethod(args.notify_customer) : null;
  let method: ContactMethod;
  if (chosen && chosen !== "call") {
    method = chosen;
  } else {
    const contact = await getContactOptions(organizationId, phone, org.country);
    if (args.confirmed === true && !contactWays(contact)) {
      method = "none";
    } else {
      const said = [...(email ? [`email ${email}`] : []), ...detailLines];
      const change = `book ${customer} on ${shownPhone} for ${service ? `${service} on ` : ""}${when}${notes ? ` — notes: "${notes}"` : ""}${said.length ? ` — details: ${said.join("; ")}` : ""}`;
      return {
        success: false,
        message:
          args.confirmed === true
            ? askContactMessage(customer, contact, "owner_book_appointment")
            : readBackMessage(change, customer, contact, "owner_book_appointment", "booked") + bookingReadBackRule(shownPhone, notes, verifications),
        data: bookData({
          outcome: "needs_confirmation",
          ...base,
          contact_options: contact.options,
          ...(contact.note ? { contact_note: contact.note } : {}),
          customer_notified: false,
        }),
      };
    }
  }

  /**
   * The booking from a moment ago, handed back AS IT STANDS (its stored name, service
   * and note — a retry with other details changes nothing, and says so), with what its
   * customer was told.
   */
  const repeatBooking = async (earlier: SameCallBooking): Promise<ToolResult> => {
    // A first attempt cut off between its booking and its audit row would leave the
    // recap email without it: the repeat writes the missing row (silent lens r2 F3).
    await ensureCreatedAudit(supabase, organizationId, earlier.id, ctx.callId);
    const contact = await repeatBookingContact(supabase, {
      organizationId,
      appointmentId: earlier.id,
      start,
      method,
      phone,
      country: org.country,
      timezone: tz,
      callId: ctx.callId,
    });
    const withWhom = earlier.practitioner ? ` with ${earlier.practitioner}` : "";
    const who = earlier.customer ?? customer;
    const detailsKept = (serviceTypeId ?? null) !== earlier.serviceTypeId || diaryNotes !== earlier.notes || (email ?? null) !== earlier.email;
    return {
      success: true,
      message:
        `${who} is already booked for ${when}${withWhom} — that's the booking from a moment ago.` +
        (detailsKept ? " It keeps the service, note and contact details it was booked with — the new ones weren't added; they can be changed in Appointments." : "") +
        (contact
          ? contactOutcomeSentence(contact, who, "booked")
          : ` I couldn't check whether ${who} was texted about it — check the booking in Appointments before texting them yourself.`),
      data: bookData({
        outcome: "booked",
        customer_name: who,
        customer_phone: shownPhone,
        when,
        ...(earlier.service ? { service: earlier.service } : {}),
        ...(earlier.practitioner ? { practitioner: earlier.practitioner } : {}),
        appointment_id: earlier.id,
        ...(earlier.confirmationCode ? { confirmation_code: earlier.confirmationCode } : {}),
        ...(contact ? { customer_contact: contact } : {}),
        customer_notified: contact ? isCustomerNotified(contact) : false,
      }),
    };
  };

  // This customer (their number and given name), at this time, already booked on this call:
  // the same booking asked for again after its result never came back. Hand it back —
  // never book it twice (with two or more staff the diary would happily take a second one).
  const earlier = await sameCallBooking(supabase, organizationId, ctx.callId, start, bookedPhone, customer);
  if (earlier === "error") return errorResult(SAME_CALL_READ_FAULT);
  if (earlier) return repeatBooking(earlier);

  if (!(await ownerMutationAllowed(supabase, organizationId))) {
    return { success: false, message: RATE_LIMITED_MSG, data: bookData({ outcome: "rate_limited", ...base, customer_notified: false }) };
  }

  const result = await handleBookAppointment(
    organizationId,
    {
      first_name: givenName,
      ...(surname ? { last_name: surname } : {}),
      phone: bookedPhone,
      datetime: toLocalIsoMinute(start, tz),
      ...(email ? { email } : {}),
      ...(diaryNotes ? { notes: diaryNotes } : {}),
      ...(serviceTypeId ? { service_type_id: serviceTypeId } : {}),
    },
    { callId: ctx.callId, ownerBooking: true }
  );
  if (result.data?.ownerRefusal === "external_calendar") {
    return { success: false, message: result.message, data: bookData({ outcome: "external_calendar", ...base, customer_notified: false }) };
  }
  if (result.error === true) {
    // The booking path's own faults are worded for a caller ("…someone call you back").
    return errorResult(`I couldn't book that just now — something went wrong on our side. Please check Appointments before trying again.`);
  }
  if (!result.success) {
    // Hours, a block, a clash, a staff member who doesn't do that service… The
    // booking path's reason is written for a caller; the model says it in its own words.
    return {
      success: false,
      message:
        `Nothing was booked. The diary said: "${result.message}" Tell the owner in a few words, and offer another time if it's about the time.` +
        " Outside opening hours or in blocked-out time, the owner can still book it themselves in Appointments.",
      data: bookData({ outcome: "not_booked", ...base, customer_notified: false }),
    };
  }

  const booked = result.data ?? {};
  const appointmentId = typeof booked.appointmentId === "string" ? booked.appointmentId : null;
  if (!appointmentId) {
    console.error("[owner-assistant] booking succeeded without an appointment id:", { organizationId, callId: ctx.callId });
    return errorResult(`I booked ${customer} but couldn't read the booking back — please check Appointments.`);
  }
  if (booked.duplicate === true) {
    // The diary's own same-call net, which matches by first name only: it's this
    // booking again only with this customer's number too — another "Jane" booked then
    // on this call is a clash.
    const again = await sameCallBookingById(supabase, organizationId, appointmentId, bookedPhone, customer);
    if (again === "error") return errorResult(SAME_CALL_READ_FAULT);
    if (!again) {
      return {
        success: false,
        message: "Nothing was booked: that time is taken by another booking made on this call. Offer the owner another time.",
        data: bookData({ outcome: "not_booked", ...base, customer_notified: false }),
      };
    }
    return repeatBooking(again);
  }

  // (The booking path refreshes the voice server's schedule cache itself.)
  const audited = await recordAppointmentEvent(supabase, {
    appointmentId,
    organizationId,
    eventType: "created",
    actorType: "staff",
    actorId: null,
    channel: "voice",
    callId: ctx.callId,
  });
  if (!audited) pageUnaudited(organizationId, ctx.callId, appointmentId, "created");

  const contact = await contactCustomer({
    orgId: organizationId,
    method,
    kind: "booked",
    appointmentId,
    startTime: start,
    phone,
    country: org.country,
    timezone: tz,
    requestedByCallId: ctx.callId,
  });
  const assigned = typeof booked.practitionerName === "string" ? sanitizeCustomerText(booked.practitionerName, NAME_MAX) : null;
  const confirmationCode = typeof booked.confirmationCode === "string" ? booked.confirmationCode : undefined;
  return {
    success: true,
    message: `Booked ${customer} for ${when}${assigned ? ` with ${assigned}` : ""}.${contactOutcomeSentence(contact, customer, "booked")}`,
    data: bookData({
      outcome: "booked",
      ...base,
      ...(assigned ? { practitioner: assigned } : {}),
      appointment_id: appointmentId,
      ...(confirmationCode ? { confirmation_code: confirmationCode } : {}),
      customer_contact: contact,
      customer_notified: isCustomerNotified(contact),
    }),
  };
}

/** A live booking made on this owner call: what a repeat of it hands back, as stored. */
interface SameCallBooking {
  id: string;
  confirmationCode: string | null;
  /** The name it was booked under. */
  customer: string | null;
  serviceTypeId: string | null;
  service: string | null;
  notes: string | null;
  /** The booking's email, when a real one was saved (never the diary's placeholder). */
  email: string | null;
  practitioner: string | null;
}

const SAME_CALL_COLS =
  "id, attendee_first_name, attendee_name, attendee_phone, attendee_email, confirmation_code, service_type_id, notes, service_types(name), practitioners(name)";
/** The booking path's stand-in when no email was given — not a customer's address. */
const PLACEHOLDER_EMAIL = /^booking-[0-9a-f-]+@noreply\.phondo\.ai$/i;
const SAME_CALL_READ_FAULT = "I couldn't check the diary just now — please check Appointments before trying again.";

/**
 * The same customer: the same number AND the same given name — the receptionist's
 * own rule (SCRUM-514, findOverlappingBookingFromCall). A family on one mobile (two
 * children booked at once with two staff) is two bookings, not a repeat (security
 * lens, round 2); a surname respelled on the retry is still the same customer, never
 * a second booking (code lens, round 2).
 */
function sameCustomer(row: any, phone: string, customer: string): boolean {
  const given = normalizeGivenName(row?.attendee_first_name || String(row?.attendee_name ?? "").split(" ")[0]);
  return phonesMatchForOwnership(row?.attendee_phone, phone) && given !== "" && given === normalizeGivenName(customer.split(" ")[0]);
}

function toSameCallBooking(row: any): SameCallBooking {
  return {
    id: row.id,
    confirmationCode: typeof row.confirmation_code === "string" ? row.confirmation_code : null,
    customer: sanitizeCustomerText(row.attendee_name, NAME_MAX),
    serviceTypeId: typeof row.service_type_id === "string" ? row.service_type_id : null,
    service: sanitizeCustomerText(row.service_types?.name, NAME_MAX),
    notes: typeof row.notes === "string" && row.notes !== "" ? row.notes : null,
    email: typeof row.attendee_email === "string" && row.attendee_email !== "" && !PLACEHOLDER_EMAIL.test(row.attendee_email) ? row.attendee_email : null,
    practitioner: sanitizeCustomerText(row.practitioners?.name, NAME_MAX),
  };
}

/**
 * The booking's "created" audit row on this call — written now when the first attempt
 * never got to it (the recap email is built from these rows). A read fault is logged:
 * whether the row is missing can't be told.
 */
async function ensureCreatedAudit(supabase: any, organizationId: string, appointmentId: string, callId: string): Promise<void> {
  const { data, error } = await supabase
    .from("appointment_events")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("appointment_id", appointmentId)
    .eq("event_type", "created")
    .eq("call_id", callId)
    .limit(1);
  if (error) {
    console.error("[owner-assistant] repeated booking's audit read failed:", { organizationId, appointmentId, error });
    return;
  }
  if (Array.isArray(data) && data.length > 0) return;
  const audited = await recordAppointmentEvent(supabase, {
    appointmentId,
    organizationId,
    eventType: "created",
    actorType: "staff",
    actorId: null,
    channel: "voice",
    callId,
  });
  if (!audited) pageUnaudited(organizationId, callId, appointmentId, "created");
}

/** This customer's live booking at `start` made on this call (by their number and given name), or null; "error" on a fault. */
async function sameCallBooking(
  supabase: any,
  organizationId: string,
  callId: string,
  start: Date,
  phone: string,
  customer: string
): Promise<SameCallBooking | null | "error"> {
  const { data, error } = await supabase
    .from("appointments")
    .select(SAME_CALL_COLS)
    .eq("organization_id", organizationId)
    .eq("call_id", callId)
    .eq("start_time", start.toISOString())
    .in("status", ["confirmed", "pending"]);
  if (error) {
    console.error("[owner-assistant] same-call booking read failed:", { organizationId, callId, error });
    return "error";
  }
  const row = ((data ?? []) as any[]).find((r) => sameCustomer(r, phone, customer));
  return row ? toSameCallBooking(row) : null;
}

/** The booking the diary handed back as this call's — when it's this customer's (by number and given name); "error" on a fault. */
async function sameCallBookingById(
  supabase: any,
  organizationId: string,
  appointmentId: string,
  phone: string,
  customer: string
): Promise<SameCallBooking | null | "error"> {
  const { data, error } = await supabase
    .from("appointments")
    .select(SAME_CALL_COLS)
    .eq("id", appointmentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    console.error("[owner-assistant] same-call booking read failed:", { organizationId, appointmentId, error });
    return "error";
  }
  return data && sameCustomer(data, phone, customer) ? toSameCallBooking(data) : null;
}

/**
 * What a repeated booking's customer was told. A text the first attempt sent — or may
 * have sent: caller-sms logs "failed" on a Twilio timeout too, when Twilio may have
 * taken it — is reported, and never sent twice. When none can have gone (none was
 * tried — the first attempt stopped before it — or it was held back: skipped_*,
 * opted_out), the owner's choice now is carried out, with every check the send path
 * makes. Null when it can't be told — the log can't be read, or holds only its
 * "pending" default — so nothing is said as fact.
 */
async function repeatBookingContact(
  supabase: any,
  req: {
    organizationId: string;
    appointmentId: string;
    start: Date;
    method: ContactMethod;
    phone: string;
    country: string | null;
    timezone: string;
    callId: string;
  }
): Promise<CustomerContactResult | null> {
  const { data, error } = await supabase
    .from("appointment_confirmations")
    .select("status")
    .eq("organization_id", req.organizationId)
    .eq("idempotency_key", confirmationIdempotencyKey(req.appointmentId, "sms", "confirmation", req.start.toISOString()))
    .maybeSingle();
  if (error) {
    console.error("[owner-assistant] repeated booking's text log read failed:", { organizationId: req.organizationId, appointmentId: req.appointmentId, error });
    return null;
  }
  if (data?.status === "sent" || data?.status === "delivered") return { method: "text", status: "sent" };
  // Sent but not delivered (it would not reach them again either), or "failed" — which
  // may have left Twilio (combined lens r3): reported, never sent again.
  if (data?.status === "undelivered" || data?.status === "failed") return { method: "text", status: "not_sent", reason: data.status };
  // The column's default; caller-sms writes an outcome, never "pending": can't tell.
  if (data?.status === "pending") return null;
  return contactCustomer({
    orgId: req.organizationId,
    method: req.method,
    kind: "booked",
    appointmentId: req.appointmentId,
    startTime: req.start,
    phone: req.phone,
    country: req.country,
    timezone: req.timezone,
    requestedByCallId: req.callId,
  });
}

/**
 * SCRUM-599: block out time in the diary ("I'm off Friday afternoon"), for everyone
 * (one staff member's block isn't in v1 — the owner prompt has no staff list). Two
 * calls. The read-back names the jobs already booked in that time — they stay booked:
 * blocking never moves or cancels anything (the owner deals with each, one at a
 * time). The block is the dashboard's own row, linked to this call so the recap
 * email lists it.
 */
export async function handleOwnerBlockTime(
  organizationId: string,
  args: { start?: string; end?: string; reason?: string; confirmed?: unknown },
  ctx: OwnerCallContext
): Promise<ToolResult> {
  const supabase = createAdminClient();
  const tz = await getOrgTimezone(supabase, organizationId);
  if (!tz) return errorResult(TROUBLE);

  const invalidTime = (message: string): ToolResult => ({ success: false, message, data: blockData({ outcome: "invalid_time" }) });
  const start = parseOwnerLocalDatetime(args.start, tz);
  const end = parseOwnerLocalDatetime(args.end, tz);
  if (!start || !end) return invalidTime("I need the start and end as dates and times, like 2026-10-30T13:00 to 2026-10-30T17:00.");
  if (end.getTime() <= start.getTime()) return invalidTime("The end has to be after the start. What time should the block finish?");
  if (end.getTime() <= Date.now()) return invalidTime("That time has already passed. Which time should I block out?");
  // Two weeks on the org's own calendar, never in milliseconds: across a clock change
  // exactly two weeks is 335 or 337 hours.
  const startLocal = toLocalIsoMinute(start, tz);
  const endLocal = toLocalIsoMinute(end, tz);
  if (endLocal > `${addDaysISO(startLocal.slice(0, 10), BLOCK_MAX_DAYS)}T${startLocal.slice(11)}`) {
    return invalidTime("That's longer than two weeks — please block that out in the dashboard.");
  }

  const diary = await ownerDiaryProvider(organizationId);
  if (diary === "error") return errorResult(TROUBLE);
  if (diary !== "phondo") return { success: false, message: externalDiaryMessage(diary, "blocked anything"), data: blockData({ outcome: "external_calendar" }) };

  const title = sanitizeCustomerText(args.reason, BLOCK_TITLE_MAX) ?? DEFAULT_BLOCK_TITLE;
  const when = formatSpan(start, end, tz);
  const who = " for everyone";
  const base = { when, title };

  // The jobs already booked then (live, and not already over — a block from this
  // morning doesn't name the jobs done since).
  const { data: jobs, error: jobsError } = await supabase
    .from("appointments")
    .select("attendee_name, start_time")
    .eq("organization_id", organizationId)
    .in("status", ["confirmed", "pending"])
    .lt("start_time", end.toISOString())
    .gt("end_time", new Date(Math.max(start.getTime(), Date.now())).toISOString())
    .order("start_time", { ascending: true });
  if (jobsError) {
    console.error("[owner-assistant] jobs-in-the-way lookup failed:", { organizationId, error: jobsError });
    return errorResult(TROUBLE);
  }
  const inTheWay = (jobs ?? []) as Array<{ attendee_name: string | null; start_time: string }>;
  const jobsLine = inTheWay.length
    ? ` ${inTheWay.length === 1 ? "One job is" : `${inTheWay.length} jobs are`} already booked then and will stay booked unless the owner moves or cancels ${inTheWay.length === 1 ? "it" : "them"}: ` +
      inTheWay
        .slice(0, BLOCK_JOBS_NAMED)
        .map((j) => `${sanitizeCustomerText(j.attendee_name, NAME_MAX) ?? "a customer"} on ${formatWhen(new Date(j.start_time), tz)}`)
        .join("; ") +
      `${inTheWay.length > BLOCK_JOBS_NAMED ? `, and ${inTheWay.length - BLOCK_JOBS_NAMED} more` : ""}. Say so in the read-back.`
    : "";

  if (args.confirmed !== true) {
    return {
      success: false,
      message:
        `Read this back and get a clear yes before changing anything: block out ${when}${who}${title !== DEFAULT_BLOCK_TITLE ? ` ("${title}")` : ""}.${jobsLine}` +
        ` If the owner confirms, call owner_block_time again with confirmed=true and the same start, end and reason.`,
      data: blockData({ outcome: "needs_confirmation", ...base, jobs_in_the_way: inTheWay.length }),
    };
  }

  // The same block asked for again on this call (its result never came back): hand it
  // back — a second identical row would only clutter the diary.
  const { data: sameBlock, error: sameBlockError } = await supabase
    .from("blocked_times")
    .select("id, title")
    .eq("organization_id", organizationId)
    .eq("created_on_call_id", ctx.callId)
    .eq("start_time", start.toISOString())
    .eq("end_time", end.toISOString())
    .limit(1);
  if (sameBlockError) {
    console.error("[owner-assistant] same-call block read failed:", { organizationId, error: sameBlockError });
    return errorResult(TROUBLE);
  }
  if (Array.isArray(sameBlock) && sameBlock.length > 0) {
    return {
      success: true,
      message: `${when} is already blocked out${who} — that's the block from a moment ago.`,
      data: blockData({
        outcome: "blocked",
        ...base,
        title: sanitizeCustomerText(sameBlock[0].title, BLOCK_TITLE_MAX) ?? DEFAULT_BLOCK_TITLE,
        jobs_in_the_way: inTheWay.length,
        block_id: sameBlock[0].id,
      }),
    };
  }

  if (!(await ownerMutationAllowed(supabase, organizationId))) {
    return { success: false, message: RATE_LIMITED_MSG, data: blockData({ outcome: "rate_limited", ...base }) };
  }
  // All-day is ONE whole day, as the dashboard makes them (it shows an all-day block as
  // a single date); longer blocks keep their start and end.
  const allDay = startLocal.slice(11) === "00:00" && endLocal.slice(11) === "00:00" && endLocal.slice(0, 10) === addDaysISO(startLocal.slice(0, 10), 1);
  const createdBy = await orgOwnerUserId(supabase, organizationId);
  const { data: block, error: insertError } = await supabase
    .from("blocked_times")
    .insert({
      organization_id: organizationId,
      title,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      all_day: allDay,
      reason: "Added by your assistant",
      practitioner_id: null,
      created_by: createdBy,
      // The recap email lists the blocks this call made (migration 00173).
      created_on_call_id: ctx.callId,
    })
    .select("id")
    .single();
  if (insertError || !block) {
    console.error("[owner-assistant] block insert failed:", { organizationId, error: insertError ?? "no row" });
    return errorResult("I couldn't block that time out — something went wrong on our side. Please check the diary in the dashboard.");
  }
  runAfterResponse(async () => {
    try {
      await invalidateVoiceScheduleCache(organizationId);
    } catch (err) {
      console.warn("[VoiceCacheInvalidate] after-response failed:", err instanceof Error ? err.message : err);
    }
  });
  return {
    success: true,
    message: `Blocked out ${when}${who}.${inTheWay.length ? ` ${inTheWay.length === 1 ? "The job" : `The ${inTheWay.length} jobs`} already booked then ${inTheWay.length === 1 ? "is" : "are"} still booked.` : ""}`,
    data: blockData({ outcome: "blocked", ...base, jobs_in_the_way: inTheWay.length, block_id: block.id }),
  };
}

/**
 * SCRUM-599: mark one pending callback request done (the dashboard's own update).
 * Two calls. The callback must still be waiting — done, cancelled, another org's or a
 * nonsense id all read the same ("isn't waiting"). Linked to this call so the recap
 * email lists it.
 */
export async function handleOwnerMarkCallbackDone(
  organizationId: string,
  args: { callback_id?: string; note?: string; confirmed?: unknown },
  ctx: OwnerCallContext
): Promise<ToolResult> {
  const notWaiting: ToolResult = {
    success: false,
    message: "That callback isn't waiting any more — it may already be done. Check the messages again if you're not sure.",
    data: callbackDoneData({ outcome: "not_found" }),
  };
  if (typeof args.callback_id !== "string" || !isValidUUID(args.callback_id)) return notWaiting;
  const supabase = createAdminClient();
  const tz = await getOrgTimezone(supabase, organizationId);
  if (!tz) return errorResult(TROUBLE);

  const { data: cb, error: cbError } = await supabase
    .from("callback_requests")
    .select("id, caller_name, reason, created_at")
    .eq("id", args.callback_id)
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .maybeSingle();
  if (cbError) {
    console.error("[owner-assistant] callback lookup failed:", { organizationId, error: cbError });
    return errorResult(TROUBLE);
  }
  if (!cb) return { ...notWaiting, data: callbackDoneData({ outcome: "not_found", callback_id: args.callback_id }) };

  const caller = sanitizeCustomerText(cb.caller_name, NAME_MAX) ?? "the caller";
  const reason = sanitizeCustomerText(cb.reason, TEXT_MAX) ?? "no reason given";
  const received = formatWhen(new Date(cb.created_at), tz);
  const base = { callback_id: cb.id, caller_name: caller, reason, received };

  const note = sanitizeCustomerText(args.note, CALLBACK_NOTE_MAX);
  if (args.confirmed !== true) {
    return {
      success: false,
      message:
        `Read this back and get a clear yes before changing anything: mark ${caller}'s callback (${reason}, received ${received}) as done${note ? `, with the note "${note}"` : ""}.` +
        " If the owner confirms, call owner_mark_callback_done again with confirmed=true and the same callback_id and note.",
      data: callbackDoneData({ outcome: "needs_confirmation", ...base, ...(note ? { note } : {}) }),
    };
  }
  if (!(await ownerMutationAllowed(supabase, organizationId))) {
    return { success: false, message: RATE_LIMITED_MSG, data: callbackDoneData({ outcome: "rate_limited", ...base }) };
  }

  const now = new Date().toISOString();
  const completedBy = await orgOwnerUserId(supabase, organizationId);
  const { data: updated, error: updateError } = await supabase
    .from("callback_requests")
    .update({
      status: "completed",
      completed_at: now,
      completed_by: completedBy,
      completion_notes: note ?? DEFAULT_CALLBACK_NOTE,
      // The recap email lists the callbacks this call marked done (migration 00173).
      completed_on_call_id: ctx.callId,
      updated_at: now,
    })
    .eq("id", cb.id)
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .select("id");
  if (updateError) {
    console.error("[owner-assistant] callback update failed:", { organizationId, error: updateError });
    return errorResult("I couldn't mark that callback done — something went wrong on our side. Please check it in the dashboard.");
  }
  if (!Array.isArray(updated) || updated.length === 0) return { ...notWaiting, data: callbackDoneData({ outcome: "not_found", ...base }) };
  return {
    success: true,
    message: `Marked ${caller}'s callback as done.`,
    data: callbackDoneData({ outcome: "callback_done", ...base }),
  };
}
