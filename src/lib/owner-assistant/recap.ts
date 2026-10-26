// src/lib/owner-assistant/recap.ts
// SCRUM-597: what the owner's assistant actually changed on one call, for the recap
// email the owner asked for ("in case the AI made a mistake or hallucinated"). Built
// only from the system's own records — the appointment audit trail and the text log —
// never from anything the AI said.
import { formatSpan, formatWhen } from "./time";
import { sanitizeCustomerText } from "./sanitize";
import { parseConfirmationIdempotencyKey } from "@/lib/sms/caller-sms";
import { CUSTOMER_NOTIFY_CALL_TYPE } from "./owner-call";

/** Where a customer call names the owner call that asked for it (the voice server writes it there — parity-tested). */
export const REQUESTED_BY_PATH = "metadata->notify->>requested_by_call_id";

export type RecapChange = "cancelled" | "moved" | "booked";

/**
 * What happened to the customer. Only "not_texted" carries a reason. "calling" is a
 * call placed about the change (SCRUM-598): how it went comes in its own email.
 */
export type RecapTold =
  | { told: "texted" }
  | { told: "text_failed" }
  | { told: "not_texted"; toldWhy: string }
  | { told: "calling" }
  | { told: "not_told" };

/** A booking the call changed, and whether its customer was told. */
export type BookingRecapItem = {
  change: RecapChange;
  customer: string;
  /** Spoken form (formatWhen) of the job's time: the cancelled time, the new time, or the booked time. */
  when: string;
  /** A move's old time (spoken form). */
  from?: string;
} & RecapTold;

/** SCRUM-599: time the call blocked out in the diary (blocked_times.created_on_call_id). */
export interface BlockRecapItem {
  change: "blocked";
  /** Spoken form of the block (formatSpan). */
  when: string;
  /** The staff member it's for; null means everyone. */
  practitioner: string | null;
  title: string;
}

/** SCRUM-599: a callback request the call marked done (callback_requests.completed_on_call_id). */
export interface CallbackRecapItem {
  change: "callback_done";
  customer: string;
  reason: string;
}

export type OwnerRecapItem = BookingRecapItem | BlockRecapItem | CallbackRecapItem;

const NAME_MAX = 80;
/** A callback's reason, as the owner's messages list caps it. */
const REASON_MAX = 240;
/** A change's text goes out right after its write and audit row; allow for clock skew. */
const TEXT_AFTER_EVENT_SKEW_MS = 60_000;
/** The audit events a recap lists, and what each one says. */
const CHANGE_BY_EVENT: Readonly<Record<string, RecapChange>> = { cancelled: "cancelled", rescheduled: "moved", created: "booked" };

/** appointment_confirmations.status → what the recap says about the customer. */
function toldFromStatus(status: unknown): RecapTold {
  switch (status) {
    case "sent":
    case "delivered":
      return { told: "texted" };
    case "pending":
      // Only the column default — caller-sms always records an outcome. Never over-claim.
      return { told: "not_texted", toldWhy: "we couldn't confirm the text went out" };
    case "failed":
    case "undelivered":
      return { told: "text_failed" };
    case "skipped_disabled":
      return { told: "not_texted", toldWhy: "customer texts are switched off" };
    case "skipped_no_contact":
      return { told: "not_texted", toldWhy: "no mobile number to text" };
    case "opted_out":
      return { told: "not_texted", toldWhy: "they've opted out of texts" };
    case "skipped_db_error":
      return { told: "not_texted", toldWhy: "we couldn't run a check, so the text was held back" };
    case "skipped_cap":
      // Never "already texted about this": the earlier text may have been about the old time.
      return { told: "not_texted", toldWhy: "they'd already had texts from you within the hour, so this one was held back" };
    default:
      return { told: "not_texted", toldWhy: "the text didn't go out" };
  }
}

/**
 * Everything the owner's assistant changed on `callId`: the bookings (oldest first),
 * then the time it blocked out, then the callbacks it marked done (SCRUM-599). Null
 * when any of the records couldn't be read — the caller reports it: a missing recap
 * is a failure, never "no changes".
 */
