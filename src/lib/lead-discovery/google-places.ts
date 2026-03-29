/**
 * Google Places API (v2 — Text Search) client for business discovery.
 *
 * Uses field masks to minimise per-request cost.
 * Env: GOOGLE_PLACES_API_KEY
 */

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
): Promise<DiscoveredPlace[]> {
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
      break; // Return whatever we have so far
    }

    const data = await res.json();
    const places: unknown[] = data.places ?? [];

    for (const p of places) {
      const place = p as Record<string, unknown>;
      results.push(normalizePlaceResult(place));
    }

    pageToken = data.nextPageToken as string | undefined;
    if (!pageToken || places.length === 0) break;
  }

  return results;
}

/**
 * Search across multiple professions, deduplicate by placeId.
 */
export async function searchMultipleProfessions(
  location: string,
  professions: string[],
  totalLimit: number
): Promise<DiscoveredPlace[]> {
  const perProfessionLimit = Math.ceil(totalLimit / professions.length);
  const seen = new Set<string>();
  const results: DiscoveredPlace[] = [];

  // Run professions sequentially to avoid burst API costs
  for (const profession of professions) {
    if (results.length >= totalLimit) break;

    const places = await searchPlaces({
      location,
      profession,
      limit: perProfessionLimit,
    });

    for (const place of places) {
      if (results.length >= totalLimit) break;
      if (seen.has(place.placeId)) continue;
      seen.add(place.placeId);
      results.push(place);
    }
  }

  return results;
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
