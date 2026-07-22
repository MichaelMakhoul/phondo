import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-566: PostHog rides UNDER the existing typed analytics facade — these
// tests pin the fan-out seam through the PUBLIC index barrel (a stale
// re-export in index.ts would silently kill a whole backend while deep-path
// tests stay green): init posture (the privacy-load-bearing config), BOTH
// backend legs of event/pageview/consent dispatch, identify, throw
// containment, and the key-absent no-op guarantee.

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  set_config: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthogMock }));

const PH_KEY = "phc_test_key_123";
const GA_ID = "G-TEST123";

function stubBrowserGlobals() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    location: { origin: "https://phondo.test", href: "https://phondo.test/x" },
    dataLayer: [],
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

/** GA's public boundary: the dataLayer receives `arguments` objects. */
function gtagCalls(): unknown[][] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).dataLayer.map((a: IArguments) => Array.from(a));
}

async function loadFacade() {
  // Env is read at module scope — fresh module graph per test. The facade is
  // imported through the index barrel on purpose (see header comment).
  vi.resetModules();
  return {
    api: await import("@/lib/analytics"),
    posthog: await import("@/lib/analytics/posthog"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stubBrowserGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("initPostHog posture", () => {
  it("does NOTHING without NEXT_PUBLIC_POSTHOG_KEY — and capture stays a safe no-op", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const { api, posthog } = await loadFacade();
    api.initAnalytics();
    posthog.phCapture("test_event");
    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it("inits once with the privacy-load-bearing config (proxy host, no autocapture, no replay, no double pageviews)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    api.initAnalytics();

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    const [key, config] = posthogMock.init.mock.calls[0];
    expect(key).toBe(PH_KEY);
    expect(config).toMatchObject({
      api_host: "/ingest",
      autocapture: false,
      capture_pageview: false,
      disable_session_recording: true,
      person_profiles: "identified_only",
      // Consent defaults DENIED → cookieless memory persistence.
      persistence: "memory",
    });
  });

  it("a stored consent grant inits with persisted analytics", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    localStorage.setItem("analytics_consent", "granted");
    const { api } = await loadFacade();
    api.initAnalytics();
    expect(posthogMock.init.mock.calls[0][1]).toMatchObject({ persistence: "localStorage+cookie" });
  });

  it("an init throw latches NOTHING: captures no-op, the next initAnalytics retries", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    posthogMock.init.mockImplementationOnce(() => {
      throw new Error("sdk init exploded");
    });
    const { api } = await loadFacade();
    api.initAnalytics();
    api.trackSignUp("google");
    expect(posthogMock.capture).not.toHaveBeenCalled();

    api.initAnalytics(); // strict-mode double-mount = the natural retry
    api.trackSignUp("google");
    expect(posthogMock.init).toHaveBeenCalledTimes(2);
    expect(posthogMock.capture).toHaveBeenCalledWith("sign_up", { method: "google" });
  });
});

describe("facade fan-out — PostHog leg", () => {
  it("a typed tracker reaches PostHog with its params", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    api.trackSignUp("google");
    expect(posthogMock.capture).toHaveBeenCalledWith("sign_up", { method: "google" });
  });

  it("trackPageView emits a $pageview with the full URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    api.trackPageView("/dashboard?tab=calls");
    expect(posthogMock.capture).toHaveBeenCalledWith("$pageview", {
      $current_url: "https://phondo.test/dashboard?tab=calls",
    });
  });

  it("identifyUser identifies with the RAW uuid and org person-properties (never hashed)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    await api.identifyUser({
      userId: "user-uuid-1",
      organizationId: "org-uuid-1",
      planType: "professional",
      industry: "dental",
      country: "AU",
    });
    expect(posthogMock.identify).toHaveBeenCalledTimes(1);
    const [distinctId, props] = posthogMock.identify.mock.calls[0];
    expect(distinctId).toBe("user-uuid-1");
    expect(props).toMatchObject({
      organization_id: "org-uuid-1",
      plan_type: "professional",
      industry: "dental",
      country: "AU",
    });
  });

  it("a posthog-js throw never escapes the facade", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    posthogMock.capture.mockImplementation(() => {
      throw new Error("sdk exploded");
    });
    const { api } = await loadFacade();
    api.initAnalytics();
    expect(() => api.trackLogin("email")).not.toThrow();
  });
});

