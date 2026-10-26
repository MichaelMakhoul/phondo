// src/lib/owner-assistant/recap.ts
// SCRUM-597: what the owner's assistant actually changed on one call, for the recap
// email the owner asked for ("in case the AI made a mistake or hallucinated"). Built
// only from the system's own records — the appointment audit trail and the text log —
// never from anything the AI said.
import { formatWhen } from "./time";
import { sanitizeCustomerText } from "./sanitize";
import { parseConfirmationIdempotencyKey } from "@/lib/sms/caller-sms";

export type RecapChange = "cancelled" | "moved" | "booked";

/** What happened to the customer. Only "not_texted" carries a reason (SCRUM-598 adds call outcomes). */
export type RecapTold =
  | { told: "texted" }
  | { told: "text_failed" }
  | { told: "not_texted"; toldWhy: string }
  | { told: "not_told" };

export type OwnerRecapItem = {
  change: RecapChange;
  customer: string;
  /** Spoken form (formatWhen) of the job's time: the cancelled time, the new time, or the booked time. */
  when: string;
  /** A move's old time (spoken form). */
  from?: string;
} & RecapTold;

const NAME_MAX = 80;
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
    case "skipped_cap":
      // Never "already texted about this": the earlier text may have been about the old time.
      return { told: "not_texted", toldWhy: "another text went to them moments before, so this one was held back" };
    default:
      return { told: "not_texted", toldWhy: "the text didn't go out" };
  }
}

/**
 * The changes made on `callId`, oldest first, or null when the records couldn't be
 * read (the caller reports it — a missing recap is a failure, never "no changes").
 * - `cancelled` and `rescheduled` events with this call_id (the owner tools record
 *   them on the cancelled row and on a move's NEW leg); `created` is a booking made
 *   on the call (SCRUM-598's AI call to a customer).
 * - A move's old time comes from the leg it replaced (rescheduled_from_id).
 * - Whether the customer was told comes from appointment_confirmations attempted
 *   since the session started: the cancellation text on a cancelled row, the
 *   confirmation text on a new leg or a booking (the intent is in idempotency_key).
 */
export async function buildOwnerRecap(
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
): Promise<OwnerRecapItem[] | null> {
  const { data: events, error: eventsError } = await supabase
    .from("appointment_events")
    .select("appointment_id, event_type, created_at")
    .eq("organization_id", organizationId)
    .eq("call_id", callId)
    .in("event_type", ["cancelled", "rescheduled", "created"])
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

  const items: OwnerRecapItem[] = [];
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
    const told: RecapTold = text ? toldFromStatus(text.status) : { told: "not_told" };
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
