/**
 * Billing Service
 *
 * Handles subscription management, usage tracking, and billing operations.
 * Implements the call-based pricing model: soft caps for paid subscriptions
 * (never block revenue), hard caps for expired trials (enforce conversion).
 */

import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getStripeClient,
  PLANS,
  PlanType,
  planTypeFromPriceId,
  CALL_THRESHOLD_WARNING,
  CALL_THRESHOLD_LIMIT,
  CALL_THRESHOLD_OVER,
} from "./client";
import type Stripe from "stripe";
import type { Database } from "@/lib/supabase/types";

// Compile-time assertion: PlanType and DB enum must stay in sync.
// If these fail, a plan was added/removed in one place but not the other.
type _DBPlanType = Database["public"]["Enums"]["plan_type"];
type _PlanTypesMatch = [PlanType] extends [_DBPlanType]
  ? [_DBPlanType] extends [PlanType] ? true : false
  : false;
const _planTypesSynced: _PlanTypesMatch = true; // eslint-disable-line @typescript-eslint/no-unused-vars

// Legacy plan name aliases — maps old enum values to current ones.
// Existing Stripe subscriptions may have "growth" or "free" in metadata.
const PLAN_ALIASES: Record<string, PlanType> = {
  growth: "business",
  free: "starter",
};

/**
 * Resolve a plan string to a valid PlanType, handling legacy aliases.
 * When throwOnUnknown is true (webhook handlers), unknown plans throw to
 * trigger Stripe retry rather than silently downgrading a paying customer.
 */
function resolvePlanType(raw: string, throwOnUnknown = false): PlanType {
  const resolved = (PLAN_ALIASES[raw] || raw) as PlanType;
  if (!(resolved in PLANS)) {
    const msg = `Unknown plan type "${raw}" (resolved: "${resolved}")`;
    console.error(msg);
    if (throwOnUnknown) {
      throw new Error(msg);
    }
    return "starter";
  }
  return resolved;
}

// Subscription states in which Stripe is (or will resume) billing the customer.
// Shared by the checkout guard and the duplicate-subscription reconciliation.
//
// 'unpaid' is deliberately EXCLUDED: with Stripe's default dunning settings
// (ours) a subscription whose retries are exhausted is CANCELED, not marked
// unpaid, so the status is unreachable in practice. Accepted residual: if an
// existing row ever does read 'unpaid', the reconciliation below overwrites
// it without canceling — revisit if dunning is ever reconfigured to
// "mark as unpaid".
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"];

/**
 * Whether an existing subscription row must block a NEW paid checkout.
 *
 * A real (non-placeholder) Stripe subscription in a live state means the org is
 * already paying, so a second checkout would create a duplicate concurrent
 * subscription (double charge, only one visible in our DB). The `trial_<orgId>`
 * placeholder created by the trial route must NOT block — converting a free
 * trial to paid is exactly what checkout is for.
 */
export function blocksNewCheckout(
  sub: { stripe_subscription_id?: string | null; status?: string | null } | null
): boolean {
  if (!sub) return false;
  const id = sub.stripe_subscription_id ?? "";
  if (id === "" || id.startsWith("trial_")) return false;
  return LIVE_SUBSCRIPTION_STATUSES.includes(sub.status ?? "");
}

export type SubscriptionStatus =
  | "active"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "trialing"
  | "unpaid";

export interface SubscriptionInfo {
  id: string;
  plan: PlanType;
  status: SubscriptionStatus;
  callsLimit: number;
  callsUsed: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
}

export type WarningLevel = "none" | "approaching" | "at_limit" | "over_limit";

export type GatedFeature = "smsNotifications" | "webhookIntegrations" | "advancedAnalytics" | "prioritySupport" | "practitioners" | "crmIntegrations";

export type LimitedResource = "assistants" | "phoneNumbers";

export interface ResourceLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number; // -1 = unlimited
  plan: PlanType | null;
}

export interface UsageInfo {
  callsUsed: number;
  callsLimit: number;
  usagePercentage: number;
  isOverLimit: boolean;
  shouldWarn: boolean;
  warningLevel: WarningLevel;
}

