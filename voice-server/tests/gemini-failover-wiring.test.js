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
const { _test, resolveOpenAIRealtimeModel } = require("../services/openai-realtime");

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

  it("the metadata model comes from the adapter's own resolver — no second literal to drift (SCRUM-588)", () => {
    // server.js records _failoverModel in calls.metadata; PROVIDERS.openai's
    // url() is the model actually dialed. Both must read the ONE default in
    // openai-realtime.js — a duplicated literal is how they drift apart.
    assert.match(
      serverSrc,
      /const _failoverModel = resolveOpenAIRealtimeModel\(\);/,
      "_failoverModel must come from openai-realtime's resolveOpenAIRealtimeModel()"
    );
    assert.doesNotMatch(
      serverSrc,
      /OPENAI_REALTIME_MODEL \|\| "/,
      "server.js must not carry its own OpenAI Realtime default literal"
    );
  });

  it("the resolver and the dialed URL agree — default and env override", () => {
    const prevEnv = process.env.OPENAI_REALTIME_MODEL;
    const modelInUrl = () => /model=([^&]+)$/.exec(_test.PROVIDERS.openai.url())?.[1];
    try {
      delete process.env.OPENAI_REALTIME_MODEL;
      assert.equal(resolveOpenAIRealtimeModel(), "gpt-realtime-2.1");
      assert.equal(modelInUrl(), resolveOpenAIRealtimeModel());
      process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-test";
      assert.equal(resolveOpenAIRealtimeModel(), "gpt-realtime-test");
      assert.equal(modelInUrl(), "gpt-realtime-test");
    } finally {
      if (prevEnv !== undefined) process.env.OPENAI_REALTIME_MODEL = prevEnv;
      else delete process.env.OPENAI_REALTIME_MODEL;
    }
  });
});
