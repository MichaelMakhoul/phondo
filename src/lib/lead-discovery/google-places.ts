/**
 * Google Places API (v2 — Text Search) client for business discovery.
 *
 * Uses field masks to minimise per-request cost.
 * Env: GOOGLE_PLACES_API_KEY
 */

import { PlacesApiError } from "./errors";

// ── Types ────────────────────────────────────────────────────────────

export interface PlacesSearchParams {
  location: string;       // e.g. "Bondi Junction NSW"
  profession: string;     // e.g. "dentist"
  limit: number;          // desired results (API caps at 20 per page)
}

export interface DiscoveredPlace {
  placeId: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  types: string[];
}

/**
 * Result of a Places search that may be incomplete. `partial` is true when
 * an upstream error (quota/outage non-2xx) truncated the results AFTER some
 * were already collected, so the caller can avoid durably caching a
 * truncated set and can flag it to the UI (SCRUM-318). A failure that
 * collected ZERO results does NOT come back partial — it throws a
 * `PlacesApiError`, so a quota-exhausted search can't masquerade as
 * "no businesses".
 */
export interface PlacesSearchResult {
  places: DiscoveredPlace[];
  partial: boolean;
  /** Upstream HTTP status of the page/profession that degraded the result,
   *  when `partial` and the failure was a non-2xx. undefined otherwise. */
  failedStatus?: number;
  /** Coarse cause when `partial`, for alert triage where there's no HTTP
   *  status — a soft empty-page truncation ("empty-page") or a raw
   *  network/parse throw ("network-or-parse:<name>"). Mirrors `http-<status>`
   *  for the non-2xx case so the alert can tell quota from outage from soft
   *  truncation. SCRUM-321. */
  failedReason?: string;
}

// ── Field mask — only request fields we need (cost control) ──────────

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.types",
].join(",");

// ── API call ─────────────────────────────────────────────────────────

/**
 * Search Google Places for businesses matching a query.
 * Returns up to `limit` results (paginating internally if needed).
 */
export async function searchPlaces(
  params: PlacesSearchParams
): Promise<PlacesSearchResult> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY not configured");
  }

  const textQuery = `${params.profession} in ${params.location}`;
  const results: DiscoveredPlace[] = [];
  let pageToken: string | undefined;

  // Google returns max 20 per page — paginate up to the requested limit
  while (results.length < params.limit) {
    const body: Record<string, unknown> = {
      textQuery,
      maxResultCount: Math.min(20, params.limit - results.length),
      languageCode: "en",
    };
    if (pageToken) {
      body.pageToken = pageToken;
    }

    const res = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(
        `[Google Places] API error ${res.status}:`,
        errBody.slice(0, 500)
      );
      // SCRUM-314: a non-2xx (429 quota, 5xx outage, 403 key/project) must
      // not be swallowed — it previously `break`'d, so a quota-exhausted
      // search looked identical to "this area has no businesses".
      // SCRUM-318: distinguish two cases by what we've collected so far:
      //  - ZERO results yet (the common page-1 quota/auth failure): throw a
      //    typed PlacesApiError carrying the status, so the search 500s +
      //    pages rather than returning a misleading empty set.
      //  - Already have page-1+ results (a transient blip on a LATER page):
      //    return what we have, flagged `partial`, instead of discarding
      //    ~20 valid results. The aggregate caller surfaces the partial
      //    signal (skip durable cache + warn) rather than hard-failing.
      if (results.length > 0) {
        return {
          places: results,
          partial: true,
          failedStatus: res.status,
          failedReason: `http-${res.status}`,
        };
      }
      throw new PlacesApiError(
        `Google Places API returned ${res.status}`,
        { status: res.status },
      );
    }

    const data = await res.json();
    const places: unknown[] = data.places ?? [];

    for (const p of places) {
      const place = p as Record<string, unknown>;
      results.push(normalizePlaceResult(place));
    }

    pageToken = data.nextPageToken as string | undefined;
    if (!pageToken) break; // no continuation token — genuinely complete

    // SCRUM-321: a 200 with an empty `places` page (or a body missing
    // `places`) WHILE a nextPageToken is still present is a truncated
    // sequence — Google returned a usable-result-free page mid-pagination.
    // If we already collected results, return them flagged partial so
    // executeSearch skips the durable cache + warns: a false partial only
    // costs a skipped cache + a warning, whereas a false "complete" silently
    // drops ~20 results behind the 7-day cache TTL. With zero results so far
    // it's just an empty query (no businesses) — return non-partial.
    if (places.length === 0) {
      if (results.length > 0) {
        return { places: results, partial: true, failedReason: "empty-page" };
      }
      break;
    }
  }

  return { places: results, partial: false };
}

