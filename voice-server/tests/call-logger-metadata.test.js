"use strict";

/**
 * SCRUM-535 — pins completeCallRecord's metadata merge, which had no direct
 * coverage anywhere (the kill-switch route tests inject a stub).
 *
 * Two things matter:
 * 1. pipelineFailover lands in calls.metadata next to voice_provider — the
 *    queryable audit trail of which calls a Gemini outage touched.
 * 2. A HEALTHY call (no extras) must NOT write metadata at all. server.js
 *    passes `s.pipelineFailover || null` on every call; if the truthy guard
 *    regressed to unconditional inclusion, every completed call would rewrite
 *    metadata wholesale and clobber keys the call-completed webhook writes
 *    concurrently (the race the merge comment warns about).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

/** @type {{table: string, payload: object}[]} */
const updates = [];

const mockSupabase = {
  from: (table) => ({
    update: (payload) => {
      updates.push({ table, payload });
      const chain = {
        eq: () => chain,
        is: () => chain,
        then: (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject),
      };
      return chain;
    },
  }),
};

const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { getSupabase: () => mockSupabase },
};

const { completeCallRecord } = require("../lib/call-logger");

test("pipelineFailover is merged into calls.metadata alongside voice_provider", async () => {
  updates.length = 0;
  const failover = {
    from: "gemini-live",
    to: "openai-realtime",
    reason: "setup-timeout",
    model: "gpt-realtime-2.1",
  };
  await completeCallRecord("call-1", {
    status: "completed",
    durationSeconds: 42,
    transcript: [],
    pipelineFailover: failover,
  });
  const record = updates.find((u) => u.table === "calls");
  assert.ok(record, "calls row must be updated");
  assert.deepEqual(record.payload.metadata, {
    voice_provider: "self_hosted",
    pipelineFailover: failover,
  });
});

test("a healthy call (pipelineFailover null, no other extras) writes NO metadata key", async () => {
  updates.length = 0;
  await completeCallRecord("call-2", {
    status: "completed",
    durationSeconds: 42,
    transcript: [],
    pipelineFailover: null, // what server.js passes on every non-failover call
  });
  const record = updates.find((u) => u.table === "calls");
  assert.ok(record, "calls row must be updated");
  assert.equal(
    "metadata" in record.payload,
    false,
    "an unconditional metadata write would clobber webhook-written keys"
  );
});