/**
 * Get subscription info for an organization
 */
export async function getSubscriptionInfo(
  organizationId: string
): Promise<SubscriptionInfo | null> {
  const supabase = createAdminClient();

  const { data: subscription, error } = await (supabase as any)
    .from("subscriptions")
    .select("*")
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      // No rows found — genuinely no subscription
      return null;
    }
    // Real database error — throw so callers can distinguish from "no subscription"
    console.error("Failed to fetch subscription:", {
      organizationId,
      errorCode: error.code,
      errorMessage: error.message,
    });
    throw new Error(`Failed to fetch subscription for org ${organizationId}: ${error.message}`);
  }

  if (!subscription) {
    return null;
  }

  const plan = resolvePlanType(subscription.plan_type || "starter");
  const planConfig = PLANS[plan];

  return {
    id: subscription.id,
    plan,
    status: subscription.status,
    // Source of truth is plan config (not DB column) so limits stay in sync with plan definitions
    callsLimit: planConfig?.callsLimit ?? 150,
    callsUsed: subscription.calls_used ?? 0,
    currentPeriodStart: new Date(subscription.current_period_start),
    currentPeriodEnd: new Date(subscription.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
    trialEnd: subscription.trial_end ? new Date(subscription.trial_end) : null,
  };
}

/**
 * Get usage info for an organization
 */
export async function getUsageInfo(organizationId: string): Promise<UsageInfo> {
  let subscription: SubscriptionInfo | null;
  try {
    subscription = await getSubscriptionInfo(organizationId);
  } catch (err) {
    console.error("getUsageInfo: DB error, returning empty usage:", { organizationId, err });
    return {
      callsUsed: 0,
      callsLimit: 0,
      usagePercentage: 0,
      isOverLimit: false,
      shouldWarn: false,
      warningLevel: "none",
    };
  }

  if (!subscription) {
    return {
      callsUsed: 0,
      callsLimit: 0,
      usagePercentage: 0,
      isOverLimit: false,
      shouldWarn: false,
      warningLevel: "none",
    };
  }

  const { callsUsed, callsLimit } = subscription;

  // Guard: if callsLimit is -1, treat as unlimited. No current plan uses this
  // value (CHECK constraint prevents it in new DBs), but defensive for legacy rows.
  if (callsLimit === -1) {
    return {
      callsUsed,
      callsLimit: -1,
      usagePercentage: 0,
      isOverLimit: false,
      shouldWarn: false,
      warningLevel: "none",
    };
  }

  const usagePercentage = callsLimit > 0 ? (callsUsed / callsLimit) * 100 : 0;
  const ratio = callsLimit > 0 ? callsUsed / callsLimit : 0;
  const isOverLimit = ratio >= CALL_THRESHOLD_LIMIT;
  const shouldWarn = ratio >= CALL_THRESHOLD_WARNING;

  let warningLevel: WarningLevel = "none";
  if (ratio >= CALL_THRESHOLD_OVER) {
    warningLevel = "over_limit";
  } else if (ratio >= CALL_THRESHOLD_LIMIT) {
    warningLevel = "at_limit";
  } else if (ratio >= CALL_THRESHOLD_WARNING) {
    warningLevel = "approaching";
  }

  return {
    callsUsed,
    callsLimit,
    usagePercentage: Math.round(usagePercentage),
    isOverLimit,
    shouldWarn,
    warningLevel,
  };
}

function checkShouldUpgrade(callsUsed: number, callsLimit: number): boolean {
  if (callsLimit <= 0) return false;
  return (callsUsed / callsLimit) >= CALL_THRESHOLD_WARNING;
}

/**
 * Increment call usage for an organization
 * Uses atomic database increment to prevent race conditions
 */
