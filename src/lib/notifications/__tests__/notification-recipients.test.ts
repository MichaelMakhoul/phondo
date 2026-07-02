import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-497: call notifications must reach the org owner AND admin members —
// previously only role='owner' was ever looked up, so admins got nothing.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: unknown) => void) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setExtras: vi.fn() })
  ),
  captureMessage: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import * as Sentry from "@sentry/nextjs";
import { getOrganizationNotificationEmails } from "@/lib/notifications/notification-service";

type QueryResult = { data: unknown; error: { message?: string; code?: string } | null };

// Thenable query builder — multi-row lookups await the chain directly.
function builder(result: QueryResult) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain, eq: chain, in: chain, limit: chain, order: chain,
    single: async () => result,
    then: (resolve: (v: QueryResult) => unknown) => resolve(result),
  });
  return b;
}

function fakeAdmin(tables: Record<string, QueryResult>) {
  return {
    from: (table: string) => builder(tables[table] ?? { data: null, error: null }),
  };
}

describe("getOrganizationNotificationEmails (SCRUM-497)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns owner + admin emails, owner first", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: {
          data: [
            { user_id: "u-admin", role: "admin" },
            { user_id: "u-owner", role: "owner" },
          ],
          error: null,
        },
        user_profiles: {
          data: [
            { id: "u-admin", email: "admin@biz.com" },
            { id: "u-owner", email: "owner@biz.com" },
          ],
          error: null,
        },
      }) as never,
    );

    await expect(getOrganizationNotificationEmails("org-1")).resolves.toEqual([
      "owner@biz.com",
      "admin@biz.com",
    ]);
  });

  it("dedupes case-insensitively when owner and admin share an email", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: {
          data: [
            { user_id: "u-owner", role: "owner" },
            { user_id: "u-admin", role: "admin" },
          ],
          error: null,
        },
        user_profiles: {
          data: [
            { id: "u-owner", email: "Boss@Biz.com" },
            { id: "u-admin", email: "boss@biz.com" },
          ],
          error: null,
        },
      }) as never,
    );

    await expect(getOrganizationNotificationEmails("org-1")).resolves.toEqual(["Boss@Biz.com"]);
  });

  it("skips members without an email instead of failing the whole lookup", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: {
          data: [
            { user_id: "u-owner", role: "owner" },
            { user_id: "u-admin", role: "admin" },
          ],
          error: null,
        },
        user_profiles: {
          data: [
            { id: "u-owner", email: "owner@biz.com" },
            { id: "u-admin", email: "" }, // admin invited but profile incomplete
          ],
          error: null,
        },
      }) as never,
    );

    await expect(getOrganizationNotificationEmails("org-1")).resolves.toEqual(["owner@biz.com"]);
  });

  it("reports the OWNER's missing email even when an admin still resolves (review P1)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: {
          data: [
            { user_id: "u-owner", role: "owner" },
            { user_id: "u-admin", role: "admin" },
          ],
          error: null,
        },
        user_profiles: {
          // Owner's profile row missing entirely — the buyer would silently
          // stop receiving every notification class.
          data: [{ id: "u-admin", email: "admin@biz.com" }],
          error: null,
        },
      }) as never,
    );

    await expect(getOrganizationNotificationEmails("org-1")).resolves.toEqual(["admin@biz.com"]);
    expect(Sentry.captureMessage).toHaveBeenCalled(); // owner drop-off stays loud
  });

  it("still notifies admins when the org has no owner member (and reports the data problem)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: {
          data: [{ user_id: "u-admin", role: "admin" }],
          error: null,
        },
        user_profiles: {
          data: [{ id: "u-admin", email: "admin@biz.com" }],
          error: null,
        },
      }) as never,
    );

    await expect(getOrganizationNotificationEmails("org-1")).resolves.toEqual(["admin@biz.com"]);
    expect(Sentry.captureMessage).toHaveBeenCalled(); // ownerless org is surfaced
  });

  it("returns [] and reports when the members query errors", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: { data: null, error: { message: "db down" } },
      }) as never,
    );

    await expect(getOrganizationNotificationEmails("org-1")).resolves.toEqual([]);
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });

  it("returns [] when the org has no members at all", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: { data: [], error: null },
      }) as never,
    );

    await expect(getOrganizationNotificationEmails("org-1")).resolves.toEqual([]);
  });

  it("returns [] and reports when the profiles query errors", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        org_members: { data: [{ user_id: "u-owner", role: "owner" }], error: null },
        user_profiles: { data: null, error: { message: "db down" } },
      }) as never,
    );

    await expect(getOrganizationNotificationEmails("org-1")).resolves.toEqual([]);
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });
});
