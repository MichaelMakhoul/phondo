"use strict";

/**
 * SCRUM-531 wiring test — pins that BOTH context loaders route KB entries
 * through lib/kb-aggregate.js (owner-authored first, website imports last).
 *
 * The ordering logic itself is pinned in kb-aggregate.test.js; this file
 * exists because those tests stay green if a loader quietly reverts to
 * inline created_at-order aggregation — which is exactly the regression
 * that shipped the original bug.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// The DB returns entries in created_at order: website import first (it is
// created during onboarding), the owner's FAQ second. Big enough that the
// old ordering demonstrably evicts the FAQ (see kb-aggregate.test.js).
const KB_ROWS = [
  {
    id: "kb-web",
    title: "example.com.au",
    source_type: "website",
    content: "We are a family owned practice. ".repeat(700), // ~22k chars
    is_active: true,
  },
  {
    id: "kb-faq",
    title: "Frequently Asked Questions",
    source_type: "faq",
    content: JSON.stringify([{ question: "Loan cars?", answer: "Yes, free loan cars." }]),
    is_active: true,
  },
];

const ASSISTANT_ROW = {
  id: "asst-1",
  name: "Test Assistant",
  system_prompt: "You are a receptionist. {knowledge_base}",
  prompt_config: null,
  settings: {},
  first_message: null,
  is_active: true,
  voice_id: "voice-1",
  language: "en",
  after_hours_config: null,
};

const ORG_ROW = {
  id: "org-1",
  name: "Test Org",
  industry: "other",
  timezone: "Australia/Sydney",
  business_hours: null,
  default_appointment_duration: 30,
  country: "AU",
  business_state: null,
  recording_consent_mode: "auto",
  appointment_verification_fields: null,
  recording_disclosure_text: null,
};

/**
 * Minimal table-keyed PostgREST fake: every filter/order call returns the
 * chain; awaiting the chain resolves the table's list result; .single()
 * resolves the table's row result. Unknown .single() tables resolve a
 * PGRST116 miss so an unexpected query fails the test loudly (the loader
 * returns null) instead of crashing on undefined data.
 */
function makeChain(table) {
  const singleRows = { assistants: ASSISTANT_ROW, organizations: ORG_ROW };
  const listRows = { knowledge_bases: KB_ROWS };
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    single: () =>
      Promise.resolve(
        table in singleRows
          ? { data: singleRows[table], error: null }
          : { data: null, error: { code: "PGRST116", message: `no ${table} row` } }
      ),
    then: (resolve, reject) =>
      Promise.resolve({ data: listRows[table] || [], error: null }).then(resolve, reject),
  };
  return chain;
}

const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { getSupabase: () => ({ from: (table) => makeChain(table) }) },
};

const { loadCallContext, loadTestCallContext } = require("../lib/call-context");

function assertOwnerFaqOutranksWebsite(knowledgeBase, label) {
  const faqIdx = knowledgeBase.indexOf("## Frequently Asked Questions");
  const webIdx = knowledgeBase.indexOf("## example.com.au");
  assert.ok(faqIdx !== -1, `${label}: FAQ section missing from aggregated KB`);
  assert.ok(webIdx !== -1, `${label}: website section missing from aggregated KB`);
  assert.ok(
    faqIdx < webIdx,
    `${label}: owner FAQ must be aggregated BEFORE the website import (got faq@${faqIdx}, web@${webIdx})`
  );
}

test("loadCallContext aggregates owner entries before the website import", async () => {
  const prefetchedPhone = {
    id: "ph-1",
    organization_id: "org-1",
    assistant_id: "asst-1",
    ai_enabled: true,
    user_phone_number: null,
    forwarding_status: null,
    source_type: "purchased",
  };
  const context = await loadCallContext("+61255550100", prefetchedPhone);
  assert.ok(context, "loadCallContext returned null — the mock is missing a table it queries");
  assertOwnerFaqOutranksWebsite(context.knowledgeBase, "loadCallContext");
});

test("loadTestCallContext aggregates owner entries before the website import", async () => {
  const context = await loadTestCallContext("asst-1", "org-1");
  assert.ok(context, "loadTestCallContext returned null — the mock is missing a table it queries");
  assertOwnerFaqOutranksWebsite(context.knowledgeBase, "loadTestCallContext");
});