describe("pre-init queue — mount-effect events must not be lost", () => {
  // {children} passive effects flush BEFORE the root layout's init effect,
  // so onboarding_start on a hard load fires pre-init 100% of the time.
  it("captures and identifies fired before init are queued and drained IN ORDER on init", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api, posthog } = await loadFacade();

    api.trackOnboardingStart();
    posthog.phIdentify("user-uuid-1", { plan_type: "starter" });
    expect(posthogMock.capture).not.toHaveBeenCalled();
    expect(posthogMock.identify).not.toHaveBeenCalled();

    api.initAnalytics();

    expect(posthogMock.capture).toHaveBeenCalledWith("onboarding_start", undefined);
    expect(posthogMock.identify).toHaveBeenCalledWith("user-uuid-1", { plan_type: "starter" });
    const captureOrder = posthogMock.capture.mock.invocationCallOrder[0];
    const identifyOrder = posthogMock.identify.mock.invocationCallOrder[0];
    expect(captureOrder).toBeLessThan(identifyOrder);
  });

  it("a queued pageview keeps the URL from CALL time, not drain time", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();

    api.trackPageView("/onboarding");
    // Simulate a navigation happening before init drains the queue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).location = { origin: "https://phondo.test", href: "https://phondo.test/dashboard" };
    api.initAnalytics();

    expect(posthogMock.capture).toHaveBeenCalledWith("$pageview", {
      $current_url: "https://phondo.test/onboarding",
    });
  });

  it("the queue is bounded — unbounded pre-init growth is not a thing analytics gets to do", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api, posthog } = await loadFacade();

    for (let i = 0; i < 50; i++) posthog.phCapture(`e${i}`);
    api.initAnalytics();

    // 20 drained, the rest dropped.
    expect(posthogMock.capture).toHaveBeenCalledTimes(20);
    expect(posthogMock.capture).toHaveBeenCalledWith("e0", undefined);
    expect(posthogMock.capture).not.toHaveBeenCalledWith("e20", undefined);
  });

  it("without a key nothing is queued either", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const { api, posthog } = await loadFacade();
    posthog.phCapture("early");
    api.initAnalytics();
    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });
});

describe("facade fan-out — GA leg stays intact with both backends configured", () => {
  // The refactor's headline risk: shipping PostHog while silently zeroing
  // the incumbent GA backend. These assert GA's PUBLIC boundary (dataLayer).
  it("initAnalytics configures gtag consent-denied, and events/pageviews still reach the dataLayer", async () => {
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", GA_ID);
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();

    api.initAnalytics();
    expect(gtagCalls()).toContainEqual(["config", GA_ID, { send_page_view: false }]);
    expect(gtagCalls()).toContainEqual(["consent", "update", { analytics_storage: "denied", ad_storage: "denied" }]);

    api.trackSignUp("google");
    expect(gtagCalls()).toContainEqual(["event", "sign_up", { method: "google" }]);
    // PostHog leg unaffected by GA presence.
    expect(posthogMock.capture).toHaveBeenCalledWith("sign_up", { method: "google" });

    api.trackPageView("/dashboard");
    expect(gtagCalls()).toContainEqual([
      "event",
      "page_view",
      { page_path: "/dashboard", page_location: "https://phondo.test/x" },
    ]);
  });

  it("setConsent(true) reaches BOTH backends", async () => {
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", GA_ID);
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();

    api.setConsent(true);
    expect(gtagCalls()).toContainEqual(["consent", "update", { analytics_storage: "granted", ad_storage: "denied" }]);
    expect(posthogMock.set_config).toHaveBeenCalledWith({ persistence: "localStorage+cookie" });

    api.setConsent(false);
    expect(posthogMock.set_config).toHaveBeenCalledWith({ persistence: "memory" });
  });

  it("initAnalytics configs BOTH the GA4 and Google Ads tags on the shared dataLayer", async () => {
    // Pins that initAnalytics still calls initGoogleAds — the ONLY place
    // gtag("config","AW-…") runs (the component's inline script only sets
    // consent defaults). Without it, conversions fire against an unconfigured
    // tag (attribution silently broken) with a green suite.
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", GA_ID);
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "AW-18339493581");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    expect(gtagCalls()).toContainEqual(["config", GA_ID, { send_page_view: false }]);
    expect(gtagCalls()).toContainEqual(["config", "AW-18339493581"]);
  });
});

