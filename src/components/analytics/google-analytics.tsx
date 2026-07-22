"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Script from "next/script";
import {
  GA_MEASUREMENT_ID,
  GOOGLE_ADS_ID,
  resolveGtagLoadId,
  initAnalytics,
  trackPageView,
  syncSessionReplay,
} from "@/lib/analytics";

export function GoogleAnalytics() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    // SCRUM-566: single init for every configured backend (GA/Ads scripts
    // below stay gated; PostHog inits here even when they are dormant — the
    // early null return only skips the Google <Script> tags, not these hooks).
    initAnalytics();
  }, []);

  useEffect(() => {
    if (!pathname) return;
    // SCRUM-569: sync default-deny session replay FIRST, by pathname only (no
    // query string). The PII-critical stop() on a public→authenticated
    // navigation must never depend on an unrelated telemetry call (trackPageView)
    // succeeding — so it runs before it.
    syncSessionReplay(pathname);
    const url =
      pathname +
      (searchParams?.toString() ? `?${searchParams.toString()}` : "");
    trackPageView(url);
  }, [pathname, searchParams]);

  // SCRUM-569: the Google tag (gtag.js) is loaded once for whichever Google
  // product is configured — GA4 (G-…) or Google Ads (AW-…). Same loader; each
  // backend's init() then `config`s its own id on the shared dataLayer.
  const gtagLoadId = resolveGtagLoadId(GA_MEASUREMENT_ID, GOOGLE_ADS_ID);
  if (!gtagLoadId) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${gtagLoadId}`}
        strategy="afterInteractive"
      />
      <Script
        id="gtag-init"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('consent', 'default', {
              analytics_storage: 'denied',
              ad_storage: 'denied',
            });
          `,
        }}
      />
    </>
  );
}
