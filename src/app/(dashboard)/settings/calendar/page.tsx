import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CalendarSettings } from "./calendar-settings";
import { ServiceTypesCard } from "./service-types-card";
import { CalendarIntegrationCollapsible } from "./calendar-integration-collapsible";

export const metadata: Metadata = {
  title: "Scheduling | Phondo",
  description: "Manage appointment types and calendar integrations",
};

export default async function CalendarSettingsPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Get user's organization
  const { data: membership } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    redirect("/onboarding");
  }

  // Fetch service types, calendar integration, and assistants in parallel
  const [serviceTypesResult, integrationResult, assistantsResult] =
    await Promise.all([
      (supabase as any)
        .from("service_types")
        .select("*")
        .eq("organization_id", membership.organization_id)
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      (supabase as any)
        .from("calendar_integrations")
        .select("id, calendar_id, booking_url, assistant_id, is_active, settings")
        .eq("organization_id", membership.organization_id)
        .eq("provider", "cal_com")
        .single(),
      (supabase as any)
        .from("assistants")
        .select("id, name")
        .eq("organization_id", membership.organization_id)
        .order("created_at", { ascending: false }),
    ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Scheduling</h1>
        <p className="text-muted-foreground">
          Manage your appointment types and calendar integrations.
        </p>
      </div>

      {/* Primary: Appointment Types */}
      <ServiceTypesCard initialServiceTypes={serviceTypesResult.data || []} />

      {/* Secondary: Calendar Integration (collapsed by default) */}
      <CalendarIntegrationCollapsible
        organizationId={membership.organization_id}
        initialIntegration={integrationResult.data}
        assistants={assistantsResult.data || []}
      />
    </div>
  );
}
