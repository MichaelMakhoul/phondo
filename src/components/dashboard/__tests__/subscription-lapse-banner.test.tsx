import { describe, it, expect } from "vitest";
import {
  DEFAULT_GRACE_DAYS,
  DEFAULT_RECLAIM_DAYS,
  type LapseSubscription,
} from "@/lib/subscriptions/lapse-state";
// Import the PURE content helper directly (no React / next / lucide), so this
// runs in the repo's node vitest env (no jsdom). The server component renders
// straight from this mapping, so testing it covers the banner's state→copy and
// severity (variant) selection.
import { getLapseBannerContent } from "../lapse-banner-content";

const DAY = 86_400_000;
const ANCHOR_ISO = "2026-06-01T00:00:00.000Z";
const ANCHOR = Date.parse(ANCHOR_ISO);
const GRACE_MS = DEFAULT_GRACE_DAYS * DAY; // 7d
const RECLAIM_MS = DEFAULT_RECLAIM_DAYS * DAY; // 90d

describe("getLapseBannerContent — hidden (no banner)", () => {
  it("returns null when there is no subscription", () => {
    expect(getLapseBannerContent(null, ANCHOR)).toBeNull();
    expect(getLapseBannerContent(undefined, ANCHOR)).toBeNull();
  });

  it("returns null for an active subscription, regardless of timestamps", () => {
    const sub: LapseSubscription = {
      status: "active",
      current_period_end: ANCHOR_ISO,
      service_ended_at: ANCHOR_ISO,
    };
    expect(getLapseBannerContent(sub, ANCHOR + 10 * RECLAIM_MS)).toBeNull();
  });

  it("returns null for past_due (Stripe dunning grace stays callable)", () => {
    const sub: LapseSubscription = {
      status: "past_due",
      current_period_end: ANCHOR_ISO,
    };
    expect(getLapseBannerContent(sub, ANCHOR + 10 * RECLAIM_MS)).toBeNull();
  });

  it("returns null while a trial is still valid", () => {
    const sub: LapseSubscription = { status: "trialing", trial_end: ANCHOR_ISO };
    expect(getLapseBannerContent(sub, ANCHOR - DAY)).toBeNull();
  });
});

describe("getLapseBannerContent — in_grace (amber warning)", () => {
  // unpaid → the period already ended, so within grace it is in_grace.
  const sub: LapseSubscription = {
    status: "unpaid",
    current_period_end: ANCHOR_ISO,
  };
  const content = getLapseBannerContent(sub, ANCHOR + DAY);

  it("is shown with warning severity for the recoverable window", () => {
    expect(content).not.toBeNull();
    expect(content!.severity).toBe("warning");
    expect(content!.state).toBe("in_grace");
  });

  it("tells the user the AI keeps answering until the grace deadline", () => {
    // grace ends 7 days after the 1 June anchor → 8 June 2026 (UTC, en-AU).
    expect(content!.description).toContain("keeps answering until");
    expect(content!.description).toContain("8 June 2026");
  });

  it("offers an Update billing CTA", () => {
    expect(content!.ctaLabel).toBe("Update billing");
  });

  it("is also reachable from a trialing subscription past its trial", () => {
    const trial: LapseSubscription = {
      status: "trialing",
      trial_end: ANCHOR_ISO,
    };
    const c = getLapseBannerContent(trial, ANCHOR + DAY);
    expect(c).not.toBeNull();
    expect(c!.severity).toBe("warning");
    expect(c!.state).toBe("in_grace");
  });
});

describe("getLapseBannerContent — lapsed (destructive)", () => {
  const sub: LapseSubscription = {
    status: "unpaid",
    current_period_end: ANCHOR_ISO,
  };
  const content = getLapseBannerContent(sub, ANCHOR + GRACE_MS + DAY);

  it("is shown with destructive severity once past grace", () => {
    expect(content).not.toBeNull();
    expect(content!.severity).toBe("destructive");
    expect(content!.state).toBe("lapsed");
  });

  it("warns that the AI has stopped answering and calls divert", () => {
    expect(content!.title.toLowerCase()).toContain("stopped answering");
    expect(content!.description.toLowerCase()).toMatch(/fallback|voicemail/);
  });
});

describe("getLapseBannerContent — release_pending (destructive)", () => {
  // canceled past the 90-day reclaim window, anchored at service_ended_at.
  const sub: LapseSubscription = {
    status: "canceled",
    service_ended_at: ANCHOR_ISO,
  };
  const content = getLapseBannerContent(sub, ANCHOR + RECLAIM_MS + DAY);

  it("is shown with destructive severity", () => {
    expect(content).not.toBeNull();
    expect(content!.severity).toBe("destructive");
    expect(content!.state).toBe("release_pending");
  });

  it("warns the number may be released and prompts resubscribe", () => {
    expect(content!.title.toLowerCase()).toContain("released soon");
    expect(content!.description.toLowerCase()).toContain("resubscribe");
    expect(content!.ctaLabel).toBe("Resubscribe");
  });
});
