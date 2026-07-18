import posthog from "posthog-js";

// SCRUM-566: PostHog product-analytics backend, fanned out UNDER the existing
// typed facade (events.ts trackers / trackPageView / identifyUser) — call
// sites never talk to posthog-js directly, so GA and PostHog stay swappable.
//
// Posture decisions (deliberate, documented in the ticket):
//  - EU cloud via the first-party /ingest reverse proxy (next.config.ts
//    rewrites): ad-blocker resilient, and CSP needs no new hosts — the
//    proxied requests are same-origin ('self' covers connect-src and the
//    lazily-loaded feature chunks under /ingest/static).
//  - autocapture OFF: dashboard rows render caller PII (names, numbers,
//    transcripts); autocapture ships clicked-element innerText offshore.
//    Only the facade's explicit typed events and pageviews are sent.
//  - session recording OFF in v1 for the same reason.
//  - person_profiles identified_only: anonymous marketing traffic stays
//    cheap; dashboard users become identified via identifyUser.
//  - Consent mirrors the GA consent-mode stance (default DENIED): while
//    denied, PostHog runs cookieless ("memory" persistence — no device
//    identifiers persisted); a consent grant upgrades persistence.

export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || "/ingest";

let initialized = false;
let warnedMissing = false;

function isConfigured(): boolean {
  if (typeof window === "undefined") return false;
  if (!POSTHOG_KEY) {
    if (!warnedMissing && process.env.NODE_ENV === "development") {
      console.warn("[Analytics] NEXT_PUBLIC_POSTHOG_KEY is not set. PostHog tracking is disabled.");
      warnedMissing = true;
    }
    return false;
  }
  return true;
}

function isReady(): boolean {
  return initialized && isConfigured();
}

export function initPostHog(consented: boolean): void {
  if (!isConfigured() || initialized) return;
  try {
    posthog.init(POSTHOG_KEY!, {
      api_host: POSTHOG_HOST,
      ui_host: "https://eu.posthog.com",
      defaults: "2025-05-24",
      // The facade's route-change effect drives SPA pageviews for BOTH
      // backends — PostHog's own history capture would double-count.
      capture_pageview: false,
      autocapture: false,
      person_profiles: "identified_only",
      disable_session_recording: true,
      persistence: consented ? "localStorage+cookie" : "memory",
    });
    initialized = true;
  } catch (err) {
    console.debug("[Analytics] PostHog init failed:", err);
  }
}

export function phCapture(eventName: string, params?: Record<string, unknown>): void {
  if (!isReady()) return;
  try {
    posthog.capture(eventName, params);
  } catch (err) {
    console.debug("[Analytics] PostHog capture failed:", err);
  }
}

export function phPageView(url: string): void {
  if (!isReady()) return;
  try {
    posthog.capture("$pageview", { $current_url: window.location.origin + url });
  } catch (err) {
    console.debug("[Analytics] PostHog pageview failed:", err);
  }
}

/**
 * Raw ids on purpose (unlike GA's hashed user properties): the Supabase user
 * uuid is the pseudonymous join key PostHog person profiles are built on —
 * hashing it would orphan every cross-tool lookup. No email/name is sent.
 */
export function phIdentify(distinctId: string, personProperties?: Record<string, unknown>): void {
  if (!isReady()) return;
  try {
    posthog.identify(distinctId, personProperties);
  } catch (err) {
    console.debug("[Analytics] PostHog identify failed:", err);
  }
}

export function phUpdateConsent(granted: boolean): void {
  if (!isReady()) return;
  try {
    posthog.set_config({ persistence: granted ? "localStorage+cookie" : "memory" });
  } catch (err) {
    console.debug("[Analytics] PostHog consent update failed:", err);
  }
}

/** Test-only: reset the module-level init latch. */
export function _resetForTests(): void {
  initialized = false;
  warnedMissing = false;
}
