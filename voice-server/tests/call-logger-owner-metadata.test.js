// voice-server/tests/call-logger-owner-metadata.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-587 — call_type/owner_auth land in calls.metadata (PR B's
// call-completed bypass and lockout email read them from the DB row), and a
// healthy customer call still writes NO metadata (the SCRUM-535 race guard).
const updates = [];
const mockSupabase = {
  from: (table) => ({
    update: (payload) => {
      updates.push({ table, payload });
      const chain = { eq: () => chain, is: () => chain, then: (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject) };
      return chain;
    },
  }),
};
const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { getSupabase: () => mockSupabase } };
const { completeCallRecord } = require("../lib/call-logger");

test("an owner call stamps call_type and owner_auth next to voice_provider", async () => {
  updates.length = 0;
  await completeCallRecord("call-1", { status: "completed", durationSeconds: 42, transcript: "…", callType: "owner", ownerAuth: "verified", actionTaken: "owner_call", callerName: "Dave", summary: "Owner call: Checked today's jobs." });
  const main = updates.find((u) => u.payload.metadata);
  assert.deepEqual(main.payload.metadata, { voice_provider: "self_hosted", call_type: "owner", owner_auth: "verified" });
  assert.equal(main.payload.caller_name, "Dave");
  assert.equal(main.payload.summary, "Owner call: Checked today's jobs.");
  assert.ok(updates.some((u) => u.payload.action_taken === "owner_call"));
});

test("a customer call that failed the PIN gate stamps owner_auth only (no call_type)", async () => {
  updates.length = 0;
  await completeCallRecord("call-2", { status: "completed", durationSeconds: 10, transcript: "…", callType: null, ownerAuth: "locked" });
  const main = updates.find((u) => u.payload.metadata);
  assert.deepEqual(main.payload.metadata, { voice_provider: "self_hosted", owner_auth: "locked" });
});

test("a plain customer call still writes no metadata at all", async () => {
  updates.length = 0;
  await completeCallRecord("call-3", { status: "completed", durationSeconds: 10, transcript: "…", callType: null, ownerAuth: null });
  assert.ok(updates.every((u) => !("metadata" in u.payload)));
});

test("every PIN-gate outcome — including a lockout check that errored — is stamped verbatim", async () => {
  for (const ownerAuth of ["verified", "locked", "failed", "error"]) {
    updates.length = 0;
    await completeCallRecord("call-4", { status: "completed", durationSeconds: 10, transcript: "…", ownerAuth });
    assert.equal(updates.find((u) => u.payload.metadata).payload.metadata.owner_auth, ownerAuth);
  }
});
