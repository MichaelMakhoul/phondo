import { describe, it, expect, vi } from "vitest";
import { createOrResumeOrganization, generateSlug } from "@/lib/onboarding/create-org";

// SCRUM-426 (audit findings #24 & #25): onboarding org creation must be
// idempotent across retries (resume into the already-owned org instead of
// dead-ending on the owned-org cap) and resilient to slug collisions
// (retry with a random suffix instead of hard-failing).

type RpcResult = { data: Array<{ id: string }> | null; error: { code?: string; message?: string } | null };

function fakeSupabase(rpcResults: RpcResult[], ownedOrg?: { data: unknown; error: unknown }) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let rpcIdx = 0;
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResults[Math.min(rpcIdx++, rpcResults.length - 1)];
    }),
    from: vi.fn(() => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      Object.assign(b, {
        select: chain,
        eq: chain,
        maybeSingle: async () => ownedOrg ?? { data: null, error: null },
      });
      return b;
    }),
  };
  return { client, rpcCalls };
}

describe("generateSlug", () => {
  it("kebab-cases and strips punctuation", () => {
    expect(generateSlug("Bondi Dental & Co.")).toBe("bondi-dental-co");
    expect(generateSlug("  A  B  ")).toBe("a-b");
  });
});

describe("createOrResumeOrganization (SCRUM-426)", () => {
  it("creates the org on the happy path with the base slug", async () => {
    const { client, rpcCalls } = fakeSupabase([{ data: [{ id: "org-new" }], error: null }]);

    const res = await createOrResumeOrganization(client, "user-1", "Bondi Dental");
    expect(res).toEqual({ ok: true, orgId: "org-new", resumed: false });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.org_slug).toBe("bondi-dental");
  });

  it("retries a slug collision with a random suffix (finding #25)", async () => {
    const { client, rpcCalls } = fakeSupabase([
      { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "organizations_slug_key"' } },
      { data: [{ id: "org-new" }], error: null },
    ]);

    const res = await createOrResumeOrganization(client, "user-1", "Bondi Dental");
    expect(res).toEqual({ ok: true, orgId: "org-new", resumed: false });
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].args.org_slug).toBe("bondi-dental");
    expect(rpcCalls[1].args.org_slug).toMatch(/^bondi-dental-[a-z0-9]{1,4}$/);
  });

  it("gives up after repeated collisions with a clear error", async () => {
    const collision: RpcResult = {
      data: null,
      error: { code: "23505", message: 'duplicate key value violates unique constraint "organizations_slug_key"' },
    };
    const { client, rpcCalls } = fakeSupabase([collision, collision, collision, collision]);

    await expect(createOrResumeOrganization(client, "user-1", "Bondi Dental")).rejects.toThrow(/organizations_slug_key/);
    expect(rpcCalls).toHaveLength(4); // base + 3 suffixed attempts
  });

  it("routes a raw 23505 on the one-owner index into RESUME, not slug retries", async () => {
    // Two concurrent first attempts can race past the RPC's friendly EXISTS
    // check; the loser hits the 00148 partial index with a raw 23505.
    const { client, rpcCalls } = fakeSupabase(
      [{ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "org_members_one_owner_per_user"' } }],
      { data: { organization_id: "org-existing" }, error: null },
    );

    const res = await createOrResumeOrganization(client, "user-1", "Bondi Dental");
    expect(res).toEqual({ ok: true, orgId: "org-existing", resumed: true });
    expect(rpcCalls).toHaveLength(1); // no pointless slug retries
  });

  it("throws (no retry) on a 23505 naming an unknown constraint", async () => {
    const { client, rpcCalls } = fakeSupabase([
      { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "something_else"' } },
    ]);

    await expect(createOrResumeOrganization(client, "user-1", "Bondi Dental")).rejects.toThrow(/something_else/);
    expect(rpcCalls).toHaveLength(1);
  });

  it("RESUMES into the already-owned org when the per-user cap fires (finding #24)", async () => {
    const { client } = fakeSupabase(
      [{ data: null, error: { message: "User already owns an organization" } }],
      { data: { organization_id: "org-existing" }, error: null },
    );

    const res = await createOrResumeOrganization(client, "user-1", "Bondi Dental");
    expect(res).toEqual({ ok: true, orgId: "org-existing", resumed: true });
  });

  it("falls back (ok: false) when the cap fires but the owned org can't be found", async () => {
    const { client } = fakeSupabase(
      [{ data: null, error: { message: "User already owns an organization" } }],
      { data: null, error: { message: "db down" } },
    );

    const res = await createOrResumeOrganization(client, "user-1", "Bondi Dental");
    expect(res).toEqual({ ok: false, reason: "owned-org-lookup-failed" });
  });

  it("throws on a non-collision, non-cap error", async () => {
    const { client, rpcCalls } = fakeSupabase([
      { data: null, error: { message: "permission denied for function" } },
    ]);

    await expect(createOrResumeOrganization(client, "user-1", "Bondi Dental")).rejects.toThrow(/permission denied/);
    expect(rpcCalls).toHaveLength(1); // no retry on unrelated errors
  });

  it("uses a fallback slug for a name that strips to nothing", async () => {
    const { client, rpcCalls } = fakeSupabase([{ data: [{ id: "org-new" }], error: null }]);

    await createOrResumeOrganization(client, "user-1", "***");
    expect(rpcCalls[0].args.org_slug).toBe("business");
  });
});
