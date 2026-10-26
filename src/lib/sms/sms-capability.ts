// src/lib/sms/sms-capability.ts
// SCRUM-597: can this customer number take a text? The owner asked that a
// landline, or a number that can't receive SMS for any reason, never gets one.
// Every step fails closed: when in doubt, no text.
import { createAdminClient } from "@/lib/supabase/admin";
import { getTwilioClient } from "@/lib/twilio/client";
import { isE164, parsePhoneToE164, type SupportedCountry } from "@/lib/phone/normalize";

export type LineType = "mobile" | "landline" | "other";

/**
 * The line type a numbering plan fixes, with no I/O, or null when the plan can't
 * tell. AU: a national number starting 4 is a mobile (AU mobile numbers can't be
 * ported to a fixed line), 2/3/7/8 is a geographic landline, and anything else
 * under +61 (13/1300/1800, 05, satellite…) is "other". NANP (+1) mixes mobiles and
 * landlines in every area code, so it needs a carrier lookup (null here).
 */
export function numberingPlanLineType(e164: string | null | undefined): LineType | null {
  // Only a real E.164 string is classified: "+61 412 345 678" is a mobile written
  // with spaces, not an "other" number (toNumberingPlanE164 cleans it first).
  if (!isE164(e164) || !e164.startsWith("+61")) return null;
  const national = /^\+61(\d{9})$/.exec(e164)?.[1];
  if (!national) return "other";
  if (national[0] === "4") return "mobile";
  if ("2378".includes(national[0])) return "landline";
  return "other";
}

/**
 * A stored number in E.164 for numberingPlanLineType, or null. International form
 * with punctuation ("+61 412 345 678", "+61 (2) 9555-1234") is compacted; a national
 * number ("0412 345 678", "(02) 9555 1234") is read as AU, the only plan classified
 * for free — a NANP national number doesn't parse as AU, so it stays unclassified.
 */
export function toNumberingPlanE164(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = dropAuTrunkZero(raw);
  const compact = cleaned.replace(/[\s().-]/g, "");
  if (isE164(compact)) return compact;
  return parsePhoneToE164(cleaned, "AU");
}

/**
 * "+61 (0) 412 345 678" / "+610412345678" → "+61 412 345 678": the trunk 0 some
 * people keep after the country code. No AU national number starts with 0, so a 0
 * right after +61 is always that trunk digit.
 */
function dropAuTrunkZero(raw: string): string {
  return raw.replace(/^(\s*\+\s*61)[\s().-]*0/, "$1");
}

/** Why a customer can't be texted (the order checks run in). */
export type TextBlockReason =
  | "texts_paused" // CALLER_SMS_ENABLED is off (SCRUM-264)
  | "no_number" // no phone on the booking, or it doesn't normalise in the org's country
  | "landline"
  | "not_mobile" // toll-free, 13/1300/1800, VoIP, pager…
  | "opted_out" // the customer replied STOP
  | "check_failed"; // a lookup or the opt-out read failed

export type TextCapability =
  | { canText: true; phone: string }
  | { canText: false; reason: TextBlockReason; phone: string | null };

export interface TextCapabilityDeps {
  /** Defaults to process.env.CALLER_SMS_ENABLED === "true" at call time. */
  smsEnabled?: boolean;
  /** Carrier line type for a number the numbering plan can't classify ("error" on failure). */
  lookupLineType?: (e164: string) => Promise<LineType | "error">;
  /** Whether the customer opted out; throws on a failed read. */
  isOptedOut?: (orgId: string, e164: string) => Promise<boolean>;
}

/**
 * Twilio Lookup Line Type Intelligence (US$0.008 a request). Only "mobile" can
 * take a text; a missing type or a failed request is "error" (no text).
 */
export async function lookupLineTypeViaTwilio(e164: string): Promise<LineType | "error"> {
  try {
    const result = await getTwilioClient().lookups.v2.phoneNumbers(e164).fetch({ fields: "line_type_intelligence" });
    const type = (result.lineTypeIntelligence as { type?: unknown } | null | undefined)?.type;
    if (type === "mobile") return "mobile";
    if (type === "landline" || type === "fixedVoip") return "landline";
    if (typeof type === "string" && type) return "other";
    console.warn("[SmsCapability] line type lookup returned no type:", { errorCode: (result.lineTypeIntelligence as any)?.error_code ?? null });
    return "error";
  } catch (err) {
    console.warn("[SmsCapability] line type lookup failed:", err instanceof Error ? err.message : String(err));
    return "error";
  }
}

async function readOptOut(orgId: string, e164: string): Promise<boolean> {
  const { data, error } = await (createAdminClient() as any)
    .from("caller_sms_optouts")
    .select("id")
    .eq("phone_number", e164)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`opt-out read failed: ${error.code || error.message}`);
  return !!data;
}

/**
 * Can this customer take a text right now? Checks, in order: the global SMS pause,
 * the number itself, its line type (free for AU, a Twilio lookup for US), and the
 * customer's STOP opt-out. What sendCallerSMS checks at send time (the org's own
 * confirmation toggle, rate limits) is reported there.
 */
export async function getTextCapability(
  orgId: string,
  rawPhone: string | null | undefined,
  country: string | null | undefined,
  deps: TextCapabilityDeps = {}
): Promise<TextCapability> {
  const smsEnabled = deps.smsEnabled ?? process.env.CALLER_SMS_ENABLED === "true";
  if (!smsEnabled) return { canText: false, reason: "texts_paused", phone: null };

  const supported: SupportedCountry | null = country === "AU" || country === "US" ? country : null;
  const phone = supported && typeof rawPhone === "string" ? parsePhoneToE164(dropAuTrunkZero(rawPhone), supported) : null;
  if (!phone) return { canText: false, reason: "no_number", phone: null };

  let line: LineType | "error" | null = numberingPlanLineType(phone);
  if (line === null) {
    // Only NANP numbers reach a paid lookup; any other unclassifiable number is refused.
    line = phone.startsWith("+1") ? await (deps.lookupLineType ?? lookupLineTypeViaTwilio)(phone) : "other";
  }
  if (line === "error") return { canText: false, reason: "check_failed", phone };
  if (line === "landline") return { canText: false, reason: "landline", phone };
  if (line !== "mobile") return { canText: false, reason: "not_mobile", phone };

  try {
    if (await (deps.isOptedOut ?? readOptOut)(orgId, phone)) return { canText: false, reason: "opted_out", phone };
  } catch (err) {
    console.error("[SmsCapability] opt-out check failed — no text:", { orgId, error: err instanceof Error ? err.message : String(err) });
    return { canText: false, reason: "check_failed", phone };
  }
  return { canText: true, phone };
}
