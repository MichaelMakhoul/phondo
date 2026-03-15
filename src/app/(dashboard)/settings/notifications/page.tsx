import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { NotificationSettings } from "./notification-settings";

export const metadata: Metadata = {
  title: "Notification Settings | Phondo",
  description: "Manage your email and SMS notification preferences",
};

export default async function NotificationsPage() {
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

  // Get notification preferences
  const { data: preferences } = await (supabase as any)
    .from("notification_preferences")
    .select("*")
    .eq("organization_id", membership.organization_id)
    .single();

  // Get user profile for email
  const { data: profile } = await (supabase as any)
    .from("user_profiles")
    .select("email")
    .eq("id", user.id)
    .single();

  // Check plan access for caller SMS features
  const smsCallerEnabled = await hasFeatureAccess(
    membership.organization_id,
    "smsNotifications"
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Notification Settings</h1>
        <p className="text-muted-foreground">
          Configure how and when you receive notifications about calls and
          appointments.
        </p>
      </div>

      <NotificationSettings
        organizationId={membership.organization_id}
        initialPreferences={preferences}
        userEmail={profile?.email}
        smsCallerEnabled={smsCallerEnabled}
      />
    </div>
  );
}
