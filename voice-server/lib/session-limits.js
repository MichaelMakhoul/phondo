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
const MAX_DEMO_CALL_DURATION_MS = 3 * 60 * 1000; // public demo — 3 min (tighter)

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
};
