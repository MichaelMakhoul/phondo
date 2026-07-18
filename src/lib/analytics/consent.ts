import { updateConsent } from "./gtag";
import { phUpdateConsent } from "./posthog";

const CONSENT_KEY = "analytics_consent";

export function getStoredConsent(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(CONSENT_KEY);
    if (stored === null) return null;
    return stored === "granted";
  } catch (err) {
    console.debug("[Analytics] localStorage read failed:", err);
    return null;
  }
}

export function setConsent(granted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied");
  } catch (err) {
    console.debug("[Analytics] localStorage write failed:", err);
  }
  updateConsent(granted);
  // SCRUM-566: PostHog mirrors the same signal — granted upgrades to
  // persisted analytics, denied drops back to cookieless memory mode.
  phUpdateConsent(granted);
}

export function initConsent(): void {
  const stored = getStoredConsent();
  updateConsent(stored ?? false);
}
