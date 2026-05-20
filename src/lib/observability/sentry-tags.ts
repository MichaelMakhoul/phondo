import type { Scope } from "@sentry/nextjs";
import type { SentryReason } from "@/lib/security/error-ids";

/** Sentinel used when `setReasonTag` is called with a non-string
 *  argument — almost always a typo (`SENTRY_REASONS.FAIL_OPENN` →
 *  `undefined` at runtime, no compile-time error if the caller used
 *  `as any` or skipped typechecking). Without this sentinel the
 *  matching Grafana alert rule would silently never fire. With it,
 *  on-call sees a wrong-but-loud `reason=invalid-reason-passed`
 *  alert and can chase down the typo. */
const INVALID_REASON_SENTINEL = "invalid-reason-passed";

/**
 * Set the `reason` tag on a Sentry scope using a typed constant.
 *
 * Use this instead of `scope.setTag("reason", "raw-string")` at any
 * site that builds its own Sentry scope (e.g. when also calling
 * `Sentry.captureMessage` with a sampled rate, or when the surrounding
 * code attaches multiple tags before the capture). The typechecker
 * rejects values that aren't in `SENTRY_REASONS`, so a typo or rename
 * fails the build instead of silently breaking the matching Grafana
 * alert rule.
 *
 * SCRUM-297: introduced as the enforcement mechanism for the
 * "no inline reason strings" rule documented in
 * `src/lib/security/error-ids.ts`. Review surfaced that compile-time
 * enforcement is not bulletproof — `(SENTRY_REASONS as any).TYPO` or
 * a build that skipped typechecking silently produces `undefined`,
 * which Sentry then stores as an empty/missing tag and the alert
 * rule never matches. The runtime guard below ensures a loud
 * fallback alert fires instead.
 *
 * For the common case (route catch-all that just wants to page),
 * prefer `pageSentry({ reason })` instead — it also bundles the
 * SCRUM-277 defensive shim around the transport.
 */
export function setReasonTag(scope: Scope, reason: SentryReason): void {
  if (typeof reason !== "string" || reason.length === 0) {
    // Caller bug — log loudly so the typo is greppable in Loki, then
    // emit a fallback sentinel so the alert event still has SOMETHING
    // to match on. Better a wrong-but-loud alert than a silent miss.
    console.error(
      "[setReasonTag] reason is not a non-empty string (typo or missing constant):",
      reason,
    );
    scope.setTag("reason", INVALID_REASON_SENTINEL);
    return;
  }
  scope.setTag("reason", reason);
}
