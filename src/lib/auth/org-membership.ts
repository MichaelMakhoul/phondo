/**
 * Resource-first org membership resolution.
 *
 * The legacy pattern in our route handlers was:
 *
 *   const { data: membership } = await supabase
 *     .from("org_members")
 *     .select("organization_id, role")
 *     .eq("user_id", user.id)
 *     .single();
 *
 * That broke silently for any user belonging to 2+ organizations — `.single()`
 * throws when more than one row matches, so `membership` came back null and the
 * handler 404'd with "No organization found", even when the user legitimately
 * owned the resource being requested.
 *
 * The fix is to load the resource FIRST (RLS automatically scopes the query
 * to whichever orgs the user has access to), then look up the user's role
 * for THAT resource's specific organization via the helper below. Because
 * `(user_id, organization_id)` is unique on `org_members`, `.single()` is
 * safe in this second lookup — it returns exactly 1 row when the user is in
 * the org, or 0 (handled as null) when they aren't.
 *
 * See SCRUM-276 for the cross-cutting plan; this PR migrates the two
 * phone-numbers routes that were explicitly flagged. Other routes are
 * tracked in follow-up tickets.
 *
 * Note on typing: the existing route handlers in this repo cast the
 * supabase client to `any` everywhere (`(supabase.from(...) as any)`)
 * because the generated `Database` type doesn't always agree with the
 * inferred call-site types. We follow that convention here so callers
 * can pass their typed client without an extra cast.
 */

import * as Sentry from "@sentry/nextjs";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { setReasonTag } from "@/lib/observability/sentry-tags";

export interface OrgRole {
  role: string | null;
}

const ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * Postgrest error codes that mean "no rows" — expected when the user is not
 * a member of the org we're asking about. Everything else is a real DB
 * failure (connection refused, admin shutdown, RLS misconfiguration, etc.)
 * and gets Sentry-paged so on-call can distinguish "user lost admin access"
 * from "the database is on fire."
 */
const NO_ROWS_ERROR_CODE = "PGRST116";

/**
 * Look up the given user's role in the given organization.
 *
 * Returns `null` when the user is not a member of the org (no rows) AND when
 * a DB error occurs — fail-closed posture for auth (denying on a transient
 * fault is the right default). Real DB errors are Sentry-paged so the silent
 * fail-closed isn't actually silent in production.
 *
 * Use this AFTER loading the target resource so the `organizationId` argument
 * is the resource's own org, not "whichever org the user happens to be in
 * first."
 */
export async function getUserRoleInOrg(
  supabase: any,
  userId: string,
  organizationId: string,
): Promise<OrgRole | null> {
  // `(user_id, organization_id)` is unique on org_members → .single() is safe
  // here and produces a clearer not-found signal than .maybeSingle().
  const { data, error } = await supabase
    .from("org_members")
    .select("role")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    // Legitimate "not a member" — no log, no page. Most common case after
    // a resource-first row load when the user is the WRONG org's admin.
    if (error.code === NO_ROWS_ERROR_CODE) return null;

    // Anything else is a real DB fault. Caller still fails closed (we
    // return null → 404/403) but we surface it so on-call can tell
    // "your admin access was revoked" apart from "the database is sick."
    console.error("[org-membership] getUserRoleInOrg failed:", {
      userId,
      organizationId,
      code: error.code,
      message: error.message,
    });
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "next-api");
        setReasonTag(scope, SENTRY_REASONS.ORG_ROLE_LOOKUP_FAILED);
        scope.setLevel("warning");
        scope.setExtras({ userId, organizationId, code: error.code });
        Sentry.captureException(error);
      });
    } catch {
      // Sentry shim defect must not crash the caller — already returning null.
    }
    return null;
  }

  if (!data) return null;
  return { role: (data as { role: string | null }).role };
}

/**
 * @returns true when the role string is one of the admin roles (owner/admin).
 *   Null/unknown roles return false — safer default for write-gate checks.
 */
export function isOrgAdmin(role: string | null | undefined): boolean {
  return !!role && ADMIN_ROLES.has(role);
}
