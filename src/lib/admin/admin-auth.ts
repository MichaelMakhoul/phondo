import {
  createAdminClient,
  type ServiceRoleSupabaseClient,
} from "@/lib/supabase/admin";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { pageSentry } from "@/lib/observability/page-sentry";

/**
 * Postgrest error code that means "no rows" — expected when the user
 * isn't in `user_profiles` yet. Distinguished from real DB errors so
 * a transient Supabase brownout doesn't quietly deny a real admin.
 */
const NO_ROWS_ERROR_CODE = "PGRST116";

/**
 * Check whether a given user has the `is_platform_admin` flag set.
 *
 * SCRUM-301: now accepts an optional service-role client so callers
 * that already constructed one (e.g. for a co-located rate-limit
 * check) can avoid spinning up a second client per request. When
 * omitted, falls back to the previous behaviour of constructing a
 * fresh client — keeping the function's existing call sites working.
 *
 * SCRUM-300: real DB errors (anything except PGRST116 "no rows")
 * now page Sentry so a Supabase brownout that denies a legitimate
 * admin doesn't disappear into a console.error.
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
    // Legitimate "not found" — no row in user_profiles is a normal case for
    // users not in the admin pool, so the caller fails closed to non-admin.
    // SCRUM-316: route this through pageSentry at WARNING so it reaches Loki.
    // Individually it does NOT page (the "Next.js — error logged" rule keys on
    // level=error); but a Grafana VOLUME rule on this reason catches a
    // signup-flow regression that leaves many users profileless. userId is a
    // UUID (non-PII). Measured 2026-05-20: 0 of 3 users profileless, so this
    // effectively never fires today and carries no noise risk.
    if (error.code === NO_ROWS_ERROR_CODE) {
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.ADMIN_PROFILE_ROW_MISSING,
        level: "warning",
        message: "isPlatformAdmin: no user_profiles row — treated as non-admin",
        extras: { userId },
      });
      return false;
    }

    // Anything else (network, RLS regression, admin-shutdown, etc.)
    // is a real fault. The caller still gets a fail-closed `false`,
    // but on-call sees the brownout instead of "user is not admin".
    console.error("[isPlatformAdmin] Query failed:", error);
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.ADMIN_AUTH_LOOKUP_FAILED,
      err: error,
      extras: { userId, code: error.code },
    });
    return false;
  }
  if (!data) return false;
  return data.is_platform_admin === true;
}
