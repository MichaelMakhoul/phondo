import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { blocksNewCheckout } from "@/lib/stripe/billing-service";
import {
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
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
      // Org is already paying. Creating a second checkout would produce a
      // duplicate live subscription, so route them to the Stripe billing portal
      // to change/manage their plan instead — the same destination as the
      // dashboard "Downgrade" button. The "Upgrade" button POSTs here, so
      // returning a portal URL (the client just redirects to `url`) keeps that
      // CTA working for existing subscribers rather than dead-ending on an error.
      if (organization.stripe_customer_id) {
        const portal = await createBillingPortalSession(
          organization.stripe_customer_id,
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
    const session = await createCheckoutSession(
      customerId,
      plan.stripePriceId,
      `${baseUrl}/billing?success=true`,
      `${baseUrl}/billing?canceled=true`,
      { organizationId: organization.id, plan: planType },
      { idempotencyKey: `checkout:${organization.id}:${planType}:${hourBucket}` }
    );

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("Checkout error:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
