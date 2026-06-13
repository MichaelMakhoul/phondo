/**
 * Subscription lapse-state machine (SCRUM-475 — foundation for the
 * subscription-lapse epic SCRUM-474).
 *
 * PURE, no-IO helper: given a subscription snapshot and the current time, it
 * derives where the org sits on the active → in_grace → lapsed → release_pending
 * timeline. It performs ZERO I/O and NEVER reads the clock itself — `now` is
 * passed in (epoch ms) so the function stays deterministic and trivially
 * testable, and so every consumer (gate, cron, banner) can share one clock.
 *
 * This module intentionally has NO runtime consumer yet — the gate, the
 * lapse-sweep cron and the dashboard banner are wired in later PRs of the epic.
 * It must be safe to merge alone (no behavior change).
 *
 * A hand-written CommonJS port lives at voice-server/lib/lapse-state.js (Fly
 * deploys the voice server standalone and cannot import from src/). The two are
 * kept byte-for-byte equivalent and that is enforced by
 * src/lib/subscriptions/__tests__/lapse-state-parity.test.ts — change BOTH
 * together.
 *
 * FAIL-OPEN philosophy (matches the existing voice gate in
 * voice-server/lib/answer-mode.js → isSubscriptionCallable): when we cannot
 * confidently place an org in a non-callable state — no row, an unknown status,
 * or a terminal status whose anchor timestamp is missing/unparseable — we treat
 * it as `active` (callable). We never cut off a customer because of missing or
 * malformed data; the lapse states are only asserted when the data supports them.
 */

/** Days a lapsed-but-recoverable org stays in `in_grace` before becoming `lapsed`. */
export const DEFAULT_GRACE_DAYS = 7;

/**
 * Days after the cancellation anchor before a `canceled` org becomes eligible
 * for resource release (number reclaim, hard teardown). Only `canceled` ever
 * reaches `release_pending`.
 */
export const DEFAULT_RECLAIM_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * Where an org sits on the lapse timeline.
 * - `active`          — fully paid / valid trial, or fail-open default.
 * - `in_grace`        — billing has lapsed but we still answer calls (recoverable).
 * - `lapsed`          — past grace; calls blocked, data retained.
 * - `release_pending` — past the reclaim window; resources may be reclaimed.
 *                       Only reachable from a `canceled` subscription.
 */
export type LapseState = "active" | "in_grace" | "lapsed" | "release_pending";

/**
 * The slice of a subscription row this machine reads. All timestamps are ISO
 * strings (DB `timestamptz`) or null/undefined. Mirrors snake_case DB columns
 * so callers can pass a raw row straight through.
 */
export interface LapseSubscription {
  status?: string | null;
  trial_end?: string | null;
  current_period_end?: string | null;
  /** SCRUM-475: cancellation anchor captured from Stripe on customer.subscription.deleted. */
  canceled_at?: string | null;
}

/** Optional overrides for the grace / reclaim windows (defaults above). */
export interface LapseConfig {
  graceDays?: number;
  reclaimDays?: number;
}

export interface LapseResult {
  state: LapseState;
  /** The timestamp the timeline is measured from (ISO), or null when none applies. */
  anchorAt: string | null;
  /** When `in_grace` ends → `lapsed` (anchor + graceDays, ISO). Null when there's no anchor. */
  graceEndsAt: string | null;
  /** When a canceled org becomes release-eligible (anchor + reclaimDays, ISO). Only set for `canceled`. */
  releaseEligibleAt: string | null;
  /** Whether calls should still be answered: true only for `active` and `in_grace`. */
  callable: boolean;
}

/**
 * Parse an ISO timestamp to epoch ms, returning null for missing/unparseable
 * input. This is the single defensive choke point: a null result means "no
 * usable anchor", which the callers below translate into the fail-open `active`.
 */
function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Build the result object. Centralised so the key order (and therefore the
 * JSON shape) is identical here and in the JS port — the parity test compares
 * stringified output. `callable` is derived from `state` in exactly one place.
 */