export async function incrementCallUsage(
  organizationId: string
): Promise<{ success: boolean; shouldUpgrade: boolean }> {
  const supabase = createAdminClient();

  const { data: result, error } = await (supabase as any).rpc(
    "increment_call_usage",
    { org_id: organizationId }
  );

  // If the RPC doesn't exist, fall back to regular update (with race condition risk)
  if (error && (error.code === "42883" || error.code === "PGRST202")) {
    const { data: subscription } = await (supabase as any)
      .from("subscriptions")
      .select("id, calls_used, calls_limit")
      .eq("organization_id", organizationId)
      .single();

    if (!subscription) {
      return { success: false, shouldUpgrade: true };
    }

    const newUsage = (subscription.calls_used || 0) + 1;
    const callsLimit = subscription.calls_limit || 150;

    const { error: updateError } = await (supabase as any)
      .from("subscriptions")
      .update({ calls_used: newUsage })
      .eq("id", subscription.id);

    if (updateError) {
      console.error("Failed to update call usage (fallback path):", {
        organizationId,
        subscriptionId: subscription.id,
        error: updateError,
      });
      return { success: false, shouldUpgrade: false };
    }

    return { success: true, shouldUpgrade: checkShouldUpgrade(newUsage, callsLimit) };
  }

  if (error || !result) {
    console.error("Failed to increment call usage:", error);
    return { success: false, shouldUpgrade: false };
  }

  return {
    success: true,
    shouldUpgrade: checkShouldUpgrade(result.calls_used || 0, result.calls_limit || 150),
  };
}

/**
 * Check if organization can make more calls.
 * Soft cap for active paid subscriptions: always allows calls (never block revenue).
 * Hard cap for expired trials and terminal statuses: blocks calls.
 * Fails open on DB errors: never block calls due to infrastructure issues.
 */
export async function canMakeCall(organizationId: string): Promise<boolean> {
  let sub: SubscriptionInfo | null;
  try {
    sub = await getSubscriptionInfo(organizationId);
  } catch (err) {
    console.error("canMakeCall: DB error, allowing call (fail-open):", { organizationId, err });
    return true;
  }

  if (!sub) return false;

  // Only allow calls for active or valid trialing subscriptions
  if (!["active", "trialing"].includes(sub.status)) {
    return false;
  }

  // Expired trial — block calls to enforce conversion to paid
  if (sub.status === "trialing" && sub.trialEnd && new Date() > sub.trialEnd) {
    return false;
  }

  // Active paid subscriptions: soft cap — never block calls
  return true;
}

/**
 * Reset monthly usage at a billing-period reset. Invoked from the
 * invoice.payment_succeeded webhook handler (handleInvoicePaymentSucceeded).
 */
export async function resetMonthlyUsage(organizationId: string): Promise<void> {
  const supabase = createAdminClient();

  const { error } = await (supabase as any)
    .from("subscriptions")
    .update({ calls_used: 0 })
    .eq("organization_id", organizationId);

  if (error) {
    console.error("Failed to reset monthly usage:", { organizationId, error });
    throw new Error(`Failed to reset monthly usage for org ${organizationId}: ${error.message}`);
  }
}

/**
 * Handle invoice.payment_succeeded — reset call usage at the start of a new
 * billing cycle. THROWS on a real DB error so the webhook's idempotency ledger
 * releases the claim and Stripe retries, rather than silently ACKing a usage
 * reset that never happened (SCRUM-409). A missing local subscription row is
 * acked (a retry can't conjure it).
 */
export async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  // Webhook invoices never expand `subscription`, so it is the string id here
  // (the type also allows an expanded Stripe.Subscription). If a future change
  // ever passes an expanded invoice, this cast would put [object Object] into
  // the .eq() filter — revisit then.
  const subscriptionId = invoice.subscription as string | null;
  if (!subscriptionId || invoice.billing_reason !== "subscription_cycle") return;

  const supabase = createAdminClient();
  const { data: sub, error } = await (supabase as any)
    .from("subscriptions")
    .select("organization_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (error) {
    console.error("invoice.payment_succeeded: subscription lookup failed:", {
      stripeSubscriptionId: subscriptionId,
      error,
    });
    throw new Error(
      `invoice.payment_succeeded lookup failed for ${subscriptionId}: ${error.message}`
    );
  }

  if (!sub) {
    console.warn(
      "invoice.payment_succeeded: no local subscription for",
      subscriptionId,
      "— skipping usage reset",
    );
    return;
  }

  // resetMonthlyUsage throws on DB error → propagates so the webhook retries.
  await resetMonthlyUsage(sub.organization_id);
}

