// src/lib/owner-assistant/customer-contact.ts
// SCRUM-597: "let them know?" on every owner cancel or move. The owner asked to be
// asked, in case they forget, and to choose a text or a call; a customer who can't
// take a text never gets one (sms-capability.ts). The text reuses the messages the
// dashboard already sends. Calls arrive with SCRUM-598.
import { sendAppointmentConfirmationSMS, sendCancellationSMS } from "@/lib/sms/caller-sms";
import { getTextCapability, type TextBlockReason, type TextCapabilityDeps } from "@/lib/sms/sms-capability";

export const CONTACT_METHODS = ["text", "call", "none"] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

/** The owner's choice as the model sent it, or null when it isn't one of the three. */
export function parseContactMethod(value: unknown): ContactMethod | null {
  return typeof value === "string" && (CONTACT_METHODS as readonly string[]).includes(value) ? (value as ContactMethod) : null;
}

/** What the read-back offers: always "none"; "text" only when it can go out now. */
export interface ContactOptions {
  options: ContactMethod[];
  /** One short sentence saying why text isn't offered, when it isn't. */
  note?: string;
}

export interface CustomerContactResult {
  method: ContactMethod;
  status: "sent" | "not_sent" | "not_available" | "not_requested";
  /** Why a text didn't go out: a TextBlockReason or sendCallerSMS's own reason. */
  reason?: string;
}

const BLOCK_NOTES: Record<TextBlockReason, string> = {
  texts_paused: "Texts to customers are switched off for now.",
  no_number: "There's no mobile number on this booking.",
  landline: "Their number is a landline, so it can't take a text.",
  not_mobile: "Their number can't take texts.",
  opted_out: "They've opted out of texts from you.",
  check_failed: "I couldn't check whether their number takes texts.",
};

/** Spoken reasons a text didn't go out, by TextBlockReason or sendCallerSMS reason. */
const NOT_SENT_WHY: Record<string, string> = {
  texts_paused: "texts to customers are switched off for now",
  sms_globally_paused: "texts to customers are switched off for now",
  no_number: "there's no mobile number on the booking",
  landline: "their number is a landline",
  not_mobile: "their number can't take texts",
  opted_out: "they've opted out of texts",
  check_failed: "I couldn't check their number",
  org_disabled: "customer texts are turned off in your settings",
  feature_disabled: "customer texts are turned off in your settings",
  caller_opted_out: "they've opted out of texts",
  rate_limited: "they were already texted about this a moment ago",
  plan_not_eligible: "customer texts aren't included in your plan",
  no_org_phone_number: "there's no business number to text from",
};

export async function getContactOptions(
  orgId: string,
  phone: string | null | undefined,
  country: string | null | undefined,
  deps?: TextCapabilityDeps
): Promise<ContactOptions> {
  const text = await getTextCapability(orgId, phone, country, deps);
  if (text.canText) return { options: ["text", "none"] };
  return { options: ["none"], note: BLOCK_NOTES[text.reason] };
}

/** "by text, or leave it" / "leave it" — the choices the read-back may offer. */
export function describeOptions(options: readonly ContactMethod[]): string {
  const offered = options.filter((m) => m !== "none").map((m) => (m === "text" ? "a text" : "a call"));
  return offered.length ? `${offered.join(" or ")}, or leave it` : "leave it (nothing else is possible)";
}

export interface ContactRequest {
  orgId: string;
  method: ContactMethod;
  kind: "cancelled" | "moved";
  /** The booking the text is about: the cancelled one, or the NEW leg of a move. */
  appointmentId: string;
  /** Its start: the cancelled time, or the new time. */
  startTime: Date;
  phone: string | null | undefined;
  country: string | null | undefined;
  timezone: string;
}

export interface ContactDeps extends TextCapabilityDeps {
  sendCancellation?: typeof sendCancellationSMS;
  sendConfirmation?: typeof sendAppointmentConfirmationSMS;
}

/**
 * Carry out the owner's choice after the change has been written. Never throws:
 * a failed contact is reported, never allowed to undo or hide the change.
 */
export async function contactCustomer(req: ContactRequest, deps: ContactDeps = {}): Promise<CustomerContactResult> {
  if (req.method === "none") return { method: "none", status: "not_requested" };
  if (req.method === "call") return { method: "call", status: "not_available", reason: "calls_unavailable" };

  // Checked again at send time: the read-back was a separate request, and the
  // customer may have opted out (or texts been paused) since.
  const text = await getTextCapability(req.orgId, req.phone, req.country, deps);
  if (!text.canText) return { method: "text", status: "not_sent", reason: text.reason };
  try {
    const result =
      req.kind === "cancelled"
        ? await (deps.sendCancellation ?? sendCancellationSMS)(req.orgId, text.phone, req.startTime, req.timezone, req.appointmentId)
        : await (deps.sendConfirmation ?? sendAppointmentConfirmationSMS)(req.orgId, text.phone, req.startTime, req.timezone, undefined, req.appointmentId);
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
      const why = (result.reason && NOT_SENT_WHY[result.reason]) || "the text didn't go through";
      return ` I couldn't text ${customer}: ${why}. I can read you their number if you want to let them know.`;
    }
    case "not_available":
      return ` I can't call customers yet, so ${customer} hasn't been told. I can read you their number if you want to let them know.`;
    case "not_requested":
      return ` As you asked, ${customer} hasn't been told.`;
  }
}
