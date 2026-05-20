import * as Sentry from "@sentry/nextjs";
import type { SentryReason } from "@/lib/security/error-ids";
import { scrubObject } from "./sentry-scrub";

/**
 * Emit a structured `[ALERT:<level>] [<service>] <message> | k=v …` line
 * — the SAME format the voice-server's structured-log shim
 * (`voice-server/lib/sentry.js`) uses — so the existing Grafana Loki
 * alert rules (which match `[ALERT:error]` / `[ALERT:warning]`) cover the
 * Next.js half once Vercel logs are drained to Loki.
 *
 * SCRUM-320: this is the PRIMARY signal. `@sentry/nextjs` is disabled in
 * production (no `NEXT_PUBLIC_SENTRY_DSN`), so the `Sentry.captureException`
 * call in pageSentry is a no-op — without this line a paged Next.js error
 * would surface nowhere alertable. Extras are PII-scrubbed via the
 * SCRUM-312 scrubber. Pure stdout; never throws (caller wraps it).
 */
function emitStructuredAlert(opts: {
  service: string;
  reason: SentryReason;
  level: "warning" | "error";
  err?: unknown;
  message?: string;
  extras?: Record<string, unknown>;
  tags?: Record<string, string>;
}): void {
  const { service, reason, level, err, message, extras, tags } = opts;
  const summary =
    message ??
    (err instanceof Error
      ? err.message
      : err !== undefined
        ? String(err)
        : `pageSentry called with no payload (reason=${reason})`);

  const fields: Record<string, unknown> = { reason, ...tags, ...extras };
  if (err instanceof Error && err.stack) {
    // First 3 stack frames, single-lined — matches the voice-server shim.
    fields.stack = err.stack.split("\n").slice(0, 3).join(" → ");
  }
  const scrubbed = scrubObject(fields) as Record<string, unknown>;
  const pairs = Object.entries(scrubbed)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);

  const line = `[ALERT:${level}] [${service}] ${summary}${pairs.length ? ` | ${pairs.join(" ")}` : ""}`;
  if (level === "error") console.error(line);
  else console.warn(line);
}

/**
 * Shared helper for paging Sentry from server-side code.
 *
 * Wraps `Sentry.withScope` in the defensive `try/catch (sentryErr)`
 * suppression shim established in SCRUM-277 — a permanent shim defect
 * must not crash the caller (a cron, a route handler, a webhook).
 * The original `console.error` from the caller still records the
 * failure so on-call has a Loki breadcrumb when Sentry itself is down.
 *
 * Centralised in `src/lib/observability/page-sentry.ts` (SCRUM-300)
 * so routes + crons stop hand-rolling their own scope+shim every time.
 *
 * @param service     The high-level area of the app (e.g. "next-api",
 *                    "next-cron"). Maps to the `service` Sentry tag —
 *                    Grafana alerts route on this + `reason` together.
 * @param reason      Stable reason tag from SENTRY_REASONS. Drives the
 *                    Grafana alert rule that fires.
 * @param level       Sentry severity. "warning" by default; use "error"
 *                    for config-missing / customer-intent violations.
 * @param err         Thrown/error-object failure. When set, the helper
 *                    routes through `captureException` (preserves stack).
 * @param message     Non-Error condition (e.g. "RPC returned wrong
 *                    shape"). Routes through `captureMessage` —
 *                    SCRUM-304 will revisit this to attach stack traces.
 * @param extras      Arbitrary context for triage. A `beforeSend` PII
 *                    scrubber runs on every Next.js Sentry event
 *                    (SCRUM-312, `src/lib/observability/sentry-scrub.ts`):
 *                    it masks values under PII-named keys (phone, email,
 *                    name, address, …) and truncates long strings. That
 *                    is a safety net, not a license — it keys on the
 *                    field NAME, so PII smuggled under a benign key
 *                    (e.g. `note: "call John on +61…"`) still gets
 *                    through. Prefer passing IDs (orgId, callSid) over
 *                    raw values, and use PII-suggestive key names when
 *                    a value could contain PII so the scrubber catches it.
 */
export function pageSentry(opts: {
  service: "next-api" | "next-cron";
  reason: SentryReason;
  level?: "warning" | "error";
  err?: unknown;
  message?: string;
  extras?: Record<string, unknown>;
  /** Optional extra tags. Useful for route-specific keys like
   *  `cron: "keep-alive"` or `route: "voice-preview"` that downstream
   *  alert rules might split by. */
  tags?: Record<string, string>;
}) {
  const { service, reason, level = "warning", err, message, extras, tags } = opts;

  // SCRUM-320: PRIMARY signal — a structured [ALERT:*] stdout line that
  // works regardless of the (currently-unset) Sentry DSN, so Next.js
  // errors are visible in Vercel logs and Loki-alertable once drained.
  // Wrapped so a formatting/scrub defect can't crash the caller.
  try {
    emitStructuredAlert({ service, reason, level, err, message, extras, tags });
  } catch (logErr) {
    console.error("[pageSentry] structured_log_failed (continuing):", logErr);
  }

  // SCRUM-277 contract: a Sentry shim defect must not crash a cron
  // or route handler — Sentry is a side-channel. The outer try
  // remains in place to preserve that contract. (Secondary path: only
  // transports if a NEXT_PUBLIC_SENTRY_DSN is ever configured.)
  //
  // SCRUM-300 review: prior code logged "[pageSentry] capture
  // failed" for ANY swallow, which conflated two very different
  // cases — (1) Sentry transport defect during captureException
  // (rare, infrastructure), and (2) caller bug during scope setup
  // (Symbol in extras, circular ref, etc — programming error).
  // The two now log with DISTINCT prefixes so Grafana can alert
  // on `pageSentry_scope_setup_failed` independently — caller
  // bugs surface loudly in Loki without crashing the cron.
  try {
    Sentry.withScope((scope) => {
      scope.setTag("service", service);
      scope.setTag("reason", reason);
      if (tags) {
        for (const [k, v] of Object.entries(tags)) scope.setTag(k, v);
      }
      scope.setLevel(level);
      if (extras) scope.setExtras(extras);
      try {
        if (err !== undefined) {
          Sentry.captureException(
            err instanceof Error ? err : new Error(String(err)),
          );
        } else if (message) {
          Sentry.captureMessage(message);
        } else {
          // Defensive: caller passed neither `err` nor `message` (or
          // passed `err: undefined` from a narrowed type). Emit a
          // captureMessage so the scope's tags + reason still produce
          // a Sentry event and Grafana alerts still fire — instead of
          // silently no-op'ing as the SCRUM-300 review surfaced.
          Sentry.captureMessage(`pageSentry called with no payload (reason=${reason})`);
        }
      } catch (transportErr) {
        // Inner shim: Sentry transport defect.
        console.error(
          "[pageSentry] transport_failed (continuing):",
          transportErr instanceof Error
            ? `${transportErr.message}\n${transportErr.stack ?? ""}`
            : transportErr,
        );
      }
    });
  } catch (scopeErr) {
    // Outer shim: scope-setup error — almost always a caller bug
    // (Symbol/BigInt/circular-ref in extras, malformed tags object)
    // or a Sentry SDK regression. Distinct log prefix so a Grafana
    // alert rule can fire on it independently of Sentry events
    // (since Sentry itself failed, we can't rely on it for signal).
    console.error(
      "[pageSentry] scope_setup_failed — caller bug or SDK regression (continuing):",
      scopeErr instanceof Error
        ? `reason=${reason} ${scopeErr.message}\n${scopeErr.stack ?? ""}`
        : scopeErr,
    );
  }
}
