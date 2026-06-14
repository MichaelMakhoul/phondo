/**
 * Pure state → banner-copy mapping for the dashboard subscription-lapse banner
 * (SCRUM-477, part of the lapse epic SCRUM-474).
 *
 * Deliberately kept FREE of React / Next / UI imports so it can be unit-tested
 * in the repo's node vitest environment (no jsdom / testing-library) without
 * dragging in `next/link` or `lucide-react`. The server component
 * (subscription-lapse-banner.tsx) imports this and only adds rendering.
 *
 * It REUSES the shared lapse-state machine — it does NOT reimplement any lapse
 * logic. The single source of truth for state transitions stays in
 * @/lib/subscriptions/lapse-state.
 */
import {
  computeLapseState,
  type LapseState,
  type LapseSubscription,
} from "@/lib/subscriptions/lapse-state";

/**
 * Visual severity, driving the rendered Alert treatment:
 *  - `warning`     — amber, recoverable (AI is still answering).
 *  - `destructive` — red, the AI has stopped / the number is at risk.
 */
export type LapseBannerSeverity = "warning" | "destructive";

export interface LapseBannerContent {
  /** Drives the rendered Alert variant + styling. */
  severity: LapseBannerSeverity;
  /** The lapse state this content was derived from (also set as a data attr). */
  state: Exclude<LapseState, "active">;
  title: string;
  description: string;
  /** CTA label — the button always links to /billing. */
  ctaLabel: string;
}

/**
 * Format the grace deadline for display. UTC + a spelled-out month keeps the
 * output deterministic across server timezones AND unambiguous for both AU and
 * US readers (e.g. "8 June 2026" rather than an ambiguous 6/8 vs 8/6). Falls
 * back to "soon" if the anchor is missing/unparseable (the machine should
 * always give us a grace date here, but never render "Invalid Date").
 */
function formatGraceDate(iso: string | null): string {
  if (!iso) return "soon";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "soon";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

/**
 * Map a subscription snapshot at time `now` (epoch ms) to banner content, or
 * `null` when no banner should show. PURE — no I/O, no clock reads.
 *
 *  - active / no subscription → null (nothing to warn about).
 *  - in_grace                 → amber warning, AI still answering.
 *  - lapsed                   → red, AI has stopped.
 *  - release_pending          → red, number at risk of release.
 */
export function getLapseBannerContent(
  sub: LapseSubscription | null | undefined,
  now: number
): LapseBannerContent | null {
  const { state, graceEndsAt } = computeLapseState(sub, now);

  switch (state) {
    case "in_grace":
      return {
        severity: "warning",
        state,
        title: "Your subscription has lapsed",
        description: `AI keeps answering until ${formatGraceDate(
          graceEndsAt
        )}. Update your billing to avoid an interruption.`,
        ctaLabel: "Update billing",
      };
    case "lapsed":
      return {
        severity: "destructive",
        state,
        title: "Your AI receptionist has stopped answering",
        description:
          "Calls now divert to your fallback or voicemail. Update your billing to switch it back on.",
        ctaLabel: "Update billing",
      };
    case "release_pending":
      return {
        severity: "destructive",
        state,
        title: "Your number may be released soon",
        description:
          "Resubscribe now to keep your phone number and restore your AI receptionist.",
        ctaLabel: "Resubscribe",
      };
    default:
      // "active" → no banner.
      return null;
  }
}