/**
 * Handle invoice.payment_failed — mark the subscription past_due. THROWS on a DB
 * error so the webhook retries instead of silently leaving the row "active"
 * (SCRUM-409).
 */
export async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  // Webhook invoices never expand `subscription`, so it is the string id here
  // (the type also allows an expanded Stripe.Subscription). If a future change
  // ever passes an expanded invoice, this cast would put [object Object] into
  // the .eq() filter — revisit then.
  const subscriptionId = invoice.subscription as string | null;
  if (!subscriptionId) return;

  const supabase = createAdminClient();
  const { error } = await (supabase as any)
    .from("subscriptions")
    .update({ status: "past_due" })
    .eq("stripe_subscription_id", subscriptionId);

  if (error) {
    console.error("invoice.payment_failed: failed to mark past_due:", {
      stripeSubscriptionId: subscriptionId,
      error,
    });
    throw new Error(
      `invoice.payment_failed update failed for ${subscriptionId}: ${error.message}`
    );
  }
}

/**
 * Create a checkout session for subscription
 */
export async function createSubscriptionCheckout(
  organizationId: string,
  plan: PlanType,
  successUrl: string,
  cancelUrl: string
): Promise<string | null> {
  const supabase = createAdminClient();
  const stripe = getStripeClient();

  // Get organization and create/get Stripe customer
  const { data: org } = await (supabase as any)
    .from("organizations")
    .select("id, name, stripe_customer_id")
    .eq("id", organizationId)
    .single();

  if (!org) {
    return null;
  }

  // Get the owner's email
  const { data: owner } = await (supabase as any)
    .from("org_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .single();

  const { data: profile } = await (supabase as any)
    .from("user_profiles")
    .select("email")
    .eq("id", owner?.user_id)
    .single();

  let customerId = org.stripe_customer_id;

  // Create Stripe customer if needed
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profile?.email,
      name: org.name,
      metadata: {
        organizationId,
      },
    });
    customerId = customer.id;

    // Fail before creating the session — a paid subscription with no linked
    // Stripe customer on the org is a manual-reconciliation dead-end, while
    // an orphaned empty Stripe customer is recoverable (SCRUM-421 review).
    const { error: customerSaveError } = await (supabase as any)
      .from("organizations")
      .update({ stripe_customer_id: customerId })
      .eq("id", organizationId);
    if (customerSaveError) {
      console.error("[Billing] Failed to persist stripe_customer_id:", {
        organizationId,
        customerId,
        error: customerSaveError,
      });
      return null;
    }
  }

  // Get price ID for plan
  const planConfig = PLANS[plan];
  if (!planConfig?.stripePriceId) {
    console.error(`No Stripe price ID configured for plan: ${plan}`);
    return null;
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [
      {
        price: planConfig.stripePriceId,
        quantity: 1,
      },
    ],
    mode: "subscription",
    subscription_data: {
      trial_period_days: ("trialDays" in planConfig ? planConfig.trialDays : 14) || 14,
      metadata: {
        organizationId,
        plan,
      },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      organizationId,
      plan,
    },
  });

  return session.url;
}

/**
 * Handle successful subscription from Stripe webhook
 */
