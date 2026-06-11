import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";

/**
 * Per-page platform-admin gate (SCRUM-420, audit findings #26/#61).
 *
 * The (admin) route-group layout checks isPlatformAdmin once, but Next.js
 * does NOT re-run layouts on soft navigation between sibling segments — only
 * the leaf page re-renders. A revoked admin with the layout already mounted
 * could therefore keep navigating admin pages, each of which queries ALL
 * tenants via the service-role client. Every admin page must call this as
 * its FIRST statement, before any createAdminClient() use (DAL pattern).
 *
 * Redirect semantics match the layout: no session → /login, non-admin → /.
 * isPlatformAdmin fails CLOSED (false) on DB errors and pages Sentry itself.
 *
 * @returns the verified admin's user id, for pages that need it.
 */
export async function requirePlatformAdmin(): Promise<{ userId: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const isAdmin = await isPlatformAdmin(user.id);
  if (!isAdmin) redirect("/");

  return { userId: user.id };
}
