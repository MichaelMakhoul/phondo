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
 * inline strings at capture sites — use `setReasonTag(scope, reason)`
 * from `@/lib/observability/sentry-tags` or `pageSentry({ reason })`
 * from `@/lib/observability/page-sentry` so the typechecker enforces
 * the constraint.
 *
 * Casing convention (SCRUM-297):
 *   - NEW reasons use kebab-case (`my-thing-failed`).
 *   - LEGACY reasons that pre-date this file (caller-sms, twilio
 *     webhook, `user_phone_equals_phondo` in voice-server) keep their
 *     existing snake_case wire format to preserve any Grafana alert
 *     rules already keyed on those strings. Renaming them would be a
 *     coordinated flag-day operation (update code + alert rules in
 *     the same window) and is out of scope here.
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

  /** SCRUM-324: CRON_SECRET is not set, so a cron route can't authenticate
   *  and 500s without running. A deploy misconfig that silently disables
   *  EVERY cron — paged at error level (via requireCronAuth) so a future
   *  regression is caught, instead of the old bare console.error / silent 500. */
  CRON_SECRET_MISSING: "cron-secret-missing",

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
   *  we want to see it loudly. Uses level=error.
   *
   *  CONTRACT: `extractBusinessInfoWithLLM` (src/lib/scraper/website-
   *  scraper.ts) returns `{}` on every POST-validation error path (its
   *  pre-`try` arg guard is the only window that could throw, and the
   *  route always passes a well-formed pages array), so this fires 0× in
   *  production. If this alert EVER fires, the catch-internally contract
   *  has broken — RUNBOOK: check website-scraper.ts's
   *  `extractBusinessInfoWithLLM` for a regression in the inner catch
   *  handler (e.g. an OpenAI SDK upgrade or a refactor that lets an
   *  error escape the function). The scrape itself is unaffected (the
   *  LLM step is non-fatal); the alert is a code-health signal, not a
   *  customer-facing incident. Covered by scrape-preview/__tests__/
   *  route.test.ts (SCRUM-307). */
  SCRAPE_PREVIEW_LLM_EXTRACT_BUG: "scrape-preview-llm-extract-bug",
  KB_SCRAPE_FAILED: "kb-scrape-failed",
  /** resyncOrgAssistants failure after a successful knowledge-base
   *  scrape — user already got their KB content, but the assistant
   *  prompt didn't refresh. Surfaces in UI as a `resyncWarning` field. */
  KB_SCRAPE_RESYNC_FAILED: "kb-scrape-resync-failed",
  LEAD_DISCOVERY_SCAN_FAILED: "lead-discovery-scan-failed",
  LEAD_DISCOVERY_SEARCH_FAILED: "lead-discovery-search-failed",
  /** searchMultipleProfessions returned PARTIAL results — a profession (or
   *  a later page within one) quota/outage-failed AFTER earlier results
   *  were already collected. The search still 200s with what it found, but
   *  the result is NOT durably cached (SCRUM-318) so the next identical
   *  search retries the missing slice instead of serving a truncated set
   *  for the 7-day cache TTL. Distinct from LEAD_DISCOVERY_SEARCH_FAILED
   *  (the whole search threw → 500) so a Grafana rule can alert on silent
   *  truncation at warning level. SCRUM-318. */
  LEAD_DISCOVERY_SEARCH_PARTIAL: "lead-discovery-search-partial",
  LEAD_DISCOVERY_EXPORT_FAILED: "lead-discovery-export-failed",
  /** discovered_businesses upsert failed during executeSearch — non-fatal
   *  (the reload still recovers whatever IS persisted), but paged at warning
   *  (SCRUM-321) so a silent write regression (column rename / constraint /
   *  RLS) doesn't masquerade as a normal or quota-truncated result. */
  LEAD_DISCOVERY_UPSERT_FAILED: "lead-discovery-upsert-failed",
  /** scanBusinessCRMs completed but N per-business CRM updates failed —
   *  the scan still returns 200 with the rows that DID update. Distinct
   *  from LEAD_DISCOVERY_SCAN_FAILED (the whole scan threw → 500) so a
   *  Grafana rule can alert on a SYSTEMATIC update regression (a
   *  permanently-stuck set of rows re-scraped every scan) at warning
   *  level without conflating it with hard failures. SCRUM-315. */
  LEAD_DISCOVERY_SCAN_UPDATE_PARTIAL: "lead-discovery-scan-update-partial",
  /** Migrated from the inline `"twilio-create-call-failed"` literal
   *  the test-fallback route was using since SCRUM-268. */
  TWILIO_CREATE_CALL_FAILED: "twilio-create-call-failed",
  /** test-fallback route's outer catch — an unexpected throw anywhere
   *  in the handler (not the scoped Twilio-create failure above).
   *  level=error: the route promised JSON but hit an unhandled path. */
  TEST_FALLBACK_UNEXPECTED: "test-fallback-unexpected",
  /** isPlatformAdmin's Postgres query failed — fails closed (treats
   *  user as non-admin) but pages so a real admin denied during a
   *  brownout isn't invisible. */
  ADMIN_AUTH_LOOKUP_FAILED: "admin-auth-lookup-failed",
  /** isPlatformAdmin found NO user_profiles row (PGRST116) for a user
   *  hitting an admin route — treated as non-admin (fail-closed). Benign
   *  individually (level=warning, so it does NOT page), but SCRUM-316 routes
   *  it through Loki so a VOLUME alert can catch a signup-flow regression
   *  that leaves many users profileless. Measured ~0/hr today. */
  ADMIN_PROFILE_ROW_MISSING: "admin-profile-row-missing",

  // ─── org membership lookup (SCRUM-297) ──────────────────────────────
  /** getUserRoleInOrg's Postgres query failed — fails closed (returns
   *  null → 404/403) but pages so a real admin denied during a brownout
   *  isn't invisible. Distinct from ADMIN_AUTH_LOOKUP_FAILED above:
   *  that's platform-admin, this is per-org role. */
  ORG_ROLE_LOOKUP_FAILED: "org-role-lookup-failed",

  // ─── caller-sms (SCRUM-297, legacy snake_case wire format) ──────────
  // The 8 reasons below pre-date this constants file. Wire format kept
  // as snake_case so existing Grafana rules / on-call runbooks still
  // match. New SMS reasons should use kebab-case.
  /** Failed to read `organizations.sms_sender` — degraded SMS to use
   *  the phone-number sender. Page so the branded-sender feature can't
   *  silently regress to phone-number senders across the fleet. */
  SMS_SENDER_READ_FAILED: "sms_sender_read_failed",
  /** Alphanumeric SMS body has no opt-out marker — compliance risk
   *  (every commercial SMS must carry a working unsubscribe facility
   *  per AU Spam Act 2003 / US TCPA). */
  SMS_OPT_OUT_MARKER_MISSING: "sms_opt_out_marker_missing",
  /** Failed to look up org's business phone/email when rewriting the
   *  alphanumeric opt-out line. */
  OPT_OUT_CONTACT_READ_FAILED: "opt_out_contact_read_failed",
  /** Failed to check opt-out status before sending caller SMS. */
  OPTOUT_CHECK_FAILED: "optout_check_failed",
  /** Failed to evaluate the per-org rate-limit cap before sending
   *  caller SMS. */
  RATE_LIMIT_CHECK_FAILED: "rate_limit_check_failed",
  /** Failed to insert the outbound SMS log row. */
  SMS_LOG_INSERT_FAILED: "sms_log_insert_failed",
  /** Failed to read the org's SMS-notifications-enabled toggle. */
  ORG_TOGGLE_READ_FAILED: "org_toggle_read_failed",
  /** Failed to upsert the appointment-confirmation tracking row after
   *  sending a confirmation SMS. */
  CONFIRMATION_UPSERT_FAILED: "confirmation_upsert_failed",

  // ─── twilio sms-status webhook (SCRUM-297, legacy snake_case) ───────
  /** Twilio signature validation failed on the SMS status webhook —
   *  brute-force probe or genuine misconfig. Sampled 1-in-50 to avoid
   *  Sentry-quota burn during attack noise. */
  INVALID_SIGNATURE: "invalid_signature",
  /** Two terminal delivery callbacks arrived out of order — e.g.
   *  `undelivered` after `delivered`. We keep the first; this tag lets
   *  on-call investigate whether the carrier or our handler is buggy. */
  TERMINAL_STATE_COLLISION: "terminal_state_collision",

  // ─── open-redirect probe (SCRUM-354) ────────────────────────────────
  /** safeRedirectPath rejected a NON-EMPTY redirect param at a server sink
   *  (e.g. /auth/callback). A burst of these is someone probing the auth flow
   *  for a post-login phishing bounce — worth surfacing, not silently dropping. */
  OPEN_REDIRECT_BLOCKED: "open-redirect-blocked",
} as const;

export type SentryReason = (typeof SENTRY_REASONS)[keyof typeof SENTRY_REASONS];
