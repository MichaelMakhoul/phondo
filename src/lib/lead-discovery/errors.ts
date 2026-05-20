/**
 * Typed errors for lead-discovery, so the admin route catch blocks can
 * tag Sentry events with a `failureKind` instead of forcing on-call to
 * open the stack to tell a Google Places quota failure apart from a
 * Postgres failure.
 *
 * SCRUM-309: the scan/search/export routes used to page Sentry with
 * only `businessIdCount` / `location` / `crmFilter` extras. This module
 * + `classifyLeadDiscoveryFailure` lets each catch attach a coarse
 * `failureKind` that the Grafana board can filter on.
 *
 * Note on "scraper" failures: `scanWebsiteForCRM` (crm-detector.ts)
 * catches internally and records the failure on the row's
 * `website_scan_error` column — it never throws. So a scraper failure
 * never reaches a route catch as an exception, and there is
 * deliberately no "scraper" kind here. If that internal catch is ever
 * removed, add the kind + a `CrmScanError` at the same time.
 */

export type LeadDiscoveryFailureKind = "google-places" | "db-query" | "unknown";

/**
 * Base class. Carries the `failureKind` the route catch reads.
 *
 * `abstract` so it can't be constructed with an arbitrary kind — every
 * throw site must go through a concrete subclass (which hardcodes its
 * kind), keeping "class identity ⇔ failureKind" an enforced invariant
 * rather than a convention. `instanceof` narrowing in
 * `classifyLeadDiscoveryFailure` reads the kind off any subclass and
 * still works against an abstract base at runtime.
 */
export abstract class LeadDiscoveryError extends Error {
  readonly failureKind: LeadDiscoveryFailureKind;

  constructor(
    message: string,
    failureKind: LeadDiscoveryFailureKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LeadDiscoveryError";
    this.failureKind = failureKind;
  }
}

/** Google Places API failure (missing key, network error, non-JSON body). */
export class PlacesApiError extends LeadDiscoveryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "google-places", options);
    this.name = "PlacesApiError";
  }
}

/** Postgres read/query failure inside the orchestrator. */
export class LeadDiscoveryDbError extends LeadDiscoveryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "db-query", options);
    this.name = "LeadDiscoveryDbError";
  }
}

/**
 * Map any caught value to a coarse failure kind for Sentry triage.
 * Returns the typed kind for a `LeadDiscoveryError`, else "unknown".
 *
 * "unknown" therefore means "a throw we didn't wrap in a typed error"
 * — the stack is still on the Sentry event. NOTE: this is a one-level
 * check; it does NOT walk `err.cause`. If a future intermediate layer
 * re-wraps a typed error in a plain `Error(msg, { cause: typedErr })`,
 * classification degrades to "unknown" (the `errors.test.ts` cause-
 * wrapping case documents this). Throw the typed error directly, or
 * widen this to walk the cause chain, if that pattern is introduced.
 */
export function classifyLeadDiscoveryFailure(
  err: unknown,
): LeadDiscoveryFailureKind {
  if (err instanceof LeadDiscoveryError) return err.failureKind;
  return "unknown";
}
