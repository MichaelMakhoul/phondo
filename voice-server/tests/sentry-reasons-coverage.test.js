"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { SENTRY_REASONS } = require("../lib/sentry-reasons");

/**
 * SCRUM-297 coverage test: scan every voice-server production file
 * that consolidates onto `setReasonTag(scope, SENTRY_REASONS.X)` and
 * verify that EVERY constant referenced resolves to a known wire
 * value. Catches:
 *   - typos at the call site (`SENTRY_REASONS.FAIL_OPENN`) — these
 *     would otherwise produce `undefined`, which the structured-log
 *     shim filters out of `formatExtras`, and the matching Grafana
 *     alert rule silently never fires.
 *   - new inline `scope.setTag("reason", "raw-string")` sites
 *     re-introducing the convention drift this ticket addresses.
 *
 * `server-sentry-sites.test.js` does a tighter introspection on the
 * server.js + kill-switch.js subset because those have the strictest
 * level/reason taxonomy. This file is the broader migration-
 * completeness guard for the other 3 files migrated in SCRUM-297.
 */

const VOICE_SERVER_DIR = path.join(__dirname, "..");

const MIGRATED_FILES = [
  "lib/answer-mode.js",
  "lib/fallback-dial-consent.js",
  "lib/route-handlers/kill-switch.js",
  "services/tool-executor.js",
  "server.js",
];

const INLINE_RE = /\w+\.setTag\("reason",\s*"([^"]+)"\)/g;
const HELPER_RE = /setReasonTag\(\s*\w+\s*,\s*SENTRY_REASONS\.([A-Z0-9_]+)\s*\)/g;

describe("SCRUM-297 — voice-server reason-tag coverage", () => {
  for (const relativePath of MIGRATED_FILES) {
    const absolutePath = path.join(VOICE_SERVER_DIR, relativePath);
    const source = fs.readFileSync(absolutePath, "utf8");

    test(`${relativePath} — every setReasonTag(SENTRY_REASONS.X) resolves to a known constant`, () => {
      const referencedKeys = [];
      for (const match of source.matchAll(HELPER_RE)) {
        referencedKeys.push(match[1]);
      }
      const unknown = referencedKeys.filter(
        (k) => !Object.prototype.hasOwnProperty.call(SENTRY_REASONS, k),
      );
      assert.deepEqual(
        unknown,
        [],
        `${relativePath}: setReasonTag references unknown constant(s): ${unknown.join(", ")}. ` +
          `Either add the constant to lib/sentry-reasons.js or fix the typo.`,
      );
    });

    test(`${relativePath} — no inline scope.setTag("reason", "raw-string") sites`, () => {
      // Allow setReasonTag(scope, "raw") through? No — both raw-string
      // patterns should be migrated. The exception is the helper's own
      // implementation (lib/sentry-reasons.js itself) but it's not in
      // this scan list.
      const inlineMatches = [];
      for (const match of source.matchAll(INLINE_RE)) {
        inlineMatches.push(match[1]);
      }
      assert.deepEqual(
        inlineMatches,
        [],
        `${relativePath}: found inline raw-string reason(s): ${inlineMatches.join(", ")}. ` +
          `Migrate to setReasonTag(scope, SENTRY_REASONS.X) per SCRUM-297.`,
      );
    });
  }
});