export async function buildOwnerRecap(
  supabase: any,
  args: { organizationId: string; callId: string; timezone: string; since: Date }
): Promise<OwnerRecapItem[] | null> {
  const bookings = await buildBookingRecap(supabase, args);
  if (bookings === null) return null;
  const { organizationId, callId, timezone } = args;

  const { data: blocks, error: blocksError } = await supabase
    .from("blocked_times")
    .select("id, title, start_time, end_time, practitioners(name)")
    .eq("organization_id", organizationId)
    .eq("created_on_call_id", callId)
    .order("created_at", { ascending: true });
  if (blocksError) {
    console.error("[OwnerRecap] blocked_times read failed:", { organizationId, callId, error: blocksError });
    return null;
  }
  const { data: callbacks, error: callbacksError } = await supabase
    .from("callback_requests")
    .select("id, caller_name, reason")
    .eq("organization_id", organizationId)
    .eq("completed_on_call_id", callId)
    .order("completed_at", { ascending: true });
  if (callbacksError) {
    console.error("[OwnerRecap] callback_requests read failed:", { organizationId, callId, error: callbacksError });
    return null;
  }

  const blockItems: BlockRecapItem[] = (blocks ?? []).map((b: any) => ({
    change: "blocked",
    when: formatSpan(new Date(b.start_time), new Date(b.end_time), timezone),
    practitioner: sanitizeCustomerText(b.practitioners?.name, NAME_MAX),
    title: sanitizeCustomerText(b.title, NAME_MAX) ?? "Time off",
  }));
  const callbackItems: CallbackRecapItem[] = (callbacks ?? []).map((c: any) => ({
    change: "callback_done",
    customer: sanitizeCustomerText(c.caller_name, NAME_MAX) ?? "A caller",
    reason: sanitizeCustomerText(c.reason, REASON_MAX) ?? "no reason given",
  }));
  return [...bookings, ...blockItems, ...callbackItems];
}

/**
 * The bookings changed on `callId`, oldest first, or null when the records couldn't be
 * read.
 * - `cancelled` and `rescheduled` events with this call_id (the owner tools record
 *   them on the cancelled row and on a move's NEW leg); `created` is a booking made
 *   on the call (SCRUM-598's AI call to a customer).
 * - A move's old time comes from the leg it replaced (rescheduled_from_id).
 * - Whether the customer was told comes from appointment_confirmations attempted
 *   since the session started: the cancellation text on a cancelled row, the
 *   confirmation text on a new leg or a booking (the intent is in idempotency_key).
 *   SCRUM-598: or a call this session asked for about that booking (calls rows of
 *   call_type customer_notify, requested_by_call_id = this call).
 */
