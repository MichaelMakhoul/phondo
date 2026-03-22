import Stripe from "stripe";

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2025-02-24.acacia",
    });
  }
  return stripeClient;
}

// AUD call-based pricing model (SMB-first). Stripe price IDs set via env vars (see .env.example).
export const PLANS = {
  starter: {
    name: "Starter",
    description: "Perfect for getting started",
    price: 14900, // $149 AUD/month
    callsLimit: 150,
    assistants: 1,
    phoneNumbers: 1,
    calendarIntegration: true,
    callTransfer: true,
    prioritySupport: false,
    smsNotifications: false,
    webhookIntegrations: false,
    nativeCrmLimit: 0,
    advancedAnalytics: false,
    practitioners: false,
    practitionersLimit: 0,
    highlighted: false,
    trialDays: 14,
    stripePriceId: process.env.STRIPE_STARTER_PRICE_ID,
    features: [
      "150 calls/month",
      "1 AI assistant",
      "1 phone number",
      "Calendar booking",
      "Call transfers",
      "Call transcripts",
      "Solo practitioner only",
    ],
  },
  professional: {
    name: "Professional",
    description: "For growing businesses",
    price: 24900, // $249 AUD/month
    callsLimit: 400,
    assistants: 3,
    phoneNumbers: 2,
    calendarIntegration: true,
    callTransfer: true,
    prioritySupport: false,
    smsNotifications: true,
    webhookIntegrations: true,
    nativeCrmLimit: 1,
    advancedAnalytics: true,
    practitioners: true,
    practitionersLimit: 5,
    highlighted: true,
    trialDays: 14,
    stripePriceId: process.env.STRIPE_PROFESSIONAL_PRICE_ID,
    features: [
      "400 calls/month",
      "3 AI assistants",
      "2 phone numbers",
      "SMS notifications",
      "Advanced analytics dashboard",
      "Up to 5 staff members",
      "Call recording",
    ],
  },
  business: {
    name: "Business",
    description: "For high-volume businesses",
    price: 39900, // $399 AUD/month
    callsLimit: 1000,
    assistants: 10,
    phoneNumbers: 5,
    calendarIntegration: true,
    callTransfer: true,
    prioritySupport: true,
    smsNotifications: true,
    webhookIntegrations: true,
    nativeCrmLimit: 3,
    advancedAnalytics: true,
    practitioners: true,
    practitionersLimit: 15,
    highlighted: false,
    trialDays: 14,
    stripePriceId: process.env.STRIPE_BUSINESS_PRICE_ID,
    features: [
      "1,000 calls/month",
      "10 AI assistants",
      "5 phone numbers",
      "Up to 15 staff members",
      "Everything in Professional",
      "Dedicated onboarding support",
    ],
  },
  // Agency tiers (Phase 2 — not shown in UI, no Stripe products created yet)
  agency_starter: {
    name: "Agency Starter",
    description: "For small agencies",
    price: 19900,
    callsLimit: 0,
    assistants: -1,
    phoneNumbers: -1,
    subaccounts: 10,
    ratePerCall: 50,
    practitioners: true,
    practitionersLimit: -1,
    highlighted: false,
    stripePriceId: process.env.STRIPE_AGENCY_STARTER_PRICE_ID,
    features: [
      "Up to 10 client accounts",
      "Unlimited assistants",
      "White-label options",
      "$0.50/call",
    ],
  },
  agency_growth: {
    name: "Agency Growth",
    description: "For growing agencies",
    price: 49900,
    callsLimit: 0,
    assistants: -1,
    phoneNumbers: -1,
    subaccounts: 50,
    ratePerCall: 35,
    practitioners: true,
    practitionersLimit: -1,
    highlighted: false,
    stripePriceId: process.env.STRIPE_AGENCY_GROWTH_PRICE_ID,
    features: [
      "Up to 50 client accounts",
      "Unlimited assistants",
      "Full white-label",
      "$0.35/call",
    ],
  },
  agency_scale: {
    name: "Agency Scale",
    description: "For enterprise agencies",
    price: 99900,
    callsLimit: 0,
    assistants: -1,
    phoneNumbers: -1,
    subaccounts: -1,
    ratePerCall: 25,
    practitioners: true,
    practitionersLimit: -1,
    highlighted: false,
    stripePriceId: process.env.STRIPE_AGENCY_SCALE_PRICE_ID,
    features: [
      "Unlimited client accounts",
      "Custom integrations",
      "Dedicated support",
      "$0.25/call",
    ],
  },
} as const;

export type PlanType = keyof typeof PLANS;

// Soft cap thresholds — never block calls
export const CALL_THRESHOLD_WARNING = 0.8; // Warn at 80% usage
export const CALL_THRESHOLD_LIMIT = 1.0; // At 100% — send upgrade nudge
export const CALL_THRESHOLD_OVER = 1.2; // At 120% — strong upgrade nudge

/** Returns SMB plans for display in UI (excludes agency tiers). */
export function getDisplayPlans() {
  return [
    { id: "starter" as PlanType, ...PLANS.starter },
    { id: "professional" as PlanType, ...PLANS.professional },
    { id: "business" as PlanType, ...PLANS.business },
  ];
}

export async function createCustomer(
  email: string,
  name: string,
  organizationId: string
): Promise<Stripe.Customer> {
  const stripe = getStripeClient();
  return stripe.customers.create({
    email,
    name,
    metadata: {
      organizationId,
    },
  });
}

export async function createCheckoutSession(
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
  metadata?: Record<string, string>
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient();
  return stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    mode: "subscription",
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
  });
}

export async function createBillingPortalSession(
  customerId: string,
  returnUrl: string
): Promise<Stripe.BillingPortal.Session> {
  const stripe = getStripeClient();
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

export async function getSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  const stripe = getStripeClient();
  return stripe.subscriptions.retrieve(subscriptionId);
}

export async function cancelSubscription(
  subscriptionId: string,
  cancelAtPeriodEnd: boolean = true
): Promise<Stripe.Subscription> {
  const stripe = getStripeClient();
  return stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: cancelAtPeriodEnd,
  });
}

export async function reportUsage(
  subscriptionItemId: string,
  quantity: number,
  timestamp?: number
): Promise<Stripe.UsageRecord> {
  const stripe = getStripeClient();
  return stripe.subscriptionItems.createUsageRecord(subscriptionItemId, {
    quantity,
    timestamp: timestamp || Math.floor(Date.now() / 1000),
    action: "increment",
  });
}

export function constructWebhookEvent(
  payload: string,
  signature: string
): Stripe.Event {
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  );
}
