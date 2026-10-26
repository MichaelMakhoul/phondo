import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { DashboardHeader } from "@/components/dashboard/header";
import { MobileBottomNav } from "@/components/dashboard/mobile-nav";
import { AnalyticsIdentifier } from "@/components/analytics/analytics-identifier";
import { SubscriptionLapseBanner } from "@/components/dashboard/subscription-lapse-banner";
import { OwnerAssistantProvider } from "@/components/owner-assistant/owner-assistant-provider";
import { OwnerAssistantBubble } from "@/components/owner-assistant/owner-assistant-bubble";
import { isOwnerAssistantUiEnabled } from "@/lib/feature-flags";
import type { LapseSubscription } from "@/lib/subscriptions/lapse-state";

interface Organization {
  id: string;
  name: string;
  slug: string;
  type: string;
  logo_url: string | null;
  industry: string | null;
  country: string | null;
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
        logo_url,
        industry,
        country
      )
    `)
    .eq("user_id", user.id)
    // SCRUM-428 (finding #38): deterministic order so memberships[0] (the
    // header org) provably matches getPrimaryMembership()'s choice in API
    // routes — unordered results could show org B while routes act on org A.
    .order("created_at", { ascending: true }) as unknown as { data: Membership[] | null };

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

  // Get subscription for analytics user properties (plan_type) and the
  // SCRUM-477 lapse banner (status + the timestamps computeLapseState reads).
  const { data: subscription, error: subError } = currentOrg
    ? await supabase
        .from("subscriptions")
        .select(
          "plan_type, status, cancel_at_period_end, current_period_end, trial_end, service_ended_at"
        )
        .eq("organization_id", currentOrg.id)
        .single()
    : { data: null, error: null };

  // PGRST116 = no rows found, expected for orgs without subscriptions
  if (subError && subError.code !== "PGRST116") {
    console.error("[Dashboard Layout] Failed to fetch subscription for analytics:", subError);
  }

  // SCRUM-597: the always-on owner assistant bubble. Only the org's owner gets
  // it, only while OWNER_ASSISTANT_UI_ENABLED is on, and only with an active
  // assistant to talk in the voice of: the same pick as /assistant-line. Nobody
  // else costs a query. The token route checks all of it again.
  let ownerAssistantId: string | null = null;
  if (isOwnerAssistantUiEnabled() && memberships[0].role === "owner" && currentOrg) {
    const { data: assistant, error: assistantError } = await (supabase as any)
      .from("assistants")
      .select("id")
      .eq("organization_id", currentOrg.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (assistantError) {
      console.error("[Dashboard Layout] owner assistant read failed:", {
        organizationId: currentOrg.id,
        errorCode: assistantError.code,
        errorMessage: assistantError.message,
      });
    }
    ownerAssistantId = assistant?.id ?? null;
  }

  const dashboard = (
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
        {/* With the bubble, extra bottom room lets the end of every page scroll clear of it. */}
        <main
          id="main-content"
          className={`flex-1 overflow-y-auto bg-muted/30 p-4 md:p-6 ${ownerAssistantId ? "pb-40 md:pb-24" : "pb-24 md:pb-6"}`}
        >
          <SubscriptionLapseBanner
            subscription={(subscription as LapseSubscription | null) ?? null}
            now={Date.now()}
          />
          {children}
        </main>
        <MobileBottomNav currentOrg={currentOrg ? { name: currentOrg.name, type: currentOrg.type || "business" } : null} />
      </div>
      {currentOrg && (
        <AnalyticsIdentifier
          userId={user.id}
          organizationId={currentOrg.id}
          planType={(subscription as any)?.plan_type ?? undefined}
          industry={currentOrg.industry ?? undefined}
          country={currentOrg.country ?? undefined}
        />
      )}
    </div>
  );

  if (!ownerAssistantId) return dashboard;

  // Keyed by org: switching org ends the old org's session instead of carrying it over.
  return (
    <OwnerAssistantProvider assistantId={ownerAssistantId} key={currentOrg.id}>
      {dashboard}
      <OwnerAssistantBubble />
    </OwnerAssistantProvider>
  );
}
