import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPrimaryMembership } from "@/lib/auth/membership";
import { isOwnerAssistantUiEnabled } from "@/lib/feature-flags";
import { OwnerTalkPanel } from "./owner-talk-panel";

export const metadata: Metadata = {
  title: "Your Assistant | Phondo",
  description: "Talk to your assistant about your bookings",
};

/**
 * SCRUM-596: the owner assistant in the browser. Only the org's owner sees it,
 * and only once OWNER_ASSISTANT_UI_ENABLED is on. The token route checks both
 * again, since it is what actually opens the session.
 */
export default async function AssistantLinePage() {
  if (!isOwnerAssistantUiEnabled()) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getPrimaryMembership(supabase, user.id);
  if (!membership) redirect("/onboarding");
  if (membership.role !== "owner") notFound();

  // The assistant speaks in the voice of the org's first active assistant. The
  // token route checks that it belongs to this org.
  const { data: assistant, error } = await (supabase as any)
    .from("assistants")
    .select("id")
    .eq("organization_id", membership.organization_id)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[AssistantLine] assistants read failed:", {
      organizationId: membership.organization_id,
      errorCode: error.code,
      errorMessage: error.message,
    });
  }

  return <OwnerTalkPanel assistantId={assistant?.id ?? null} loadFailed={Boolean(error)} />;
}
