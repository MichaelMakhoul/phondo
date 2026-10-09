import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BusinessSettingsForm } from "./business-settings-form";
import { BrandingForm } from "./branding-form";
import { DeleteAccountCard } from "./delete-account-card";
import { OwnerLineCard, type OwnerLineInitial } from "./owner-line-card";
import { isOwnerAssistantUiEnabled } from "@/lib/feature-flags";

export const metadata: Metadata = {
  title: "Settings | Phondo",
  description: "Manage your business settings",
};

interface Organization {
  id: string;
  name: string;
  slug: string;
  type: string;
  logo_url: string | null;
  primary_color: string | null;
  business_name: string | null;
  industry: string | null;
  business_website: string | null;
  business_phone: string | null;
  business_email: string | null;
  business_address: string | null;
  timezone: string | null;
  country: string | null;
  business_hours: Record<string, { open: string; close: string } | null> | null;
  default_appointment_duration: number | null;
  business_state: string | null;
  recording_consent_mode: string | null;
  recording_disclosure_text: string | null;
  appointment_verification_fields: string[] | null;
  send_customer_confirmations: boolean | null;
  sms_sender: string | null;
}

interface Membership {
  role: string;
  organizations: Organization;
}

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: membership } = (await supabase
    .from("org_members")
    .select(
      `
      role,
      organizations (
        id, name, slug, type, logo_url, primary_color,
        business_name, industry, business_website, business_phone, business_email, business_address,
        timezone, country, business_hours, default_appointment_duration,
        business_state, recording_consent_mode, recording_disclosure_text, appointment_verification_fields,
        send_customer_confirmations, sms_sender
      )
    `
    )
    .eq("user_id", user.id)
    .single()) as { data: Membership | null };

  if (!membership) {
    redirect("/onboarding");
  }

  const organization = membership.organizations;

  // SCRUM-585: the owner line is owner-only (the API refuses everyone else)
  // and dark until OWNER_ASSISTANT_UI_ENABLED. Select columns explicitly —
  // migration 00171 withholds pin_hash/pin_salt from `authenticated`, so a
  // `*` read would fail with permission denied.
  const showOwnerLine = membership.role === "owner" && isOwnerAssistantUiEnabled();
  let ownerLine: OwnerLineInitial = { configured: false, phoneE164: null, pinLength: null, enabled: true };
  let phondoNumber: string | null = null;
  if (showOwnerLine) {
    const { data: access, error: accessError } = await (supabase as any)
      .from("owner_access")
      .select("phone_e164, pin_length, enabled")
      .eq("organization_id", organization.id)
      .maybeSingle();
    if (accessError) {
      // Render the card in its empty state rather than hide it; the API
      // read on save will surface a real outage with its own message.
      console.error("[Settings] owner_access read failed:", {
        organizationId: organization.id,
        errorCode: accessError.code,
        errorMessage: accessError.message,
      });
    } else if (access) {
      ownerLine = {
        configured: true,
        phoneE164: access.phone_e164,
        pinLength: access.pin_length,
        enabled: access.enabled,
      };
    }

    // Only feeds the "save this number as a contact" hint, so a failed read
    // drops the hint rather than the card — but it is logged, not swallowed.
    const { data: number, error: numberError } = await (supabase as any)
      .from("phone_numbers")
      .select("phone_number")
      .eq("organization_id", organization.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (numberError) {
      console.error("[Settings] phone_numbers read for owner line failed:", {
        organizationId: organization.id,
        errorCode: numberError.code,
        errorMessage: numberError.message,
      });
    }
    phondoNumber = number?.phone_number ?? null;
  }

  return (
    <>
      <BusinessSettingsForm
        organizationId={organization.id}
        initialData={{
          country: organization.country || "US",
          businessName: organization.business_name || organization.name,
          industry: organization.industry || "",
          websiteUrl: organization.business_website || "",
          phone: organization.business_phone || "",
          businessEmail: organization.business_email || "",
          address: organization.business_address || "",
          timezone: organization.timezone || "America/New_York",
          businessHours: organization.business_hours || null,
          defaultAppointmentDuration: organization.default_appointment_duration ?? 30,
          businessState: organization.business_state || "",
          recordingConsentMode: organization.recording_consent_mode || "auto",
          recordingDisclosureText: organization.recording_disclosure_text || "",
          appointmentVerificationFields: organization.appointment_verification_fields || ["name", "phone"],
          sendCustomerConfirmations: organization.send_customer_confirmations !== false,
          smsSender: organization.sms_sender || null,
        }}
      />

      <BrandingForm
        organizationId={organization.id}
        initialLogoUrl={organization.logo_url || ""}
        initialPrimaryColor={organization.primary_color || "#3B82F6"}
      />

      {showOwnerLine && (
        <OwnerLineCard
          country={organization.country === "US" ? "US" : "AU"}
          phondoNumber={phondoNumber}
          initial={ownerLine}
        />
      )}

      {membership.role === "owner" && (
        <DeleteAccountCard
          organizationId={organization.id}
          organizationName={organization.name}
        />
      )}
    </>
  );
}
