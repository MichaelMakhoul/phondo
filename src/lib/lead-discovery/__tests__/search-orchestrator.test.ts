import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceRoleSupabaseClient } from "@/lib/supabase/admin";

const pageSentryMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/page-sentry", () => ({
  pageSentry: pageSentryMock,
}));

// scanWebsiteForCRM is irrelevant to UPDATE-failure counting — stub it
// to a benign result so the focus stays on the update path.
vi.mock("../crm-detector", () => ({
  scanWebsiteForCRM: vi.fn(async () => ({ software: "Cliniko", confidence: "high", signals: ["x"] })),
}));

// SCRUM-318: control the Places layer so executeSearch's cache/partial
// logic can be exercised without real fetches.
const searchMultiMock = vi.hoisted(() => vi.fn());
vi.mock("../google-places", () => ({
  searchMultipleProfessions: searchMultiMock,
}));

import { scanBusinessCRMs, executeSearch } from "../search-orchestrator";

/**
 * Thenable supabase mock for scanBusinessCRMs. The function issues three
 * shapes of query against `discovered_businesses`:
 *   - load:   .select().in("id").is("detected_crm", null)   → { data, error }
 *   - update: .update({...}).eq("id")                        → { error }
 *   - reload: .select().in("id")                             → { data, error }
 * The chain records calls and resolves based on whether `update` was seen
 * (update vs select) and whether `is` was seen (load vs reload).
 */
function makeClient(opts: {
  load: { data: unknown; error: unknown };
  reload: { data: unknown; error: unknown };
  /** Returns an error object for the UPDATE targeting this biz id, or null.
   *  Keyed by id (not call order) so multi-batch tests are deterministic
   *  despite the concurrent Promise.all updates. */
  updateErrorById?: (id: string) => unknown;
  /** If it returns true for this biz id, the UPDATE thenable REJECTS
   *  (transport fault) rather than resolving `{ error }`. */
  updateRejectById?: (id: string) => boolean;
}): ServiceRoleSupabaseClient {
  function makeChain() {
    let isUpdate = false;
    let sawIs = false;
    let eqId: string | undefined;
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: () => {
        isUpdate = true;
        return chain;
      },
      in: () => chain,
      is: () => {
        sawIs = true;
        return chain;
      },
      eq: (_col: string, val: string) => {
        eqId = val;
        return chain;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (isUpdate) {
          if (opts.updateRejectById && eqId !== undefined && opts.updateRejectById(eqId)) {
            return Promise.reject(new Error(`transport fault updating ${eqId}`)).then(resolve, reject);
          }
          const err = opts.updateErrorById && eqId !== undefined ? opts.updateErrorById(eqId) : null;
          return Promise.resolve({ error: err }).then(resolve, reject);
        }
        return Promise.resolve(sawIs ? opts.load : opts.reload).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from: () => makeChain() } as unknown as ServiceRoleSupabaseClient;
}

const biz = (id: string, website: string | null = "https://x.test") => ({
  id,
  website,
  detected_crm: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scanBusinessCRMs — UPDATE failure counting (SCRUM-315)", () => {
  it("all updates succeed → does NOT page Sentry, returns reloaded rows", async () => {
    const client = makeClient({
      load: { data: [biz("a"), biz("b")], error: null },
      reload: { data: [{ id: "a" }, { id: "b" }], error: null },
      updateErrorById: () => null,
    });
    const out = await scanBusinessCRMs(["a", "b"], client);
    expect(out).toEqual([{ id: "a" }, { id: "b" }]);
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("some updates fail → pages ONCE with the count, still returns reloaded rows (non-fatal)", async () => {
    const client = makeClient({
      load: { data: [biz("a"), biz("b"), biz("c")], error: null },
      reload: { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null },
      updateErrorById: (id) => (id === "a" || id === "b" ? { message: "constraint violation" } : null),
    });
    const out = await scanBusinessCRMs(["a", "b", "c"], client);
    // Non-fatal: still returns the reloaded rows.
    expect(out).toHaveLength(3);
    // Exactly ONE aggregate page, carrying the count.
    expect(pageSentryMock).toHaveBeenCalledTimes(1);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "lead-discovery-scan-update-partial",
        level: "warning",
        tags: { failureKind: "db-query" },
        extras: { updateFailures: 2, scanned: 3 },
      }),
    );
  });

  it("sums failures ACROSS batches and still pages exactly ONCE (SCAN_CONCURRENCY=3)", async () => {
    // 5 rows = 2 batches ([a,b,c],[d,e]). Fail one in EACH batch (a, e).
    // A regression that paged per-batch would call pageSentry twice;
    // the correct behaviour sums across batches and pages once with 2.
    const ids = ["a", "b", "c", "d", "e"];
    const client = makeClient({
      load: { data: ids.map((id) => biz(id)), error: null },
      reload: { data: ids.map((id) => ({ id })), error: null },
      updateErrorById: (id) => (id === "a" || id === "e" ? { message: "constraint violation" } : null),
    });
    const out = await scanBusinessCRMs(ids, client);
    expect(out).toHaveLength(5);
    expect(pageSentryMock).toHaveBeenCalledTimes(1);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({ extras: { updateFailures: 2, scanned: 5 } }),
    );
  });

  it("no-website rows also count toward update failures", async () => {
    const client = makeClient({
      load: { data: [biz("a", null)], error: null }, // no website → no_website update
      reload: { data: [{ id: "a" }], error: null },
      updateErrorById: () => ({ message: "rls denied" }),
    });
    await scanBusinessCRMs(["a"], client);
    expect(pageSentryMock).toHaveBeenCalledTimes(1);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({ extras: { updateFailures: 1, scanned: 1 } }),
    );
  });

  it("an UPDATE that REJECTS (transport fault) propagates as a throw — does NOT page the partial reason", async () => {
    // A rejected promise (network/transport, not a Postgres {error}) is a
    // HARD failure: it propagates out of scanBusinessCRMs to the route's
    // catch-all (→ LEAD_DISCOVERY_SCAN_FAILED 500), NOT the partial page.
    const client = makeClient({
      load: { data: [biz("a")], error: null },
      reload: { data: [{ id: "a" }], error: null },
      updateRejectById: (id) => id === "a",
    });
    await expect(scanBusinessCRMs(["a"], client)).rejects.toThrow();
    expect(pageSentryMock).not.toHaveBeenCalled();
  });
});