/**
 * Search across multiple professions, deduplicate by placeId.
 *
 * Returns a `partial` flag (SCRUM-318) so `executeSearch` can avoid durably
 * caching a truncated set and can flag it to the UI. Partial arises two
 * ways, both AFTER some results were collected: (a) a later profession
 * quota/outage-fails, or (b) a later page WITHIN a profession blips (the
 * within-profession case `searchPlaces` already returns flagged partial).
 * A failure with ZERO results collected still throws (the caller surfaces
 * it as failureKind=google-places rather than a misleading empty set).
 */
export async function searchMultipleProfessions(
  location: string,
  professions: string[],
  totalLimit: number
): Promise<PlacesSearchResult> {
  const perProfessionLimit = Math.ceil(totalLimit / professions.length);
  const seen = new Set<string>();
  const results: DiscoveredPlace[] = [];
  let partial = false;
  let failedStatus: number | undefined;
  let failedReason: string | undefined;

  // Run professions sequentially to avoid burst API costs
  for (const profession of professions) {
    if (results.length >= totalLimit) break;

    let pageResult: PlacesSearchResult;
    try {
      pageResult = await searchPlaces({
        location,
        profession,
        limit: perProfessionLimit,
      });
    } catch (err) {
      // SCRUM-314/318: a zero-result Places failure for THIS profession
      // (PlacesApiError from searchPlaces, or a raw network/parse throw).
      //  - If earlier professions yielded results, degrade to partial and
      //    stop — a quota error on profession 3 shouldn't nuke 1-2's data.
      //    Page + skip-cache happens in executeSearch off the partial flag.
      //  - If we have nothing yet, rethrow so executeSearch surfaces it as
      //    failureKind=google-places (the user sees "try again" rather than
      //    a misleading empty "no businesses found").
      if (results.length > 0) {
        partial = true;
        if (err instanceof PlacesApiError) {
          failedStatus = err.status;
          failedReason = err.status ? `http-${err.status}` : "google-places";
        } else {
          // SCRUM-321: raw network/parse throw — no HTTP status. Carry a
          // coarse reason so the alert can tell this apart from a quota (429).
          failedReason = err instanceof Error ? `network-or-parse:${err.name}` : "network-or-parse";
        }
        console.warn(
          `[Google Places] '${profession}' failed after ${results.length} results — returning partial:`,
          err instanceof Error ? err.message : err,
        );
        break;
      }
      throw err;
    }

    // SCRUM-318: a within-profession page blip (page-2+ failed after page-1
    // succeeded) comes back flagged partial with the page-1 data preserved.
    // Carry the flag up; keep collecting from the remaining professions.
    if (pageResult.partial) {
      partial = true;
      // Keep failedStatus + failedReason sourced from the SAME (first) failure
      // so the alert can't show e.g. a 503 status with an "empty-page" reason.
      if (failedStatus === undefined) failedStatus = pageResult.failedStatus;
      if (failedReason === undefined) failedReason = pageResult.failedReason;
    }

    for (const place of pageResult.places) {
      if (results.length >= totalLimit) break;
      if (seen.has(place.placeId)) continue;
      seen.add(place.placeId);
      results.push(place);
    }
  }

  // SCRUM-318 type review: build the result so `failedStatus` can only ride
  // a partial result. It's meaningless when `partial` is false, and a future
  // edit shouldn't be able to emit a status on a complete result and feed a
  // misleading value into the Sentry triage extra.
  return partial
    ? { places: results, partial: true, failedStatus, failedReason }
    : { places: results, partial: false };
}

// ── Helpers ──────────────────────────────────────────────────────────

function normalizePlaceResult(raw: Record<string, unknown>): DiscoveredPlace {
  const displayName = raw.displayName as Record<string, unknown> | undefined;
  return {
    placeId: (raw.id as string) ?? "",
    name: (displayName?.text as string) ?? "Unknown",
    address: (raw.formattedAddress as string) ?? null,
    phone: (raw.nationalPhoneNumber as string) ?? null,
    website: (raw.websiteUri as string) ?? null,
    rating: (raw.rating as number) ?? null,
    reviewCount: (raw.userRatingCount as number) ?? null,
    types: (raw.types as string[]) ?? [],
  };
}
