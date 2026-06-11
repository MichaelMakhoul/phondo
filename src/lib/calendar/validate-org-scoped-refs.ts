/**
 * SCRUM-360: validate that a service_type_id / practitioner_id referenced on an
 * appointment or blocked-time write belongs to the caller's organization.
 *
 * RLS already prevents READING another org's rows, but it doesn't stop a client
 * from attaching another org's service-type/practitioner id to its OWN record —
 * a cross-tenant data-integrity issue (the write stays in the caller's tenant,
 * but references a foreign id). This scopes each referenced id to the org.
 *
 * Returns a client-safe error message when a ref is missing or cross-org; null
 * when all provided refs are valid (or none were provided). THROWS on a DB error
 * so the caller's try/catch surfaces a 500 — we never silently allow an
 * unvalidated reference (fail closed).
 *
 * SCRUM-444: `requireActive` additionally rejects refs whose row is deactivated
 * (`is_active = false`). Paths that ATTACH a ref (voice booking, dashboard
 * create, dashboard explicit change) enable it; it stays off by default so
 * callers validating rows that may legitimately carry a since-deactivated ref
 * aren't broken.
 */

// The Supabase client is intentionally loosely typed (`from` returns `any`) to
// match this codebase's `(supabase as any)` convention (SSR type inference makes
// the deep PostgREST builder types unusable at call sites — see CLAUDE.md).
interface SupabaseLike {
  from: (table: string) => any;
}

export async function validateOrgScopedRefs(
  supabase: SupabaseLike,
  orgId: string,
  refs: { serviceTypeId?: string | null; practitionerId?: string | null },
  options: { requireActive?: boolean } = {},
): Promise<string | null> {
  const checks: Array<{ table: string; id: string; label: string }> = [];
  if (refs.serviceTypeId) {
    checks.push({ table: "service_types", id: refs.serviceTypeId, label: "service_type_id" });
  }
  if (refs.practitionerId) {
    checks.push({ table: "practitioners", id: refs.practitionerId, label: "practitioner_id" });
  }

  // Independent lookups — run in parallel (this sits on the live voice
  // booking path as well as the dashboard routes; SCRUM-425 review).
  const results = await Promise.all(
    checks.map(async ({ table, id, label }) => {
      let query = supabase
        .from(table)
        .select("id")
        .eq("id", id)
        .eq("organization_id", orgId);
      if (options.requireActive) {
        query = query.eq("is_active", true);
      }
      const { data, error } = await query.maybeSingle();
      if (error) {
        throw new Error(`Failed to validate ${label}: ${error.message}`);
      }
      if (data) return null;
      // One query can't distinguish cross-org from deactivated — say both.
      return options.requireActive
        ? `Invalid ${label}: does not belong to this organization or is inactive`
        : `Invalid ${label}: does not belong to this organization`;
    }),
  );

  return results.find((r) => r !== null) ?? null;
}