/**
 * executeSearch supabase mock. The function issues, in order:
 *   - cache check:    from("lead_search_cache").select().eq().gt().single()
 *   - business upsert: from("discovered_businesses").upsert()
 *   - cache write:     from("lead_search_cache").upsert()      [complete only]
 *   - reload:          from("discovered_businesses").select().in()
 * `single()` returns the cache row (only lead_search_cache calls it); the
 * chain is thenable for the reload; `upsert()` records which table it hit.
 */
function makeExecClient(opts: { cacheRow?: unknown; reloadRows?: unknown[]; bizUpsertError?: unknown }) {
  const calls = { cacheUpsert: 0, bizUpsert: 0, tables: [] as string[] };
  const reloadRows = opts.reloadRows ?? [];
  const cacheRow = opts.cacheRow ?? null;

  function chainFor(table: string) {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      gt: () => chain,
      in: () => chain,
      single: async () => ({
        data: table === "lead_search_cache" ? cacheRow : null,
        error: null,
      }),
      upsert: async () => {
        if (table === "lead_search_cache") {
          calls.cacheUpsert += 1;
          return { error: null };
        }
        calls.bizUpsert += 1;
        return { error: opts.bizUpsertError ?? null };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: reloadRows, error: null }).then(resolve, reject),
    };
    return chain;
  }

  const client = {
    from: (table: string) => {
      calls.tables.push(table);
      return chainFor(table);
    },
  } as unknown as ServiceRoleSupabaseClient;

  return { client, calls };
}

const place = (placeId: string) => ({
  placeId,
  name: "B",
  address: null,
  phone: null,
  website: null,
  rating: null,
  reviewCount: null,
  types: [],
});

describe("executeSearch — partial result handling (SCRUM-318)", () => {
  const params = { location: "Bondi NSW", professions: ["dentist", "lawyer"], limit: 25 };

  it("PARTIAL: skips the durable cache write, persists what it found, and pages a warning", async () => {
    searchMultiMock.mockResolvedValueOnce({ places: [place("p1")], partial: true, failedStatus: 429, failedReason: "http-429" });
    const { client, calls } = makeExecClient({ reloadRows: [{ id: "1", name: "B" }] });

    const out = await executeSearch(params, client);

    expect(out.partial).toBe(true);
    expect(out.cached).toBe(false);
    expect(out.businesses).toEqual([{ id: "1", name: "B" }]);
    // The truncated set must NOT be frozen behind the 7-day cache...
    expect(calls.cacheUpsert).toBe(0);
    // ...but the businesses we DID find are still persisted.
    expect(calls.bizUpsert).toBe(1);
    // On-call gets a warning page carrying the Places HTTP status.
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "lead-discovery-search-partial",
        level: "warning",
        tags: { failureKind: "google-places" },
        extras: expect.objectContaining({ placesStatus: 429, gotResults: 1, failedReason: "http-429" }),
      }),
    );
  });

  it("COMPLETE: writes the durable cache and does NOT page", async () => {
    searchMultiMock.mockResolvedValueOnce({ places: [place("p1")], partial: false });
    const { client, calls } = makeExecClient({ reloadRows: [{ id: "1", name: "B" }] });

    const out = await executeSearch(params, client);

    expect(out.partial).toBe(false);
    expect(out.cached).toBe(false);
    expect(calls.cacheUpsert).toBe(1);
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("CACHE HIT: short-circuits Google entirely and is never partial", async () => {
    const { client } = makeExecClient({
      cacheRow: { id: "c1", google_response: [{ placeId: "p1" }] },
      reloadRows: [{ id: "1", name: "B" }],
    });

    const out = await executeSearch(params, client);

    expect(out.cached).toBe(true);
    expect(out.partial).toBe(false);
    expect(out.businesses).toEqual([{ id: "1", name: "B" }]);
    expect(searchMultiMock).not.toHaveBeenCalled();
  });

  it("pages a warning when the discovered_businesses upsert fails, still returns reloaded rows (SCRUM-321)", async () => {
    searchMultiMock.mockResolvedValueOnce({ places: [place("p1")], partial: false });
    const { client, calls } = makeExecClient({
      reloadRows: [{ id: "1", name: "B" }],
      bizUpsertError: { message: "constraint violation" },
    });

    const out = await executeSearch(params, client);

    // Non-fatal: the reload still returns whatever IS persisted.
    expect(out.businesses).toEqual([{ id: "1", name: "B" }]);
    expect(calls.bizUpsert).toBe(1);
    // ...but the silent write failure is now paged at warning.
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "lead-discovery-upsert-failed",
        level: "warning",
        tags: { failureKind: "db-query" },
      }),
    );
    // A complete (non-partial) result still writes the durable cache.
    expect(calls.cacheUpsert).toBe(1);
  });
});
