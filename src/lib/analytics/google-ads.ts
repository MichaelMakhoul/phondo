// SCRUM-569: Google Ads conversion tracking. Distinct from GA4 (gtag.ts):
// GA4 is keyed on a G-XXXX measurement id and stays dormant; Google Ads is
// keyed on an AW-XXXXXXXXX conversion id. Both drive the SAME Google tag
// (one window.dataLayer / gtag queue), so this configures the AW tag on that
// shared queue rather than loading a second tag.
//
// Two-stage activation — both env vars are needed for a conversion to count:
//   NEXT_PUBLIC_GOOGLE_ADS_ID              → loads/configs the tag sitewide so
//                                            conversions attribute to paid
//                                            clicks (cookieless / consent-mode
//                                            modeled while ad_storage stays
//                                            denied — see gtag.ts consent).
//   NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_LABEL → the per-action label from the
//                                            Google Ads conversion action;
//                                            without it, no conversion fires.

export const GOOGLE_ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID;
export const GOOGLE_ADS_CONVERSION_LABEL =
  process.env.NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_LABEL;

const AW_ID_PATTERN = /^AW-[0-9]+$/;
const GA_ID_PATTERN = /^G-[A-Z0-9]+$/;

let warnedMissingLabel = false;

/**
 * The single Google tag (gtag.js) is loaded ONCE for whichever Google product
 * is configured — GA4 (G-…) preferred, else Google Ads (AW-…); each backend's
 * init() then `config`s its own id on the shared dataLayer. Returns the id to
 * load in the loader `<script src>`, or null when neither is configured.
 *
 * Pure + exported so the GA-dormant/Ads-only branch is unit-testable — the
 * component TSX that consumes it is not executable in the repo's vitest env.
 */
export function resolveGtagLoadId(
  gaMeasurementId?: string,
  googleAdsId?: string
): string | null {
  if (gaMeasurementId && GA_ID_PATTERN.test(gaMeasurementId)) return gaMeasurementId;
  if (googleAdsId && AW_ID_PATTERN.test(googleAdsId)) return googleAdsId;
  return null;
}

export function isGoogleAdsConfigured(): boolean {
  if (typeof window === "undefined") return false;
  return !!GOOGLE_ADS_ID && AW_ID_PATTERN.test(GOOGLE_ADS_ID);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gtag(..._args: any[]) {
  if (typeof window === "undefined") return;
  try {
    // Even the `|| []` assignment is guarded — a consent platform / extension
    // can make window.dataLayer a non-writable or throwing property, so the
    // "telemetry never breaks the product" doctrine must cover it too.
    window.dataLayer = window.dataLayer || [];
    // gtag() must push the `arguments` object, not a spread array, so the
    // Google tag processes it correctly.
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer.push(arguments as unknown as Record<string, unknown>);
  } catch (err) {
    console.debug("[Analytics] Google Ads gtag push failed:", err);
  }
}

export function initGoogleAds(): void {
  if (!isGoogleAdsConfigured()) return;
  // dataLayer is initialized inside gtag() (guarded) — no bare touch here.
  gtag("js", new Date());
  gtag("config", GOOGLE_ADS_ID);
}

/**
 * Fire a Google Ads conversion. No-op until BOTH the AW id and the per-action
 * conversion label are set — the label comes from the conversion action
 * created in the Google Ads UI, so the plumbing ships inert and activates the
 * moment that env var is filled in.
 */
export function trackGoogleAdsConversion(params?: Record<string, unknown>): void {
  if (!isGoogleAdsConfigured()) return;
  if (!GOOGLE_ADS_CONVERSION_LABEL) {
    if (!warnedMissingLabel && process.env.NODE_ENV === "development") {
      console.warn(
        "[Analytics] NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_LABEL is not set — Google Ads conversion not fired."
      );
      warnedMissingLabel = true;
    }
    return;
  }
  gtag("event", "conversion", {
    send_to: `${GOOGLE_ADS_ID}/${GOOGLE_ADS_CONVERSION_LABEL}`,
    ...params,
  });
}
