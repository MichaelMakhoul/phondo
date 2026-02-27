import { Metadata } from "next";
import Link from "next/link";
import { Check, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { AnimateOnScroll } from "@/components/marketing/animate-on-scroll";
import { getDisplayPlans } from "@/lib/stripe/client";
import { formatCurrency } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing | Hola Recep",
  description: "Simple, transparent pricing for AI-powered phone receptionists",
};

const PLANS = getDisplayPlans();

export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden bg-hero-gradient">
          <div className="absolute inset-0 bg-grid-pattern" />
          <div className="relative container mx-auto px-4 py-16 text-center sm:py-20">
            <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
              Simple, transparent pricing
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-400">
              Start with a 14-day free trial. No credit card required.
              Cancel anytime.
            </p>
          </div>
        </section>

        {/* Plans Grid */}
        <section className="container mx-auto px-4 -mt-8 relative z-10 pb-16 sm:pb-24">
          <div className="grid gap-8 md:grid-cols-3 max-w-5xl mx-auto">
            {PLANS.map((plan) => (
              <AnimateOnScroll key={plan.id} animation="animate-fade-in-up">
                <div
                  className={`relative rounded-xl border bg-card p-8 shadow-sm transition-transform hover:-translate-y-1 ${
                    plan.highlighted
                      ? "border-orange-500 ring-2 ring-orange-500"
                      : "border-border"
                  }`}
                >
                  {plan.highlighted && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-orange-500 text-white hover:bg-orange-600">
                        Most Popular
                      </Badge>
                    </div>
                  )}

                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-semibold">{plan.name}</h3>
                      <p className="text-sm text-muted-foreground">{plan.description}</p>
                    </div>

                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-bold">{formatCurrency(plan.price)}</span>
                      <span className="text-muted-foreground">/month</span>
                    </div>

                    <Link href="/signup" className="block">
                      <Button
                        className={`w-full ${
                          plan.highlighted
                            ? "bg-orange-500 text-white hover:bg-orange-600"
                            : ""
                        }`}
                        variant={plan.highlighted ? "default" : "outline"}
                      >
                        Start Free Trial
                      </Button>
                    </Link>

                    <ul className="space-y-3">
                      {plan.features.map((feature) => (
                        <li key={feature} className="flex items-center gap-3 text-sm">
                          <Check className="h-4 w-4 text-orange-500 flex-shrink-0" />
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </AnimateOnScroll>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="border-t bg-slate-50 dark:bg-slate-900 py-16 sm:py-24">
          <div className="container mx-auto px-4">
            <AnimateOnScroll className="text-center mb-12">
              <h2 className="text-2xl font-bold">
                Frequently asked questions
              </h2>
            </AnimateOnScroll>
            <div className="max-w-2xl mx-auto space-y-6">
              {[
                {
                  q: "What counts as a call?",
                  a: "Each inbound call answered by your AI receptionist counts as one call, regardless of duration. Spam calls detected by our system are not counted.",
                },
                {
                  q: "Can I change plans later?",
                  a: "Yes, you can upgrade or downgrade at any time. Changes take effect at the start of your next billing cycle.",
                },
                {
                  q: "What happens when I hit my call limit?",
                  a: "Your AI receptionist will continue answering calls even if you exceed your limit \u2014 we never let a call go unanswered. You\u2019ll receive warnings prompting you to upgrade.",
                },
                {
                  q: "Is there a contract?",
                  a: "No long-term contracts. All plans are month-to-month and you can cancel anytime.",
                },
              ].map((faq) => (
                <AnimateOnScroll key={faq.q}>
                  <div>
                    <h3 className="font-semibold">{faq.q}</h3>
                    <p className="text-sm text-muted-foreground mt-1">{faq.a}</p>
                  </div>
                </AnimateOnScroll>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden bg-hero-gradient">
          <div className="absolute inset-0 bg-grid-pattern" />
          <div className="relative container mx-auto px-4 py-16 text-center sm:py-20">
            <h2 className="text-3xl font-bold text-white">
              Ready to never miss a call again?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-slate-400">
              14-day free trial. No credit card required. Set up in 5 minutes.
            </p>
            <div className="mt-8">
              <Link href="/signup">
                <Button size="lg" className="gap-2 bg-orange-500 text-white hover:bg-orange-600 animate-glow-pulse">
                  Get Started Free
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
