"use strict";

/**
 * SCRUM-476 — voice gate grace window before divert.
 *
 * Pins the DELIBERATE behavior change: the live call gate (isSubscriptionCallable
 * → computeLapseState) now keeps canceled / incomplete_expired / unpaid /
 * expired-trial subscriptions CALLABLE for the grace window and only diverts
 * AFTER it. Previously those states (and an expired trial) were blocked the
 * instant they lapsed. past_due stays always-callable. A reviewer explicitly
 * flagged the unpaid + incomplete_expired loosening, so it is pinned here as a
 * documented decision rather than left implicit.
 *
 * The divert itself is the EXISTING kill-switch ladder (fallback_forward_number →
 * Dial → voicemail) triggered by isAiEnabled returning false — not rebuilt here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// Capture the PostgREST select string lookupPhoneNumber builds, and return a
// quiet "no rows" so no Sentry/console noise fires. Installed BEFORE requiring
// answer-mode (mirrors answer-mode-sentry.test.js). `node --test` runs each file
// in its own process, so this require.cache patch is isolated to this file.
let capturedSelect = null;
const mockSupabase = {
  from: () => {
    const chain = {
      select: (s) => {
        capturedSelect = s;
        return chain;
      },
      eq: () => chain,
      single: () => Promise.resolve({ data: null, error: { code: "PGRST116", message: "no rows" } }),
    };
    return chain;
  },
};
const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { getSupabase: () => mockSupabase },
};

const { isSubscriptionCallable, isAiEnabled, lookupPhoneNumber } = require("../lib/answer-mode");
const { DEFAULT_GRACE_DAYS } = require("../lib/lapse-state");

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const withinGrace = () => iso(Date.now() - 1 * DAY); // 1d past anchor → inside default grace
const pastGrace = () => iso(Date.now() - (DEFAULT_GRACE_DAYS + 1) * DAY); // > grace past anchor

/** Force the gate ON for a test and restore the env afterwards. */
function gateOn(t) {
  process.env.ENFORCE_SUBSCRIPTION_GATE = "true";
  t.after(() => {
    delete process.env.ENFORCE_SUBSCRIPTION_GATE;
  });
}

test("lapsed states stay CALLABLE during the grace window", (t) => {
  gateOn(t);
  assert.equal(
    isSubscriptionCallable({ status: "canceled", service_ended_at: withinGrace() }),
    true,
    "canceled in grace",
  );
  assert.equal(
    isSubscriptionCallable({ status: "trialing", trial_end: withinGrace() }),
    true,
    "expired trial in grace",
  );
  assert.equal(
    isSubscriptionCallable({ status: "unpaid", current_period_end: withinGrace() }),
    true,
    "unpaid in grace (the reviewer-flagged loosening)",
  );
  assert.equal(
    isSubscriptionCallable({ status: "incomplete_expired", current_period_end: withinGrace() }),
    true,
    "incomplete_expired in grace (the reviewer-flagged loosening)",
  );
});

test("lapsed states are BLOCKED after the grace window (→ kill-switch)", (t) => {
  gateOn(t);
  assert.equal(
    isSubscriptionCallable({ status: "canceled", service_ended_at: pastGrace() }),
    false,
    "canceled past grace",
  );
  assert.equal(
    isSubscriptionCallable({ status: "trialing", trial_end: pastGrace() }),
    false,
    "expired trial past grace (the audited exploit)",
  );
  assert.equal(
    isSubscriptionCallable({ status: "unpaid", current_period_end: pastGrace() }),
    false,
    "unpaid past grace",
  );
  assert.equal(
    isSubscriptionCallable({ status: "incomplete_expired", current_period_end: pastGrace() }),
    false,
    "incomplete_expired past grace",
  );
});

test("post-grace block routes the live call to the kill-switch (isAiEnabled=false)", async (t) => {
  gateOn(t);
  const phone = (sub) => ({
    ai_enabled: true,
    organization_id: "org-1",
    organizations: { subscriptions: [sub] },
  });
  // In grace → AI still answers (callable=true).
  assert.equal(
    await isAiEnabled("+1", phone({ status: "canceled", service_ended_at: withinGrace() })),
    true,
    "in grace → AI on",
  );
  // Past grace → AI off → server.js falls through the existing kill-switch ladder
  // (fallback_forward_number → Dial → voicemail). Never a dropped call.
  assert.equal(
    await isAiEnabled("+1", phone({ status: "canceled", service_ended_at: pastGrace() })),
    false,
    "past grace → AI off → kill-switch",
  );
});

