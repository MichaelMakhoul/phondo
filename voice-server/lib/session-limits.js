/**
 * SCRUM-363: per-session duration caps for the /ws/test (test + demo) path.
 *
 * Both authenticated dashboard test calls and the public /demo run through
 * /ws/test, but they warrant different ceilings. A demo session is public,
 * unauthenticated, and billed on the paid Gemini Live key, so it gets a tighter
 * cap — long enough to experience the AI receptionist, short enough to bound
 * cost/abuse. Authenticated dashboard test calls keep the longer cap.
 *
 * Extracted so the ceiling selection is unit-testable (mirrors the
 * test-session-caps pattern).
 */

// Mirror of src/lib/demo/config.ts DEMO_ORG_ID — the public demo org whose
// sessions reach /ws/test via the demo-call token. Kept in sync manually (the
// voice server doesn't import the Next.js app's TS config).
const DEMO_ORG_ID = "d0000000-0000-4000-a000-000000000001";

const MAX_TEST_CALL_DURATION_MS = 5 * 60 * 1000; // authed dashboard test calls — 5 min
// Public demo (website /demo and the published demo phone line) — 3 min by
// default. DEMO_MAX_CALL_MINUTES overrides it (whole minutes, 1-15); anything
// else keeps the default with a warning so a typo never removes the ceiling.
const DEFAULT_DEMO_CALL_MINUTES = 3;
const MAX_DEMO_CALL_MINUTES_ALLOWED = 15;

/**
 * @param {string|undefined} raw - DEMO_MAX_CALL_MINUTES
 * @returns {number} minutes
 */
function demoCallMinutes(raw) {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEMO_CALL_MINUTES;
  const n = Number(raw.trim());
  if (Number.isInteger(n) && n >= 1 && n <= MAX_DEMO_CALL_MINUTES_ALLOWED) return n;
  const shown = JSON.stringify(raw).replace(/[\[\]]/g, "").slice(0, 40);
  console.warn(`[DemoLine] DEMO_MAX_CALL_MINUTES ${shown} is not a whole number from 1 to ${MAX_DEMO_CALL_MINUTES_ALLOWED} — using ${DEFAULT_DEMO_CALL_MINUTES} min`);
  return DEFAULT_DEMO_CALL_MINUTES;
}

const MAX_DEMO_CALL_DURATION_MS = demoCallMinutes(process.env.DEMO_MAX_CALL_MINUTES) * 60 * 1000;

/**
 * Max session duration for a /ws/test session, given the token's organizationId.
 * Demo org → the tighter demo cap; everything else → the standard test cap.
 * @param {string|null|undefined} organizationId
 * @returns {number} milliseconds
 */
function getMaxSessionDurationMs(organizationId) {
  return organizationId === DEMO_ORG_ID
    ? MAX_DEMO_CALL_DURATION_MS
    : MAX_TEST_CALL_DURATION_MS;
}

module.exports = {
  DEMO_ORG_ID,
  MAX_TEST_CALL_DURATION_MS,
  MAX_DEMO_CALL_DURATION_MS,
  getMaxSessionDurationMs,
  demoCallMinutes,
};
