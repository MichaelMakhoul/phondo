import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";

interface Membership {
  organization_id: string;
}

const ALLOWED_FIELDS = [
  "email_on_missed_call",
  "email_on_voicemail",
  "email_on_appointment_booked",
  "email_daily_summary",
  "sms_on_missed_call",
  "sms_on_voicemail",
  "sms_phone_number",
  "webhook_url",
  "sms_textback_on_missed_call",
  "sms_appointment_confirmation",
] as const;

const SMS_CALLER_FIELDS = [
  "sms_textback_on_missed_call",
  "sms_appointment_confirmation",
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
      return NextResponse.json({ error: error.message }, { status: 500 });
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

    // Gate SMS caller fields behind plan access.
    // Capture downgrade flag *before* mutating — then silently set to false.
    const smsAllowed = await hasFeatureAccess(membership.organization_id, "smsNotifications");
    let smsFieldsDowngraded = false;
    if (!smsAllowed) {
      for (const field of SMS_CALLER_FIELDS) {
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

    const admin = createAdminClient();
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
      return NextResponse.json({ error: error.message }, { status: 500 });
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
