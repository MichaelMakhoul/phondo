// src/lib/owner-assistant/customer-contact.ts
// SCRUM-597: "let them know?" on every owner cancel or move. The owner asked to be
// asked, in case they forget, and to choose a text or a call; a customer who can't
// take a text never gets one (sms-capability.ts). The text reuses the messages the
// dashboard already sends. SCRUM-598: a call is the assistant phoning them
// (customer-call.ts), offered only when the voice server says one can be placed now.
import { sendAppointmentConfirmationSMS, sendCancellationSMS } from "@/lib/sms/caller-sms";
import { getTextCapability, type TextBlockReason, type TextCapabilityDeps } from "@/lib/sms/sms-capability";
import {
  callNote,
  callWhy,
  checkCustomerCall,
  placeCustomerCall,
  type CallBlockReason,
} from "./customer-call";

export const CONTACT_METHODS = ["text", "call", "none"] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

/** The owner's choice as the model sent it, or null when it isn't one of the three. */
export function parseContactMethod(value: unknown): ContactMethod | null {
  return typeof value === "string" && (CONTACT_METHODS as readonly string[]).includes(value) ? (value as ContactMethod) : null;
}

/** What the read-back offers: always "none"; "text" and "call" only when each can go out now. */
export interface ContactOptions {
  options: ContactMethod[];
  /** Short sentences saying why text (or a call) isn't offered, when it isn't. */
  note?: string;
}

/**
 * What happened to the owner's choice. Each status belongs to one method, and a
 * contact that didn't happen always says why (a TextBlockReason or sendCallerSMS's
 * own reason; a CallBlockReason). "calling" is a call placed: how it went reaches
 * the owner in its own email.
 */
export type CustomerContactResult =
  | { method: "none"; status: "not_requested" }
  | { method: "call"; status: "calling"; callId: string }
  | { method: "call"; status: "not_placed"; reason: CallBlockReason }
  | { method: "text"; status: "sent" }
  | { method: "text"; status: "not_sent"; reason: string };

/** True when a text went out or a call was placed (the spec's customer_notified). */
export function isCustomerNotified(result: CustomerContactResult | undefined): boolean {
  return result?.status === "sent" || result?.status === "calling";
}

const BLOCK_NOTES: Record<TextBlockReason, string> = {
  texts_paused: "Texting customers isn't available yet.",
  no_number: "There's no mobile number on this booking.",
  landline: "Their number is a landline, so it can't take a text.",
  not_mobile: "Their number can't take texts.",
  opted_out: "They've opted out of texts from you.",
  check_failed: "I couldn't check whether their number takes texts.",
};

/** Spoken reasons a text didn't go out: every TextBlockReason (checked by the compiler)... */
const BLOCK_WHY = {
  texts_paused: "texting customers isn't available yet",
  no_number: "there's no mobile number on the booking",
  landline: "their number is a landline",
  not_mobile: "their number can't take texts",
  opted_out: "they've opted out of texts",
  check_failed: "I couldn't check their number",
} satisfies Record<TextBlockReason, string>;

/**
 * ...and sendCallerSMS's own refusals. A held-back text never reads as if the
 * customer already knows about THIS change (an earlier text may have been about
 * the old time).
 */
const SEND_WHY: Record<string, string> = {
  sms_globally_paused: "texting customers isn't available yet",
  not_mobile: "their number can't take texts",
  org_disabled: "customer texts are turned off in your settings",
  feature_disabled: "customer texts are turned off in your settings",
  caller_opted_out: "they've opted out of texts",
  // Owner texts are held back at 3 an hour to one number (caller-sms ownerTextCapState).
  rate_limited: "they've already had several texts from you this hour, so this one was held back",
  plan_not_eligible: "customer texts aren't included in your plan",
  no_org_phone_number: "there's no business number to text from",
  cap_check_failed: "I couldn't check their recent texts, so I held it back",
  db_error: "I couldn't check your text settings, so I held it back",
};

export interface ContactCapabilityDeps extends TextCapabilityDeps {
  checkCall?: typeof checkCustomerCall;
}

/** What a call about this change would be: the booking, why, and the owner session asking. */
export interface CallContext {
  appointmentId: string;
  purpose: "cancelled" | "moved";
  requestedByCallId: string;
}

/**
 * The ways this customer can be told right now. Text and call are checked side by
 * side; a call only with a CallContext (the owner tools always pass one).
 */
export async function getContactOptions(
  orgId: string,
  phone: string | null | undefined,
  country: string | null | undefined,
  deps?: ContactCapabilityDeps,
  call?: CallContext
): Promise<ContactOptions> {
  const [text, calling] = await Promise.all([
    getTextCapability(orgId, phone, country, deps),
    call
      ? (deps?.checkCall ?? checkCustomerCall)({ organizationId: orgId, appointmentId: call.appointmentId, purpose: call.purpose, phone, requestedByCallId: call.requestedByCallId })
      : Promise.resolve(null),
  ]);
  const options: ContactMethod[] = [];
  const notes: string[] = [];
  if (text.canText) options.push("text");
  else notes.push(BLOCK_NOTES[text.reason]);
  if (calling?.canCall) options.push("call");
  else if (calling && !calling.canCall) {
    const n = callNote(calling.reason);
    if (n) notes.push(n);
  }
  options.push("none");
  return notes.length ? { options, note: notes.join(" ") } : { options };
}

