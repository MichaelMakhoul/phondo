import { describe, it, expect } from "vitest";
import { validateOrgScopedRefs } from "../validate-org-scoped-refs";

// SCRUM-360: refs must belong to the caller's org. Build a tiny supabase stub
// whose .from(table).select().eq()….maybeSingle() resolves to a per-table
// programmed result, and record which (table, id, orgId[, activeOnly]) tuples
// were queried. Filters are recorded by COLUMN NAME (not chain position) so the
// optional SCRUM-444 `.eq("is_active", true)` can be asserted present/absent.

function makeSupabase(results: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: Array<{ table: string; id?: string; orgId?: string; activeOnly?: boolean }> = [];
  const supabase = {
    from(table: string) {
      const rec: { table: string; id?: string; orgId?: string; activeOnly?: boolean } = { table };
      calls.push(rec);
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          if (col === "id") rec.id = val as string;
          else if (col === "organization_id") rec.orgId = val as string;
          else if (col === "is_active") rec.activeOnly = val === true;
          return builder;
        },
        maybeSingle: async () => results[table] ?? { data: null, error: null },
      };
      return builder;
    },
  };
  return { supabase, calls };
}

const ORG = "11111111-1111-4111-8111-111111111111";

describe("validateOrgScopedRefs", () => {
  it("returns null when no refs are provided (no queries)", async () => {
    const { supabase, calls } = makeSupabase({});
    expect(await validateOrgScopedRefs(supabase as any, ORG, {})).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when both refs belong to the org", async () => {
    const { supabase, calls } = makeSupabase({
      service_types: { data: { id: "st1" }, error: null },
      practitioners: { data: { id: "p1" }, error: null },
    });
    const res = await validateOrgScopedRefs(supabase as any, ORG, { serviceTypeId: "st1", practitionerId: "p1" });
    expect(res).toBeNull();
    // both tables queried, scoped to the org
    expect(calls).toEqual([
      { table: "service_types", id: "st1", orgId: ORG },
      { table: "practitioners", id: "p1", orgId: ORG },
    ]);
  });

  it("rejects a cross-org / missing service_type_id", async () => {
    const { supabase } = makeSupabase({ service_types: { data: null, error: null } });
    const res = await validateOrgScopedRefs(supabase as any, ORG, { serviceTypeId: "foreign" });
    expect(res).toMatch(/service_type_id/);
  });

  it("rejects a cross-org / missing practitioner_id", async () => {
    const { supabase } = makeSupabase({ practitioners: { data: null, error: null } });
    const res = await validateOrgScopedRefs(supabase as any, ORG, { practitionerId: "foreign" });
    expect(res).toMatch(/practitioner_id/);
  });

  it("skips null/undefined refs (clearing a field is allowed)", async () => {
    const { supabase, calls } = makeSupabase({});
    expect(await validateOrgScopedRefs(supabase as any, ORG, { serviceTypeId: null, practitionerId: undefined })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("throws (fail-closed) on a DB error so the caller surfaces a 500", async () => {
    const { supabase } = makeSupabase({ service_types: { data: null, error: { message: "conn reset" } } });
    await expect(validateOrgScopedRefs(supabase as any, ORG, { serviceTypeId: "st1" })).rejects.toThrow(/service_type_id/);
  });

  // ── SCRUM-444: requireActive option ──────────────────────────────────────

  it("requireActive adds the is_active filter to BOTH ref checks", async () => {
    const { supabase, calls } = makeSupabase({
      service_types: { data: { id: "st1" }, error: null },
      practitioners: { data: { id: "p1" }, error: null },
    });
    const res = await validateOrgScopedRefs(
      supabase as any,
      ORG,
      { serviceTypeId: "st1", practitionerId: "p1" },
      { requireActive: true },
    );
    expect(res).toBeNull();
    expect(calls).toEqual([
      { table: "service_types", id: "st1", orgId: ORG, activeOnly: true },
      { table: "practitioners", id: "p1", orgId: ORG, activeOnly: true },
    ]);
  });

  it("requireActive rejects an org-owned but deactivated practitioner with a message that says so", async () => {
    // The is_active filter excludes the (existing, org-owned) row → no row found.
    const { supabase } = makeSupabase({ practitioners: { data: null, error: null } });
    const res = await validateOrgScopedRefs(
      supabase as any,
      ORG,
      { practitionerId: "p-deactivated" },
      { requireActive: true },
    );
    expect(res).toMatch(/practitioner_id/);
    expect(res).toMatch(/inactive/);
  });

  it("per-ref requireActive filters ONLY the flagged ref (carried refs stay org-scope-only)", async () => {
    const { supabase, calls } = makeSupabase({
      service_types: { data: { id: "st1" }, error: null },
      practitioners: { data: { id: "p1" }, error: null },
    });
    const res = await validateOrgScopedRefs(
      supabase as any,
      ORG,
      { serviceTypeId: "st1", practitionerId: "p1" },
      { requireActive: { practitioner: true } }, // serviceType carried → org-scope-only
    );
    expect(res).toBeNull();
    expect(calls).toEqual([
      { table: "service_types", id: "st1", orgId: ORG },
      { table: "practitioners", id: "p1", orgId: ORG, activeOnly: true },
    ]);
  });

  it("per-ref requireActive: only the flagged ref's failure message mentions inactivity", async () => {
    const { supabase } = makeSupabase({ service_types: { data: null, error: null } });
    // serviceType NOT flagged (carried) → plain org-scope failure message.
    const res = await validateOrgScopedRefs(
      supabase as any,
      ORG,
      { serviceTypeId: "st-gone" },
      { requireActive: { practitioner: true } },
    );
    expect(res).toMatch(/service_type_id/);
    expect(res).not.toMatch(/inactive/);
  });

  it("default (no options) does NOT filter on is_active — rows carrying a since-deactivated ref stay valid", async () => {
    // Pins the dashboard semantic: a validator call WITHOUT requireActive must
    // not silently start excluding deactivated rows.
    const { supabase, calls } = makeSupabase({
      practitioners: { data: { id: "p1" }, error: null },
    });
    const res = await validateOrgScopedRefs(supabase as any, ORG, { practitionerId: "p1" });
    expect(res).toBeNull();
    expect(calls).toEqual([{ table: "practitioners", id: "p1", orgId: ORG }]);
    expect(calls[0].activeOnly).toBeUndefined();
  });
});
