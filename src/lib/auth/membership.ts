/**
 * SCRUM-428 (audit finding #38): shared org-membership resolution for API
 * routes.
 *
 * Routes used `.single()` on org_members keyed only by user_id — PostgREST's
 * .single() ERRORS when more than one row matches, so a user belonging to
 * multiple orgs got `data: null` and a misleading "No organization found"
 * 404 on every route that did this. This helper takes the user's FIRST
 * membership (oldest, deterministically) instead — consistent with the
 * dashboard layout's `memberships[0]` convention.
 */

// Loosely-typed client to match the codebase's `(supabase as any)` SSR
// convention (see CLAUDE.md).
interface SupabaseLike {
  from: (table: string) => any;
}

export interface PrimaryMembership {
  organization_id: string;
  role: "owner" | "admin" | "member";
}

export async function getPrimaryMembership(
  supabase: SupabaseLike,
  userId: string,
): Promise<PrimaryMembership | null> {
  const { data, error } = await supabase
    .from("org_members")
    .select("organization_id, role")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    console.error("[Membership] Failed to resolve membership:", { userId, error });
    return null;
  }
  return (data?.[0] as PrimaryMembership) ?? null;
}

/** Owner/admin gate used by write routes (billing, KB, integrations …). */
export function isOrgAdminRole(role: string | undefined | null): boolean {
  return role === "owner" || role === "admin";
}
