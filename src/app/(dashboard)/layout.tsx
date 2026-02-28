import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { DashboardHeader } from "@/components/dashboard/header";
import { MobileBottomNav } from "@/components/dashboard/mobile-nav";

interface Organization {
  id: string;
  name: string;
  slug: string;
  type: string;
  logo_url: string | null;
}

interface Membership {
  role: string;
  organizations: Organization;
}

interface UserProfile {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Get user's organizations
  const { data: memberships } = await supabase
    .from("org_members")
    .select(`
      role,
      organizations (
        id,
        name,
        slug,
        type,
        logo_url
      )
    `)
    .eq("user_id", user.id) as { data: Membership[] | null };

  // Get user profile
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("id", user.id)
    .single() as { data: UserProfile | null };

  // If no organizations, redirect to onboarding
  if (!memberships || memberships.length === 0) {
    redirect("/onboarding");
  }

  // Use first organization as current (later we can add org switching)
  const currentOrg = memberships[0].organizations;

  return (
    <div className="flex h-screen">
      <DashboardSidebar
        organizations={memberships.map((m) => ({
          ...m.organizations,
          role: m.role,
        }))}
        currentOrgId={currentOrg?.id}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <DashboardHeader
          user={{
            id: user.id,
            email: user.email!,
            fullName: profile?.full_name,
            avatarUrl: profile?.avatar_url,
          }}
          organization={currentOrg}
        />
        <div className="h-[2px] bg-gradient-to-r from-primary/60 via-primary/20 to-transparent" />
        <main id="main-content" className="flex-1 overflow-y-auto bg-muted/30 p-4 pb-20 md:p-6 md:pb-6">
          {children}
        </main>
        <MobileBottomNav />
      </div>
    </div>
  );
}
