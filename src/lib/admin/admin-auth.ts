import { createAdminClient } from "@/lib/supabase/admin";

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("user_profiles")
    .select("is_platform_admin")
    .eq("id", userId)
    .single();

  if (error || !data) return false;
  return data.is_platform_admin === true;
}
