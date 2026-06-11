import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPrimaryMembership, isOrgAdminRole } from "@/lib/auth/membership";
import { KnowledgeSettings } from "./knowledge-settings";

export const metadata: Metadata = {
  title: "Knowledge Base | Phondo",
  description: "Manage your AI's knowledge sources",
};

export default async function KnowledgePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Same membership source as the KB write routes — `.single()` errors for
  // multi-org users (more than one row), which would bounce them to
  // onboarding here while the routes still serve them.
  const membership = await getPrimaryMembership(supabase as any, user.id);

  if (!membership) {
    redirect("/onboarding");
  }

  const organizationId = membership.organization_id;
  // KB writes are owner/admin-gated server-side (SCRUM-428) — pass the role
  // down so the UI disables write controls instead of 403ing on click
  // (SCRUM-446, same pattern as billing's SCRUM-422 gate).
  const canEdit = isOrgAdminRole(membership.role);

  // Fetch KB entries (metadata only, no full content)
  const { data: entries } = await (supabase as any)
    .from("knowledge_bases")
    .select("id, title, source_type, source_url, is_active, metadata, created_at")
    .eq("organization_id", organizationId)
    .is("assistant_id", null)
    .order("created_at", { ascending: false });

  return (
    <KnowledgeSettings
      entries={entries || []}
      organizationId={organizationId}
      canEdit={canEdit}
    />
  );
}
