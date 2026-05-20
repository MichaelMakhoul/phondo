import {
  createAdminClient,
  type ServiceRoleSupabaseClient,
} from "@/lib/supabase/admin";

/**
 * Check whether a given user has the `is_platform_admin` flag set.
 *
 * SCRUM-301: now accepts an optional service-role client so callers
 * that already constructed one (e.g. for a co-located rate-limit
 * check) can avoid spinning up a second client per request. When
 * omitted, falls back to the previous behaviour of constructing a
 * fresh client — keeping the function's existing call sites working.
 */
export async function isPlatformAdmin(
  userId: string,
  adminClient?: ServiceRoleSupabaseClient,
): Promise<boolean> {
  const supabase = adminClient ?? createAdminClient();
  const { data, error } = await (supabase as any)
    .from("user_profiles")
    .select("is_platform_admin")
    .eq("id", userId)
    .single();

  if (error) {
    console.error("[isPlatformAdmin] Query failed:", error);
    return false;
  }
  if (!data) return false;
  return data.is_platform_admin === true;
}
