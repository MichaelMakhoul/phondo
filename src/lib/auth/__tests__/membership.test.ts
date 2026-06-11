import { describe, it, expect } from "vitest";
import { getPrimaryMembership, isOrgAdminRole } from "@/lib/auth/membership";

// SCRUM-428 (audit finding #38): routes used .single() on org_members, which
// ERRORS when the user belongs to more than one org — turning multi-org
// membership into a misleading "No organization found" 404 everywhere.

function fakeClient(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain,
    eq: chain,
    order: chain,
    limit: chain,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR),
  });
  return { from: () => b };
}

describe("getPrimaryMembership (SCRUM-428)", () => {
  it("returns the first membership row", async () => {
    const client = fakeClient({
      data: [{ organization_id: "org-1", role: "owner" }],
      error: null,
    });
    expect(await getPrimaryMembership(client, "user-1")).toEqual({
      organization_id: "org-1",
      role: "owner",
    });
  });

  it("returns null (not an error) when the user has no memberships", async () => {
    const client = fakeClient({ data: [], error: null });
    expect(await getPrimaryMembership(client, "user-1")).toBeNull();
  });

  it("returns null on a DB error", async () => {
    const client = fakeClient({ data: null, error: { message: "db down" } });
    expect(await getPrimaryMembership(client, "user-1")).toBeNull();
  });
});

describe("isOrgAdminRole", () => {
  it("admits owner and admin only", () => {
    expect(isOrgAdminRole("owner")).toBe(true);
    expect(isOrgAdminRole("admin")).toBe(true);
    expect(isOrgAdminRole("member")).toBe(false);
    expect(isOrgAdminRole(undefined)).toBe(false);
    expect(isOrgAdminRole(null)).toBe(false);
  });
});
