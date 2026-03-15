import { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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

  const { data: membership } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    redirect("/onboarding");
  }

  const organizationId = membership.organization_id as string;

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
    />
  );
}
