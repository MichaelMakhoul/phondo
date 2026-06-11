import crypto from "crypto";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  blocksNewCheckout,
  LIVE_SUBSCRIPTION_STATUSES,
} from "@/lib/stripe/billing-service";
import {
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  retrieveCheckoutSession,
  getSubscription,
  PLANS,
  PlanType,
} from "@/lib/stripe";

interface Organization {
  id: string;
  name: string;
  stripe_customer_id: string | null;
}

interface Membership {
  organization_id: string;
  role: string;
  organizations: Organization;
}

// Shared "already subscribed" response. Creating another checkout would
// produce a duplicate live subscription, so route the customer to the Stripe
// billing portal to change/manage their plan instead — the same destination
// as the dashboard "Downgrade" button. The "Upgrade" button POSTs here, so
// returning a portal URL (the client just redirects to `url`) keeps that CTA
// working for existing subscribers rather than dead-ending on an error.
async function respondAlreadySubscribed(
  stripeCustomerId: string | null,
  baseUrl: string
): Promise<NextResponse> {
  if (stripeCustomerId) {
    const portal = await createBillingPortalSession(
      stripeCustomerId,
      `${baseUrl}/billing`
    );
    return NextResponse.json({ url: portal.url });
  }
  return NextResponse.json(
    {
      error:
        "Your organization already has an active subscription. Manage it from the billing portal.",
      code: "already_subscribed",
    },
    { status: 409 }
  );
}

