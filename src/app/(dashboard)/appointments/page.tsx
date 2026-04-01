import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppointmentsList } from "./appointments-list";

export const metadata: Metadata = {
  title: "Appointments | Phondo",
  description: "Manage all appointments",
};

interface Membership {
  organization_id: string;
}

export default async function AppointmentsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single() as { data: Membership | null };

  if (!membership) redirect("/onboarding");

  const orgId = membership.organization_id;

  // Fetch service types and practitioners for filters + manual creation form
  const [serviceTypesResult, practitionersResult] = await Promise.all([
    (supabase as any)
      .from("service_types")
      .select("id, name, duration_minutes")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("sort_order"),
    (supabase as any)
      .from("practitioners")
      .select("id, name, title")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("name"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Appointments</h1>
        <p className="text-muted-foreground">
          View, edit, and manage all appointments.
        </p>
      </div>

      <AppointmentsList
        serviceTypes={serviceTypesResult.data || []}
        practitioners={practitionersResult.data || []}
      />
    </div>
  );
}
