import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BusinessSettingsForm } from "./business-settings-form";
import { AnswerModeCard } from "./answer-mode-card";
import { BrandingForm } from "./branding-form";
import { DeleteAccountCard } from "./delete-account-card";

export const metadata: Metadata = {
  title: "Settings | Hola Recep",
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
  business_address: string | null;
  timezone: string | null;
  country: string | null;
  business_hours: Record<string, { open: string; close: string } | null> | null;
  default_appointment_duration: number | null;
  business_state: string | null;
  recording_consent_mode: string | null;
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
        business_name, industry, business_website, business_phone, business_address,
        timezone, country, business_hours, default_appointment_duration,
        business_state, recording_consent_mode
      )
    `
    )
    .eq("user_id", user.id)
    .single()) as { data: Membership | null };

  if (!membership) {
    redirect("/onboarding");
  }

  const organization = membership.organizations;

  // Load the first active assistant to get answer mode settings
  const { data: assistant } = await (supabase
    .from("assistants") as any)
    .select("id, settings")
    .eq("organization_id", organization.id)
    .eq("is_active", true)
    .limit(1)
    .single();

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
          address: organization.business_address || "",
          timezone: organization.timezone || "America/New_York",
          businessHours: organization.business_hours || null,
          defaultAppointmentDuration: organization.default_appointment_duration ?? 30,
          businessState: organization.business_state || "",
          recordingConsentMode: organization.recording_consent_mode || "auto",
        }}
      />

      {assistant && (
        <AnswerModeCard
          assistantId={assistant.id}
          initialSettings={{
            answerMode: assistant.settings?.answerMode || "ai_first",
            ringFirstNumber: assistant.settings?.ringFirstNumber || "",
            ringFirstTimeout: assistant.settings?.ringFirstTimeout || 20,
          }}
        />
      )}

      <BrandingForm
        organizationId={organization.id}
        initialLogoUrl={organization.logo_url || ""}
        initialPrimaryColor={organization.primary_color || "#3B82F6"}
      />

      {membership.role === "owner" && (
        <DeleteAccountCard
          organizationId={organization.id}
          organizationName={organization.name}
        />
      )}
    </>
  );
}
