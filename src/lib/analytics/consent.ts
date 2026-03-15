import { updateConsent } from "./gtag";

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
}

export function initConsent(): void {
  const stored = getStoredConsent();
  updateConsent(stored ?? false);
}
