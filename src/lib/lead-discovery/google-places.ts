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
        return { places: results, partial: true, failedStatus: res.status };
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
    // A 200 with an empty `places` page (even with a nextPageToken still
    // present), or a 200 missing `places` entirely, is treated as a COMPLETE
    // result — a soft/empty-page truncation is NOT flagged partial here, the
    // way a non-2xx above is. Flipping that needs a deliberate call on
    // Google Places (New) empty-page semantics + loop-safety; tracked in
    // SCRUM-321.
    if (!pageToken || places.length === 0) break;
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
        if (err instanceof PlacesApiError) failedStatus = err.status;
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
      if (failedStatus === undefined) failedStatus = pageResult.failedStatus;
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
    ? { places: results, partial: true, failedStatus }
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
