import { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TestCallPage } from "./test-call-page";

export const metadata: Metadata = {
  title: "Test Assistant | Phondo",
  description: "Test your AI receptionist with a live call",
};

interface Assistant {
  id: string;
  name: string;
  system_prompt: string;
  first_message: string;
  voice_id: string;
  prompt_config: Record<string, any> | null;
}

export default async function AssistantTestPage({
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

  // Get the assistant
  const { data: assistant, error } = await (supabase as any)
    .from("assistants")
    .select("id, name, system_prompt, first_message, voice_id, prompt_config")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single() as { data: Assistant | null; error: any };

  if (error || !assistant) {
    notFound();
  }

  return (
    <TestCallPage
      assistantId={assistant.id}
      assistantData={{
        assistantName: assistant.name,
        systemPrompt: assistant.system_prompt,
        firstMessage: assistant.first_message,
        voiceId: assistant.voice_id,
        hasAfterHoursHandling: !!assistant.prompt_config?.behaviors?.afterHoursHandling,
      }}
    />
  );
}
