import { NextResponse } from "next/server";
import { constructWebhookEvent } from "@/lib/stripe";
import {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionCanceled,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
} from "@/lib/stripe/billing-service";
import { createAdminClient } from "@/lib/supabase/admin";
import type Stripe from "stripe";

// POST /api/webhooks/stripe - Handle Stripe webhook events
export async function POST(request: Request) {
  try {
    const payload = await request.text();
    const signature = request.headers.get("stripe-signature");

    if (!signature) {
      return NextResponse.json({ error: "No signature" }, { status: 400 });
    }

    let event: Stripe.Event;
    try {
      event = constructWebhookEvent(payload, signature);
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    console.log("Stripe webhook received:", event.type);

    // SCRUM-349 (L3): idempotency ledger. Claim this event.id BEFORE mutating any
    // billing state. Stripe delivers at-least-once and a captured signed payload
    // can be replayed within the signature tolerance window; without this, a
    // redelivery could double-apply non-idempotent changes (e.g. resetMonthlyUsage).
    const ledger = createAdminClient();
    const { error: claimError } = await (ledger as any)
      .from("stripe_processed_events")
      .insert({ event_id: event.id, event_type: event.type });

    if (claimError) {
      // 23505 = unique_violation → we've already processed this event.id.
      if (claimError.code === "23505") {
        console.log("Stripe webhook duplicate event skipped:", event.id, event.type);
        return NextResponse.json({ received: true, duplicate: true });
      }
      // Any other ledger error: fail closed (500 → Stripe retries) rather than
      // process without a recorded claim, which a later retry would double-apply.
      console.error("Stripe webhook: failed to record event id; skipping to avoid double-apply:", claimError);
      return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
    }

    try {
      switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subscriptionId = session.subscription as string;

        if (subscriptionId) {
          // Retrieve the full subscription to get metadata
          const stripe = (await import("stripe")).default;
          const stripeClient = new stripe(process.env.STRIPE_SECRET_KEY!, {
            apiVersion: "2025-02-24.acacia",
          });
          const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);

          // Pass the Checkout Session metadata as a fallback for any session
          // created before subscription_data.metadata shipped (older sessions
          // carry the org only at the session level). `planType` is the legacy
          // key the checkout route used before standardising on `plan`.
          await handleSubscriptionCreated(subscription, {
            organizationId: session.metadata?.organizationId,
            plan: session.metadata?.plan ?? session.metadata?.planType,
          });
        }
        break;
      }

      case "customer.subscription.created": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionCreated(subscription);
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(subscription);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionCanceled(subscription);
        break;
      }

      case "invoice.payment_succeeded": {
        // Resets call usage on a new billing cycle. Throws on a real DB error so
        // the ledger claim is released below and Stripe retries (SCRUM-409).
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      }

      case "invoice.payment_failed": {
        // Marks the subscription past_due. Throws on a DB error so Stripe retries
        // rather than the row silently staying "active" (SCRUM-409).
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      }

      default:
        console.log("Unhandled event type:", event.type);
      }
    } catch (handlerErr) {
      // SCRUM-349: processing failed AFTER we claimed the event.id. Release the
      // claim so Stripe's retry can re-attempt — otherwise the retry would be
      // skipped as a duplicate and the event would never be applied. Re-throw to
      // the outer catch so we return 500 and Stripe knows to retry.
      const { error: releaseError } = await (ledger as any)
        .from("stripe_processed_events")
        .delete()
        .eq("event_id", event.id);
      if (releaseError) {
        // Compound failure: the handler threw AND we couldn't release the claim.
        // The row is now stranded, so Stripe's retry will be skipped as a
        // duplicate and this billing event will never apply. Log loudly (not
        // silently) so it can be reconciled manually.
        console.error(
          "Stripe webhook: FAILED to release ledger claim after handler error — event is STRANDED and will not re-apply on retry; reconcile manually:",
          event.id,
          event.type,
          releaseError
        );
      }
      throw handlerErr;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
