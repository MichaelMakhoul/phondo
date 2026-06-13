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

  // SCRUM-476: lapsed states now keep a grace window (DEFAULT_GRACE_DAYS) before
  // they divert. WITHIN grace → still callable. (A bare terminal status with no
  // anchor fails open — exhaustively covered in answer-mode-grace.test.js.)
  const inGrace = new Date(Date.now() - DAY).toISOString(); // 1d past anchor → inside 7d grace
  assert.equal(
    isSubscriptionCallable({ status: "trialing", trial_end: inGrace }),
    true,
    "trial expired 1d ago → still in grace",
  );
  assert.equal(
    isSubscriptionCallable({ status: "canceled", service_ended_at: inGrace }),
    true,
    "canceled 1d ago → still in grace",
  );
  assert.equal(
    isSubscriptionCallable({ status: "unpaid", current_period_end: inGrace }),
    true,
    "unpaid 1d ago → still in grace",
  );

  // Blocked — only AFTER the grace window. The anchor (trial_end / service_ended_at
  // / current_period_end) must be older than DEFAULT_GRACE_DAYS.
  const pastGrace = new Date(Date.now() - 8 * DAY).toISOString();
  assert.equal(
    isSubscriptionCallable({ status: "trialing", trial_end: pastGrace }),
    false,
    "expired trial past grace (the audited exploit)",
  );
  assert.equal(
    isSubscriptionCallable({ status: "canceled", service_ended_at: pastGrace }),
    false,
    "canceled past grace",
  );
  assert.equal(
    isSubscriptionCallable({ status: "incomplete_expired", current_period_end: pastGrace }),
    false,
    "incomplete_expired past grace",
  );
  assert.equal(
    isSubscriptionCallable({ status: "unpaid", current_period_end: pastGrace }),
    false,
    "unpaid past grace",
  );
});

// Exercise the actual load-bearing wiring inside isAiEnabled (the line that
// blocks a live call). The prefetched path does not touch the DB, so no mock is
// needed.
test("isAiEnabled applies the gate on the prefetched path (gate ON)", async (t) => {
  process.env.ENFORCE_SUBSCRIPTION_GATE = "true";
  t.after(() => {
    delete process.env.ENFORCE_SUBSCRIPTION_GATE;
  });

  const mk = (status, trial_end, extra = {}) => ({
    ai_enabled: true,
    organization_id: "org-1",
    organizations: { subscriptions: [{ status, trial_end, ...extra }] },
  });
  const inGrace = new Date(Date.now() - DAY).toISOString(); // within the grace window
  const pastGrace = new Date(Date.now() - 8 * DAY).toISOString(); // past the grace window
  const future = new Date(Date.now() + DAY).toISOString();

  // SCRUM-476: within grace → still answers; only past grace diverts to kill-switch.
  assert.equal(await isAiEnabled("+1", mk("trialing", inGrace)), true, "trial within grace → AI on");
  assert.equal(await isAiEnabled("+1", mk("trialing", pastGrace)), false, "trial past grace → AI off");
  assert.equal(await isAiEnabled("+1", mk("trialing", future)), true, "in-progress trial → AI on");
  assert.equal(await isAiEnabled("+1", mk("canceled", null, { service_ended_at: pastGrace })), false, "canceled past grace → AI off");
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
