import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import Twilio from "twilio";

const OPT_OUT_KEYWORDS = ["stop", "unsubscribe", "cancel", "end", "quit"];
const OPT_IN_KEYWORDS = ["start", "unstop", "subscribe", "resume"];
const HELP_KEYWORDS = ["help", "info"];

/**
 * POST /api/webhooks/twilio-sms
 *
 * Receives inbound SMS from Twilio. Handles:
 * - STOP/CANCEL/etc: Record opt-out + log for TCPA audit
 * - START/UNSTOP/etc: Remove opt-out (re-subscribe) + log
 * - HELP: Reply with compliance info
 *
 * Twilio auto-handles STOP at carrier level, but we track locally
 * for pre-send checks and TCPA compliance audit trail.
 */
export async function POST(request: Request) {
  try {
    // 1. Validate Twilio signature
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    if (!twilioAuthToken) {
      console.error("[TwilioSMS] TWILIO_AUTH_TOKEN not configured — cannot validate inbound SMS");
      return new Response("<Response></Response>", {
        status: 500,
        headers: { "Content-Type": "text/xml" },
      });
    }

    const signature = request.headers.get("X-Twilio-Signature") || "";
    const url =
      process.env.NEXT_PUBLIC_APP_URL
        ? `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio-sms`
        : request.url;

    const formData = await request.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = value.toString();
    });

    const isValid = Twilio.validateRequest(
      twilioAuthToken,
      signature,
      url,
      params
    );

    if (!isValid) {
      console.warn("[TwilioSMS] Invalid Twilio signature — rejecting request");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    const body = (params.Body || "").trim().toLowerCase();
    const from = params.From || "";
    const to = params.To || "";

    // 2. Look up org by the `To` number (the org's Twilio number)
    const supabase = createAdminClient();
    const { data: phoneRecord, error: phoneLookupErr } = await (supabase as any)
      .from("phone_numbers")
      .select("organization_id")
      .eq("phone_number", to)
      .eq("is_active", true)
      .maybeSingle();

    if (phoneLookupErr) {
      console.error("[TwilioSMS] Phone number lookup failed:", { to, error: phoneLookupErr });
      return new Response("<Response></Response>", {
        status: 500,
        headers: { "Content-Type": "text/xml" },
      });
    }

    if (!phoneRecord) {
      console.warn("[TwilioSMS] No org found for number:", to);
      return new Response("<Response></Response>", {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    const orgId = phoneRecord.organization_id;

    // 3. Handle STOP (opt-out)
    if (OPT_OUT_KEYWORDS.includes(body)) {
      const { error } = await (supabase as any)
        .from("caller_sms_optouts")
        .upsert(
          {
            phone_number: from,
            organization_id: orgId,
            opted_out_at: new Date().toISOString(),
            source: "twilio_stop",
          },
          { onConflict: "phone_number,organization_id" }
        );

      if (error) {
        console.error("[TwilioSMS] Failed to record opt-out:", { orgId, error });
        return new Response("<Response></Response>", {
          status: 500,
          headers: { "Content-Type": "text/xml" },
        });
      }

      // Log for TCPA audit trail — non-fatal since primary opt-out was already saved.
      try {
        await logConsentAction(supabase, from, orgId, "opt_out", "sms_keyword", body);
      } catch (auditErr) {
        console.error("[TwilioSMS] Consent audit log threw — primary opt-out was already saved:", { orgId, error: auditErr });
      }

      console.log("[TwilioSMS] Recorded opt-out for orgId:", orgId);
      return twimlResponse("You've been unsubscribed from messages. Reply START to re-subscribe.");
    }

    // 4. Handle START (re-subscribe / opt-in)
    if (OPT_IN_KEYWORDS.includes(body)) {
      const { error } = await (supabase as any)
        .from("caller_sms_optouts")
        .delete()
        .eq("phone_number", from)
        .eq("organization_id", orgId);

      if (error) {
        console.error("[TwilioSMS] Failed to remove opt-out:", { orgId, error });
        return new Response("<Response></Response>", {
          status: 500,
          headers: { "Content-Type": "text/xml" },
        });
      }

      // Log for TCPA audit trail — non-fatal since primary opt-in was already saved.
      try {
        await logConsentAction(supabase, from, orgId, "opt_in", "sms_keyword", body);
      } catch (auditErr) {
        console.error("[TwilioSMS] Consent audit log threw — primary opt-in was already saved:", { orgId, error: auditErr });
      }

      // Look up business name for confirmation message
      const { data: org, error: orgError } = await (supabase as any)
        .from("organizations")
        .select("business_name")
        .eq("id", orgId)
        .single();

      if (orgError) {
        console.error("[TwilioSMS] Org lookup failed for opt-in confirmation:", { orgId, error: orgError });
      }

      const businessName = org?.business_name || "this business";
      console.log("[TwilioSMS] Removed opt-out (re-subscribed) for orgId:", orgId);
      return twimlResponse(`You've been re-subscribed to messages from ${businessName}. Reply STOP to unsubscribe.`);
    }

    // 5. Handle HELP
    if (HELP_KEYWORDS.includes(body)) {
      return twimlResponse("Reply STOP to unsubscribe from messages. Reply START to re-subscribe.");
    }

    // 6. Unrecognized message — ignore
    return new Response("<Response></Response>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (err) {
    console.error("[TwilioSMS] Unhandled error in SMS webhook:", err);
    return new Response("<Response></Response>", {
      status: 500,
      headers: { "Content-Type": "text/xml" },
    });
  }
}

/** Build a TwiML response with a message. */
function twimlResponse(message: string): Response {
  const xml = `<Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

/** Escape special XML characters to prevent injection. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Log a consent action to the audit trail. Non-fatal on failure. */
async function logConsentAction(
  supabase: ReturnType<typeof createAdminClient>,
  phone: string,
  orgId: string,
  action: "opt_out" | "opt_in",
  source: string,
  keyword: string
): Promise<void> {
  const { error } = await (supabase as any)
    .from("caller_sms_consent_log")
    .insert({
      phone_number: phone,
      organization_id: orgId,
      action,
      source,
      keyword,
    });

  if (error) {
    console.error("[TwilioSMS] Failed to log consent action — audit trail incomplete:", {
      orgId, action, error,
    });
  }
}
