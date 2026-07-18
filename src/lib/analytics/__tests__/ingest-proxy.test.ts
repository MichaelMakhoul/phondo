import { describe, it, expect } from "vitest";

import nextConfig from "../../../../next.config";

// SCRUM-566: the /ingest reverse proxy is what keeps PostHog first-party —
// ad-blocker resilient AND covered by the CSP's 'self' (no new hosts in
// connect-src/script-src). Dropping or reordering these rewrites silently
// kills analytics (requests 404) or breaks lazily-loaded PostHog assets.

describe("PostHog /ingest reverse proxy", () => {
  it("proxies /ingest to the EU cloud, static route FIRST", async () => {
    const rewrites = await nextConfig.rewrites!();
    const list = Array.isArray(rewrites)
      ? rewrites
      : [...(rewrites.beforeFiles ?? []), ...(rewrites.afterFiles ?? []), ...(rewrites.fallback ?? [])];

    const staticIdx = list.findIndex((r) => r.source === "/ingest/static/:path*");
    const apiIdx = list.findIndex((r) => r.source === "/ingest/:path*");

    expect(staticIdx).toBeGreaterThanOrEqual(0);
    expect(apiIdx).toBeGreaterThanOrEqual(0);
    // The catch-all would shadow the assets host if it came first.
    expect(staticIdx).toBeLessThan(apiIdx);
    expect(list[staticIdx].destination).toBe("https://eu-assets.i.posthog.com/static/:path*");
    expect(list[apiIdx].destination).toBe("https://eu.i.posthog.com/:path*");
  });
});
