// src/lib/owner-assistant/call-outcome.ts
// SCRUM-598: how a call the assistant placed to a customer went, for the email the
// owner asked for ("they should know after the assistant has done that, in case the
// AI made a mistake or hallucinated"). The result is the phone system's (answered,
// voicemail, no answer…) and the diary lines are the bookings themselves; the
// assistant's own note and the call summary are passed through LABELLED as
// AI-written, never as fact.
import { formatWhen } from "./time";
import { sanitizeCustomerText } from "./sanitize";
import { CALL_PURPOSES, parseCallOutcome, type CallOutcome, type CallPurpose } from "./customer-call";

/** What the phone system says happened. */
export type CallResult =
  /** A conversation ran; sureItWasAPerson is false when answering-machine detection couldn't tell. */
  | { kind: "answered"; seconds: number; endedOnAFault: boolean; sureItWasAPerson: boolean }
  /** The message was spoken; playedToEnd when Twilio confirmed the whole message played. */
  | { kind: "voicemail"; playedToEnd: boolean }
  /** A voicemail picked up, but no message was left. */
  | { kind: "voicemail_not_left" }
  | { kind: "no_answer" }
  | { kind: "busy" }
  /** Picked up, but the call ended before the assistant spoke. */
  | { kind: "dropped" }
  /** Picked up, but our side failed before the assistant could speak. */
  | { kind: "failed_on_our_side" }
  /** A fax or another machine that isn't a voicemail answered; the call hung up (code lens N7). */
  | { kind: "machine_answered" }
  /** The conversation was cut off on our side (the phone system restarted mid-call, or its record couldn't be saved). */
  | { kind: "cut_off"; seconds: number }
  | { kind: "failed" };

/** What the diary shows for the call, from the bookings themselves. */
export type DiaryLine =
  | { kind: "booked"; when: string }
  | { kind: "moved"; from: string | null; when: string }
  | { kind: "cancelled"; when: string }
  /** Nothing changed on the call; the booking it was about is still booked, still cancelled, or neither (moved on since, done). */
  | { kind: "unchanged"; when: string; state: "booked" | "cancelled" | "inactive" };

export interface CallOutcomeReport {
  callId: string;
  purpose: CallPurpose;
  customer: string;
  phone: string | null;
  /** Spoken form of the booking the call was about (for a move's call, the new time). */
  bookingWhen: string | null;
  /** For a move's call: where it was moved from, when the earlier leg is known. */
  previousWhen: string | null;
  result: CallResult;
  diary: DiaryLine[];
  /** record_call_outcome, as the assistant chose it (AI-written). */
  assistantOutcome: CallOutcome | null;
  assistantNote: string | null;
  /** The post-call summary (AI-written). */
  summary: string | null;
  /** The message a voicemail-mode call left. */
  voicemailText: string | null;
}

const NAME_MAX = 80;
const NOTE_MAX = 200;
const SUMMARY_MAX = 600;
const VOICEMAIL_MAX = 400;
const PHONE_MAX = 32;
/** A cancel made on the call lands between its start and a little after its end. */
const CANCEL_WINDOW_SLACK_MS = 2 * 60_000;
const ACTIVE = new Set(["confirmed", "pending"]);
/**
 * Twilio's AnsweredBy values the voice server hangs up on — neither a person (or
 * "unknown") it talks to, nor a voicemail it leaves a message on. The parity test
 * holds this to the voice server's own two sets.
 */
export const MACHINE_ANSWERS: ReadonlySet<string> = new Set(["fax", "machine_start"]);

function isPurpose(v: unknown): v is CallPurpose {
  return typeof v === "string" && (CALL_PURPOSES as readonly string[]).includes(v);
}

/**
 * The phone system's result, from the call row the voice server finished. The
 * voice server says "voicemail" only for a message actually spoken, and stamps
 * our own setup failures (setup_failed) so they never read as the customer hanging up.
 */
export function callResultOf(row: { status?: unknown; outcome?: unknown; duration_seconds?: unknown; metadata?: any }): CallResult {
  const seconds = typeof row.duration_seconds === "number" && row.duration_seconds > 0 ? Math.round(row.duration_seconds) : 0;
  const notify = row.metadata?.notify ?? {};
  if (typeof notify.setup_failed === "string" && notify.setup_failed) return { kind: "failed_on_our_side" };
  if (row.outcome === "voicemail") return { kind: "voicemail", playedToEnd: notify.voicemail_played === true };
  if (notify.mode === "voicemail") return { kind: "voicemail_not_left" };
  if (notify.cut_off === true) return { kind: "cut_off", seconds };
  if (row.outcome === "answered") {
    return { kind: "answered", seconds, endedOnAFault: row.status === "failed", sureItWasAPerson: notify.answered_by === "human" };
  }
  if (typeof notify.answered_by === "string" && MACHINE_ANSWERS.has(notify.answered_by)) return { kind: "machine_answered" };
  switch (row.status) {
    case "no-answer":
      return { kind: "no_answer" };
    case "busy":
      return { kind: "busy" };
    case "completed":
      return { kind: "dropped" };
    default:
      return { kind: "failed" };
  }
}

/**
 * The report for one customer call, or null when it can't be built (the call row
 * or the booking unreadable — the caller pages; a missing email is a failure, never
 * "nothing happened"). `timezone` is the org's.
 */
