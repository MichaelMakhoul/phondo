/**
 * Search orchestrator — ties together Google Places, DB caching, and CRM detection.
 *
 * Flow:
 *   1. Hash query params → check lead_search_cache
 *   2. Cache miss → call Google Places, upsert into discovered_businesses, save cache
 *   3. scanBusinessCRMs() → fetch each website, detect CRM, update DB
 */

import crypto from "crypto";
import {
  createAdminClient,
  type ServiceRoleSupabaseClient,
} from "@/lib/supabase/admin";
import {
  searchMultipleProfessions,
  type DiscoveredPlace,
  type PlacesSearchResult,
} from "./google-places";
import { scanWebsiteForCRM } from "./crm-detector";
import { PlacesApiError, LeadDiscoveryDbError } from "./errors";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { pageSentry } from "@/lib/observability/page-sentry";
import type { DiscoveredBusiness } from "./types";

export type { DiscoveredBusiness };

// ── Types ────────────────────────────────────────────────────────────

export interface SearchParams {
  location: string;
  professions: string[];
  limit: number;
}

// ── Cache key ────────────────────────────────────────────────────────

function computeCacheKey(params: SearchParams): string {
  const normalized = JSON.stringify({
    location: params.location.toLowerCase().trim(),
    professions: [...params.professions].sort(),
    limit: params.limit,
  });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// ── Execute search (cache-first) ─────────────────────────────────────

export async function executeSearch(
  params: SearchParams,
  adminClient?: ServiceRoleSupabaseClient,
): Promise<{ businesses: DiscoveredBusiness[]; cached: boolean; partial: boolean }> {
  // SCRUM-301: callers can thread their pre-constructed admin client
  // through to avoid spinning up another SupabaseClient + GoTrueClient
  // + RealtimeClient. Falls back to creating a fresh one to keep
  // existing single-call sites working.
  const supabase = adminClient ?? createAdminClient();
  const cacheKey = computeCacheKey(params);

  // 1. Check cache
  const { data: cached } = await (supabase as any)
    .from("lead_search_cache")
    .select("id, google_response")
    .eq("query_hash", cacheKey)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (cached) {
    // Load associated businesses from DB
    const placeIds = (cached.google_response as DiscoveredPlace[]).map(
      (p) => p.placeId
    );
    if (placeIds.length === 0) {
      return { businesses: [], cached: true, partial: false };
    }
    // SCRUM-309: capture the read error. A cache HIT means this query
    // had results before — silently returning [] on a DB error would
    // be actively misleading (looks like the cached query now finds
    // nothing). Throw so it 500s + pages with failureKind=db-query.
    const { data: businesses, error: cacheHitReadError } = await (supabase as any)
      .from("discovered_businesses")
      .select("*")
      .in("google_place_id", placeIds);
    if (cacheHitReadError) {
      throw new LeadDiscoveryDbError(
        `Failed to load cached businesses: ${cacheHitReadError.message}`,
        { cause: cacheHitReadError },
      );
    }
    // A cache HIT is a COMPLETE prior result by construction — SCRUM-318
    // never writes a cache entry for a partial search — so partial is false.
    return { businesses: businesses ?? [], cached: true, partial: false };
  }

  // 2. Cache miss — search Google Places
  // SCRUM-309 + SCRUM-314: tag Google Places throws so the route catch
  // sets failureKind=google-places. searchPlaces now throws a typed
  // PlacesApiError (carrying the HTTP status) on a non-2xx — quota (429),
  // outage (5xx), and key/project (403) failures all reach here typed,
  // so we pass them through unchanged. A raw network/parse throw gets
  // wrapped so it still classifies as google-places.
  let searchResult: PlacesSearchResult;
  try {
    searchResult = await searchMultipleProfessions(
      params.location,
      params.professions,
      params.limit
    );
  } catch (err) {
    if (err instanceof PlacesApiError) throw err;
    throw new PlacesApiError(
      err instanceof Error ? err.message : "Google Places search failed",
      { cause: err },
    );
  }

  // SCRUM-318: `partial` is true when a profession (or a later page within
  // one) quota/outage-failed AFTER earlier results were collected. We still
  // persist the businesses we DID find, but must NOT durably cache a
  // truncated set (see the cache step below).
  const { places, partial } = searchResult;

  if (places.length === 0) {
    return { businesses: [], cached: false, partial: false };
  }

  // 3. Upsert into discovered_businesses
  const rows = places.map((p) => ({
    google_place_id: p.placeId,
    name: p.name,
    address: p.address,
    phone: p.phone,
    website: p.website,
    google_rating: p.rating,
    google_review_count: p.reviewCount,
    google_types: p.types,
    profession: params.professions.length === 1 ? params.professions[0] : null,
    updated_at: new Date().toISOString(),
  }));

  const { error: upsertError } = await (supabase as any)
    .from("discovered_businesses")
    .upsert(rows, { onConflict: "google_place_id", ignoreDuplicates: false });

  if (upsertError) {
    // SCRUM-321: non-fatal (the reload below still returns whatever IS in
    // discovered_businesses), but a silent upsert failure means the reload
    // can return an incomplete/stale set that looks like a normal result. Page
    // at warning (consistent with SCRUM-315's partial-scan pattern) so a
    // persistent write regression (column rename / constraint / RLS) surfaces
    // instead of being misattributed to a Google quota truncation.
    console.error("[Lead Discovery] Business upsert error:", upsertError);
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.LEAD_DISCOVERY_UPSERT_FAILED,
      level: "warning",
      message: `discovered_businesses upsert failed for ${rows.length} rows — reload may return incomplete data`,
      tags: { failureKind: "db-query" },
      extras: { rowCount: rows.length, location: params.location },
    });
  }

  // 4. Save cache entry (7-day TTL) — COMPLETE results only.
  // SCRUM-318: a partial result must NOT be durably cached, or every
  // identical search for the next 7 days serves the truncated set behind a
  // "Cached results" badge and never re-calls Google — so the missing
  // professions stay silently absent for a week. Skipping the write means
  // the next search re-attempts the failed slice (bounded by the route's
  // adminExpensive rate limit). Page a warning so on-call sees the
  // degradation, consistent with SCRUM-315's partial-scan pattern.
  if (partial) {
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.LEAD_DISCOVERY_SEARCH_PARTIAL,
      level: "warning",
      message: `Google Places returned partial results (${places.length} businesses) — skipping durable cache so the next search retries`,
      tags: { failureKind: "google-places" },
      extras: {
        location: params.location,
        professionCount: params.professions.length,
        gotResults: places.length,
        placesStatus: searchResult.failedStatus,
        // SCRUM-321: coarse cause when there's no HTTP status (soft empty-page
        // truncation or a raw network/parse throw) so the alert is actionable.
        failedReason: searchResult.failedReason,
      },
    });
  } else {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error: cacheError } = await (supabase as any).from("lead_search_cache").upsert(
      {
        query_hash: cacheKey,
        location: params.location,
        professions: params.professions,
        result_count: places.length,
        google_response: places,
        expires_at: expiresAt,
      },
      { onConflict: "query_hash" }
    );

    if (cacheError) {
      console.error("[Lead Discovery] Cache upsert error:", cacheError);
    }
  }

  // 5. Reload from DB (to get generated IDs)
  // SCRUM-309: capture the read error. We've already spent the (paid,
  // rate-limited) Google Places calls by this point — silently
  // returning [] on a reload failure would discard that work and look
  // like an empty search. Throw so it 500s + pages with db-query.
  const placeIds = places.map((p) => p.placeId);
  const { data: businesses, error: reloadError } = await (supabase as any)
    .from("discovered_businesses")
    .select("*")
    .in("google_place_id", placeIds);

  if (reloadError) {
    throw new LeadDiscoveryDbError(
      `Failed to reload searched businesses: ${reloadError.message}`,
      { cause: reloadError },
    );
  }

  return { businesses: businesses ?? [], cached: false, partial };
}

