import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVapiClient } from "@/lib/vapi";
import { getCountryConfig, formatPhoneForCountry } from "@/lib/country-config";
import { z } from "zod";
import { checkResourceLimit } from "@/lib/stripe/billing-service";
import { PLANS } from "@/lib/stripe/client";

// Type for org_members query result
interface Membership {
  organization_id: string;
  role?: string;
}

const buyPhoneNumberSchema = z.object({
  sourceType: z.enum(["purchased", "forwarded"]).default("purchased"),
  areaCode: z.string().optional(),
  assistantId: z.string().uuid().optional(),
  friendlyName: z.string().optional(),
  userPhoneNumber: z.string().optional(),
  carrier: z.string().optional(),
}).refine(
  (data) => data.sourceType !== "forwarded" || data.userPhoneNumber,
  { message: "userPhoneNumber is required for forwarded numbers", path: ["userPhoneNumber"] }
);

// GET /api/v1/phone-numbers - List all phone numbers
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    const { data: phoneNumbers, error } = await (supabase
      .from("phone_numbers") as any)
      .select(`
        *,
        assistants (id, name)
      `)
      .eq("organization_id", membership.organization_id)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(phoneNumbers);
  } catch (error) {
    console.error("Error listing phone numbers:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/phone-numbers - Provision a new phone number (purchased or forwarded)
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    if (!membership.role || !["owner", "admin"].includes(membership.role)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // Enforce plan phone number limit
    const limitCheck = await checkResourceLimit(membership.organization_id, "phoneNumbers");
    if (!limitCheck.allowed) {
      const planName = limitCheck.plan ? PLANS[limitCheck.plan].name : "current";
      return NextResponse.json({
        error: `Your ${planName} plan allows up to ${limitCheck.limit} phone number${limitCheck.limit === 1 ? "" : "s"}. Upgrade your plan to add more.`,
        code: "RESOURCE_LIMIT_REACHED",
        limit: limitCheck.limit,
        current: limitCheck.currentCount,
      }, { status: 403 });
    }

    // Look up org's country
    const { data: org, error: orgError } = await (supabase as any)
      .from("organizations")
      .select("country")
      .eq("id", membership.organization_id)
      .single();

    if (orgError || !org) {
      return NextResponse.json({ error: "Failed to load organization" }, { status: 500 });
    }

    const countryCode = org.country || "US";
    const config = getCountryConfig(countryCode);

    const body = await request.json();
    const validatedData = buyPhoneNumberSchema.parse(body);

    // For forwarded numbers, check for duplicate user phone in same org
    if (validatedData.sourceType === "forwarded" && validatedData.userPhoneNumber) {
      const cleanedUserPhone = validatedData.userPhoneNumber.replace(/\D/g, "");
      const { data: existing } = await (supabase
        .from("phone_numbers") as any)
        .select("id")
        .eq("organization_id", membership.organization_id)
        .eq("user_phone_number", cleanedUserPhone)
        .maybeSingle();

      if (existing) {
        return NextResponse.json(
          { error: "This phone number already has forwarding set up in your organization" },
          { status: 409 }
        );
      }
    }

    // Get assistant's Vapi ID if provided
    let vapiAssistantId: string | undefined;
    if (validatedData.assistantId) {
      const { data: assistant } = await (supabase
        .from("assistants") as any)
        .select("vapi_assistant_id")
        .eq("id", validatedData.assistantId)
        .eq("organization_id", membership.organization_id)
        .single();

      if (assistant?.vapi_assistant_id) {
        vapiAssistantId = assistant.vapi_assistant_id;
      }
    }

    // Determine area code
    let areaCode = validatedData.areaCode;
    if (!areaCode && validatedData.sourceType === "forwarded" && validatedData.userPhoneNumber) {
      const digits = validatedData.userPhoneNumber.replace(/\D/g, "");
      areaCode = config.phone.extractAreaCode(digits) || undefined;
    }

    const vapi = getVapiClient();
    let vapiPhoneNumberId: string;
    let phoneNumber: string;
    let twilioSid: string | null = null;
    let telnyxConnectionId: string | null = null;
    let telephonyProvider: "twilio" | "telnyx" = "twilio";

    if (config.phoneProvider === "telnyx") {
      // ── Telnyx flow: buy from Telnyx, assign to TeXML App ──
      telephonyProvider = "telnyx";
      const { searchAvailableNumbers, purchaseNumber, configureVoiceWebhook, configureSmsWebhook } =
        await import("@/lib/telnyx/client");

      // 1. Search Telnyx for a number matching area code
      const available = await searchAvailableNumbers(config.twilioCountryCode, areaCode, 1);
      if (available.length === 0) {
        return NextResponse.json(
          { error: `No phone numbers available for area code ${areaCode || "any"} in ${config.name}` },
          { status: 404 }
        );
      }

      // 2. Purchase from Telnyx
      const purchased = await purchaseNumber(available[0].number);
      telnyxConnectionId = purchased.connectionId;
      phoneNumber = purchased.number;

      // 3. Configure voice — assign to TeXML Application (routes calls to voice server /texml)
      // This is FATAL — without voice routing, calls to this number go nowhere
      try {
        await configureVoiceWebhook(telnyxConnectionId);
      } catch (webhookErr) {
        console.error(`[PhoneNumbers] Failed to configure Telnyx voice for ${phoneNumber} — releasing number:`, webhookErr);
        try {
          const { releaseNumber: releaseTelnyx } = await import("@/lib/telnyx/client");
          await releaseTelnyx(telnyxConnectionId);
        } catch (releaseErr) {
          console.error(`CRITICAL: Orphaned Telnyx number! ID=${telnyxConnectionId}, number=${phoneNumber}`, releaseErr);
        }
        return NextResponse.json(
          { error: "Failed to configure phone number for voice calls. Please try again." },
          { status: 502 }
        );
      }

      // 3b. Configure SMS
      try {
        await configureSmsWebhook(telnyxConnectionId);
      } catch (smsErr) {
        console.error(`[PhoneNumbers] Failed to configure Telnyx SMS for ${phoneNumber}:`, smsErr);
        // Non-fatal
      }

      // 4. No Vapi import for Telnyx numbers
      vapiPhoneNumberId = "";
    } else if (config.phoneProvider === "twilio") {
      // ── Twilio flow: buy from Twilio, configure voice webhook, silently import into Vapi ──
      const { searchAvailableNumbers, purchaseNumber, releaseNumber, configureVoiceWebhook, configureSmsWebhook, getTwilioCredentials } =
        await import("@/lib/twilio/client");

      // 1. Search Twilio for a number matching area code
      const available = await searchAvailableNumbers(config.twilioCountryCode, areaCode, 1);
      if (available.length === 0) {
        return NextResponse.json(
          { error: `No phone numbers available for area code ${areaCode || "any"} in ${config.name}` },
          { status: 404 }
        );
      }

      // 2. Purchase from Twilio
      const purchased = await purchaseNumber(available[0].number);
      twilioSid = purchased.sid;
      phoneNumber = purchased.number;

      // 3. Configure Twilio voice webhook to point at voice server
      const voiceServerUrl = process.env.VOICE_SERVER_PUBLIC_URL;
      if (voiceServerUrl) {
        try {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL;
          const fallbackUrl = appUrl ? `${appUrl}/api/twilio/voice-fallback` : undefined;
          if (!fallbackUrl) {
            console.warn(`[PhoneNumbers] NEXT_PUBLIC_APP_URL not set — fallback URL not configured for ${phoneNumber}`);
          }
          await configureVoiceWebhook(twilioSid, `${voiceServerUrl}/twiml`, fallbackUrl);
        } catch (webhookErr) {
          console.error(`[PhoneNumbers] Failed to configure voice webhook for ${phoneNumber}:`, webhookErr);
          // Non-fatal — the number still works, just needs manual webhook config
        }
      } else {
        console.warn("[PhoneNumbers] VOICE_SERVER_PUBLIC_URL not set — voice webhook not configured");
      }

      // 3b. Configure Twilio SMS webhook for opt-out tracking
      const appUrl = process.env.NEXT_PUBLIC_APP_URL;
      if (appUrl) {
        try {
          await configureSmsWebhook(twilioSid, `${appUrl}/api/webhooks/twilio-sms`);
        } catch (smsWebhookErr) {
          console.error(`[PhoneNumbers] Failed to configure SMS webhook for ${phoneNumber}:`, smsWebhookErr);
          // Non-fatal
        }
      } else {
        console.warn("[PhoneNumbers] NEXT_PUBLIC_APP_URL not set — SMS opt-out webhook not configured");
      }

      // 4. Silently import into Vapi as backup (non-fatal)
      try {
        const twilioCreds = getTwilioCredentials();
        const vapiResult = await vapi.importTwilioNumber({
          number: phoneNumber,
          twilioAccountSid: twilioCreds.accountSid,
          twilioAuthToken: twilioCreds.authToken,
          assistantId: vapiAssistantId,
          name: validatedData.friendlyName,
        });
        vapiPhoneNumberId = vapiResult.id;
      } catch (vapiError) {
        // Vapi import failure is non-fatal — self-hosted is primary
        console.warn(`[PhoneNumbers] Vapi import failed for ${phoneNumber} (non-fatal):`, vapiError);
        vapiPhoneNumberId = ""; // Will be stored as empty string
      }
    } else {
      // ── Vapi flow: buy directly from Vapi (free SIP numbers) ──
      const vapiPhoneNumber = await vapi.buyPhoneNumber({
        provider: "vapi",
        numberDesiredAreaCode: areaCode,
        assistantId: vapiAssistantId,
        name: validatedData.friendlyName,
      });
      vapiPhoneNumberId = vapiPhoneNumber.id;
      phoneNumber = vapiPhoneNumber.number;
    }

    // Build insert data
    const cleanedUserPhone = validatedData.userPhoneNumber
      ? validatedData.userPhoneNumber.replace(/\D/g, "")
      : null;

    const resolvedFriendlyName = validatedData.friendlyName
      || (validatedData.sourceType === "forwarded" && cleanedUserPhone
        ? `Forwarding for ${formatPhoneForCountry(cleanedUserPhone, countryCode)}`
        : undefined);

    const insertData: Record<string, unknown> = {
      organization_id: membership.organization_id,
      assistant_id: validatedData.assistantId,
      phone_number: phoneNumber,
      vapi_phone_number_id: vapiPhoneNumberId || null,
      twilio_sid: twilioSid,
      telnyx_connection_id: telnyxConnectionId,
      telephony_provider: telephonyProvider,
      friendly_name: resolvedFriendlyName,
      is_active: true,
      source_type: validatedData.sourceType,
      // Both Twilio and Telnyx numbers use self-hosted voice server
      voice_provider: (config.phoneProvider === "twilio" || config.phoneProvider === "telnyx") ? "self_hosted" : "vapi",
    };

    if (validatedData.sourceType === "forwarded") {
      insertData.user_phone_number = cleanedUserPhone;
      insertData.forwarding_status = "pending_setup";
      insertData.carrier = validatedData.carrier || null;
    }

    // Save to database
    const { data: phoneNumberRecord, error } = await (supabase
      .from("phone_numbers") as any)
      .insert(insertData)
      .select(`
        *,
        assistants (id, name)
      `)
      .single();

    if (error) {
      // Rollback: delete from Vapi + release from carrier
      if (vapiPhoneNumberId) {
        try {
          await vapi.deletePhoneNumber(vapiPhoneNumberId);
        } catch (e) {
          console.error(`Failed to rollback Vapi phone number (ID=${vapiPhoneNumberId}):`, e);
        }
      }
      if (twilioSid) {
        try {
          const { releaseNumber } = await import("@/lib/twilio/client");
          await releaseNumber(twilioSid);
        } catch (e) {
          console.error(
            `CRITICAL: Orphaned Twilio number! SID=${twilioSid}, number=${phoneNumber}. Manual release required.`,
            e
          );
        }
      }
      if (telnyxConnectionId) {
        try {
          const { releaseNumber } = await import("@/lib/telnyx/client");
          await releaseNumber(telnyxConnectionId);
        } catch (e) {
          console.error(
            `CRITICAL: Orphaned Telnyx number! ID=${telnyxConnectionId}, number=${phoneNumber}. Manual release required.`,
            e
          );
        }
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(phoneNumberRecord, { status: 201 });
  } catch (error: any) {
    console.error("Error buying phone number:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.errors },
        { status: 400 }
      );
    }
    if (error?.message) {
      const statusCode = error?.statusCode || error?.status || 500;
      return NextResponse.json(
        { error: error.message },
        { status: typeof statusCode === "number" && statusCode >= 400 && statusCode < 600 ? statusCode : 500 }
      );
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
