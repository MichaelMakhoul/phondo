import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { CalendarSettings } from "./calendar-settings";
import { ServiceTypesCard } from "./service-types-card";
import { PractitionersCard } from "./practitioners-card";
import { CalendarIntegrationCollapsible } from "./calendar-integration-collapsible";
import { BlockedTimesCard } from "./blocked-times-card";

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

  const orgId = membership.organization_id;

  // Fetch service types, practitioners, calendar integration, assistants, and feature access in parallel
  const [serviceTypesResult, practitionersResult, integrationResult, assistantsResult, hasPractitionersAccess] =
    await Promise.all([
      (supabase as any)
        .from("service_types")
        .select("*")
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      (supabase as any)
        .from("practitioners")
        .select(`
          id, name, title, is_active, created_at, updated_at,
          practitioner_services (
            service_type_id,
            service_types ( id, name, duration_minutes )
          )
        `)
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .order("name", { ascending: true }),
      (supabase as any)
        .from("calendar_integrations")
        .select("id, calendar_id, booking_url, assistant_id, is_active, settings")
        .eq("organization_id", orgId)
        .eq("provider", "cal_com")
        .single(),
      (supabase as any)
        .from("assistants")
        .select("id, name")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false }),
      hasFeatureAccess(orgId, "practitioners"),
    ]);

  // Transform practitioners to camelCase for the client component
  const practitioners = (practitionersResult.data || []).map((p: any) => ({
    id: p.id,
    name: p.name,
    title: p.title,
    isActive: p.is_active,
    services: (p.practitioner_services || []).map((ps: any) => ({
      id: ps.service_types?.id ?? ps.service_type_id,
      name: ps.service_types?.name ?? null,
      durationMinutes: ps.service_types?.duration_minutes ?? null,
    })),
  }));

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

      {/* Staff Management (Professional+ only) */}
      <PractitionersCard
        initialPractitioners={practitioners}
        serviceTypes={serviceTypesResult.data || []}
        hasPractitionersAccess={hasPractitionersAccess}
      />

      {/* Blocked Times */}
      <BlockedTimesCard />

      {/* Secondary: Calendar Integration (collapsed by default) */}
      <CalendarIntegrationCollapsible
        organizationId={orgId}
        initialIntegration={integrationResult.data}
        assistants={assistantsResult.data || []}
      />
    </div>
  );
}
