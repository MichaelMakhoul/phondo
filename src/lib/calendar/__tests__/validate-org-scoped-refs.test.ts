import { describe, it, expect } from "vitest";
import { validateOrgScopedRefs } from "../validate-org-scoped-refs";

// SCRUM-360: refs must belong to the caller's org. Build a tiny supabase stub
// whose .from(table).select().eq().eq().maybeSingle() resolves to a per-table
// programmed result, and record which (table, id, orgId) tuples were queried.

function makeSupabase(results: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: Array<{ table: string; id?: string; orgId?: string }> = [];
  const supabase = {
    from(table: string) {
      const rec: { table: string; id?: string; orgId?: string } = { table };
      calls.push(rec);
      return {
        select: () => ({
          eq: (_c: string, idVal: string) => {
            rec.id = idVal;
            return {
              eq: (_c2: string, orgVal: string) => {
                rec.orgId = orgVal;
                return { maybeSingle: async () => results[table] ?? { data: null, error: null } };
              },
            };
          },
        }),
      };
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
});
