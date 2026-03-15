import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CalendarSettings } from "./calendar-settings";

export const metadata: Metadata = {
  title: "Calendar Integration | Phondo",
  description: "Connect your calendar for automatic appointment booking",
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

  // Get existing calendar integration (excluding sensitive fields)
  const { data: integration } = await (supabase as any)
    .from("calendar_integrations")
    .select("id, calendar_id, booking_url, assistant_id, is_active, settings")
    .eq("organization_id", membership.organization_id)
    .eq("provider", "cal_com")
    .single();

  // Get assistants for the assistant selector
  const { data: assistants } = await (supabase as any)
    .from("assistants")
    .select("id, name")
    .eq("organization_id", membership.organization_id)
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Calendar Integration</h1>
        <p className="text-muted-foreground">
          Connect your Cal.com account to let your AI receptionist book
          appointments automatically.
        </p>
      </div>

      <CalendarSettings
        organizationId={membership.organization_id}
        initialIntegration={integration}
        assistants={assistants || []}
      />
    </div>
  );
}
