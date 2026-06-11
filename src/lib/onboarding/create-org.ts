/**
 * SCRUM-426 (audit findings #24 & #25): idempotent org creation for onboarding.
 *
 * Two failure modes this module closes:
 *  - #24: a failure AFTER org creation (org-update / assistant creation) used
 *    to orphan the org — a retry called create_organization_with_owner again
 *    and hit the per-user owned-org cap (SCRUM-412), dead-ending onboarding.
 *    Now the caller persists createdOrgId immediately, and if the cap still
 *    fires (e.g. localStorage cleared), we RECOVER the user's owned org and
 *    resume into it instead of giving up.
 *  - #25: a slug UNIQUE collision (two businesses with the same name)
 *    hard-failed onboarding. Now we retry with a short random suffix.
 */

interface SupabaseLike {
  rpc: (fn: string, args: Record<string, unknown>) => any;
  from: (table: string) => any;
}

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** 4 chars of base36 — enough to make same-name businesses collide ~never. */
function randomSlugSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * The owned-org cap can surface two ways: the RPC's friendly EXISTS check
 * (P0001 "already owns an organization"), or — when two concurrent first
 * attempts race past that check — a raw 23505 on the 00148
 * org_members_one_owner_per_user partial index. Both mean "resume, don't
 * retry slugs".
 */
function isOwnedOrgCap(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = error.message || "";
  if (/already owns an organization/i.test(msg)) return true;
  return error.code === "23505" && /org_members|one_owner_per_user/i.test(msg);
}

/**
 * Only a 23505 that names the organizations slug constraint is a slug
 * collision — a generic "duplicate key" match would misroute the owner-cap
 * index violation into useless slug retries (SCRUM-426 review).
 */
function isSlugCollision(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = error.message || "";
  if (/org_members|one_owner_per_user/i.test(msg)) return false;
  return (error.code === "23505" && /slug/i.test(msg)) || /organizations_slug/i.test(msg);
}

const MAX_SLUG_ATTEMPTS = 4; // base slug + 3 suffixed retries

export type CreateOrgResult =
  | { ok: true; orgId: string; resumed: boolean }
  // The user already owns an org but we couldn't find it — the caller should
  // fall back to the dashboard (the pre-SCRUM-426 behavior).
  | { ok: false; reason: "owned-org-lookup-failed" };

/**
 * Create the onboarding organization, or resume into the one the user
 * already owns. Throws on hard failures (caller toasts the message).
 */
export async function createOrResumeOrganization(
  supabase: SupabaseLike,
  userId: string,
  businessName: string,
): Promise<CreateOrgResult> {
  const baseSlug = generateSlug(businessName) || "business";

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSlugSuffix()}`;

    const { data: orgResult, error: orgError } = (await supabase.rpc(
      "create_organization_with_owner",
      { org_name: businessName, org_slug: slug, org_type: "business" },
    )) as { data: Array<{ id: string }> | null; error: { code?: string; message?: string } | null };

    if (!orgError && orgResult && orgResult.length > 0) {
      return { ok: true, orgId: orgResult[0].id, resumed: false };
    }

    // Per-user owned-org cap (SCRUM-412): the org from a previous partial
    // attempt already exists — find it and RESUME instead of dead-ending.
    if (isOwnedOrgCap(orgError)) {
      const { data: owned, error: lookupError } = await supabase
        .from("org_members")
        .select("organization_id")
        .eq("user_id", userId)
        .eq("role", "owner")
        .maybeSingle();
      if (!lookupError && owned?.organization_id) {
        return { ok: true, orgId: owned.organization_id, resumed: true };
      }
      console.error("[Onboarding] User owns an org but lookup failed:", { userId, lookupError });
      return { ok: false, reason: "owned-org-lookup-failed" };
    }

    if (isSlugCollision(orgError) && attempt < MAX_SLUG_ATTEMPTS - 1) {
      continue; // same business name as another org — retry with a suffix
    }

    throw new Error(orgError?.message || "Failed to create organization");
  }

  // Unreachable (the loop throws or returns), but keeps TypeScript honest.
  throw new Error("Failed to create organization after multiple attempts");
}
