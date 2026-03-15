import { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSubscriptionInfo } from "@/lib/stripe/billing-service";
import { PLANS } from "@/lib/stripe/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Mail,
  MessageSquare,
  BookOpen,
  Zap,
  Clock,
  ExternalLink,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Support | Phondo",
};

const GUIDES = [
  {
    title: "Getting Started",
    description: "Set up your AI receptionist in under 5 minutes.",
    href: "/settings",
  },
  {
    title: "Phone Number Setup",
    description: "Forward your existing number or get a new one.",
    href: "/phone-numbers",
  },
  {
    title: "Knowledge Base",
    description: "Teach your AI about your business and services.",
    href: "/settings/knowledge",
  },
  {
    title: "Billing & Plans",
    description: "Manage your subscription and view usage.",
    href: "/billing",
  },
];

export default async function SupportPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: membership } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .single();

  if (!membership) redirect("/onboarding");

  const organizationId = membership.organization_id as string;
  // Check priority support directly via plan config (fail closed — null sub = no priority).
  // Using getSubscriptionInfo instead of hasFeatureAccess which fails open on DB errors.
  let hasPriority = false;
  try {
    const sub = await getSubscriptionInfo(organizationId);
    if (sub && ["active", "trialing"].includes(sub.status)) {
      const planConfig = PLANS[sub.plan] as Record<string, unknown>;
      hasPriority = !!planConfig?.prioritySupport;
    }
  } catch (err) {
    console.error("[Support] Failed to check priority support — showing standard:", { organizationId, error: err });
  }

  const supportEmail = "support@phondo.ai";
  const prioritySubject = encodeURIComponent("[PRIORITY] Support Request");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Support</h1>
        <p className="text-muted-foreground">
          Get help with your Phondo account.
        </p>
      </div>

      {/* Priority Support Banner */}
      {hasPriority ? (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Zap className="h-6 w-6 text-primary" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">Priority Support</h2>
                <Badge variant="default">Business Plan</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Your support requests are handled first. Typical response time: under 4 hours during business hours.
              </p>
            </div>
            <a href={`mailto:${supportEmail}?subject=${prioritySubject}`}>
              <Button className="gap-2">
                <Mail className="h-4 w-4" />
                Priority Email
              </Button>
            </a>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted">
              <Clock className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <h2 className="font-semibold">Standard Support</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                We typically respond within 24 hours during business hours (AEST).
              </p>
            </div>
            <a href={`mailto:${supportEmail}`}>
              <Button variant="outline" className="gap-2">
                <Mail className="h-4 w-4" />
                Email Support
              </Button>
            </a>
          </CardContent>
        </Card>
      )}

      {/* Upgrade prompt for non-priority */}
      {!hasPriority && (
        <div className="rounded-lg border border-dashed p-4 text-center">
          <p className="text-sm text-muted-foreground">
            Need faster responses?{" "}
            <Link href="/billing" className="font-medium text-primary hover:underline">
              Upgrade to Business
            </Link>{" "}
            for priority support with under 4-hour response times.
          </p>
        </div>
      )}

      {/* Contact Options */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="h-4 w-4" />
              Email
            </CardTitle>
            <CardDescription>Best for detailed questions and account issues.</CardDescription>
          </CardHeader>
          <CardContent>
            <a
              href={`mailto:${supportEmail}${hasPriority ? `?subject=${prioritySubject}` : ""}`}
              className="text-sm font-medium text-primary hover:underline"
            >
              {supportEmail}
            </a>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4" />
              FAQ
            </CardTitle>
            <CardDescription>Common questions about setup, billing, and features.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Coming soon. In the meantime, email us with any questions.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Guides */}
      <div>
        <h2 className="mb-4 text-lg font-semibold">Quick Guides</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {GUIDES.map((guide) => (
            <Link key={guide.href} href={guide.href}>
              <Card className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center gap-3 pt-6">
                  <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{guide.title}</p>
                    <p className="text-xs text-muted-foreground">{guide.description}</p>
                  </div>
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