export interface ContactRequest {
  orgId: string;
  method: ContactMethod;
  kind: "cancelled" | "moved";
  /** The booking the contact is about: the cancelled one, or the NEW leg of a move. */
  appointmentId: string;
  /** Its start: the cancelled time, or the new time. */
  startTime: Date;
  phone: string | null | undefined;
  country: string | null | undefined;
  timezone: string;
  /** The owner session asking (the envelope callId) — a call can only follow one. */
  requestedByCallId: string;
}

export interface ContactDeps extends TextCapabilityDeps {
  sendCancellation?: typeof sendCancellationSMS;
  sendConfirmation?: typeof sendAppointmentConfirmationSMS;
  placeCall?: typeof placeCustomerCall;
}

/**
 * The owner asked for this text about a change they just made, so the automated
 * one-per-hour cap (meant for texts nobody asked for) doesn't hold it back — the
 * booking's original confirmation may have gone out minutes ago, about the old time.
 * It gets a looser per-number cap instead; opt-outs, the org's toggle and the plan
 * still apply.
 */
const OWNER_REQUESTED = { ownerRequested: true } as const;

/**
 * Carry out the owner's choice after the change has been written. Never throws:
 * a failed contact is reported, never allowed to undo or hide the change.
 */
export async function contactCustomer(req: ContactRequest, deps: ContactDeps = {}): Promise<CustomerContactResult> {
  if (req.method === "none") return { method: "none", status: "not_requested" };
  if (req.method === "call") {
    // The voice server re-checks everything at the moment of dialling (hours, caps,
    // the booking's state and number) — the read-back was a separate request.
    try {
      const placed = await (deps.placeCall ?? placeCustomerCall)({
        organizationId: req.orgId,
        appointmentId: req.appointmentId,
        purpose: req.kind,
        phone: req.phone,
        requestedByCallId: req.requestedByCallId,
      });
      return placed.placed
        ? { method: "call", status: "calling", callId: placed.callId }
        : { method: "call", status: "not_placed", reason: placed.reason };
    } catch (err) {
      // placeCustomerCall never throws; this is only a net. Unknown → maybe ringing.
      console.error("[owner-assistant] customer call threw:", {
        orgId: req.orgId,
        appointmentId: req.appointmentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { method: "call", status: "not_placed", reason: "place_unconfirmed" };
    }
  }

  // Checked again at send time: the read-back was a separate request, and the
  // customer may have opted out (or texts been paused) since.
  const text = await getTextCapability(req.orgId, req.phone, req.country, deps);
  if (!text.canText) return { method: "text", status: "not_sent", reason: text.reason };
  try {
    const result =
      req.kind === "cancelled"
        ? await (deps.sendCancellation ?? sendCancellationSMS)(req.orgId, text.phone, req.startTime, req.timezone, req.appointmentId, OWNER_REQUESTED)
        : await (deps.sendConfirmation ?? sendAppointmentConfirmationSMS)(req.orgId, text.phone, req.startTime, req.timezone, undefined, req.appointmentId, { ...OWNER_REQUESTED, moved: true });
    if (result?.sent) return { method: "text", status: "sent" };
    return { method: "text", status: "not_sent", reason: result?.reason || result?.status || "not_sent" };
  } catch (err) {
    console.error("[owner-assistant] customer text threw:", {
      orgId: req.orgId,
      appointmentId: req.appointmentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { method: "text", status: "not_sent", reason: "send_failed" };
  }
}

/**
 * The sentence after a change, saying exactly what happened to the customer. The
 * model repeats it; it never claims a contact the result doesn't confirm.
 */
export function contactOutcomeSentence(result: CustomerContactResult, customer: string): string {
  switch (result.status) {
    case "sent":
      return ` I've texted ${customer} to let them know.`;
    case "not_sent": {
      const why = (BLOCK_WHY as Record<string, string>)[result.reason] ?? SEND_WHY[result.reason] ?? "the text didn't go through";
      return ` I couldn't text ${customer}: ${why}. I can read you their number if you want to tell them yourself.`;
    }
    case "calling":
      return ` I'm calling ${customer} now to let them know. You'll get an email when the call's done.`;
    case "not_placed":
      if (result.reason === "calls_disabled") {
        return ` I can't call customers yet, so I haven't let ${customer} know. I can read you their number if you want to tell them yourself.`;
      }
      if (result.reason === "place_unconfirmed") {
        return ` I'm not sure the call to ${customer} went out — check Calls in the dashboard before you ring them yourself.`;
      }
      return ` I couldn't call ${customer}: ${callWhy(result.reason)}. I can read you their number if you want to tell them yourself.`;
    case "not_requested":
      // Not "as you asked": with nothing to choose, the owner may never have been asked.
      return ` I haven't let ${customer} know. I can read you their number if you want to tell them yourself.`;
  }
}