// ── CRM scanning ─────────────────────────────────────────────────────

const SCAN_CONCURRENCY = 3;

/**
 * Scan a batch of businesses for CRM software.
 * Processes in batches of SCAN_CONCURRENCY to avoid hammering websites.
 */
export async function scanBusinessCRMs(
  businessIds: string[],
  adminClient?: ServiceRoleSupabaseClient,
): Promise<DiscoveredBusiness[]> {
  // SCRUM-301: thread the caller's admin client through if provided.
  const supabase = adminClient ?? createAdminClient();

  // Load businesses that need scanning
  // SCRUM-309: capture the read error and throw a typed DB error. The
  // read previously fell through silently — a real DB outage looked
  // identical to "all already scanned" and the scan returned [] as if
  // it succeeded. Now it 500s + pages with failureKind=db-query.
  const { data: businesses, error: loadError } = await (supabase as any)
    .from("discovered_businesses")
    .select("*")
    .in("id", businessIds)
    .is("detected_crm", null);

  if (loadError) {
    throw new LeadDiscoveryDbError(
      `Failed to load businesses for scanning: ${loadError.message}`,
      { cause: loadError },
    );
  }

  if (!businesses || businesses.length === 0) {
    // Return already-scanned businesses if any
    const { data: all, error: allError } = await (supabase as any)
      .from("discovered_businesses")
      .select("*")
      .in("id", businessIds);
    if (allError) {
      throw new LeadDiscoveryDbError(
        `Failed to load already-scanned businesses: ${allError.message}`,
        { cause: allError },
      );
    }
    return all ?? [];
  }

  // Process in batches. SCRUM-315: a single row's UPDATE failing must
  // NOT abort the batch (the row just stays unscanned and is re-selected
  // next pass), but the COUNT of failures was previously console-only
  // and invisible to alerting. Each task returns 1 on update failure;
  // we sum them and page ONCE at the end if any failed (see below).
  const toScan = businesses as DiscoveredBusiness[];
  let updateFailures = 0;
  for (let i = 0; i < toScan.length; i += SCAN_CONCURRENCY) {
    const batch = toScan.slice(i, i + SCAN_CONCURRENCY);

    const batchFailures = await Promise.all(
      batch.map(async (biz): Promise<number> => {
        if (!biz.website) {
          const { error: noWebErr } = await (supabase as any)
            .from("discovered_businesses")
            .update({
              detected_crm: "no_website",
              website_scanned_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", biz.id);
          if (noWebErr) {
            console.error("[Lead Discovery] Update error (no_website):", noWebErr);
            return 1;
          }
          return 0;
        }

        const result = await scanWebsiteForCRM(biz.website);

        const { error: scanErr } = await (supabase as any)
          .from("discovered_businesses")
          .update({
            detected_crm: result.software ?? "none",
            detected_crm_details: {
              software: result.software,
              confidence: result.confidence,
              signals: result.signals,
            },
            website_scanned_at: new Date().toISOString(),
            website_scan_error: result.error ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", biz.id);
        if (scanErr) {
          console.error("[Lead Discovery] Scan update error:", scanErr);
          return 1;
        }
        return 0;
      })
    );
    updateFailures += batchFailures.reduce((sum, n) => sum + n, 0);
  }

  // SCRUM-315: surface the aggregate failure count ONCE per scan (not
  // per row). A systematic update regression (column rename, constraint,
  // RLS) otherwise produces a permanently-stuck set of rows that get
  // re-scraped every scan with no on-call signal — the route returns 200.
  // Distinct reason from the route's hard-failure page so a Grafana rule
  // can alert on this partial-degradation case separately.
  //
  // Note: this count is best-effort. It covers UPDATEs that RESOLVE with
  // a Postgres `{ error }`. An UPDATE that REJECTS (transport/network
  // fault) throws out of the Promise.all and skips this page entirely —
  // that's a HARD failure and correctly surfaces as the route's
  // LEAD_DISCOVERY_SCAN_FAILED 500 instead (with the per-row console
  // breadcrumbs above still in Loki).
  if (updateFailures > 0) {
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.LEAD_DISCOVERY_SCAN_UPDATE_PARTIAL,
      level: "warning",
      message: `scanBusinessCRMs: ${updateFailures} of ${toScan.length} per-business CRM updates failed`,
      tags: { failureKind: "db-query" },
      extras: { updateFailures, scanned: toScan.length },
    });
  }

  // Return updated records
  const { data: updated, error: reloadError } = await (supabase as any)
    .from("discovered_businesses")
    .select("*")
    .in("id", businessIds);

  if (reloadError) {
    throw new LeadDiscoveryDbError(
      `Failed to reload scanned businesses: ${reloadError.message}`,
      { cause: reloadError },
    );
  }

  return updated ?? [];
}

// ── Load filtered results (for export) ───────────────────────────────

export async function loadFilteredBusinesses(
  filters: {
    location?: string;
    professions?: string[];
    crmFilter?: string; // "all" | "none" | "no_website" | "has_crm" | specific CRM name
  },
  adminClient?: ServiceRoleSupabaseClient,
): Promise<DiscoveredBusiness[]> {
  // SCRUM-301: thread the caller's admin client through if provided.
  const supabase = adminClient ?? createAdminClient();

  let query = (supabase as any)
    .from("discovered_businesses")
    .select("*")
    .order("created_at", { ascending: false });

  if (filters.professions && filters.professions.length > 0) {
    query = query.in("profession", filters.professions);
  }

  if (filters.location) {
    const escaped = filters.location.replace(/[%_\\]/g, "\\$&");
    query = query.ilike("address", `%${escaped}%`);
  }

  if (filters.crmFilter && filters.crmFilter !== "all") {
    if (filters.crmFilter === "none") {
      query = query.eq("detected_crm", "none");
    } else if (filters.crmFilter === "no_website") {
      query = query.eq("detected_crm", "no_website");
    } else if (filters.crmFilter === "has_crm") {
      query = query
        .not("detected_crm", "is", null)
        .not("detected_crm", "eq", "none")
        .not("detected_crm", "eq", "no_website");
    } else {
      // Specific CRM name
      query = query.eq("detected_crm", filters.crmFilter);
    }
  }

  const { data, error } = await query.limit(5000);
  if (error) {
    console.error("[Lead Discovery] Failed to load filtered businesses:", error);
    // SCRUM-309: typed so the export route catch tags failureKind=db-query.
    throw new LeadDiscoveryDbError(`Database query failed: ${error.message}`, {
      cause: error,
    });
  }
  return data ?? [];
}