export async function handleSubscriptionCreated(
  subscription: Stripe.Subscription,
  fallback?: { organizationId?: string | null; plan?: string | null }
): Promise<void> {
  const supabase = createAdminClient();

  // Prefer the subscription metadata (set via subscription_data.metadata at
  // checkout); fall back to the Checkout Session metadata for any session
  // created before that fix shipped.
  const organizationId =
    subscription.metadata?.organizationId || fallback?.organizationId;

  if (!organizationId) {
    // After the subscription_data.metadata fix + the session-metadata fallback,
    // every subscription created through our checkout carries an org. Reaching
    // here means an out-of-band subscription (e.g. created directly in the Stripe
    // dashboard) with no org to link — retrying can never resolve it, so log
    // loudly and ack rather than throw (which would retry-storm for ~3 days).
    console.error(
      "handleSubscriptionCreated: no organizationId on subscription (subscription + session metadata both empty) — likely out-of-band; not linking",
      { stripeSubscriptionId: subscription.id, status: subscription.status }
    );
    return;
  }

  // SCRUM-433: the upsert below is keyed on organization_id, so if the org's
  // row already points at a DIFFERENT live Stripe subscription, blindly
  // overwriting would ORPHAN that subscription — Stripe keeps billing it while
  // our DB no longer knows it exists. This can only be the duplicate-checkout
  // race (two tabs with different plans → different idempotency keys → two real
  // subs): legitimate plan changes never arrive here as a NEW subscription
  // (subscribed orgs are routed to the Billing Portal, which swaps the price on
  // the EXISTING subscription → customer.subscription.updated), and out-of-band
  // dashboard subs carry no organizationId metadata so they bail above. Resolve
  // by letting the incoming subscription win (matching the upsert) and
  // canceling the orphan so the customer is never double-billed.
  const { data: existingRow, error: existingLookupError } = await (supabase as any)
    .from("subscriptions")
    .select("stripe_subscription_id, status")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existingLookupError) {
    // Can't tell whether an orphan exists — throw so the webhook's idempotency
    // ledger releases the claim and Stripe retries, rather than guessing.
    console.error("handleSubscriptionCreated: existing-subscription lookup failed:", {
      stripeSubscriptionId: subscription.id,
      organizationId,
      error: existingLookupError,
    });
    throw new Error(
      `Existing subscription lookup failed for org ${organizationId}: ${existingLookupError.message}`
    );
  }

  const existingId: string = existingRow?.stripe_subscription_id ?? "";
  const conflictsWithLiveSub =
    existingId !== "" &&
    !existingId.startsWith("trial_") &&
    existingId !== subscription.id &&
    LIVE_SUBSCRIPTION_STATUSES.includes(existingRow?.status ?? "");

  if (conflictsWithLiveSub) {
    const stripe = getStripeClient();

    // Each subscription funnels through here twice (checkout.session.completed
    // AND customer.subscription.created), and the created-event payload is a
    // creation-time snapshot — so re-retrieve the incoming sub first. If it is
    // no longer live, it LOST this race in an earlier pass (we already canceled
    // it); writing it now would cancel the survivor and leave the org with no
    // live subscription at all.
    //
    // NOTE: equating "not live" with "lost an earlier race" assumes card-only
    // checkout, where a just-created subscription can never be 'incomplete'
    // (cards settle synchronously at checkout). If delayed payment methods
    // (e.g. bank debits) are ever enabled, an incoming sub could legitimately
    // sit at 'incomplete' here and this branch must be revisited.
    const incomingFresh = await stripe.subscriptions.retrieve(subscription.id);
    if (!LIVE_SUBSCRIPTION_STATUSES.includes(incomingFresh.status)) {
      console.warn(
        "handleSubscriptionCreated: incoming subscription no longer live (lost the duplicate-checkout race) — keeping existing row:",
        { incoming: subscription.id, existing: existingId, organizationId }
      );
      return;
    }

    // Re-retrieve the existing sub too: the DB status may be stale (e.g. its
    // cancellation webhook hasn't landed yet). Only cancel when it is REALLY
    // still live at Stripe.
    let existingLive = false;
    try {
      const existingFresh = await stripe.subscriptions.retrieve(existingId);
      existingLive = LIVE_SUBSCRIPTION_STATUSES.includes(existingFresh.status);
    } catch (err) {
      if ((err as { code?: string })?.code !== "resource_missing") {
        throw err; // transient Stripe error → webhook retries
      }
      // resource_missing: nothing live to orphan — safe to overwrite.
    }

    if (existingLive) {
      // Both subscriptions are live: the customer is being double-billed RIGHT
      // NOW. Cancel the orphaned (previous) one — the incoming sub wins, which
      // matches what the upsert records. Cancellation stops future billing but
      // does NOT refund an already-paid invoice, so flag it for follow-up.
      //
      // Capture to Sentry BEFORE attempting the cancel: if the cancel keeps
      // failing (webhook retries eventually exhaust), the customer stays
      // actively double-billed and a post-cancel capture would never fire.
      Sentry.withScope((scope) => {
        scope.setExtras({
          organizationId,
          canceledSubscriptionId: existingId,
          keptSubscriptionId: subscription.id,
        });
        Sentry.captureMessage(
          "Stripe duplicate subscription detected: canceling orphaned subscription — verify no refund is owed",
          "warning"
        );
      });
      await stripe.subscriptions.cancel(existingId);
      console.error(
        "handleSubscriptionCreated: duplicate live subscriptions for org — canceled the orphaned one (verify no refund is owed):",
        { canceled: existingId, kept: subscription.id, organizationId }
      );
    } else {
      console.warn(
        "handleSubscriptionCreated: DB row pointed at a non-live subscription (stale status) — overwriting without cancel:",
        { previous: existingId, incoming: subscription.id, organizationId }
      );
    }
  }

  // Resolve the plan from the subscription's actual price id first (the only
  // source that stays correct across Stripe-portal plan switches); fall back to
  // metadata (subscription, then session) and finally to starter.
  const priceId = subscription.items.data[0]?.price.id;
  const planFromPrice = planTypeFromPriceId(priceId);
  const plan =
    planFromPrice ??
    resolvePlanType(
      subscription.metadata?.plan || fallback?.plan || "starter",
      true
    );
  const planConfig = PLANS[plan];

  if (priceId && !planFromPrice) {
    // The price id isn't wired into PLANS (STRIPE_*_PRICE_ID drift, or a new
    // Stripe price). We fell back to metadata/starter, which goes stale across
    // portal switches — log it so the misconfig is visible, not silent.
    console.error("handleSubscriptionCreated: price id did not map to a known plan; used fallback", {
      stripeSubscriptionId: subscription.id,
      priceId,
      resolvedPlan: plan,
    });
  }

  // Upsert subscription record
  // Note: stripe_customer_id lives on the organizations table, not subscriptions
  const { error: upsertError } = await (supabase as any)
    .from("subscriptions")
    .upsert({
      organization_id: organizationId,
      stripe_subscription_id: subscription.id,
      stripe_price_id: priceId ?? planConfig?.stripePriceId ?? "unknown",
      plan_type: plan,
      status: subscription.status,
      calls_limit: planConfig?.callsLimit ?? 150,
      calls_used: 0, // Reset — safe because this only fires on initial creation or trial-to-paid
      assistants_limit: planConfig?.assistants ?? 1,
      phone_numbers_limit: planConfig?.phoneNumbers ?? 1,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      trial_end: subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
    }, {
      onConflict: "organization_id",
    });

  if (upsertError) {
    console.error("Failed to upsert subscription from Stripe webhook:", {
      stripeSubscriptionId: subscription.id,
      organizationId,
      plan,
      error: upsertError,
    });
    throw new Error(`Subscription upsert failed: ${upsertError.message}`);
  }
}

