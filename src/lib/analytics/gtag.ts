import type { EventName } from "./events";

export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

const GA_ID_PATTERN = /^G-[A-Z0-9]+$/;

declare global {
  interface Window {
    dataLayer: Record<string, unknown>[];
    gtag: (...args: unknown[]) => void;
  }
}

let warnedMissing = false;
function isAvailable(): boolean {
  if (typeof window === "undefined") return false;
  if (!GA_MEASUREMENT_ID) {
    if (!warnedMissing && process.env.NODE_ENV === "development") {
      console.warn("[Analytics] NEXT_PUBLIC_GA_MEASUREMENT_ID is not set. Analytics tracking is disabled.");
      warnedMissing = true;
    }
    return false;
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gtag(..._args: any[]) {
  if (!isAvailable()) return;
  window.dataLayer = window.dataLayer || [];
  // gtag() must push the `arguments` object, not a spread array
  // eslint-disable-next-line prefer-rest-params
  window.dataLayer.push(arguments as unknown as Record<string, unknown>);
}

export function initGtag(): void {
  if (!isAvailable()) return;
  if (!GA_ID_PATTERN.test(GA_MEASUREMENT_ID!)) {
    console.warn(`[Analytics] NEXT_PUBLIC_GA_MEASUREMENT_ID "${GA_MEASUREMENT_ID}" does not match expected format (G-XXXXXXXXXX). Analytics will not initialize.`);
    return;
  }
  window.dataLayer = window.dataLayer || [];
  gtag("js", new Date());
  gtag("config", GA_MEASUREMENT_ID, {
    send_page_view: false,
  });
}

export function trackPageView(url: string): void {
  if (!isAvailable()) return;
  gtag("event", "page_view", {
    page_path: url,
    page_location: window.location.href,
  });
}

// GA4 consent mode handles server-side filtering — events pushed while
// analytics_storage is 'denied' are sent as cookieless pings, so client-side
// consent gating is not required here.
export function pushEvent(
  eventName: EventName,
  params?: Record<string, unknown>
): void {
  if (!isAvailable()) return;
  gtag("event", eventName, params);
}

export function setUserProperties(
  properties: Record<string, unknown>
): void {
  if (!isAvailable()) return;
  gtag("set", "user_properties", properties);
}

export function updateConsent(granted: boolean): void {
  if (!isAvailable()) return;
  gtag("consent", "update", {
    analytics_storage: granted ? "granted" : "denied",
    ad_storage: "denied",
  });
}
