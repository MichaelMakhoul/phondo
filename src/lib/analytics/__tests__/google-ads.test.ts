import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-569: Google Ads conversion tracking rides the shared Google tag
// (window.dataLayer) alongside the dormant GA4 leg. These pin the two-stage
// activation: the AW tag configures when the ID is set, but a conversion
// NEVER fires until the per-action LABEL (from the Google Ads UI) is also set.

function stubWindowWithDataLayer() {
  vi.stubGlobal("window", { dataLayer: [] });
}

/** The Google tag's public boundary: the dataLayer receives `arguments`. */
function gtagCalls(): unknown[][] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).dataLayer.map((a: IArguments) => Array.from(a));
}

async function loadGoogleAds() {
  // Env is read at module scope — reset the graph so each test's stubbed env
  // is picked up on import.
  vi.resetModules();
  return import("@/lib/analytics/google-ads");
}

beforeEach(() => {
  vi.clearAllMocks();
  stubWindowWithDataLayer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("google ads conversion tracking", () => {
  it("does NOTHING without NEXT_PUBLIC_GOOGLE_ADS_ID", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "");
    const m = await loadGoogleAds();
    expect(m.isGoogleAdsConfigured()).toBe(false);
    m.initGoogleAds();
    m.trackGoogleAdsConversion();
    expect(gtagCalls()).toEqual([]);
  });

  it("ignores a malformed AW id (must match AW-<digits>)", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "18339493581"); // missing AW- prefix
    const m = await loadGoogleAds();
    expect(m.isGoogleAdsConfigured()).toBe(false);
  });

  it("configures the AW tag when the id is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "AW-18339493581");
    const m = await loadGoogleAds();
    expect(m.isGoogleAdsConfigured()).toBe(true);
    m.initGoogleAds();
    expect(gtagCalls()).toContainEqual(["config", "AW-18339493581"]);
  });

  it("does NOT fire a conversion until the per-action label is also set", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "AW-18339493581");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_LABEL", "");
    const m = await loadGoogleAds();
    m.trackGoogleAdsConversion();
    expect(gtagCalls().filter((c) => c[0] === "event")).toEqual([]);
  });

  it("fires the conversion with send_to = id/label once BOTH are set", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "AW-18339493581");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_LABEL", "abcDEF123");
    const m = await loadGoogleAds();
    m.trackGoogleAdsConversion();
    expect(gtagCalls()).toContainEqual([
      "event",
      "conversion",
      { send_to: "AW-18339493581/abcDEF123" },
    ]);
  });

  it("merges caller params into the conversion payload", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "AW-18339493581");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_LABEL", "abcDEF123");
    const m = await loadGoogleAds();
    m.trackGoogleAdsConversion({ value: 50, currency: "AUD" });
    expect(gtagCalls()).toContainEqual([
      "event",
      "conversion",
      { send_to: "AW-18339493581/abcDEF123", value: 50, currency: "AUD" },
    ]);
  });

  it("is a safe no-op during SSR (no window)", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "AW-18339493581");
    vi.unstubAllGlobals(); // remove window
    const m = await loadGoogleAds();
    expect(m.isGoogleAdsConfigured()).toBe(false);
    expect(() => m.initGoogleAds()).not.toThrow();
    expect(() => m.trackGoogleAdsConversion()).not.toThrow();
  });

  it("swallows a throwing/redefined dataLayer — telemetry never breaks the product", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "AW-18339493581");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_LABEL", "abcDEF123");
    // A consent platform / extension can replace dataLayer with a throwing push.
    vi.stubGlobal("window", {
      dataLayer: {
        push: () => {
          throw new Error("dataLayer hijacked");
        },
      },
    });
    const m = await loadGoogleAds();
    expect(() => m.trackGoogleAdsConversion()).not.toThrow();
  });
});

describe("resolveGtagLoadId — which single Google tag id to load", () => {
  it("prefers the GA4 id when it is configured", async () => {
    const m = await loadGoogleAds();
    expect(m.resolveGtagLoadId("G-ABC123", "AW-18339493581")).toBe("G-ABC123");
  });

  it("falls back to the Ads id when GA4 is dormant — the SCRUM-569 path", async () => {
    const m = await loadGoogleAds();
    expect(m.resolveGtagLoadId(undefined, "AW-18339493581")).toBe("AW-18339493581");
  });

  it("returns null when neither is configured (component renders no tag)", async () => {
    const m = await loadGoogleAds();
    expect(m.resolveGtagLoadId(undefined, undefined)).toBeNull();
  });

  it("rejects malformed ids rather than loading a garbage tag", async () => {
    const m = await loadGoogleAds();
    expect(m.resolveGtagLoadId("garbage", "AW-1")).toBe("AW-1"); // GA garbage → Ads
    expect(m.resolveGtagLoadId("G-OK", "garbage")).toBe("G-OK"); // Ads garbage → GA
    expect(m.resolveGtagLoadId("bad", "alsobad")).toBeNull();
  });
});
