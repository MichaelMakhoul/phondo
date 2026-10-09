// voice-server/tests/owner-access-embed.test.js
"use strict";
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-587 — lookupPhoneNumber must embed owner_access ONLY while the voice
// server flag is on (hot-path query unchanged otherwise), and it must read it
// through the service-role client: PR A withholds pin_hash/pin_salt from the
// `authenticated` role by column grant.
let captured = { select: null, tables: [] };
const mockSupabase = {
  from: (table) => {
    captured.tables.push(table);
    const chain = {
      select: (cols) => { captured.select = cols; return chain; },
      eq: () => chain,
      single: async () => ({ data: { id: "p1", organization_id: "o1", organizations: { name: "X" } }, error: null }),
    };
    return chain;
  },
};
const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { getSupabase: () => mockSupabase } };

const { lookupPhoneNumber } = require("../lib/answer-mode");
const BASE = "organizations(name, country, recording_consent_mode, business_state, recording_disclosure_text)";
const OWNER = "owner_access(phone_e164, pin_hash, pin_salt, pin_length, enabled)";

// The two selects lookupPhoneNumber built before SCRUM-587, written out in full
// (not composed from the pieces above) so a drifted comma or space fails here.
// While OWNER_ASSISTANT_ENABLED is unset these are what production sends, byte for byte.
const SELECT_BEFORE_SCRUM_587 =
  "id, organization_id, assistant_id, ai_enabled, fallback_forward_number, user_phone_number, forwarding_status, source_type, organizations(name, country, recording_consent_mode, business_state, recording_disclosure_text)";
const SELECT_BEFORE_SCRUM_587_SUBSCRIPTION_GATE_ON =
  "id, organization_id, assistant_id, ai_enabled, fallback_forward_number, user_phone_number, forwarding_status, source_type, organizations(name, country, recording_consent_mode, business_state, recording_disclosure_text, subscriptions(status, trial_end, service_ended_at, current_period_end))";

describe("lookupPhoneNumber owner_access embed (SCRUM-587)", () => {
  let prevOwner, prevGate;
  beforeEach(() => { captured = { select: null, tables: [] }; prevOwner = process.env.OWNER_ASSISTANT_ENABLED; prevGate = process.env.ENFORCE_SUBSCRIPTION_GATE; delete process.env.ENFORCE_SUBSCRIPTION_GATE; });
  afterEach(() => {
    if (prevOwner === undefined) delete process.env.OWNER_ASSISTANT_ENABLED; else process.env.OWNER_ASSISTANT_ENABLED = prevOwner;
    if (prevGate === undefined) delete process.env.ENFORCE_SUBSCRIPTION_GATE; else process.env.ENFORCE_SUBSCRIPTION_GATE = prevGate;
  });

  it("flag off: the select is byte-identical to today (no owner_access)", async () => {
    delete process.env.OWNER_ASSISTANT_ENABLED;
    await lookupPhoneNumber("+61255550000");
    assert.ok(captured.select.endsWith(BASE), captured.select);
    assert.ok(!captured.select.includes("owner_access"));
    assert.equal(captured.select, SELECT_BEFORE_SCRUM_587);
  });

  it("flag off + subscription gate on: still byte-identical to the pre-SCRUM-587 select", async () => {
    delete process.env.OWNER_ASSISTANT_ENABLED;
    process.env.ENFORCE_SUBSCRIPTION_GATE = "true";
    await lookupPhoneNumber("+61255550000");
    assert.equal(captured.select, SELECT_BEFORE_SCRUM_587_SUBSCRIPTION_GATE_ON);
  });

  it("flag explicitly 'false': no owner_access, select unchanged (only the string 'true' turns it on)", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "false";
    await lookupPhoneNumber("+61255550000");
    assert.equal(captured.select, SELECT_BEFORE_SCRUM_587);
  });

  it("flag on: owner_access is embedded with exactly the five columns PR C reads", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    await lookupPhoneNumber("+61255550000");
    assert.ok(captured.select.includes(OWNER), captured.select);
    assert.ok(captured.select.startsWith("id, organization_id, assistant_id, ai_enabled, fallback_forward_number, user_phone_number, forwarding_status, source_type, organizations("));
  });

  it("flag on: still ONE query against phone_numbers (the embed adds no round trip)", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    await lookupPhoneNumber("+61255550000");
    assert.deepEqual(captured.tables, ["phone_numbers"]);
  });

  it("both flags on: subscription AND owner_access embeds coexist", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    process.env.ENFORCE_SUBSCRIPTION_GATE = "true";
    await lookupPhoneNumber("+61255550000");
    assert.ok(captured.select.includes("subscriptions(status, trial_end, service_ended_at, current_period_end)"));
    assert.ok(captured.select.includes(OWNER));
  });
});
