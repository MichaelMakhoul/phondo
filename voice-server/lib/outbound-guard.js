"use strict";

// SCRUM-413: defense-in-depth guard for the outbound smoke-test dialer.
// The /outbound/* endpoints place REAL Twilio calls and are gated only by the
// shared INTERNAL_API_SECRET. Without these checks, a leaked secret could be
// used to dial arbitrary (premium-rate / victim) numbers as toll fraud or
// robocall harassment billed to Phondo. Three layers:
//   1. a deploy flag so the endpoints don't even exist as a dialing surface in
//      production unless explicitly enabled,
//   2. E.164 + an explicit (fail-closed) allowlist on every target number,
//   3. an in-memory per-process rate limit to bound a runaway loop.

// Mirror of server.js E164_REGEX_VOICE.
const E164_OUTBOUND = /^\+[1-9]\d{7,14}$/;

/**
 * Whether the outbound smoke-test endpoints are enabled. Default OFF: in
 * production the endpoints 404 unless OUTBOUND_SMOKE_TEST_ENABLED=true is set
 * (e.g. as a temporary Fly secret while running a smoke-test suite).
 * @returns {boolean}
 */
function outboundSmokeTestEnabled() {
  return process.env.OUTBOUND_SMOKE_TEST_ENABLED === "true";
}

/** @returns {string[]} the configured allowlist (E.164), or [] if unset. */
function allowedOutboundNumbers() {
  return (process.env.OUTBOUND_ALLOWED_NUMBERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate a target number for an outbound smoke-test call: it must be E.164
 * AND present in the explicit allowlist. The allowlist is FAIL-CLOSED — if
 * OUTBOUND_ALLOWED_NUMBERS is unset we refuse to dial, so an operator must list
 * the exact test numbers when enabling smoke tests.
 * @param {unknown} targetNumber
 * @returns {{ ok: boolean, error?: string }}
 */
function validateOutboundTarget(targetNumber) {
  if (!targetNumber || typeof targetNumber !== "string") {
    return { ok: false, error: "targetNumber is required" };
  }
  if (!E164_OUTBOUND.test(targetNumber)) {
    return { ok: false, error: "targetNumber must be E.164 (e.g. +61412345678)" };
  }
  const allowed = allowedOutboundNumbers();
  if (allowed.length === 0) {
    return { ok: false, error: "OUTBOUND_ALLOWED_NUMBERS is not configured — refusing to dial" };
  }
  if (!allowed.includes(targetNumber)) {
    return { ok: false, error: "targetNumber is not in the OUTBOUND_ALLOWED_NUMBERS allowlist" };
  }
  return { ok: true };
}

// In-memory rolling-window rate limit (per PROCESS). Smoke-test tooling runs on
// a single Fly machine, so a per-process counter is sufficient to bound a
// runaway loop. NOTE: if the voice server is ever scaled to >1 machine while the
// dialer is enabled, the effective cap multiplies by machine count — the
// allowlist is then the real bound. Default 30 calls / 60s; override with
// OUTBOUND_RATE_MAX (a non-numeric value falls back to the default rather than
// silently disabling the limit).
const RATE_WINDOW_MS = 60_000;

/** @type {number[]} */
let _timestamps = [];

/**
 * Consume one token from the rolling-window rate limit.
 * @param {number} [now]
 * @returns {{ ok: boolean, error?: string }}
 */
function checkOutboundRateLimit(now = Date.now()) {
  const parsed = Number(process.env.OUTBOUND_RATE_MAX);
  const max = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  _timestamps = _timestamps.filter((t) => now - t < RATE_WINDOW_MS);
  if (_timestamps.length >= max) {
    return { ok: false, error: "Outbound call rate limit exceeded" };
  }
  _timestamps.push(now);
  return { ok: true };
}

/** Test-only: clear the rate-limit window. */
function _resetOutboundRateLimit() {
  _timestamps = [];
}

module.exports = {
  E164_OUTBOUND,
  outboundSmokeTestEnabled,
  allowedOutboundNumbers,
  validateOutboundTarget,
  checkOutboundRateLimit,
  _resetOutboundRateLimit,
};