// POST /api/billing/checkout - Create a checkout session
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select(`
        organization_id,
        role,
        organizations (id, name, stripe_customer_id)
      `)
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    const organization = membership.organizations;

    const body = await request.json();
    const { planType } = body as { planType: PlanType };

    const plan = PLANS[planType];
    if (!plan || !plan.stripePriceId) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    // Block a second checkout when the org already has a real (non-placeholder)
    // active subscription — otherwise two completed sessions create two
    // concurrent live Stripe subscriptions, double-billing the customer while
    // our DB (upsert keyed on organization_id) shows only one. The trial_<orgId>
    // placeholder does NOT block: converting a free trial to paid is the point.
    // Read with the service-role client so the guard isn't dependent on RLS.
    const admin = createAdminClient();
    const { data: existingSub, error: subLookupError } = await (admin as any)
      .from("subscriptions")
      .select("stripe_subscription_id, status")
      .eq("organization_id", organization.id)
      .maybeSingle();

    if (subLookupError) {
      console.error("Checkout: failed to check existing subscription", {
        organizationId: organization.id,
        error: subLookupError,
      });
      return NextResponse.json(
        { error: "Failed to verify subscription status" },
        { status: 500 }
      );
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    if (blocksNewCheckout(existingSub)) {
      // Org is already paying — see respondAlreadySubscribed.
      return respondAlreadySubscribed(organization.stripe_customer_id, baseUrl);
    }

    // Get or create Stripe customer
    let customerId = organization.stripe_customer_id;
    if (!customerId) {
      const customer = await createCustomer(
        user.email!,
        organization.name,
        organization.id
      );
      customerId = customer.id;

      // Save customer ID to organization. Must use the service-role client:
      // stripe_customer_id is locked to service-role by the column-level
      // UPDATE allowlist (migration 00150 / SCRUM-421) — the user-scoped
      // client would get "permission denied for column".
      //
      // Fail BEFORE creating the checkout session: an unsaved customer id +
      // a completed payment leaves a live subscription with no linked Stripe
      // customer on the org (billing portal 400s, retried checkout 409s — a
      // circular dead-end needing manual reconciliation). Failing here only
      // orphans an empty Stripe customer, which is recoverable.
      const { error: customerSaveError } = await (admin
        .from("organizations") as any)
        .update({ stripe_customer_id: customerId })
        .eq("id", organization.id);
      if (customerSaveError) {
        console.error("Checkout: failed to persist stripe_customer_id", {
          organizationId: organization.id,
          customerId,
          error: customerSaveError,
        });
        return NextResponse.json(
          { error: "Failed to set up billing. Please try again." },
          { status: 500 }
        );
      }
    }

    // Create checkout session. Metadata uses the `plan` key (handleSubscriptionCreated
    // reads metadata.plan), and the idempotency key — bucketed by org+plan+hour —
    // collapses an accidental double-submit of the same plan into one session.
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const idempotencyKey = `checkout:${organization.id}:${planType}:${hourBucket}`;
    const successUrl = `${baseUrl}/billing?success=true`;
    const cancelUrl = `${baseUrl}/billing?canceled=true`;
    const metadata = { organizationId: organization.id, plan: planType };

    let session: Stripe.Checkout.Session;
    try {
      session = await createCheckoutSession(
        customerId,
        plan.stripePriceId,
        successUrl,
        cancelUrl,
        metadata,
        { idempotencyKey }
      );

      // Stripe's idempotency layer replays the ORIGINAL create response for a
      // reused key, which reports the session's status AT CREATION ("open") —
      // even if the caller already completed it (subscribe → cancel →
      // re-subscribe to the same plan within one hour bucket). Retrieve the
      // LIVE session to find out. The create above already succeeded, so a
      // transient retrieve failure must NOT fail the whole checkout — fall
      // back to the created session's URL (a stale replay is rarer and less
      // harmful than 500ing a healthy checkout).
      let liveSession: Stripe.Checkout.Session | null = null;
      try {
        liveSession = await retrieveCheckoutSession(session.id);
      } catch (retrieveErr) {
        console.warn(
          "Checkout: live-session retrieve failed — returning the created session as-is",
          {
            organizationId: organization.id,
            planType,
            sessionId: session.id,
            error: retrieveErr,
          }
        );
      }

      if (
        liveSession &&
        (liveSession.status === "complete" || liveSession.status === "expired")
      ) {
        if (liveSession.status === "complete") {
          // The replayed session was already PAID. If the subscription it
          // created is still live, the org IS subscribed and the DB guard
          // above just hasn't caught up yet (webhook lag) — minting a fresh
          // payable session here would re-open the same-plan double-subscribe
          // window. Respond exactly like the already-subscribed path instead.
          const completedSubId =
            typeof liveSession.subscription === "string"
              ? liveSession.subscription
              : liveSession.subscription?.id ?? null;
          if (completedSubId) {
            const completedSub = await getSubscription(completedSubId);
            if (LIVE_SUBSCRIPTION_STATUSES.includes(completedSub.status)) {
              console.warn(
                "Checkout: replayed session already completed with a live subscription — routing to billing portal",
                {
                  organizationId: organization.id,
                  planType,
                  sessionId: session.id,
                  subscriptionId: completedSubId,
                }
              );
              return respondAlreadySubscribed(customerId, baseUrl);
            }
          }
        }

        // Session expired, or completed but its subscription is no longer
        // live (subscribe → cancel → re-subscribe within one hour bucket) —
        // mint a fresh single-use key so the customer gets a working checkout
        // page instead of a dead one.
        console.warn("Checkout: idempotency key replayed a stale session; minting a fresh one", {
          organizationId: organization.id,
          planType,
          staleSessionId: session.id,
          staleStatus: liveSession.status,
        });
        session = await createCheckoutSession(
          customerId,
          plan.stripePriceId,
          successUrl,
          cancelUrl,
          metadata,
          { idempotencyKey: `${idempotencyKey}:${crypto.randomUUID()}` }
        );
      }
    } catch (err) {
      if (!(err instanceof Stripe.errors.StripeIdempotencyError)) {
        throw err;
      }
      if (err.statusCode === 409) {
        // HTTP 409: a concurrent request with the same key is still in
        // flight — the double-submit race on a first-ever checkout. Not a
        // server fault: return a retry-friendly conflict instead of a
        // generic 500.
        return NextResponse.json(
          {
            error:
              "A checkout is already in progress — use that tab or retry in a moment.",
            code: "checkout_in_progress",
          },
          { status: 409 }
        );
      }
      // Any other idempotency failure is key-reuse-with-DIFFERENT-params
      // (Stripe returns HTTP 400 — e.g. the plan's price id changed inside
      // one hour bucket). The bucketed key is poisoned for this request
      // shape, so retry ONCE with a fresh nonce-suffixed key; if the retry
      // also fails, let it propagate to the outer handler.
      console.warn(
        "Checkout: idempotency key reused with different params — retrying once with a fresh key",
        {
          organizationId: organization.id,
          planType,
          statusCode: err.statusCode,
        }
      );
      session = await createCheckoutSession(
        customerId,
        plan.stripePriceId,
        successUrl,
        cancelUrl,
        metadata,
        { idempotencyKey: `${idempotencyKey}:${crypto.randomUUID()}` }
      );
    }

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("Checkout error:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
