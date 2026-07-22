import { describe, it, expect } from "vitest";
import { isPublicReplayPath } from "@/lib/analytics/replay-routes";

// SCRUM-569: session replay is DEFAULT-DENY. This pins the allowlist so a
// future authenticated route (which renders caller PII) can never silently
// become recordable — an allowlist excludes unknown paths by construction.

describe("isPublicReplayPath — default-deny allowlist", () => {
  it.each([
    "/",
    "/demo",
    "/pricing",
    "/privacy",
    "/terms",
    "/data-sovereignty",
    "/industries",
    "/industries/dental",
    "/login",
    "/signup",
    "/forgot-password",
    "/auth",
    "/auth/callback",
  ])("allows public marketing/auth route %s", (p) => {
    expect(isPublicReplayPath(p)).toBe(true);
  });

  it.each([
    "/dashboard",
    "/calls",
    "/calls/abc-123",
    "/appointments",
    "/callbacks",
    "/calendar",
    "/assistants",
    "/assistants/xyz",
    "/settings",
    "/settings/team",
    "/analytics",
    "/billing",
    "/phone-numbers",
    "/support",
    "/admin",
    "/admin/calls",
    "/onboarding",
  ])("denies authenticated PII-bearing route %s", (p) => {
    expect(isPublicReplayPath(p)).toBe(false);
  });

  it("does not prefix-bleed — a longer path that merely starts with an allowed name is denied", () => {
    expect(isPublicReplayPath("/loginx")).toBe(false);
    expect(isPublicReplayPath("/demo-something")).toBe(false);
    expect(isPublicReplayPath("/industriesX")).toBe(false);
  });

  it("expects a CLEAN pathname — a query tail is not matched", () => {
    // The component feeds syncSessionReplay(pathname), never the full url. A
    // regression to the url ("/pricing?utm_source=flyer") would silently stop
    // recording exactly the flyer-QR / paid traffic landing on these pages.
    expect(isPublicReplayPath("/pricing?utm_source=flyer")).toBe(false);
    expect(isPublicReplayPath("/demo?utm_source=flyer")).toBe(false);
  });
});
