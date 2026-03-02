import { updateConsent } from "./gtag";

const CONSENT_KEY = "analytics_consent";

export function getStoredConsent(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(CONSENT_KEY);
    if (stored === null) return null;
    return stored === "granted";
  } catch {
    // localStorage unavailable (private browsing, storage disabled, etc.)
    return null;
  }
}

export function setConsent(granted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied");
  } catch {
    // localStorage unavailable — consent still applied to GA4 for this session
  }
  updateConsent(granted);
}

export function initConsent(): void {
  const stored = getStoredConsent();
  updateConsent(stored ?? false);
}
