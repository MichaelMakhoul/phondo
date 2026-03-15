import { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CallDetail } from "./call-detail";

export const metadata: Metadata = {
  title: "Call Details | Phondo",
  description: "View call details and analytics",
};

export default async function CallDetailPage({
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

  const { data: membership } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    redirect("/onboarding");
  }

  const orgId = membership.organization_id as string;

  const { data: call, error } = await (supabase as any)
    .from("calls")
    .select(
      `
      *,
      assistants (id, name),
      phone_numbers (id, phone_number, friendly_name)
    `
    )
    .eq("id", id)
    .eq("organization_id", orgId)
    .single();

  if (error || !call) {
    notFound();
  }

  return <CallDetail call={call} />;
}
