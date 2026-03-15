import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProfileForm } from "./profile-form";

export const metadata: Metadata = {
  title: "Profile Settings | Phondo",
  description: "Manage your personal account settings",
};

export default async function ProfileSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Profile Settings</h1>
        <p className="text-muted-foreground">
          Manage your personal account settings
        </p>
      </div>

      <ProfileForm
        user={{
          id: user.id,
          email: user.email || "",
          fullName: user.user_metadata?.full_name || "",
          avatarUrl: user.user_metadata?.avatar_url || "",
        }}
      />
    </div>
  );
}