export async function buildCallOutcome(
  supabase: any,
  { organizationId, callId, timezone }: { organizationId: string; callId: string; timezone: string }
): Promise<CallOutcomeReport | null> {
  const { data: call, error: callError } = await supabase
    .from("calls")
    .select("id, status, outcome, duration_seconds, summary, caller_phone, started_at, ended_at, created_at, metadata")
    .eq("id", callId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (callError || !call) {
    console.error("[CallOutcome] call row unreadable:", { organizationId, callId, error: callError ?? "missing" });
    return null;
  }
  const notify = call.metadata?.notify ?? {};
  const purpose = isPurpose(notify.purpose) ? notify.purpose : null;
  const appointmentId = typeof notify.appointment_id === "string" ? notify.appointment_id : null;
  if (!purpose || !appointmentId) {
    console.error("[CallOutcome] the call row has no purpose or booking:", { organizationId, callId });
    return null;
  }

  const { data: booking, error: bookingError } = await supabase
    .from("appointments")
    .select("id, attendee_name, start_time, status, updated_at, rescheduled_from_id")
    .eq("id", appointmentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (bookingError) {
    console.error("[CallOutcome] booking unreadable:", { organizationId, callId, error: bookingError });
    return null;
  }

  // Bookings made on the call: new ones, and new legs of a move (rescheduled_from_id).
  const { data: made, error: madeError } = await supabase
    .from("appointments")
    .select("id, start_time, status, rescheduled_from_id")
    .eq("organization_id", organizationId)
    .eq("call_id", callId)
    .order("created_at", { ascending: true });
  if (madeError) {
    console.error("[CallOutcome] bookings made on the call unreadable:", { organizationId, callId, error: madeError });
    return null;
  }
  const madeRows = (made ?? []) as Array<{ id: string; start_time: string; status: string; rescheduled_from_id: string | null }>;
  // The earlier legs: of moves made on the call, and of the move a "moved" call is about.
  const movedFromId = purpose === "moved" && typeof booking?.rescheduled_from_id === "string" ? booking.rescheduled_from_id : null;
  const priorIds = [...new Set([...madeRows.map((m) => m.rescheduled_from_id), movedFromId].filter((v): v is string => typeof v === "string"))];
  const priorStart = new Map<string, string>();
  if (priorIds.length > 0) {
    const { data: priors, error: priorsError } = await supabase
      .from("appointments")
      .select("id, start_time")
      .eq("organization_id", organizationId)
      .in("id", priorIds);
    // Silent lens R2-3: they only supply the "moved from" times — never worth the whole email.
    if (priorsError) console.error("[CallOutcome] earlier legs unreadable — sending without their times:", { organizationId, callId, error: priorsError });
    for (const p of priors ?? []) priorStart.set(p.id, p.start_time);
  }

  const when = (iso: unknown) => (typeof iso === "string" && iso ? formatWhen(new Date(iso), timezone) : null);
  // A cancel on the call leaves no call_id: the booking cancelled during the call
  // (and live when it began — a cancel's own call is about an already-cancelled one).
  const callStart = Date.parse(call.started_at ?? call.created_at);
  const callEnd = Date.parse(call.ended_at ?? "") || Date.now();
  const bookingAt = when(booking?.start_time);
  const cancelledOnCall =
    purpose !== "cancelled" &&
    booking?.status === "cancelled" &&
    Number.isFinite(callStart) &&
    Date.parse(booking.updated_at) >= callStart &&
    Date.parse(booking.updated_at) <= callEnd + CANCEL_WINDOW_SLACK_MS;
  // The booking moved on the call is shown by its new leg.
  const movedOnCall = madeRows.some((m) => m.rescheduled_from_id === appointmentId);

  const diary: DiaryLine[] = [];
  // First the booking the call was about — cancelled on the call, or as it stands —
  // then whatever the call made, so the diary reads whole (code lens R2-N4).
  if (bookingAt && cancelledOnCall) diary.push({ kind: "cancelled", when: bookingAt });
  else if (bookingAt && !movedOnCall) {
    const status = String(booking?.status);
    diary.push({ kind: "unchanged", when: bookingAt, state: ACTIVE.has(status) ? "booked" : status === "cancelled" ? "cancelled" : "inactive" });
  }
  for (const m of madeRows) {
    const at = when(m.start_time);
    if (!at) continue;
    if (m.rescheduled_from_id) diary.push({ kind: "moved", from: when(priorStart.get(m.rescheduled_from_id)), when: at });
    else diary.push({ kind: "booked", when: at });
    // Made on the call and cancelled on it too (the receptionist's own fix-up is to
    // cancel and rebook): never left reading as booked (code lens G4).
    if (m.status === "cancelled") diary.push({ kind: "cancelled", when: at });
  }

  return {
    callId,
    purpose,
    customer: sanitizeCustomerText(booking?.attendee_name, NAME_MAX) ?? "Your customer",
    phone: sanitizeCustomerText(call.caller_phone, PHONE_MAX),
    bookingWhen: bookingAt,
    previousWhen: movedFromId ? when(priorStart.get(movedFromId)) : null,
    result: callResultOf(call),
    diary,
    assistantOutcome: parseCallOutcome(notify.outcome),
    assistantNote: sanitizeCustomerText(notify.note, NOTE_MAX),
    summary: sanitizeCustomerText(call.summary, SUMMARY_MAX),
    voicemailText: sanitizeCustomerText(notify.voicemail_text, VOICEMAIL_MAX),
  };
}
