import type { ServiceTypeDefault } from "./defaults";

/**
 * SCRUM-515: turn the scraper's service list into seedable service types.
 *
 * The scraper returns short phrases lifted from the site — "Logbook servicing",
 * "New car sales", "Genuine parts". Onboarding used to drop them into free prose
 * and seed the appointment types from a generic industry table instead, so a
 * caller asking a Toyota dealership what car services it offered was told there
 * was no information, and offered a "standard consultation".
 *
 * Durations are NOT invented. Nothing on a web page says how long a logbook
 * service takes, and a fabricated number would silently mis-shape a real diary.
 * A scraped name that matches one we already know the duration of ("Root Canal"
 * in the dental table: 90 minutes) adopts it, because that is knowledge rather
 * than a guess. Everything else gets the same neutral 30 minutes the generic
 * seed always used, and the owner adjusts it in Settings where the number is
 * visible.
 */

/** Matches the name limit the service_types API validates against. */
const MAX_NAME_LENGTH = 100;
/** An org is capped at 50 service types (enforced on manual add). Stay well under. */
const MAX_SERVICES = 12;
const DEFAULT_DURATION_MINUTES = 30;

/** Reject entries that are navigation chrome or prose, not a bookable service. */
function isPlausibleServiceName(name: string): boolean {
  if (name.length < 2 || name.length > MAX_NAME_LENGTH) return false;
  // Must contain letters. "2024", "—", "•" are not services.
  if (!/\p{L}/u.test(name)) return false;
  // A sentence is a description the LLM failed to compress, not a service name.
  if (/[.!?]\s/.test(name)) return false;
  if (name.split(/\s+/).length > 8) return false;
  return true;
}

function normalizeForDedupe(name: string): string {
  // "&" spelled out first: a site writing "Check-up and Clean" means the same
  // service as the table's "Check-up & Clean", and should inherit its duration.
  return name.toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "");
}

/** Trim surrounding punctuation/bullets the scraper may have carried over. */
function tidy(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—•*·:,]+/, "")
    .replace(/[\s\-–—•*·:,]+$/, "")
    .trim();
}

/**
 * Map scraped service phrases onto seedable rows.
 *
 * Returns an empty array when nothing survives, which the caller must read as
 * "fall back to the industry defaults" — an org with no service types cannot
 * book at all, so an empty result must never be persisted as-is.
 */
export function serviceTypesFromScraped(
  services: string[] | undefined | null,
  /**
   * Services whose duration we already know, normally `getServiceDefaults(industry)`.
   * A scraped name matching one of these adopts its duration and description.
   */
  known: ServiceTypeDefault[] = []
): ServiceTypeDefault[] {
  if (!Array.isArray(services)) return [];

  const knownByName = new Map(known.map((k) => [normalizeForDedupe(k.name), k]));
  const seen = new Set<string>();
  const out: ServiceTypeDefault[] = [];

  for (const raw of services) {
    if (typeof raw !== "string") continue;
    const name = tidy(raw);
    if (!isPlausibleServiceName(name)) continue;

    const key = normalizeForDedupe(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const match = knownByName.get(key);
    out.push({
      // Keep the business's own spelling; only borrow the duration we know.
      name,
      duration_minutes: match?.duration_minutes ?? DEFAULT_DURATION_MINUTES,
      ...(match?.description && { description: match.description }),
    });
    if (out.length >= MAX_SERVICES) break;
  }

  return out;
}
