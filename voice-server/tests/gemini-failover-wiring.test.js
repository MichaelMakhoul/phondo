"use strict";

/**
 * SCRUM-535 — production-wiring introspection.
 *
 * The failover wiring lives inline in server.js's connection handler, which
 * has no unit harness. These assertions are the repo's established bridge for
 * that (see tests/server-sentry-sites.test.js, "Production introspection"):
 * they read the source and pin the load-bearing lines, so a refactor that
 * silently unwires failover — the kind of regression that stays invisible
 * until the next Gemini outage, the only moment this code matters — fails a
 * test instead of an on-call customer.
 *
 * These are brittle against legitimate refactors BY DESIGN: the failure mode
 * is a loud test edit, not a silent revert.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
const { _test } = require("../services/openai-realtime");

describe("SCRUM-535 wiring (source introspection)", () => {
  it("the default (non-override) production factory is the failover wrapper, not bare createGeminiSession", () => {
    assert.match(
      serverSrc,
      /:\s*_geminiWithFailover;/,
      "the _sessionFactory ternary's final branch must be _geminiWithFailover"
    );
    assert.match(
      serverSrc,
      /createSessionWithFailover\(\s*\n?\s*createGeminiSession,/,
      "_geminiWithFailover must wrap createGeminiSession via createSessionWithFailover"
    );
  });

  it("enabled is wired through isFailoverEnabled with the env var AND the key check — never hardcoded", () => {
    assert.match(
      serverSrc,
      /enabled:\s*isFailoverEnabled\(process\.env\.GEMINI_LIVE_FAILOVER,\s*!!process\.env\.OPENAI_API_KEY\)/,
      "bypassing isFailoverEnabled would drop the fail-closed-without-key guarantee"
    );
  });

  it("pipelineFailover is threaded from the session into completeCallRecord", () => {
    assert.match(
      serverSrc,
      /pipelineFailover:\s*s\.pipelineFailover\s*\|\|\s*null,/,
      "the audit trail must reach calls.metadata via completeCallRecord"
    );
  });

  it("the metadata model literal matches the adapter's actual default", () => {
    // "gpt-realtime-2.1" exists in two modules: server.js's _failoverModel
    // (recorded in calls.metadata) and PROVIDERS.openai's url() default (the
    // model actually dialed). Nothing else enforces the coupling — this does.
    const prevEnv = process.env.OPENAI_REALTIME_MODEL;
    delete process.env.OPENAI_REALTIME_MODEL;
    try {
      const url = _test.PROVIDERS.openai.url();
      const adapterDefault = /model=([^&]+)$/.exec(url)?.[1];
      assert.ok(adapterDefault, `could not extract model from ${url}`);
      assert.match(
        serverSrc,
        new RegExp(`process\\.env\\.OPENAI_REALTIME_MODEL \\|\\| "${adapterDefault.replace(/\./g, "\\.")}"`),
        `server.js's _failoverModel default must be "${adapterDefault}" — metadata must record the model the call actually used`
      );
    } finally {
      if (prevEnv !== undefined) process.env.OPENAI_REALTIME_MODEL = prevEnv;
    }
  });
});