/**
 * Handle subscription update from Stripe webhook
 */
export async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription
): Promise<void> {
  const supabase = createAdminClient();

  // Verify subscription exists
  const { data: existingSub, error: lookupError } = await (supabase as any)
    .from("subscriptions")
    .select("organization_id, plan_type")
    .eq("stripe_subscription_id", subscription.id)
    .single();

  if (lookupError && lookupError.code !== "PGRST116") {
    console.error("DB error looking up subscription:", {
      stripeSubscriptionId: subscription.id,
      error: lookupError,
    });
    throw new Error(`Failed to look up subscription ${subscription.id}: ${lookupError.message}`);
  }

  if (!existingSub) {
    console.error("Could not find subscription for Stripe ID:", subscription.id);
    return;
  }

  // Resolve the plan from the subscription's current price id — this is what a
  // Stripe Billing Portal upgrade/downgrade actually changes. Metadata is only a
  // fallback (portal switches do NOT rewrite it, so it goes stale immediately).
  const priceId = subscription.items.data[0]?.price.id;
  const planFromPrice = planTypeFromPriceId(priceId);
  const plan =
    planFromPrice ??
    (subscription.metadata?.plan
      ? resolvePlanType(subscription.metadata.plan, true)
      : undefined);
  const planConfig = plan ? PLANS[plan] : undefined;

  if (priceId && !planFromPrice) {
    // Price id didn't map to a known plan (STRIPE_*_PRICE_ID drift or a new
    // Stripe price). If metadata still resolved a plan we'd otherwise sync a
    // STALE value silently; if nothing resolved, plan_type/limits stay stale.
    // Either way, surface it — this is the only signal that the price→plan map
    // is misconfigured for a real subscription.
    console.error("handleSubscriptionUpdated: price id did not map to a known plan", {
      stripeSubscriptionId: subscription.id,
      priceId,
      resolvedFromMetadata: plan ?? null,
    });
  }

  // Build update payload — always sync status & period, optionally sync plan
  const updatePayload: Record<string, any> = {
    status: subscription.status,
    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end,
    stripe_price_id: priceId,
  };

  if (plan && planConfig) {
    updatePayload.plan_type = plan;
    updatePayload.calls_limit = planConfig.callsLimit;
    updatePayload.assistants_limit = planConfig.assistants;
    updatePayload.phone_numbers_limit = planConfig.phoneNumbers;

    // Downgrade policy: the new (lower) limits take effect immediately, so
    // checkResourceLimit blocks creating NEW assistants/numbers over the cap.
    // Existing over-limit resources are grandfathered (we never auto-delete a
    // customer's data from a webhook). Log the transition so a downgrade that
    // leaves an org over its new limits is visible rather than silent.
    if (existingSub.plan_type && existingSub.plan_type !== plan) {
      console.log("Subscription plan changed:", {
        stripeSubscriptionId: subscription.id,
        organizationId: existingSub.organization_id,
        from: existingSub.plan_type,
        to: plan,
      });
    }
  }

  // Note: We don't reset calls_used here — that's handled by invoice.payment_succeeded
  const { error } = await (supabase as any)
    .from("subscriptions")
    .update(updatePayload)
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    console.error("Failed to update subscription:", {
      stripeSubscriptionId: subscription.id,
      error,
    });
    throw new Error(`Subscription update failed: ${error.message}`);
  }
}

