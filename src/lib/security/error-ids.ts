/**
 * Stable error IDs for Sentry / Grafana alert routing.
 *
 * Sentry events from the Next.js side carry a `reason` tag whose value
 * Grafana / Loki alert rules match on. The risk with raw string
 * literals at every capture site is that a rename refactor silently
 * breaks the alert query — TypeScript can't catch a typo in
 * `setTag("reason", "rate-limit-distributed-failed")` if the alert
 * rule is configured outside the codebase.
 *
 * Routing the strings through a constant flips that: a rename trips
 * the typechecker (because the constant moves or disappears), and the
 * value of the constant is a stable contract between the code and the
 * alert config. Grafana queries read `reason="rate-limit-distributed-failed"`
 * directly, so the constant value is the spec.
 *
 * Add new constants here when you introduce a new Sentry reason. Don't
 * inline strings at capture sites.
 */

export const SENTRY_REASONS = {
  /** RPC unreachable / errored; limiter fell back or failed-closed. */
  RATE_LIMIT_DISTRIBUTED_FAILED: "rate-limit-distributed-failed",

  /** cleanup_rate_limit_buckets RPC errored (returned error object). */
  RATE_LIMIT_CLEANUP_FAILED: "rate-limit-cleanup-failed",

  /** cleanup_rate_limit_buckets RPC threw (network / sdk fault). */
  RATE_LIMIT_CLEANUP_THREW: "rate-limit-cleanup-threw",

  /** cleanup_rate_limit_buckets returned an unexpected shape (non-integer). */
  RATE_LIMIT_CLEANUP_UNEXPECTED_SHAPE: "rate-limit-cleanup-unexpected-shape",
} as const;

export type SentryReason = (typeof SENTRY_REASONS)[keyof typeof SENTRY_REASONS];
