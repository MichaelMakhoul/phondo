import { describe, it, expect, vi, beforeEach } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

// SCRUM-515: the seed decides what a caller can book on day one. Scraped
// services must win over the generic industry table, and an org must never be
// left with zero service types (it could not book at all).

const state: {
  user: { id: string } | null;
  membership: { organization_id: string } | null;
  existingCount: number;
  countError: unknown;
  insertError: unknown;
  insertedRows: any[];
} = {
  user: { id: "user-1" },
  membership: { organization_id: "org-1" },
  existingCount: 0,
  countError: null,
  insertError: null,
  insertedRows: [],
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: state.user } })) },
    from: () => {
      const b: any = {};
      b.select = () => b;
      b.eq = () => b;
      b.single = async () => ({ data: state.membership, error: null });
      return b;
    },
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    // Thenable builder: the route awaits the chain, not each link.
    from: () => {
      const b: any = {};
      let mode: "count" | "insert" = "count";
      b.select = () => b;
      b.eq = () => b;
      b.insert = (rows: any[]) => {
        state.insertedRows = rows;
        mode = "insert";
        return b;
      };
      b.then = (onF: (v: any) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(
          mode === "insert"
            ? { error: state.insertError }
            : { count: state.existingCount, error: state.countError }
        ).then(onF, onR);
      return b;
    },
  })),
}));

import { POST } from "../route";

function req(body: Record<string, unknown>) {
  return new Request("http://localhost/api/v1/service-types/seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.user = { id: "user-1" };
  state.membership = { organization_id: "org-1" };
  state.existingCount = 0;
  state.countError = null;
  state.insertError = null;
  state.insertedRows = [];
});

describe("POST /api/v1/service-types/seed", () => {
  it("seeds the scraped services rather than the industry defaults", async () => {
    const res = await POST(
      req({
        organizationId: "org-1",
        industry: "other",
        scrapedServices: ["Logbook servicing", "New car sales"],
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ seeded: true, source: "scraped", count: 2 });
    expect(state.insertedRows.map((r) => r.name)).toEqual(["Logbook servicing", "New car sales"]);
    // The generic pair that confused a dealership's callers.
    expect(state.insertedRows.map((r) => r.name)).not.toContain("Consultation");
  });

  it("falls back to industry defaults when the scrape found nothing usable", async () => {
    const res = await POST(req({ organizationId: "org-1", industry: "dental", scrapedServices: ["", "•"] }));
    const body = await res.json();

    expect(body).toMatchObject({ seeded: true, source: "industry-defaults" });
    expect(state.insertedRows.length).toBeGreaterThan(0);
    expect(state.insertedRows[0].organization_id).toBe("org-1");
  });

  it("falls back when no scrapedServices key is sent at all (older client)", async () => {
    const res = await POST(req({ organizationId: "org-1", industry: "dental" }));
    const body = await res.json();
    expect(body.source).toBe("industry-defaults");
    expect(state.insertedRows.length).toBeGreaterThan(0);
  });

  it("stays idempotent — never re-seeds an org that already has service types", async () => {
    state.existingCount = 2;
    const res = await POST(req({ organizationId: "org-1", scrapedServices: ["Anything"] }));
    const body = await res.json();

    expect(body.seeded).toBe(false);
    expect(state.insertedRows).toEqual([]);
  });

  it("assigns sort_order so the list reads in the order the site listed it", async () => {
    await POST(req({ organizationId: "org-1", scrapedServices: ["First", "Second", "Third"] }));
    expect(state.insertedRows.map((r) => r.sort_order)).toEqual([0, 1, 2]);
  });

  it("401s an unauthenticated caller", async () => {
    state.user = null;
    const res = await POST(req({ organizationId: "org-1" }));
    expect(res.status).toBe(401);
    expect(state.insertedRows).toEqual([]);
  });

  it("403s a caller who is not a member of the org", async () => {
    state.membership = null;
    const res = await POST(req({ organizationId: "someone-elses-org" }));
    expect(res.status).toBe(403);
    expect(state.insertedRows).toEqual([]);
  });

  it("500s without inserting when the existing-rows count fails", async () => {
    // Seeding blind here could double-seed an org that already has types.
    state.countError = { message: "db down" };
    const res = await POST(req({ organizationId: "org-1" }));
    expect(res.status).toBe(500);
    expect(state.insertedRows).toEqual([]);
  });

  it("500s when the insert fails, rather than reporting success", async () => {
    state.insertError = { message: "insert failed" };
    const res = await POST(req({ organizationId: "org-1", scrapedServices: ["Servicing"] }));
    expect(res.status).toBe(500);
    expect((await res.json()).seeded).toBeUndefined();
  });
});
