import Link from "next/link";
import { AlertCircle, AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LapseSubscription } from "@/lib/subscriptions/lapse-state";
import {
  getLapseBannerContent,
  type LapseBannerSeverity,
} from "./lapse-banner-content";

// Re-export the pure helper so consumers/tests can import either from here.
export { getLapseBannerContent } from "./lapse-banner-content";
export type {
  LapseBannerContent,
  LapseBannerSeverity,
} from "./lapse-banner-content";

/**
 * Per-severity Alert styling. The base Alert component has no first-class
 * `warning` variant, so — matching the established pattern in
 * settings/business-settings-form.tsx — we render `variant="destructive"` and
 * override with the amber treatment for the recoverable (in_grace) case.
 */
const SEVERITY_STYLES: Record<
  LapseBannerSeverity,
  { className: string; Icon: typeof AlertTriangle }
> = {
  warning: {
    className:
      "border-amber-500/50 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200 [&>svg]:text-amber-600",
    Icon: AlertTriangle,
  },
  destructive: {
    className: "bg-destructive/10",
    Icon: AlertCircle,
  },
};

interface SubscriptionLapseBannerProps {
  /**
   * The raw `subscriptions` row (snake_case) for the current org, or null when
   * the org has no subscription. Only the lapse-relevant columns are read
   * (status, trial_end, current_period_end, service_ended_at).
   */
  subscription: LapseSubscription | null | undefined;
  /** Current time as epoch ms. Passed in so SSR output stays deterministic. */
  now: number;
}

/**
 * Server component: a dashboard-wide banner shown to ALL org members when the
 * org's subscription is in_grace / lapsed / release_pending. Renders nothing
 * for active orgs or when there is no subscription. All derivation happens on
 * the server (no client-side data fetching).
 */
export function SubscriptionLapseBanner({
  subscription,
  now,
}: SubscriptionLapseBannerProps) {
  const content = getLapseBannerContent(subscription, now);
  if (!content) return null;

  const { className, Icon } = SEVERITY_STYLES[content.severity];

  return (
    <Alert
      variant="destructive"
      className={cn("mb-4 md:mb-6", className)}
      data-lapse-state={content.state}
    >
      <Icon className="h-4 w-4" />
      <AlertTitle>{content.title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{content.description}</span>
        <Link
          href="/billing"
          className={cn(
            buttonVariants({ size: "sm" }),
            "w-full shrink-0 sm:w-auto"
          )}
        >
          {content.ctaLabel}
        </Link>
      </AlertDescription>
    </Alert>
  );
}

export default SubscriptionLapseBanner;