async function buildBookingRecap(
  supabase: any,
  {
    organizationId,
    callId,
    timezone,
    since,
  }: {
    organizationId: string;
    callId: string;
    timezone: string;
    /** Text attempts before this (an earlier cancellation of a reinstated booking…) never count. */
    since: Date;
  }
): Promise<BookingRecapItem[] | null> {
  const { data: events, error: eventsError } = await supabase
    .from("appointment_events")
    .select("appointment_id, event_type, created_at")
    .eq("organization_id", organizationId)
    .eq("call_id", callId)
    .in("event_type", Object.keys(CHANGE_BY_EVENT))
    .order("created_at", { ascending: true });
  if (eventsError) {
    console.error("[OwnerRecap] appointment_events read failed:", { organizationId, callId, error: eventsError });
    return null;
  }
  const rows = (events ?? []) as Array<{ appointment_id: string; event_type: string; created_at: string }>;
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((e) => e.appointment_id))];
  const { data: appts, error: apptsError } = await supabase
    .from("appointments")
    .select("id, attendee_name, start_time, rescheduled_from_id")
    .eq("organization_id", organizationId)
    .in("id", ids);
  if (apptsError) {
    console.error("[OwnerRecap] appointments read failed:", { organizationId, callId, error: apptsError });
    return null;
  }
  const byId = new Map<string, any>((appts ?? []).map((a: any) => [a.id, a]));

  const priorIds = [...new Set(rows.filter((e) => e.event_type === "rescheduled").map((e) => byId.get(e.appointment_id)?.rescheduled_from_id).filter(Boolean))];
  const priorById = new Map<string, any>();
  if (priorIds.length > 0) {
    const { data: priors, error: priorsError } = await supabase
      .from("appointments")
      .select("id, start_time")
      .eq("organization_id", organizationId)
      .in("id", priorIds);
    if (priorsError) {
      console.error("[OwnerRecap] previous legs read failed:", { organizationId, callId, error: priorsError });
      return null;
    }
    for (const p of priors ?? []) priorById.set(p.id, p);
  }

  const { data: texts, error: textsError } = await supabase
    .from("appointment_confirmations")
    .select("appointment_id, idempotency_key, status, last_attempt_at")
    .eq("organization_id", organizationId)
    .in("appointment_id", ids)
    .gte("last_attempt_at", since.toISOString());
  if (textsError) {
    console.error("[OwnerRecap] appointment_confirmations read failed:", { organizationId, callId, error: textsError });
    return null;
  }
  const { data: placedCalls, error: callsError } = await supabase
    .from("calls")
    .select("id, metadata")
    .eq("organization_id", organizationId)
    .eq("metadata->>call_type", CUSTOMER_NOTIFY_CALL_TYPE)
    .eq(REQUESTED_BY_PATH, callId);
  if (callsError) {
    console.error("[OwnerRecap] customer calls read failed:", { organizationId, callId, error: callsError });
    return null;
  }
  const callFor = (appointmentId: string, change: RecapChange) =>
    (placedCalls ?? []).some(
      (c: any) =>
        c?.metadata?.notify?.appointment_id === appointmentId &&
        c?.metadata?.notify?.purpose === (change === "cancelled" ? "cancelled" : "moved")
    );

  // A change's own text is attempted right after it (the contact runs after the write
  // and its audit row): an attempt from before the change — an earlier cancellation of
  // a booking reinstated since — is never its text.
  const textFor = (appointmentId: string, intent: "cancellation" | "confirmation", eventAt: string) => {
    const notBefore = new Date(eventAt).getTime() - TEXT_AFTER_EVENT_SKEW_MS;
    return (texts ?? []).find((t: any) => {
      const key = parseConfirmationIdempotencyKey(t.idempotency_key);
      return (
        t.appointment_id === appointmentId &&
        key?.channel === "sms" &&
        key.intent === intent &&
        !(new Date(t.last_attempt_at).getTime() < notBefore)
      );
    });
  };

  const items: BookingRecapItem[] = [];
  for (const e of rows) {
    const appt = byId.get(e.appointment_id);
    if (!appt) {
      // Audited but no longer readable (bookings are cancelled, not deleted, so this
      // should not happen): left out of the email, and logged so it can be chased.
      console.warn("[OwnerRecap] an audited appointment is missing:", { organizationId, callId, appointmentId: e.appointment_id });
      continue;
    }
    const customer = sanitizeCustomerText(appt.attendee_name, NAME_MAX) ?? "A customer";
    const when = formatWhen(new Date(appt.start_time), timezone);
    const change = CHANGE_BY_EVENT[e.event_type];
    if (!change) continue; // the query only asks for these three
    const text = textFor(appt.id, change === "cancelled" ? "cancellation" : "confirmation", e.created_at);
    const told: RecapTold = text
      ? toldFromStatus(text.status)
      : change !== "booked" && callFor(appt.id, change)
        ? { told: "calling" }
        : { told: "not_told" };
    const prior = change === "moved" && appt.rescheduled_from_id ? priorById.get(appt.rescheduled_from_id) : undefined;
    items.push({
      change,
      customer,
      when,
      ...(prior ? { from: formatWhen(new Date(prior.start_time), timezone) } : {}),
      ...told,
    });
  }
  return items;
}
