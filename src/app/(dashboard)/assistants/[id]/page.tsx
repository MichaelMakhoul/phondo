import { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AssistantBuilder } from "./assistant-builder";
import type { AfterHoursConfig } from "@/lib/prompt-builder/types";

export const metadata: Metadata = {
  title: "Edit Assistant | Hola Recep",
  description: "Configure your AI receptionist",
};

interface Assistant {
  id: string;
  name: string;
  system_prompt: string;
  first_message: string;
  voice_id: string;
  voice_provider: string;
  is_active: boolean;
  settings: Record<string, any>;
  prompt_config: Record<string, any> | null;
  after_hours_config: AfterHoursConfig | null;
  created_at: string;
  phone_numbers?: { id: string; phone_number: string }[];
}

interface TransferRule {
  id: string;
  name: string;
  trigger_keywords: string[];
  trigger_intent: string | null;
  transfer_to_phone: string;
  transfer_to_name: string | null;
  announcement_message: string | null;
  priority: number;
  is_active: boolean;
  destinations: { phone: string; name: string }[];
  require_confirmation: boolean;
}

export default async function AssistantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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

  const organizationId = membership.organization_id as string;

  // Get the assistant with related data
  const { data: assistant, error } = await (supabase as any)
    .from("assistants")
    .select(`
      *,
      phone_numbers (id, phone_number)
    `)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single() as { data: Assistant | null; error: any };

  if (error || !assistant) {
    notFound();
  }

  // Get transfer rules for this assistant
  const { data: transferRules } = await (supabase as any)
    .from("transfer_rules")
    .select("*")
    .eq("assistant_id", id)
    .eq("organization_id", organizationId)
    .order("priority", { ascending: false }) as { data: TransferRule[] | null };

  return (
    <AssistantBuilder
      assistant={assistant}
      organizationId={organizationId}
      transferRules={transferRules || []}
    />
  );
}
