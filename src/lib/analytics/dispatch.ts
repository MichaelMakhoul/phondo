import { initGtag, pushEvent as gtagPushEvent, trackPageView as gtagTrackPageView } from "./gtag";
import { initGoogleAds, trackGoogleAdsConversion } from "./google-ads";
import { getStoredConsent, initConsent } from "./consent";
import { initPostHog, phCapture, phPageView, phSyncSessionReplay } from "./posthog";
import type { EventName } from "./events";

// SCRUM-566: single dispatch seam between the typed facade (events.ts) and
// the analytics backends. GA4 stays dormant until NEXT_PUBLIC_GA_MEASUREMENT_ID
// is set; PostHog until NEXT_PUBLIC_POSTHOG_KEY is set — each backend guards
// itself, so any combination of zero/one/both just works.

/** One-shot init for every configured backend (called from the root layout's
 * analytics component). Consent default is DENIED until granted (GA consent
 * mode → cookieless pings; PostHog → memory persistence). */
export function initAnalytics(): void {
  initGtag();
  initGoogleAds();
  initConsent();
  initPostHog(getStoredConsent() === true);
}

export function pushEvent(eventName: EventName, params?: Record<string, unknown>): void {
  gtagPushEvent(eventName, params);
  phCapture(eventName, params);
}

export function trackPageView(url: string): void {
  gtagTrackPageView(url);
  phPageView(url);
}

/** SCRUM-569: default-deny session replay, driven by the route-change effect
 * with the raw pathname (no query string). PostHog-only — GA has no replay. */
export function syncSessionReplay(pathname: string): void {
  phSyncSessionReplay(pathname);
}

/** SCRUM-569: fire a paid-campaign conversion (Google Ads only). Kept separate
 * from pushEvent — a conversion is an ads-network signal, not a GA/PostHog
 * product event, and callers pair it with a typed pushEvent when they want both. */
export function trackConversion(params?: Record<string, unknown>): void {
  trackGoogleAdsConversion(params);
}
