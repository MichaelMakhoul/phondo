"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isSubscriptionCallable,
  getEmbeddedSubscription,
  subscriptionGateEnabled,
  isAiEnabled,
} = require("../lib/answer-mode");

const DAY = 86_400_000;

test("subscription gate is OFF by default — every status is callable", () => {
  delete process.env.ENFORCE_SUBSCRIPTION_GATE;
  assert.equal(subscriptionGateEnabled(), false);
  // Even a canceled / expired-trial sub must be callable while the gate is dormant.
  assert.equal(isSubscriptionCallable({ status: "canceled" }), true);
  assert.equal(
    isSubscriptionCallable({ status: "trialing", trial_end: new Date(Date.now() - DAY).toISOString() }),
    true,
  );
});

test("isSubscriptionCallable with the gate ON", (t) => {
  process.env.ENFORCE_SUBSCRIPTION_GATE = "true";
  t.after(() => {
    delete process.env.ENFORCE_SUBSCRIPTION_GATE;
  });

  // FAIL-OPEN / allowed
  assert.equal(isSubscriptionCallable(null), true, "missing row → allow (fail-open)");
  assert.equal(isSubscriptionCallable(undefined), true, "undefined → allow (fail-open)");
  assert.equal(isSubscriptionCallable({ status: "active" }), true);
  assert.equal(isSubscriptionCallable({ status: "past_due" }), true, "dunning grace");
  assert.equal(isSubscriptionCallable({ status: "incomplete" }), true);
  assert.equal(
    isSubscriptionCallable({ status: "trialing", trial_end: new Date(Date.now() + DAY).toISOString() }),
    true,
    "in-progress trial",
  );
  assert.equal(isSubscriptionCallable({ status: "trialing", trial_end: null }), true, "trial, no end set");

  // Blocked
  assert.equal(
    isSubscriptionCallable({ status: "trialing", trial_end: new Date(Date.now() - DAY).toISOString() }),
    false,
    "expired trial (the audited exploit)",
  );
  assert.equal(isSubscriptionCallable({ status: "canceled" }), false);
  assert.equal(isSubscriptionCallable({ status: "incomplete_expired" }), false);
  assert.equal(isSubscriptionCallable({ status: "unpaid" }), false);
});

// Exercise the actual load-bearing wiring inside isAiEnabled (the line that
// blocks a live call). The prefetched path does not touch the DB, so no mock is
// needed.
test("isAiEnabled applies the gate on the prefetched path (gate ON)", async (t) => {
  process.env.ENFORCE_SUBSCRIPTION_GATE = "true";
  t.after(() => {
    delete process.env.ENFORCE_SUBSCRIPTION_GATE;
  });

  const mk = (status, trial_end) => ({
    ai_enabled: true,
    organization_id: "org-1",
    organizations: { subscriptions: [{ status, trial_end }] },
  });
  const past = new Date(Date.now() - DAY).toISOString();
  const future = new Date(Date.now() + DAY).toISOString();

  assert.equal(await isAiEnabled("+1", mk("trialing", past)), false, "expired trial → AI off");
  assert.equal(await isAiEnabled("+1", mk("trialing", future)), true, "in-progress trial → AI on");
  assert.equal(await isAiEnabled("+1", mk("canceled", null)), false, "canceled → AI off");
  assert.equal(await isAiEnabled("+1", mk("active", null)), true, "active → AI on");
  assert.equal(await isAiEnabled("+1", { ai_enabled: true, organization_id: "o", organizations: {} }), true, "no sub embed → fail-open AI on");

  // ai_enabled=false must short-circuit BEFORE the subscription check.
  assert.equal(
    await isAiEnabled("+1", {
      ai_enabled: false,
      organization_id: "org-1",
      organizations: { subscriptions: [{ status: "active" }] },
    }),
    false,
    "owner-paused short-circuits",
  );
});

test("isAiEnabled ignores the gate when OFF (expired trial still answers)", async () => {
  delete process.env.ENFORCE_SUBSCRIPTION_GATE;
  const phone = {
    ai_enabled: true,
    organization_id: "org-1",
    organizations: { subscriptions: [{ status: "trialing", trial_end: new Date(Date.now() - DAY).toISOString() }] },
  };
  assert.equal(await isAiEnabled("+1", phone), true, "gate off → expired trial still answers");
});

test("getEmbeddedSubscription tolerates array, object, empty and missing shapes", () => {
  assert.deepEqual(
    getEmbeddedSubscription({ organizations: { subscriptions: [{ status: "active" }] } }),
    { status: "active" },
  );
  assert.deepEqual(
    getEmbeddedSubscription({ organizations: { subscriptions: { status: "trialing" } } }),
    { status: "trialing" },
  );
  assert.equal(getEmbeddedSubscription({ organizations: { subscriptions: [] } }), null);
  assert.equal(getEmbeddedSubscription({ organizations: {} }), null);
  assert.equal(getEmbeddedSubscription({}), null);
  assert.equal(getEmbeddedSubscription(null), null);
});
