import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { isPublicReplayPath } from "./replay-routes";

// SCRUM-566: PostHog product-analytics backend, fanned out UNDER the existing
// typed facade (events.ts trackers / trackPageView / identifyUser) — call
// sites never talk to posthog-js directly, so GA and PostHog stay swappable.
//
// Posture decisions (deliberate, documented in the ticket):
//  - EU cloud via the first-party /ingest proxy route (cookie-stripping route
//    handler — see src/app/ingest/[...path]/route.ts for why it is NOT a
//    rewrite): ad-blocker resilient, and CSP needs no new hosts.
//  - autocapture OFF: dashboard rows render caller PII (names, numbers,
//    transcripts); autocapture ships clicked-element innerText offshore.
//    Only the facade's explicit typed events and pageviews are sent.
//  - session recording OFF in v1 for the same reason.
//  - person_profiles identified_only: anonymous marketing traffic stays
//    cheap; dashboard users become identified via identifyUser.
//  - Consent mirrors the GA consent-mode stance (default DENIED): while
//    denied, PostHog runs cookieless ("memory" persistence — no device
//    identifiers persisted); a consent grant upgrades persistence (posthog-js
//    purges the persisted store on the downgrade back).
//  - Pre-init QUEUE, not drop: mount-effect trackers in {children} run before
//    the root layout's init effect (React flushes passive effects depth-first
//    in tree order), so onboarding_start on a hard load would otherwise be
//    lost 100% deterministically. Bounded so analytics can never grow memory.

export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || "/ingest";

let initialized = false;
let warnedMissing = false;

type QueuedCall =
  | { kind: "capture"; eventName: string; params?: Record<string, unknown> }
  | { kind: "identify"; distinctId: string; personProperties?: Record<string, unknown> };

const MAX_PREINIT_QUEUE = 20;
let preInitQueue: QueuedCall[] = [];

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
      // SCRUM-569: the recorder stays DISABLED at init — session replay is
      // default-deny and only started imperatively on public marketing/auth
      // routes (see phSyncSessionReplay). maskAllInputs is set now so that when
      // recording IS active (e.g. the /signup early-access form), typed values
      // (email, phone, password) are never captured.
      disable_session_recording: true,
      session_recording: { maskAllInputs: true },
      persistence: consented ? "localStorage+cookie" : "memory",
    });
    initialized = true;
  } catch (err) {
    // A dead backend is invisible for weeks otherwise — page it once via
    // Sentry (init-level darkness, not per-event noise), then stay silent.
    console.debug("[Analytics] PostHog init failed:", err);
    try {
      Sentry.captureException(err, { tags: { analytics_backend: "posthog", phase: "init" } });
    } catch {
      /* observability must never break the product */
    }
    return;
  }

  // Drain events captured before init (in order; `initialized` is already
  // true, so these dispatch immediately).
  const queued = preInitQueue;
  preInitQueue = [];
  for (const call of queued) {
    if (call.kind === "capture") phCapture(call.eventName, call.params);
    else phIdentify(call.distinctId, call.personProperties);
  }
}

export function phCapture(eventName: string, params?: Record<string, unknown>): void {
  if (!isConfigured()) return;
  if (!initialized) {
    if (preInitQueue.length < MAX_PREINIT_QUEUE) {
      preInitQueue.push({ kind: "capture", eventName, params });
    }
    return;
  }
  try {
    posthog.capture(eventName, params);
  } catch (err) {
    console.debug("[Analytics] PostHog capture failed:", err);
  }
}

export function phPageView(url: string): void {
  if (typeof window === "undefined") return;
  // $current_url is stamped at CALL time — a queued pageview must not pick up
  // the post-navigation location when it drains.
  phCapture("$pageview", { $current_url: window.location.origin + url });
}

/**
 * Raw ids on purpose (unlike GA's hashed user properties): the Supabase user
 * uuid is the pseudonymous join key PostHog person profiles are built on —
 * hashing it would orphan every cross-tool lookup. No email/name is sent.
 */
export function phIdentify(distinctId: string, personProperties?: Record<string, unknown>): void {
  if (!isConfigured()) return;
  if (!initialized) {
    if (preInitQueue.length < MAX_PREINIT_QUEUE) {
      preInitQueue.push({ kind: "identify", distinctId, personProperties });
    }
    return;
  }
  try {
    posthog.identify(distinctId, personProperties);
  } catch (err) {
    console.debug("[Analytics] PostHog identify failed:", err);
  }
}

export function phUpdateConsent(granted: boolean): void {
  if (!isConfigured() || !initialized) return;
  try {
    posthog.set_config({ persistence: granted ? "localStorage+cookie" : "memory" });
  } catch (err) {
    console.debug("[Analytics] PostHog consent update failed:", err);
  }
}

// SCRUM-569: default-deny session replay. init keeps the recorder disabled;
// we START it only on allowlisted public marketing/auth routes and STOP it on
// every other route, so the authenticated app (caller PII) is never recorded.
// The PostHog project also carries a URL blocklist for those routes as a second
// layer. Called on every SPA route change with the pathname (no query string).
let replayActive = false;

export function phSyncSessionReplay(pathname: string): void {
  if (!isConfigured() || !initialized) return;
  const shouldRecord = isPublicReplayPath(pathname);
  try {
    if (shouldRecord && !replayActive) {
      posthog.startSessionRecording();
      replayActive = true;
    } else if (!shouldRecord && replayActive) {
      posthog.stopSessionRecording();
      replayActive = false;
    }
  } catch (err) {
    console.debug("[Analytics] PostHog session replay sync failed:", err);
  }
}
