// voice-server/tests/owner-access-embed.test.js
"use strict";
const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-587 — lookupPhoneNumber must embed owner_access ONLY while the voice
// server flag is on (hot-path query unchanged otherwise), and it must read it
// through the service-role client: PR A withholds pin_hash/pin_salt from the
// `authenticated` role by column grant.
const RECORD = { id: "p1", organization_id: "o1", organizations: { name: "X" } };
// `responses` scripts what each .single() resolves to, in order (default: the record).
let captured = { select: null, selects: [], tables: [] };
let responses = [];
const mockSupabase = {
  from: (table) => {
    captured.tables.push(table);
    const chain = {
      select: (cols) => { captured.select = cols; captured.selects.push(cols); return chain; },
      eq: () => chain,
      single: async () => responses.shift() || { data: RECORD, error: null },
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
// The two flag-on selects, also written out in full.
const SELECT_FLAG_ON =
  "id, organization_id, assistant_id, ai_enabled, fallback_forward_number, user_phone_number, forwarding_status, source_type, organizations(name, country, recording_consent_mode, business_state, recording_disclosure_text, owner_access(phone_e164, pin_hash, pin_salt, pin_length, enabled))";
const SELECT_BOTH_FLAGS =
  "id, organization_id, assistant_id, ai_enabled, fallback_forward_number, user_phone_number, forwarding_status, source_type, organizations(name, country, recording_consent_mode, business_state, recording_disclosure_text, subscriptions(status, trial_end, service_ended_at, current_period_end), owner_access(phone_e164, pin_hash, pin_salt, pin_length, enabled))";

describe("lookupPhoneNumber owner_access embed (SCRUM-587)", () => {
  let prevOwner, prevGate;
  beforeEach(() => { captured = { select: null, selects: [], tables: [] }; responses = []; prevOwner = process.env.OWNER_ASSISTANT_ENABLED; prevGate = process.env.ENFORCE_SUBSCRIPTION_GATE; delete process.env.ENFORCE_SUBSCRIPTION_GATE; });
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

  it("flag on: owner_access is embedded with exactly the five columns PR C reads — the whole select pinned", async () => {
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    await lookupPhoneNumber("+61255550000");
    assert.ok(captured.select.includes(OWNER), captured.select);
    assert.equal(captured.select, SELECT_FLAG_ON);
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
    assert.equal(captured.select, SELECT_BOTH_FLAGS, "subscriptions(...) before owner_access(...)");
  });
});

// Final-review row 6: with the flag on, a database that can't serve the owner_access embed
// (migration 00171 not applied yet, a missing column, no grant) used to reject the select for
// EVERY call — each one then failed open as "no record". The lookup now retries without the
// embed and pages once per call; any other error is handled exactly as before.
describe("lookupPhoneNumber — an owner_access embed the database rejects (SCRUM-587)", () => {
  let prevOwner, prevGate, errors;
  beforeEach(() => {
    captured = { select: null, selects: [], tables: [] }; responses = [];
    prevOwner = process.env.OWNER_ASSISTANT_ENABLED; prevGate = process.env.ENFORCE_SUBSCRIPTION_GATE;
    delete process.env.ENFORCE_SUBSCRIPTION_GATE;
    process.env.OWNER_ASSISTANT_ENABLED = "true";
    errors = [];
    mock.method(console, "error", (...a) => errors.push(a.map(String).join(" ")));
  });
  afterEach(() => {
    mock.restoreAll();
    if (prevOwner === undefined) delete process.env.OWNER_ASSISTANT_ENABLED; else process.env.OWNER_ASSISTANT_ENABLED = prevOwner;
    if (prevGate === undefined) delete process.env.ENFORCE_SUBSCRIPTION_GATE; else process.env.ENFORCE_SUBSCRIPTION_GATE = prevGate;
  });
  const rejected = (code) => ({ data: null, error: { code, message: `schema says no (${code})` } });

  for (const code of ["PGRST200", "42P01", "42703", "42501"]) {
    it(`${code}: retried once without owner_access — the call keeps its record, and it pages`, async () => {
      responses = [rejected(code)];
      const record = await lookupPhoneNumber("+61255550000");
      assert.deepEqual(record, RECORD);
      assert.deepEqual(captured.selects, [SELECT_FLAG_ON, SELECT_BEFORE_SCRUM_587]);
      const alerts = errors.filter((l) => l.includes("[ALERT:error]"));
      assert.deepEqual(alerts, [`[ALERT:error] [AnswerMode] owner_access embed rejected (${code}) — retrying without it; the owner assistant is dark until migration 00171/grants are fixed`]);
    });
  }

  it("with the subscription gate on, the retry keeps the subscriptions embed", async () => {
    process.env.ENFORCE_SUBSCRIPTION_GATE = "true";
    responses = [rejected("PGRST200")];
    await lookupPhoneNumber("+61255550000");
    assert.deepEqual(captured.selects, [SELECT_BOTH_FLAGS, SELECT_BEFORE_SCRUM_587_SUBSCRIPTION_GATE_ON]);
  });

  it("any other error (a statement timeout, 57014) is not retried — the existing DB-error path runs", async () => {
    responses = [rejected("57014")];
    assert.equal(await lookupPhoneNumber("+61255550000"), null);
    assert.deepEqual(captured.selects, [SELECT_FLAG_ON]);
    assert.ok(errors.some((l) => l.startsWith("[AnswerMode] lookupPhoneNumber DB error:")), errors.join("\n"));
    assert.ok(!errors.some((l) => l.includes("owner_access embed rejected")));
  });

  it("flag off: a schema error is never retried (the flag-off select is untouched)", async () => {
    delete process.env.OWNER_ASSISTANT_ENABLED;
    responses = [rejected("PGRST200")];
    assert.equal(await lookupPhoneNumber("+61255550000"), null);
    assert.deepEqual(captured.selects, [SELECT_BEFORE_SCRUM_587]);
    assert.ok(!errors.some((l) => l.includes("owner_access embed rejected")));
  });

  it("a retry that fails too is handled like any lookup error: null, logged, no further retry", async () => {
    responses = [rejected("PGRST200"), rejected("57014")];
    assert.equal(await lookupPhoneNumber("+61255550000"), null);
    assert.deepEqual(captured.selects, [SELECT_FLAG_ON, SELECT_BEFORE_SCRUM_587]);
    assert.ok(errors.some((l) => l.startsWith("[AnswerMode] lookupPhoneNumber DB error:")));
    assert.equal(errors.filter((l) => l.includes("owner_access embed rejected")).length, 1);
  });

  it("no row (PGRST116) is a plain miss on the first select — never retried, never logged as an error", async () => {
    responses = [rejected("PGRST116")];
    assert.equal(await lookupPhoneNumber("+61255550000"), null);
    assert.deepEqual(captured.selects, [SELECT_FLAG_ON]);
    assert.deepEqual(errors, []);
  });
});
