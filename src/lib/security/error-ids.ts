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

  // ─── keep-alive cron ping failures (SCRUM-292) ──────────────────────
  /** Supabase liveness ping RPC returned an error object. */
  SUPABASE_PING_FAILED: "supabase-ping-failed",

  /** Supabase liveness ping threw (network / SDK fault). */
  SUPABASE_PING_THREW: "supabase-ping-threw",

  /** Upstash Redis ping returned an unexpected (non-PONG) response. */
  UPSTASH_PING_FAILED: "upstash-ping-failed",

  /** Upstash Redis ping threw (network / SDK fault). */
  UPSTASH_PING_THREW: "upstash-ping-threw",

  /** Upstash env vars are half-configured (one of URL/TOKEN set, the
   *  other missing) — the ping cannot run, so this would silently
   *  decay if treated as "skipped". */
  UPSTASH_HALF_CONFIGURED: "upstash-half-configured",

  // ─── paid-action route catch blocks (SCRUM-300) ─────────────────────
  // Each paid-action route used to swallow throws in its catch-all
  // with just console.error + a generic 500. These reasons tag each
  // route's catch-all so Grafana can split alerts per route.
  VOICE_PREVIEW_FAILED: "voice-preview-failed",
  VOICE_PREVIEW_UPSTREAM_NON_2XX: "voice-preview-upstream-non-2xx",
  /** Required env vars for voice-preview are missing — deployment
   *  misconfig. Uses level=error (vs warning) so it pages on-call
   *  immediately rather than waiting for an alert threshold. */
  VOICE_PREVIEW_ENV_MISSING: "voice-preview-env-missing",
  SCRAPE_PREVIEW_FAILED: "scrape-preview-failed",
  /** scrape-preview's "should never happen" LLM extract branch — the
   *  helper claims its catch is internal, but if it ever bubbles out
   *  we want to see it loudly. Uses level=error. */
  SCRAPE_PREVIEW_LLM_EXTRACT_BUG: "scrape-preview-llm-extract-bug",
  KB_SCRAPE_FAILED: "kb-scrape-failed",
  /** resyncOrgAssistants failure after a successful knowledge-base
   *  scrape — user already got their KB content, but the assistant
   *  prompt didn't refresh. Surfaces in UI as a `resyncWarning` field. */
  KB_SCRAPE_RESYNC_FAILED: "kb-scrape-resync-failed",
  LEAD_DISCOVERY_SCAN_FAILED: "lead-discovery-scan-failed",
  LEAD_DISCOVERY_SEARCH_FAILED: "lead-discovery-search-failed",
  LEAD_DISCOVERY_EXPORT_FAILED: "lead-discovery-export-failed",
  /** Migrated from the inline `"twilio-create-call-failed"` literal
   *  the test-fallback route was using since SCRUM-268. */
  TWILIO_CREATE_CALL_FAILED: "twilio-create-call-failed",
  /** isPlatformAdmin's Postgres query failed — fails closed (treats
   *  user as non-admin) but pages so a real admin denied during a
   *  brownout isn't invisible. */
  ADMIN_AUTH_LOOKUP_FAILED: "admin-auth-lookup-failed",
} as const;

export type SentryReason = (typeof SENTRY_REASONS)[keyof typeof SENTRY_REASONS];