test("past_due is ALWAYS callable (Stripe dunning grace — never enters the machine)", (t) => {
  gateOn(t);
  assert.equal(isSubscriptionCallable({ status: "past_due" }), true, "bare past_due");
  // Even with a long-past period end, past_due must stay callable.
  assert.equal(
    isSubscriptionCallable({ status: "past_due", current_period_end: pastGrace() }),
    true,
    "past_due with an ancient period end is still callable",
  );
});

test("canceled with null service_ended_at falls back to current_period_end", (t) => {
  gateOn(t);
  // No service_ended_at, but current_period_end is within grace → callable.
  assert.equal(
    isSubscriptionCallable({ status: "canceled", service_ended_at: null, current_period_end: withinGrace() }),
    true,
    "fallback anchor within grace → callable",
  );
  // Same, but the fallback anchor is past grace → blocked.
  assert.equal(
    isSubscriptionCallable({ status: "canceled", service_ended_at: null, current_period_end: pastGrace() }),
    false,
    "fallback anchor past grace → blocked",
  );
  // Neither anchor present → no usable anchor → fail-open callable.
  assert.equal(
    isSubscriptionCallable({ status: "canceled", service_ended_at: null, current_period_end: null }),
    true,
    "no anchor at all → fail-open callable",
  );
});

test("a throw from the lapse machine fails OPEN (callable)", (t) => {
  gateOn(t);
  // A subscription whose property access throws forces computeLapseState to throw
  // (it reads sub.status first). The wrapper must swallow it and stay callable.
  const evil = {
    get status() {
      throw new Error("boom");
    },
  };
  const origError = console.error;
  let logged = "";
  console.error = (...args) => {
    logged = args.join(" ");
  };
  try {
    assert.equal(isSubscriptionCallable(evil), true, "helper throw → callable (fail-open)");
  } finally {
    console.error = origError;
  }
  assert.match(logged, /computeLapseState failed/, "should leave a fail-open breadcrumb");
});

test("GRACE_WINDOW_DAYS env override narrows the grace window", (t) => {
  gateOn(t);
  process.env.GRACE_WINDOW_DAYS = "1";
  t.after(() => {
    delete process.env.GRACE_WINDOW_DAYS;
  });
  // canceled 2 days ago: inside the default 7d grace, but OUTSIDE a 1d override.
  assert.equal(
    isSubscriptionCallable({ status: "canceled", service_ended_at: iso(Date.now() - 2 * DAY) }),
    false,
    "2d past anchor with 1d grace → blocked",
  );
  // canceled 12 hours ago: still inside the 1d override → callable.
  assert.equal(
    isSubscriptionCallable({ status: "canceled", service_ended_at: iso(Date.now() - DAY / 2) }),
    true,
    "0.5d past anchor with 1d grace → callable",
  );
});

test("a blank / garbage GRACE_WINDOW_DAYS is ignored (default grace applies)", (t) => {
  gateOn(t);
  t.after(() => {
    delete process.env.GRACE_WINDOW_DAYS;
  });
  // Number("") === 0 is the dangerous one — it must NOT zero the window.
  for (const bad of ["", "abc", "0", "-3"]) {
    process.env.GRACE_WINDOW_DAYS = bad;
    assert.equal(
      isSubscriptionCallable({ status: "canceled", service_ended_at: withinGrace() }),
      true,
      `GRACE_WINDOW_DAYS=${JSON.stringify(bad)} ignored → default ${DEFAULT_GRACE_DAYS}d grace`,
    );
  }
});

test("the subscription embed includes the new columns only when the gate is ON", async (t) => {
  t.after(() => {
    delete process.env.ENFORCE_SUBSCRIPTION_GATE;
  });

  // Gate ON → embed selects status, trial_end, service_ended_at, current_period_end.
  process.env.ENFORCE_SUBSCRIPTION_GATE = "true";
  capturedSelect = null;
  await lookupPhoneNumber("+61299999999");
  assert.ok(capturedSelect, "select must have been called");
  assert.match(
    capturedSelect,
    /subscriptions\(status, trial_end, service_ended_at, current_period_end\)/,
    "gate ON embeds the lapse columns",
  );

  // Gate OFF → byte-identical hot path: NO subscriptions embed at all.
  delete process.env.ENFORCE_SUBSCRIPTION_GATE;
  capturedSelect = null;
  await lookupPhoneNumber("+61299999999");
  assert.ok(capturedSelect, "select must have been called");
  assert.ok(!capturedSelect.includes("subscriptions"), "gate OFF must not embed subscriptions");
  assert.ok(!capturedSelect.includes("service_ended_at"), "gate OFF must not select service_ended_at");
});