/**
 * Handle subscription cancellation from Stripe webhook
 */
export async function handleSubscriptionCanceled(
  subscription: Stripe.Subscription
): Promise<void> {
  const supabase = createAdminClient();

  // SCRUM-475: persist when paid access actually ENDED as the lapse anchor —
  // NOT when cancellation was requested. Stripe sets ended_at to the access-end
  // instant for BOTH immediate cancels (= now) AND cancel_at_period_end (= the
  // period end); canceled_at is the REQUEST time and is correct only for
  // immediate cancels. For a period-end cancellation the deletion event fires at
  // period end carrying canceled_at = the earlier request time, so anchoring on
  // canceled_at would zero the grace window and back-date the 90-day reclaim.
  // Prefer ended_at, fall back to canceled_at. Both are epoch SECONDS, so ×1000
  // (same convention as current_period_end/trial_end above). If neither is
  // present (shouldn't happen on a deletion event) we write null, and the
  // lapse-state helper falls back to current_period_end.
  const serviceEndedAtUnix = subscription.ended_at ?? subscription.canceled_at;
  const serviceEndedAt = serviceEndedAtUnix
    ? new Date(serviceEndedAtUnix * 1000).toISOString()
    : null;

  const { error } = await (supabase as any)
    .from("subscriptions")
    .update({
      status: "canceled",
      cancel_at_period_end: true,
      service_ended_at: serviceEndedAt,
    })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    console.error("Failed to cancel subscription:", {
      stripeSubscriptionId: subscription.id,
      error,
    });
    throw new Error(`Subscription cancellation failed: ${error.message}`);
  }
}

