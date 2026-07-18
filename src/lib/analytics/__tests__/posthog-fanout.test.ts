import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-566: PostHog rides UNDER the existing typed analytics facade — these
// tests pin the fan-out seam: init posture (the privacy-load-bearing config),
// event/pageview/identify dispatch, consent mirroring, and the key-absent
// no-op guarantee (analytics must never break the app).

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  set_config: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthogMock }));

const PH_KEY = "phc_test_key_123";

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

async function loadFacade() {
  // Env is read at module scope — a fresh module graph per test.
  vi.resetModules();
  return {
    dispatch: await import("@/lib/analytics/dispatch"),
    posthog: await import("@/lib/analytics/posthog"),
    consent: await import("@/lib/analytics/consent"),
    userProps: await import("@/lib/analytics/user-properties"),
    events: await import("@/lib/analytics/events"),
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
    const { dispatch, posthog } = await loadFacade();
    dispatch.initAnalytics();
    posthog.phCapture("test_event");
    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it("inits once with the privacy-load-bearing config (proxy host, no autocapture, no replay, no double pageviews)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { dispatch } = await loadFacade();
    dispatch.initAnalytics();
    dispatch.initAnalytics();

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
    const { dispatch } = await loadFacade();
    dispatch.initAnalytics();
    expect(posthogMock.init.mock.calls[0][1]).toMatchObject({ persistence: "localStorage+cookie" });
  });
});

describe("facade fan-out", () => {
  it("a typed tracker reaches PostHog with its params", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { dispatch, events } = await loadFacade();
    dispatch.initAnalytics();
    events.trackSignUp("google");
    expect(posthogMock.capture).toHaveBeenCalledWith("sign_up", { method: "google" });
  });

  it("trackPageView emits a $pageview with the full URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { dispatch } = await loadFacade();
    dispatch.initAnalytics();
    dispatch.trackPageView("/dashboard?tab=calls");
    expect(posthogMock.capture).toHaveBeenCalledWith("$pageview", {
      $current_url: "https://phondo.test/dashboard?tab=calls",
    });
  });

  it("identifyUser identifies with the RAW uuid and org person-properties (never hashed)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { dispatch, userProps } = await loadFacade();
    dispatch.initAnalytics();
    await userProps.identifyUser({
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

  it("a consent flip reaches PostHog persistence", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    const { dispatch, consent } = await loadFacade();
    dispatch.initAnalytics();
    consent.setConsent(true);
    expect(posthogMock.set_config).toHaveBeenCalledWith({ persistence: "localStorage+cookie" });
    consent.setConsent(false);
    expect(posthogMock.set_config).toHaveBeenCalledWith({ persistence: "memory" });
  });

  it("a posthog-js throw never escapes the facade", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", PH_KEY);
    posthogMock.capture.mockImplementation(() => {
      throw new Error("sdk exploded");
    });
    const { dispatch, events } = await loadFacade();
    dispatch.initAnalytics();
    expect(() => events.trackLogin("email")).not.toThrow();
  });
});
