import { describe, it, expect, vi, beforeEach } from "vitest";
import { isPlatformAdmin } from "../admin-auth";
import type { ServiceRoleSupabaseClient } from "@/lib/supabase/admin";

const pageSentryMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/page-sentry", () => ({
  pageSentry: pageSentryMock,
}));

/** Build a chainable supabase-like client whose terminal `.single()`
 *  resolves to the given `{ data, error }`. */
function makeClient(result: { data: unknown; error: unknown }): ServiceRoleSupabaseClient {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    single: async () => result,
  };
  return { from: () => chain } as unknown as ServiceRoleSupabaseClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isPlatformAdmin (SCRUM-308)", () => {
  it("returns true for a user whose profile has is_platform_admin = true", async () => {
    const res = await isPlatformAdmin("user-1", makeClient({ data: { is_platform_admin: true }, error: null }));
    expect(res).toBe(true);
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("returns false when is_platform_admin = false", async () => {
    const res = await isPlatformAdmin("user-1", makeClient({ data: { is_platform_admin: false }, error: null }));
    expect(res).toBe(false);
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("PGRST116 (no profile row): returns false and pages at WARNING (admin-profile-row-missing) for the volume alert (SCRUM-316)", async () => {
    const res = await isPlatformAdmin(
      "user-1",
      makeClient({ data: null, error: { code: "PGRST116", message: "no rows" } }),
    );
    expect(res).toBe(false);
    // SCRUM-316: routed through Loki at WARNING so a volume rule can catch a
    // signup regression. Warning (not error) → no individual page.
    expect(pageSentryMock).toHaveBeenCalledTimes(1);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "next-api",
        reason: "admin-profile-row-missing",
        level: "warning",
        extras: expect.objectContaining({ userId: "user-1" }),
      }),
    );
  });

  it("real DB error (not PGRST116): returns false AND pages Sentry (ADMIN_AUTH_LOOKUP_FAILED)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await isPlatformAdmin(
      "user-1",
      makeClient({ data: null, error: { code: "57014", message: "statement timeout" } }),
    );
    expect(res).toBe(false);
    expect(pageSentryMock).toHaveBeenCalledTimes(1);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "next-api",
        reason: "admin-auth-lookup-failed",
        extras: expect.objectContaining({ userId: "user-1", code: "57014" }),
      }),
    );
    errorSpy.mockRestore();
  });
});
