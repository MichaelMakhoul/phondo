import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUserRoleInOrg, isOrgAdmin } from "../org-membership";
import * as Sentry from "@sentry/nextjs";

// Sentry is mocked so DB-error tests can assert capture without sending events
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: any) => void) => fn({
    setTag: vi.fn(),
    setLevel: vi.fn(),
    setExtras: vi.fn(),
  })),
  captureException: vi.fn(),
}));

/**
 * Tiny stub supabase client. Records the chain of `.from().select().eq().eq().single()`
 * calls and returns a per-test result.
 */
function makeStubSupabase(result: { data: unknown; error: unknown }) {
  const calls: Array<{ op: string; arg: unknown }> = [];
  const chain = {
    select: (s: string) => {
      calls.push({ op: "select", arg: s });
      return chain;
    },
    eq: (col: string, val: unknown) => {
      calls.push({ op: "eq", arg: { col, val } });
      return chain;
    },
    single: () => Promise.resolve(result),
  };
  return {
    client: {
      from: (table: string) => {
        calls.push({ op: "from", arg: table });
        return chain;
      },
    },
    calls,
  };
}

describe("getUserRoleInOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns role row when user is a member of the target org", async () => {
    const { client } = makeStubSupabase({ data: { role: "admin" }, error: null });
    const result = await getUserRoleInOrg(client, "user-1", "org-1");
    expect(result).toEqual({ role: "admin" });
  });

  it("queries org_members scoped by BOTH user_id AND organization_id", async () => {
    // This is the SCRUM-276 fix — without the organization_id filter,
    // .single() would throw for multi-org users. Lock the call shape in.
    const { client, calls } = makeStubSupabase({ data: { role: "viewer" }, error: null });
    await getUserRoleInOrg(client, "user-1", "org-1");
    expect(calls.find((c) => c.op === "from")?.arg).toBe("org_members");
    const eqCalls = calls.filter((c) => c.op === "eq").map((c) => c.arg);
    expect(eqCalls).toContainEqual({ col: "user_id", val: "user-1" });
    expect(eqCalls).toContainEqual({ col: "organization_id", val: "org-1" });
  });

  it("returns null when the user is NOT a member of the org (PGRST116 no-rows) — silent, no Sentry", async () => {
    const { client } = makeStubSupabase({
      data: null,
      error: { code: "PGRST116", message: "no rows" },
    });
    const result = await getUserRoleInOrg(client, "user-1", "other-org");
    expect(result).toBeNull();
    // No-rows is the legitimate "not a member" case — don't page on-call.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("returns null on real DB error AND Sentry-pages so on-call can debug brownouts", async () => {
    const dbError = { code: "57P01", message: "admin shutdown" };
    const { client } = makeStubSupabase({ data: null, error: dbError });
    const result = await getUserRoleInOrg(client, "user-1", "org-1");
    // Fails closed at the caller (still null) ...
    expect(result).toBeNull();
    // ... but is NOT silent — Sentry-paged with the right context.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  it("does NOT Sentry-page when error.code is PGRST116", async () => {
    const { client } = makeStubSupabase({
      data: null,
      error: { code: "PGRST116", message: "no rows" },
    });
    await getUserRoleInOrg(client, "user-1", "org-1");
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.withScope).not.toHaveBeenCalled();
  });

  it("handles multi-org users — the org_id filter narrows to exactly one row", async () => {
    // The whole point: even if the user belongs to 5 orgs, this query is
    // scoped to ONE specific org via the second .eq(). Stub returns 1 row.
    const { client, calls } = makeStubSupabase({ data: { role: "owner" }, error: null });
    const result = await getUserRoleInOrg(client, "multi-org-user", "org-3");
    expect(result).toEqual({ role: "owner" });
    // Two .eq() calls — user AND org — never just user.
    const eqCalls = calls.filter((c) => c.op === "eq");
    expect(eqCalls).toHaveLength(2);
  });

  it("preserves null role (membership exists but role is null — shouldn't happen but safe)", async () => {
    const { client } = makeStubSupabase({ data: { role: null }, error: null });
    const result = await getUserRoleInOrg(client, "user-1", "org-1");
    expect(result).toEqual({ role: null });
  });
});

describe("isOrgAdmin", () => {
  it("returns true for 'owner'", () => {
    expect(isOrgAdmin("owner")).toBe(true);
  });

  it("returns true for 'admin'", () => {
    expect(isOrgAdmin("admin")).toBe(true);
  });

  it("returns false for non-admin roles", () => {
    expect(isOrgAdmin("member")).toBe(false);
    expect(isOrgAdmin("viewer")).toBe(false);
    expect(isOrgAdmin("billing")).toBe(false);
  });

  it("returns false for null/undefined (defensive default — write-gates close)", () => {
    expect(isOrgAdmin(null)).toBe(false);
    expect(isOrgAdmin(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isOrgAdmin("")).toBe(false);
  });

  it("is case-sensitive (DB enum is lowercase — don't allow drift)", () => {
    expect(isOrgAdmin("OWNER")).toBe(false);
    expect(isOrgAdmin("Owner")).toBe(false);
    expect(isOrgAdmin("Admin")).toBe(false);
  });
});
