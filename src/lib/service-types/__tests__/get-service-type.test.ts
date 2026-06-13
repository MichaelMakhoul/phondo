import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-444 review: getServiceType must NOT conflate not-found with a DB error.
// null is reserved for a true not-found (PGRST116 — unknown/cross-org id) so
// callers can safely say "that appointment type doesn't exist here"; a real DB
// error THROWS so a transient blip surfaces as "having trouble" instead.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getServiceType } from "..";

function fakeAdmin(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain,
    eq: chain,
    single: async () => result,
  });
  return { from: () => b };
}

const ST = { id: "st-1", name: "Checkup", duration_minutes: 30, description: null };

describe("getServiceType (SCRUM-444: not-found vs DB error)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the row when found", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin({ data: ST, error: null }) as never);
    expect(await getServiceType("st-1", "org-1")).toEqual(ST);
  });

  it("returns null on PGRST116 (no rows — unknown or cross-org id)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ data: null, error: { message: "no rows", code: "PGRST116" } }) as never,
    );
    expect(await getServiceType("st-unknown", "org-1")).toBeNull();
  });

  it("THROWS on a real DB error instead of masquerading as not-found", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ data: null, error: { message: "conn reset", code: "08006" } }) as never,
    );
    await expect(getServiceType("st-1", "org-1")).rejects.toThrow(/conn reset/);
  });
});
