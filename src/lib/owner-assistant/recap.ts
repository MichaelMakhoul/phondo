// src/lib/owner-assistant/recap.ts
// SCRUM-597: what the owner's assistant actually changed on one call, for the recap
// email the owner asked for ("in case the AI made a mistake or hallucinated"). Built
// only from the system's own records — the appointment audit trail and the text log —
// never from anything the AI said.
import { formatWhen } from "./time";
import { sanitizeCustomerText } from "./sanitize";

export type RecapChange = "cancelled" | "moved" | "booked";
export type RecapTold = "texted" | "text_failed" | "not_texted" | "not_told";

export interface OwnerRecapItem {
  change: RecapChange;
  customer: string;
  /** Spoken form (formatWhen) of the job's time: the cancelled time, the new time, or the booked time. */
  when: string;
  /** A move's old time (spoken form). */
  from?: string;
  told: RecapTold;
  /** Why a text didn't go out, in a few words (not_texted only). */
  toldWhy?: string;
}

const NAME_MAX = 80;

/** appointment_confirmations.status → what the recap says about the customer. */
function toldFromStatus(status: unknown): { told: RecapTold; toldWhy?: string } {
  switch (status) {
    case "sent":
    case "delivered":
    case "pending":
      return { told: "texted" };
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
      return { told: "not_texted", toldWhy: "they were texted about it moments before" };
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
 * - Whether the customer was told comes from appointment_confirmations: the
 *   cancellation text on a cancelled row, the confirmation text on a new leg or a
 *   booking (the intent is the third part of idempotency_key).
 */
export async function buildOwnerRecap(
  supabase: any,
  { organizationId, callId, timezone }: { organizationId: string; callId: string; timezone: string }
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
  const rows = (events ?? []) as Array<{ appointment_id: string; event_type: string }>;
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
    .select("appointment_id, idempotency_key, status")
    .eq("organization_id", organizationId)
    .in("appointment_id", ids);
  if (textsError) {
    console.error("[OwnerRecap] appointment_confirmations read failed:", { organizationId, callId, error: textsError });
    return null;
  }
  const textFor = (appointmentId: string, intent: "cancellation" | "confirmation") =>
    (texts ?? []).find(
      (t: any) => t.appointment_id === appointmentId && String(t.idempotency_key ?? "").split(":")[2] === intent && String(t.idempotency_key ?? "").split(":")[1] === "sms"
    );

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
    const change: RecapChange = e.event_type === "cancelled" ? "cancelled" : e.event_type === "rescheduled" ? "moved" : "booked";
    const text = textFor(appt.id, change === "cancelled" ? "cancellation" : "confirmation");
    const told = text ? toldFromStatus(text.status) : { told: "not_told" as const };
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
