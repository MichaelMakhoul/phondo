/**
 * Billing Service
 *
 * Handles subscription management, usage tracking, and billing operations.
 * Implements the new call-based (not minute-based) pricing model.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  getStripeClient,
  PLANS,
  PlanType,
  CALL_THRESHOLD_WARNING,
  CALL_THRESHOLD_LIMIT,
  CALL_THRESHOLD_OVER,
} from "./client";
import type Stripe from "stripe";

export interface SubscriptionInfo {
  id: string;
  plan: PlanType;
  status: string;
  callsLimit: number;
  callsUsed: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
}

export type WarningLevel = "none" | "approaching" | "at_limit" | "over_limit";

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

  if (error || !subscription) {
    return null;
  }

  const plan = (subscription.plan_type || "starter") as PlanType;
  const planConfig = PLANS[plan];

  return {
    id: subscription.id,
    plan,
    status: subscription.status,
    callsLimit: planConfig?.callsLimit ?? 100,
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
  const subscription = await getSubscriptionInfo(organizationId);

  if (!subscription) {
    return {
      callsUsed: 0,
      callsLimit: 0,
      usagePercentage: 0,
      isOverLimit: false,
      shouldWarn: false,
      warningLevel: "none" as WarningLevel,
    };
  }

  const { callsUsed, callsLimit } = subscription;

  if (callsLimit === -1) {
    return {
      callsUsed,
      callsLimit: -1,
      usagePercentage: 0,
      isOverLimit: false,
      shouldWarn: false,
      warningLevel: "none" as WarningLevel,
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
      .select("id, plan_type, calls_used, calls_limit")
      .eq("organization_id", organizationId)
      .single();

    if (!subscription) {
      return { success: false, shouldUpgrade: true };
    }

    const newUsage = (subscription.calls_used || 0) + 1;
    const callsLimit = subscription.calls_limit || 100;

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
    shouldUpgrade: checkShouldUpgrade(result.calls_used || 0, result.calls_limit || 100),
  };
}

/**
 * Check if organization can make more calls.
 * Soft cap: always returns true — we never block calls.
 * The voice server uses this; blocking calls loses revenue.
 */
export async function canMakeCall(_organizationId: string): Promise<boolean> {
  return true;
}

/**
 * Reset monthly usage (called by cron job at billing period reset)
 */
export async function resetMonthlyUsage(organizationId: string): Promise<void> {
  const supabase = createAdminClient();

  await (supabase as any)
    .from("subscriptions")
    .update({ calls_used: 0 })
    .eq("organization_id", organizationId);
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

    await (supabase as any)
      .from("organizations")
      .update({ stripe_customer_id: customerId })
      .eq("id", organizationId);
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
  subscription: Stripe.Subscription
): Promise<void> {
  const supabase = createAdminClient();

  const organizationId = subscription.metadata?.organizationId;
  const plan = (subscription.metadata?.plan || "starter") as PlanType;

  if (!organizationId) {
    console.error("No organizationId in subscription metadata");
    return;
  }

  const planConfig = PLANS[plan];

  // Upsert subscription record
  // Note: stripe_customer_id lives on organizations, not subscriptions
  await (supabase as any)
    .from("subscriptions")
    .upsert({
      organization_id: organizationId,
      stripe_subscription_id: subscription.id,
      plan_type: plan,
      status: subscription.status,
      calls_limit: planConfig?.callsLimit ?? 150,
      calls_used: 0,
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
}

/**
 * Handle subscription update from Stripe webhook
 */
export async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription
): Promise<void> {
  const supabase = createAdminClient();

  // Verify subscription exists
  const { data: existingSub } = await (supabase as any)
    .from("subscriptions")
    .select("organization_id")
    .eq("stripe_subscription_id", subscription.id)
    .single();

  if (!existingSub) {
    console.error("Could not find subscription for Stripe ID:", subscription.id);
    return;
  }

  // Update subscription record
  // Note: We don't reset calls_used here - that's handled by invoice.payment_succeeded
  const { error } = await (supabase as any)
    .from("subscriptions")
    .update({
      status: subscription.status,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end,
    })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    console.error("Failed to update subscription:", error);
  }
}

/**
 * Handle subscription cancellation from Stripe webhook
 */
export async function handleSubscriptionCanceled(
  subscription: Stripe.Subscription
): Promise<void> {
  const supabase = createAdminClient();

  await (supabase as any)
    .from("subscriptions")
    .update({
      status: "canceled",
      cancel_at_period_end: true,
    })
    .eq("stripe_subscription_id", subscription.id);
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
 * Get available plans for display
 */
export function getAvailablePlans() {
  return [
    {
      id: "starter" as PlanType,
      ...PLANS.starter,
    },
    {
      id: "professional" as PlanType,
      ...PLANS.professional,
    },
    {
      id: "business" as PlanType,
      ...PLANS.business,
    },
  ];
}

/**
 * Check feature access based on plan
 */
export async function hasFeatureAccess(
  organizationId: string,
  feature: "calendarIntegration" | "callTransfer" | "advancedAnalytics" | "customVoice" | "humanEscalation"
): Promise<boolean> {
  const subscription = await getSubscriptionInfo(organizationId);

  if (!subscription) {
    return false;
  }

  const planConfig = PLANS[subscription.plan];

  // Type guard for feature access
  if (feature in planConfig) {
    return !!(planConfig as any)[feature];
  }

  return false;
}