describe("session replay — DEFAULT-DENY, public marketing/auth routes only", () => {
  // The recorder is disabled at init; we imperatively start it ONLY on
  // allowlisted public routes. Authenticated pages render caller PII, so they
  // must never record — the server-side URL blocklist is a second layer.
  it("inits with input masking AND the recorder still disabled by default", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    const config = posthogMock.init.mock.calls[0][1];
    expect(config.disable_session_recording).toBe(true);
    expect(config.session_recording).toMatchObject({ maskAllInputs: true });
  });

  it("starts recording on a public route — once — across further public routes", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    api.syncSessionReplay("/demo");
    api.syncSessionReplay("/pricing");
    expect(posthogMock.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthogMock.stopSessionRecording).not.toHaveBeenCalled();
  });

  it("stops recording the moment navigation reaches an authenticated route", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    api.syncSessionReplay("/demo"); // start
    api.syncSessionReplay("/calls"); // authed → stop
    expect(posthogMock.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("NEVER starts recording on an authenticated route (default-deny)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    api.syncSessionReplay("/dashboard");
    api.syncSessionReplay("/appointments");
    expect(posthogMock.startSessionRecording).not.toHaveBeenCalled();
  });

  it("does not touch the recorder before init (or without a key)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.syncSessionReplay("/demo"); // fired before initAnalytics
    expect(posthogMock.startSessionRecording).not.toHaveBeenCalled();
  });

  it("re-starts recording after a stop — the latch resets (public → authed → public)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { api } = await loadFacade();
    api.initAnalytics();
    api.syncSessionReplay("/pricing"); // start
    api.syncSessionReplay("/dashboard"); // authed → stop
    api.syncSessionReplay("/industries"); // public again → MUST re-start
    expect(posthogMock.startSessionRecording).toHaveBeenCalledTimes(2);
    expect(posthogMock.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("a recorder throw never escapes syncSessionReplay — SPA navigation must not break", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    posthogMock.startSessionRecording.mockImplementationOnce(() => {
      throw new Error("recorder exploded");
    });
    const { api } = await loadFacade();
    api.initAnalytics();
    expect(() => api.syncSessionReplay("/demo")).not.toThrow();
  });
});

describe("early-access lead — analytics fan-out AND the Google Ads conversion", () => {
  it("captures early_access_submitted on BOTH backends and fires the ads conversion", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", GA_ID);
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "AW-18339493581");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_LABEL", "lead123");
    const { api } = await loadFacade();
    api.initAnalytics();

    api.trackEarlyAccessRequest();

    expect(posthogMock.capture).toHaveBeenCalledWith("early_access_submitted", undefined);
    expect(gtagCalls()).toContainEqual(["event", "early_access_submitted", undefined]);
    expect(gtagCalls()).toContainEqual([
      "event",
      "conversion",
      { send_to: "AW-18339493581/lead123" },
    ]);
  });

  it("still records the lead when Google Ads is unconfigured — the conversion is just skipped", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", "");
    const { api } = await loadFacade();
    api.initAnalytics();

    api.trackEarlyAccessRequest();

    expect(posthogMock.capture).toHaveBeenCalledWith("early_access_submitted", undefined);
  });
});
