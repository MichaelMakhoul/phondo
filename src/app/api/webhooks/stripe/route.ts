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
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import type Stripe from "stripe";

// POST /api/webhooks/stripe - Handle Stripe webhook events
//
// SCRUM-201: every failure path pages via pageSentry — before this, all
// four failure sites were console.error only, invisible to Grafana on
// Vercel Hobby (this route never used the Loki-push path). Levels:
// signature failures are warning (internet probe noise; a sustained run
// still shows in Loki), everything that stalls or strands a billing
// event is error (emails via the Next.js error-logged rule).
export async function POST(request: Request) {
  // Set when the handler-stage catch already paged, so the outer catch
  // doesn't page the same failure twice on the re-throw.
  let pagedHandlerFailure = false;
  try {
    const payload = await request.text();
    const signature = request.headers.get("stripe-signature");

    if (!signature) {
      // Not paged: Stripe always sends the header, so this is pure probe
      // traffic — but leave a breadcrumb so a sustained flood shows in Loki.
      console.warn("Stripe webhook: request without stripe-signature header rejected");
      return NextResponse.json({ error: "No signature" }, { status: 400 });
    }

    let event: Stripe.Event;
    try {
      event = constructWebhookEvent(payload, signature);
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.STRIPE_WEBHOOK_SIGNATURE_FAILED,
        level: "warning",
        err,
      });
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
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.STRIPE_WEBHOOK_FAILED,
        level: "error",
        message: `ledger claim failed: ${claimError.message}`,
        extras: { stage: "ledger-claim", eventId: event.id, eventType: event.type, code: claimError.code },
      });
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
      //
      // SCRUM-201: a THROWN release (builder-level exception, SDK behavior
      // change) is the same stranded condition as a returned error — coerce
      // it so the STRANDED page below fires instead of the throw escaping
      // to the outer catch, which would page under the wrong reason with no
      // event identity and swallow the original handler error.
      let releaseError: { message: string; code?: string } | null;
      try {
        ({ error: releaseError } = await (ledger as any)
          .from("stripe_processed_events")
          .delete()
          .eq("event_id", event.id));
      } catch (thrownRelease) {
        releaseError = {
          message: thrownRelease instanceof Error ? thrownRelease.message : String(thrownRelease),
          code: "thrown",
        };
      }
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
        pageSentry({
          service: "next-api",
          reason: SENTRY_REASONS.STRIPE_WEBHOOK_EVENT_STRANDED,
          level: "error",
          message: `stranded billing event: claim release failed: ${releaseError.message}`,
          extras: { eventId: event.id, eventType: event.type, code: releaseError.code },
        });
      }
      pagedHandlerFailure = true;
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.STRIPE_WEBHOOK_FAILED,
        level: "error",
        err: handlerErr,
        extras: { stage: "handler", eventId: event.id, eventType: event.type },
      });
      throw handlerErr;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    if (!pagedHandlerFailure) {
      // Pre-handler failure (body read, ledger insert throw, …) — the
      // handler-stage catch didn't see it, so page it here.
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.STRIPE_WEBHOOK_FAILED,
        level: "error",
        err: error,
        extras: { stage: "request" },
      });
    }
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
