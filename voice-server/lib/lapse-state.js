"use strict";

/**
 * Plain JS port of src/lib/subscriptions/lapse-state.ts — keep in sync;
 * enforced by lapse-state-parity.test.ts.
 *
 * The voice server is deployed standalone to Fly and cannot import from src/,
 * so this is a hand-written mirror of the pure lapse-state machine. Same logic,
 * same exports, same JSON output shape (key order matters — the parity test
 * compares stringified results). Change BOTH files together.
 *
 * No runtime consumer yet (SCRUM-475 is the zero-behavior-change foundation for
 * the lapse epic SCRUM-474); the gate/cron/banner are wired in later PRs.
 *
 * FAIL-OPEN: missing row, unknown status, or a terminal status with no usable
 * anchor → `active` (callable). Matches isSubscriptionCallable in answer-mode.js.
 */

/** Days a lapsed-but-recoverable org stays in `in_grace` before becoming `lapsed`. */
const DEFAULT_GRACE_DAYS = 7;

/**
 * Days after the cancellation anchor before a `canceled` org becomes eligible
 * for resource release. Only `canceled` ever reaches `release_pending`.
 */
const DEFAULT_RECLAIM_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * @typedef {'active' | 'in_grace' | 'lapsed' | 'release_pending'} LapseState
 */

/**
 * @typedef {Object} LapseSubscription
 * @property {string | null} [status]
 * @property {string | null} [trial_end]
 * @property {string | null} [current_period_end]
 * @property {string | null} [canceled_at]
 */

/**
 * @typedef {Object} LapseConfig
 * @property {number} [graceDays]
 * @property {number} [reclaimDays]
 */

/**
 * @typedef {Object} LapseResult
 * @property {LapseState} state
 * @property {string | null} anchorAt
 * @property {string | null} graceEndsAt
 * @property {string | null} releaseEligibleAt
 * @property {boolean} callable
 */

/**
 * Parse an ISO timestamp to epoch ms, or null for missing/unparseable input.
 * The single defensive choke point: null → "no usable anchor" → fail-open active.
 *
 * @param {string | null | undefined} ts
 * @returns {number | null}
 */
function parseTs(ts) {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Build the result object. Centralised so the key order (JSON shape) matches
 * the TS module exactly. `callable` is derived from `state` in one place.
 *
 * @param {LapseState} state
 * @param {number | null} anchorMs
 * @param {number | null} graceEndsMs
 * @param {number | null} releaseEligibleMs
 * @returns {LapseResult}
 */
function makeResult(state, anchorMs, graceEndsMs, releaseEligibleMs) {
  return {
    state,
    anchorAt: anchorMs === null ? null : new Date(anchorMs).toISOString(),
    graceEndsAt: graceEndsMs === null ? null : new Date(graceEndsMs).toISOString(),
    releaseEligibleAt:
      releaseEligibleMs === null ? null : new Date(releaseEligibleMs).toISOString(),
    callable: state === "active" || state === "in_grace",
  };
}

/**
 * The fail-open default: callable, no anchor. Used for unknown/missing data.
 * @returns {LapseResult}
 */
function activeFallback() {
  return makeResult("active", null, null, null);
}

/**
 * Compute the lapse state for a subscription snapshot at time `now` (epoch ms).
 * See src/lib/subscriptions/lapse-state.ts for the full per-status contract —
 * this must stay identical.
 *
 * @param {LapseSubscription | null | undefined} sub
 * @param {number} now - epoch ms (passed in; never read the clock here)
 * @param {LapseConfig} [cfg]
 * @returns {LapseResult}
 */
function computeLapseState(sub, now, cfg = {}) {
  const graceMs = (cfg.graceDays ?? DEFAULT_GRACE_DAYS) * DAY_MS;
  const reclaimMs = (cfg.reclaimDays ?? DEFAULT_RECLAIM_DAYS) * DAY_MS;

  if (!sub) return activeFallback();

  const status = sub.status;

  if (status === "trialing") {
    const anchor = parseTs(sub.trial_end);
    if (anchor === null) return activeFallback(); // no trial_end → active
    /** @type {LapseState} */
    let state;
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
    /** @type {LapseState} */
    let state;
    if (now <= anchor + graceMs) state = "in_grace";
    else if (now <= anchor + reclaimMs) state = "lapsed";
    else state = "release_pending";
    return makeResult(state, anchor, anchor + graceMs, anchor + reclaimMs);
  }

  if (status === "unpaid" || status === "incomplete_expired") {
    const anchor = parseTs(sub.current_period_end);
    if (anchor === null) return activeFallback(); // no usable anchor → fail-open
    /** @type {LapseState} */
    const state = now <= anchor + graceMs ? "in_grace" : "lapsed";
    return makeResult(state, anchor, anchor + graceMs, null);
  }

  // active, past_due, incomplete, paused, any unknown status → active/callable.
  return activeFallback();
}

module.exports = {
  DEFAULT_GRACE_DAYS,
  DEFAULT_RECLAIM_DAYS,
  computeLapseState,
};