/**
 * Get billing portal URL for customer
 */
export async function getBillingPortalUrl(
  organizationId: string,
  returnUrl: string
): Promise<string | null> {
  const supabase = createAdminClient();
  const stripe = getStripeClient();

  const { data: org } = await (supabase as any)
    .from("organizations")
    .select("stripe_customer_id")
    .eq("id", organizationId)
    .single();

  if (!org?.stripe_customer_id) {
    return null;
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: returnUrl,
  });

  return session.url;
}

/**
 * Check if an organization can create more of a limited resource (assistants or phone numbers).
 * Fails open on DB errors — a transient outage should not block resource creation.
 * During onboarding (no subscription yet), allows exactly 1 resource.
 */
export async function checkResourceLimit(
  organizationId: string,
  resource: LimitedResource
): Promise<ResourceLimitResult> {
  const failOpen: ResourceLimitResult = { allowed: true, currentCount: 0, limit: -1, plan: null };

  let subscription: SubscriptionInfo | null;
  try {
    subscription = await getSubscriptionInfo(organizationId);
  } catch (err) {
    console.error("checkResourceLimit: DB error, failing open:", { organizationId, resource, err });
    return failOpen;
  }

  // Count existing resources
  const supabase = createAdminClient();
  const table = resource === "assistants" ? "assistants" : "phone_numbers";

  let currentCount: number;
  try {
    const { count, error: countError } = await (supabase as any)
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);

    if (countError) {
      console.error("checkResourceLimit: count query failed, failing open:", { organizationId, resource, countError });
      return failOpen;
    }
    currentCount = count ?? 0;
  } catch (err) {
    console.error("checkResourceLimit: count query threw, failing open:", { organizationId, resource, err });
    return failOpen;
  }

  // No subscription — bootstrapping during onboarding. Allow first resource only.
  if (!subscription) {
    return {
      allowed: currentCount === 0,
      currentCount,
      limit: 1,
      plan: null,
    };
  }

  // Only enforce for active or trialing subscriptions
  if (!["active", "trialing"].includes(subscription.status)) {
    return { allowed: false, currentCount, limit: 0, plan: subscription.plan };
  }

  // Block expired trials
  if (subscription.status === "trialing" && subscription.trialEnd && new Date() > subscription.trialEnd) {
    return { allowed: false, currentCount, limit: 0, plan: subscription.plan };
  }

  const planConfig = PLANS[subscription.plan];
  if (!planConfig) {
    console.error("checkResourceLimit: unknown plan, failing open:", { plan: subscription.plan, organizationId });
    return failOpen;
  }
  const limit = resource === "assistants"
    ? planConfig.assistants
    : planConfig.phoneNumbers;

  // -1 = unlimited (agency plans)
  if (limit === -1) {
    return { allowed: true, currentCount, limit: -1, plan: subscription.plan };
  }

  return {
    allowed: currentCount < limit,
    currentCount,
    limit,
    plan: subscription.plan,
  };
}

/**
 * Check feature access based on plan.
 * Fails open on DB errors — a transient outage should not revoke paid features.
 * Returns false only when we're confident the plan lacks the feature.
 */
export async function hasFeatureAccess(
  organizationId: string,
  feature: GatedFeature
): Promise<boolean> {
  let subscription: SubscriptionInfo | null;
  try {
    subscription = await getSubscriptionInfo(organizationId);
  } catch (err) {
    console.error("hasFeatureAccess: DB error, failing open:", { organizationId, feature, err });
    return true;
  }

  if (!subscription) {
    return false;
  }

  // Only grant feature access for active or trialing subscriptions
  if (!["active", "trialing"].includes(subscription.status)) {
    return false;
  }

  // Block expired trials
  if (subscription.status === "trialing" && subscription.trialEnd && new Date() > subscription.trialEnd) {
    return false;
  }

  const planConfig = PLANS[subscription.plan];

  // Type guard for feature access
  if (feature in planConfig) {
    return !!(planConfig as any)[feature];
  }

  return false;
}