function makeResult(
  state: LapseState,
  anchorMs: number | null,
  graceEndsMs: number | null,
  releaseEligibleMs: number | null
): LapseResult {
  return {
    state,
    anchorAt: anchorMs === null ? null : new Date(anchorMs).toISOString(),
    graceEndsAt: graceEndsMs === null ? null : new Date(graceEndsMs).toISOString(),
    releaseEligibleAt:
      releaseEligibleMs === null ? null : new Date(releaseEligibleMs).toISOString(),
    callable: state === "active" || state === "in_grace",
  };
}

/** The fail-open default: callable, no anchor. Used for unknown/missing data. */
function activeFallback(): LapseResult {
  return makeResult("active", null, null, null);
}

/**
 * Compute the lapse state for a subscription snapshot at time `now` (epoch ms).
 *
 * Per-status contract (the rest of the epic depends on this being exact):
 *
 *  • `trialing`            — anchor = trial_end. No trial_end → active (fail-open).
 *                            now <= trial_end → active; <= +grace → in_grace;
 *                            else lapsed. Never reaches release_pending.
 *  • `canceled`            — anchor = canceled_at ?? current_period_end. The ONLY
 *                            status that can reach release_pending.
 *                            now <= anchor+grace → in_grace (covers "period not
 *                            yet ended", since grace >= 0); <= anchor+reclaim →
 *                            lapsed; else release_pending.
 *  • `unpaid` /
 *    `incomplete_expired`  — anchor = current_period_end. <= anchor+grace →
 *                            in_grace; else lapsed. Never release_pending.
 *  • `active` | `past_due` | `incomplete` | `paused` | unknown | null sub
 *                          — active. (past_due is DELIBERATELY always callable:
 *                            it's Stripe's own dunning grace and must never enter
 *                            this machine — matches isSubscriptionCallable.)
 *
 * Defensive: a terminal status (canceled / unpaid / incomplete_expired) whose
 * anchor is missing or unparseable falls back to `active` rather than throwing
 * or asserting a spurious `lapsed`.
 */
export function computeLapseState(
  sub: LapseSubscription | null | undefined,
  now: number,
  cfg: LapseConfig = {}
): LapseResult {
  const graceMs = (cfg.graceDays ?? DEFAULT_GRACE_DAYS) * DAY_MS;
  const reclaimMs = (cfg.reclaimDays ?? DEFAULT_RECLAIM_DAYS) * DAY_MS;

  if (!sub) return activeFallback();

  const status = sub.status;

  if (status === "trialing") {
    const anchor = parseTs(sub.trial_end);
    if (anchor === null) return activeFallback(); // no trial_end → active
    let state: LapseState;
    if (now <= anchor) state = "active";
    else if (now <= anchor + graceMs) state = "in_grace";
    else state = "lapsed";
    return makeResult(state, anchor, anchor + graceMs, null);
  }

  if (status === "canceled") {
    // canceled_at is the precise cancellation anchor; legacy rows (predating the
    // canceled_at column) fall back to the period they last paid through.
    const anchor = parseTs(sub.canceled_at) ?? parseTs(sub.current_period_end);
    if (anchor === null) return activeFallback(); // no usable anchor → fail-open
    let state: LapseState;
    if (now <= anchor + graceMs) state = "in_grace";
    else if (now <= anchor + reclaimMs) state = "lapsed";
    else state = "release_pending";
    return makeResult(state, anchor, anchor + graceMs, anchor + reclaimMs);
  }

  if (status === "unpaid" || status === "incomplete_expired") {
    const anchor = parseTs(sub.current_period_end);
    if (anchor === null) return activeFallback(); // no usable anchor → fail-open
    const state: LapseState = now <= anchor + graceMs ? "in_grace" : "lapsed";
    return makeResult(state, anchor, anchor + graceMs, null);
  }

  // active, past_due, incomplete, paused, any unknown status → active/callable.
  return activeFallback();
}
