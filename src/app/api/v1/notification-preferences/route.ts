import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { getOrgCountry, validatePhone } from "@/lib/phone/validate-for-org";
import { isUrlAllowedAsync } from "@/lib/security/validation";

interface Membership {
  organization_id: string;
}

const ALLOWED_FIELDS = [
  "email_on_missed_call",
  "email_on_voicemail",
  "email_on_appointment_booked",
  "email_on_unsuccessful_call",
  "email_on_callback_scheduled",
  "email_daily_summary",
  "sms_on_missed_call",
  "sms_on_voicemail",
  "sms_on_callback_scheduled",
  "sms_phone_number",
  "webhook_url",
  "sms_textback_on_missed_call",
  "sms_appointment_confirmation",
] as const;

// ALL SMS toggles are Professional+ (smsNotifications plan flag) — both the
// caller-facing ones and the owner-alert ones. Previously only the caller
// fields were gated, letting a Starter org enable owner-alert SMS
// (SCRUM-423, audit finding #13).
const SMS_GATED_FIELDS = [
  "sms_on_missed_call",
  "sms_on_voicemail",
  "sms_on_callback_scheduled",
  "sms_textback_on_missed_call",
  "sms_appointment_confirmation",
] as const;

// Owner-alert SMS toggles deliver to sms_phone_number — without a number the
// channel is wanted-but-undeliverable and settleChannels records a failed
// notification on every matching call (SCRUM-442). The caller-facing SMS
// fields (textback/confirmation) go to the CALLER's number and are
// intentionally excluded.
const OWNER_SMS_TOGGLES = [
  "sms_on_missed_call",
  "sms_on_voicemail",
  "sms_on_callback_scheduled",
] as const;

// GET /api/v1/notification-preferences
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

    const admin = createAdminClient();
    const { data: preferences, error } = await (admin as any)
      .from("notification_preferences")
      .select("*")
      .eq("organization_id", membership.organization_id)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("Failed to fetch notification preferences:", {
        organizationId: membership.organization_id,
        errorCode: error.code,
        errorMessage: error.message,
      });
      return NextResponse.json({ error: "Failed to load notification preferences" }, { status: 500 });
    }

    return NextResponse.json(preferences || null);
  } catch (error) {
    console.error("Error fetching notification preferences:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/v1/notification-preferences
export async function PUT(request: Request) {
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

    const rawBody = await request.json();

    // Allowlist fields to prevent injection of arbitrary columns (e.g. organization_id override)
    const body: Record<string, any> = {};
    for (const field of ALLOWED_FIELDS) {
      if (field in rawBody) {
        body[field] = rawBody[field];
      }
    }

    // SCRUM-295: sms_phone_number must be E.164 (otherwise Twilio refuses
    // to send and the business gets no missed-call alerts). Empty string
    // and null both mean "clear the field" — allow those through.
    if (
      "sms_phone_number" in body &&
      body.sms_phone_number !== null &&
      body.sms_phone_number !== ""
    ) {
      const country = await getOrgCountry(membership.organization_id, supabase);
      const result = validatePhone(body.sms_phone_number, country, "SMS phone number");
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      body.sms_phone_number = result.value;
    }

    // Gate ALL SMS toggles behind plan access.
    // Capture downgrade flag *before* mutating — then silently set to false.
    const smsAllowed = await hasFeatureAccess(membership.organization_id, "smsNotifications");
    let smsFieldsDowngraded = false;
    if (!smsAllowed) {
      for (const field of SMS_GATED_FIELDS) {
        if (body[field]) {
          smsFieldsDowngraded = true;
          body[field] = false;
        }
      }
    }

    // Gate webhook_url behind webhookIntegrations plan feature
    const webhookAllowed = await hasFeatureAccess(membership.organization_id, "webhookIntegrations");
    let webhookDowngraded = false;
    if (!webhookAllowed && body.webhook_url) {
      webhookDowngraded = true;
      body.webhook_url = null;
    }

    // SSRF protection (SCRUM-338): reject a private/internal/metadata webhook
    // target at write time with a DNS-resolving check, so it can never be
    // stored and later delivered to an internal address.
    if (
      "webhook_url" in body &&
      typeof body.webhook_url === "string" &&
      body.webhook_url !== ""
    ) {
      if (!(await isUrlAllowedAsync(body.webhook_url))) {
        return NextResponse.json(
          { error: "Webhook URL points to a private or internal address" },
          { status: 400 }
        );
      }
    }

    const admin = createAdminClient();

    // SCRUM-442: cross-field validation. The allowlist alone permits
    // sms_on_* = true with no sms_phone_number (and clearing the number while
    // a toggle stays on). Validate the MERGED state (existing row + this
    // patch) — a partial PATCH that looks fine in isolation can still leave
    // the stored row undeliverable.
    const touchesSmsState =
      "sms_phone_number" in body || OWNER_SMS_TOGGLES.some((f) => f in body);
    if (touchesSmsState) {
      const { data: existing, error: existingError } = await (admin as any)
        .from("notification_preferences")
        .select("*")
        .eq("organization_id", membership.organization_id)
        .single();

      if (existingError && existingError.code !== "PGRST116") {
        // Without the current row we can't trust merged-state validation:
        // failing open could store an undeliverable state, validating the
        // patch alone could falsely reject a valid one. Surface the failure.
        console.error("Failed to load notification preferences for validation:", {
          organizationId: membership.organization_id,
          errorCode: existingError.code,
          errorMessage: existingError.message,
        });
        return NextResponse.json({ error: "Failed to save notification preferences" }, { status: 500 });
      }

      const merged: Record<string, any> = { ...(existing || {}), ...body };
      const wantsOwnerSms = OWNER_SMS_TOGGLES.some((f) => merged[f]);
      const hasSmsNumber =
        typeof merged.sms_phone_number === "string" && merged.sms_phone_number !== "";

      if (wantsOwnerSms && !hasSmsNumber) {
        const clearingNumber =
          "sms_phone_number" in body &&
          (body.sms_phone_number === null || body.sms_phone_number === "");
        return NextResponse.json(
          {
            error: clearingNumber
              ? "Turn off SMS alerts before removing the SMS phone number — alerts cannot be delivered without it."
              : "Add an SMS phone number before turning on SMS alerts — there is no number to send them to.",
          },
          { status: 400 }
        );
      }
    }

    const { data, error } = await (admin as any)
      .from("notification_preferences")
      .upsert({
        organization_id: membership.organization_id,
        ...body,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "organization_id",
      })
      .select()
      .single();

    if (error) {
      console.error("Failed to save notification preferences:", {
        organizationId: membership.organization_id,
        errorCode: error.code,
        errorMessage: error.message,
      });
      return NextResponse.json({ error: "Failed to save notification preferences" }, { status: 500 });
    }

    return NextResponse.json({
      ...data,
      smsFieldsDowngraded,
      webhookDowngraded,
    });
  } catch (error) {
    console.error("Error saving notification preferences:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
