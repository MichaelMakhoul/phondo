"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/use-toast";
import {
  Check,
  CreditCard,
  Loader2,
  AlertTriangle,
  Phone,
  Users,
  Smartphone,
  Calendar,
  ArrowRight,
  Headphones,
  BarChart3,
  Mic,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { getDisplayPlans } from "@/lib/stripe/client";

// Feature → icon mapping (React components can't live in client.ts)
const FEATURE_ICONS: Record<string, React.ComponentType<any>> = {
  calls: Phone,
  assistant: Users,
  phone: Smartphone,
  calendar: Calendar,
  transfer: ArrowRight,
  support: Headphones,
  escalation: Headphones,
  analytics: BarChart3,
  voice: Mic,
};

function getIconForFeature(feature: string) {
  const lower = feature.toLowerCase();
  for (const [keyword, Icon] of Object.entries(FEATURE_ICONS)) {
    if (lower.includes(keyword)) return Icon;
  }
  return null;
}

const PLANS = getDisplayPlans().map((plan) => ({
  ...plan,
  features: plan.features.map((text) => ({
    text,
    icon: getIconForFeature(text),
  })),
}));

interface Subscription {
  id: string;
  plan_type: string;
  status: string;
  calls_used: number;
  calls_limit: number;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  trial_end: string | null;
}

function BillingContent() {
  const [currentPlan, setCurrentPlan] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const supabase = createClient();

  useEffect(() => {
    loadBillingData();

    // Handle success/canceled from Stripe
    if (searchParams.get("success") === "true") {
      toast({
        title: "Payment successful!",
        description: "Your subscription is now active.",
      });
    }
    if (searchParams.get("canceled") === "true") {
      toast({
        title: "Payment canceled",
        description: "You can try again when you're ready.",
      });
    }
  }, []);

  const loadBillingData = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data: membership } = (await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single()) as { data: { organization_id: string } | null };

    if (!membership) return;

    const orgId = membership.organization_id;

    // Get subscription
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("organization_id", orgId)
      .single();

    if (sub) {
      setSubscription(sub as Subscription);
      setCurrentPlan((sub as Subscription).plan_type);
    } else {
      setCurrentPlan(null);
    }

    setIsLoading(false);
  };

  const handleSubscribe = async (planId: string) => {
    setLoadingPlan(planId);

    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planType: planId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to create checkout session");
      }

      const { url } = await response.json();
      window.location.href = url;
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to start checkout",
      });
      setLoadingPlan(null);
    }
  };

  const handleManageBilling = async () => {
    try {
      const response = await fetch("/api/billing/portal", {
        method: "POST",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to open billing portal");
      }

      const { url } = await response.json();
      window.location.href = url;
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to open billing portal",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Calculate usage percentage
  const usagePercentage =
    subscription && subscription.calls_limit > 0
      ? Math.round((subscription.calls_used / subscription.calls_limit) * 100)
      : 0;
  const isNearLimit = usagePercentage >= 80;
  const isOverLimit =
    subscription &&
    subscription.calls_limit > 0 &&
    subscription.calls_used >= subscription.calls_limit;
  const isUnlimited = subscription?.calls_limit === -1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="text-muted-foreground">
            Manage your subscription and usage
          </p>
        </div>
        {subscription && (
          <Button onClick={handleManageBilling} variant="outline">
            <CreditCard className="mr-2 h-4 w-4" />
            Manage Billing
          </Button>
        )}
      </div>

      {/* Current Plan & Usage */}
      {subscription && (
        <Card
          className={
            isNearLimit && !isUnlimited
              ? "border-orange-300 dark:border-orange-700"
              : ""
          }
        >
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Current Plan</CardTitle>
                <CardDescription>Your active subscription</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {subscription.cancel_at_period_end && (
                  <Badge variant="destructive">Canceling</Badge>
                )}
                {subscription.trial_end &&
                  new Date(subscription.trial_end) > new Date() && (
                    <Badge variant="secondary">Trial</Badge>
                  )}
                <Badge
                  variant={
                    subscription.status === "active" ? "success" : "secondary"
                  }
                >
                  {subscription.status}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold capitalize">
                  {subscription.plan_type?.replace("_", " ") ?? "Starter"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Renews{" "}
                  {new Date(subscription.current_period_end).toLocaleDateString(
                    "en-AU",
                    {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    }
                  )}
                </p>
              </div>
            </div>

            {/* Usage Section */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Calls this period</span>
                <span className="font-medium">
                  {subscription.calls_used}
                  {isUnlimited ? "" : ` / ${subscription.calls_limit}`}
                  {isUnlimited && (
                    <span className="ml-1 text-muted-foreground">
                      (unlimited)
                    </span>
                  )}
                </span>
              </div>

              {!isUnlimited && (
                <Progress
                  value={Math.min(usagePercentage, 100)}
                  className={`h-2 ${
                    isOverLimit
                      ? "[&>div]:bg-red-500"
                      : isNearLimit
                        ? "[&>div]:bg-orange-500"
                        : ""
                  }`}
                />
              )}

              {isOverLimit && (
                <div className="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-950 p-3 text-sm text-red-700 dark:text-red-300">
                  <AlertTriangle className="h-4 w-4" />
                  <span>
                    You've exceeded your call limit. Your AI receptionist
                    will continue answering calls, but please upgrade to
                    avoid service interruptions.
                  </span>
                </div>
              )}

              {isNearLimit && !isOverLimit && (
                <div className="flex items-center gap-2 rounded-md bg-orange-50 dark:bg-orange-950 p-3 text-sm text-orange-700 dark:text-orange-300">
                  <AlertTriangle className="h-4 w-4" />
                  <span>
                    You're approaching your call limit ({usagePercentage}%
                    used). Consider upgrading.
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* No subscription */}
      {!subscription && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Phone className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold">No Active Subscription</h3>
            <p className="text-muted-foreground mt-1 max-w-sm">
              Choose a plan below to start using AI-powered call handling for
              your business.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Plans */}
      <div>
        <h2 className="mb-4 text-lg font-semibold">
          {subscription ? "Upgrade Your Plan" : "Choose a Plan"}
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {PLANS.map((plan) => {
            const isCurrentPlan = currentPlan === plan.id;
            const isDowngrade =
              subscription &&
              PLANS.findIndex((p) => p.id === subscription.plan_type) >
                PLANS.findIndex((p) => p.id === plan.id);

            return (
              <Card
                key={plan.id}
                className={`relative ${plan.highlighted ? "border-primary shadow-lg" : ""} ${isCurrentPlan ? "bg-muted/50" : ""}`}
              >
                {plan.highlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-primary">Most Popular</Badge>
                  </div>
                )}
                <CardHeader>
                  <CardTitle>{plan.name}</CardTitle>
                  <CardDescription>{plan.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mb-6">
                    <span className="text-4xl font-bold">
                      {formatCurrency(plan.price)}
                    </span>
                    <span className="text-muted-foreground">/month</span>
                  </div>
                  <ul className="space-y-3">
                    {plan.features.map((feature, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm">
                        {feature.icon ? (
                          <feature.icon className="h-4 w-4 text-primary" />
                        ) : (
                          <Check className="h-4 w-4 text-primary" />
                        )}
                        {feature.text}
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  {isCurrentPlan ? (
                    <Button className="w-full" variant="outline" disabled>
                      Current Plan
                    </Button>
                  ) : isDowngrade ? (
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={handleManageBilling}
                    >
                      Downgrade
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      variant={plan.highlighted ? "default" : "outline"}
                      onClick={() => handleSubscribe(plan.id)}
                      disabled={loadingPlan === plan.id}
                    >
                      {loadingPlan === plan.id && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {subscription ? "Upgrade" : "Get Started"}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>

      {/* FAQ / Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Billing FAQ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <p className="font-medium">What counts as a call?</p>
            <p className="text-muted-foreground">
              Each inbound call answered by your AI assistant counts as one
              call, regardless of duration. Spam calls that are automatically
              filtered don't count toward your limit.
            </p>
          </div>
          <div>
            <p className="font-medium">What happens if I hit my limit?</p>
            <p className="text-muted-foreground">
              Your AI receptionist will continue answering calls even if you
              exceed your limit — we never let a call go unanswered. You'll
              receive warnings at 80% and 100% usage prompting you to upgrade.
            </p>
          </div>
          <div>
            <p className="font-medium">Can I change plans anytime?</p>
            <p className="text-muted-foreground">
              Yes! Upgrades take effect immediately. Downgrades take effect at
              the end of your billing period. You can manage everything through
              the billing portal.
            </p>
          </div>
          <div>
            <p className="font-medium">Do unused calls roll over?</p>
            <p className="text-muted-foreground">
              No, call limits reset at the start of each billing period. We
              recommend choosing a plan that fits your typical monthly volume.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <BillingContent />
    </Suspense>
  );
}
