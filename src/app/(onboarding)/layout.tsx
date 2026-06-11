import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Must be logged in to access onboarding
  if (!user) {
    redirect("/login");
  }

  // Check if user already has an organization
  const { data: memberships } = await supabase
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id);

  // SCRUM-426: only bounce to the dashboard when setup is actually COMPLETE
  // (the org has an assistant). A half-onboarded org — created but assistant
  // creation failed — must be able to re-enter onboarding so the idempotent
  // resume can finish the job; the old unconditional redirect dead-ended
  // exactly that cohort (audit finding #24).
  if (memberships && memberships.length > 0) {
    const orgIds = (memberships as { organization_id: string }[]).map((m) => m.organization_id);
    const { data: assistants, error: assistantsError } = await supabase
      .from("assistants")
      .select("id")
      .in("organization_id", orgIds)
      .limit(1);
    // On lookup error, fall back to the old behavior (redirect) — a complete
    // user stuck in onboarding is worse than a half-onboarded one on the
    // dashboard for the duration of a DB blip.
    if (assistantsError || (assistants && assistants.length > 0)) {
      redirect("/dashboard");
    }
  }

  return <>{children}</>;
}
