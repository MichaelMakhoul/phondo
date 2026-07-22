import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// SCRUM-566: the root-layout analytics component is the SOLE production
// caller of initAnalytics — a regression back to initGtag() would silently
// kill all PostHog while every facade test stays green (the facade suites
// exercise initAnalytics directly). The repo's vitest env is node with
// tsconfig jsx:"preserve", so the TSX component can't be executed here —
// source-pin the wiring instead (the voice-server house idiom for
// un-executable surfaces).

const src = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "components", "analytics", "google-analytics.tsx"),
  "utf8",
);

describe("middleware stays out of /ingest (source pin)", () => {
  it("the matcher excludes ingest/ — Supabase auth work must never run on analytics beacons", () => {
    const mw = fs.readFileSync(path.join(__dirname, "..", "..", "..", "middleware.ts"), "utf8");
    expect(mw).toMatch(/matcher:[^]{0,800}?ingest\//);
  });
});

describe("GoogleAnalytics component wiring (source pin)", () => {
  it("the init effect calls initAnalytics (the full fan-out), never initGtag directly", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{[^]{0,400}?initAnalytics\(\);/);
    expect(src).not.toMatch(/\binitGtag\(/);
    expect(src).not.toMatch(/\binitConsent\(/);
  });

  it("the SPA pageview effect drives the shared trackPageView (both backends)", () => {
    expect(src).toMatch(/trackPageView\(url\)/);
    expect(src).toMatch(/\[pathname, searchParams\]/);
  });

  it("PostHog inits even when Google is dormant: the tag guard only gates the <Script> render, after the hooks", () => {
    // SCRUM-569: the render guard is now GA-OR-Ads (either loads the Google
    // tag), but the intent is unchanged — it must sit AFTER the hooks so
    // PostHog/replay init is never skipped when Google is unconfigured.
    const guardIdx = src.indexOf("if (!gtagLoadId)");
    const initIdx = src.indexOf("initAnalytics()");
    expect(initIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(initIdx);
  });

  it("SCRUM-569: the pageview effect also syncs default-deny session replay by pathname", () => {
    // pathname only (no query string) — the replay allowlist matches paths.
    expect(src).toMatch(/syncSessionReplay\(pathname\)/);
  });

  it("SCRUM-569: the replay stop() runs BEFORE trackPageView — the PII-stop must not depend on GA telemetry", () => {
    const syncIdx = src.indexOf("syncSessionReplay(pathname)");
    const pvIdx = src.indexOf("trackPageView(url)");
    expect(syncIdx).toBeGreaterThan(-1);
    expect(pvIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeLessThan(pvIdx);
  });

  it("SCRUM-569: the Google tag load id comes from the tested GA-or-Ads resolver", () => {
    // resolveGtagLoadId is unit-tested (google-ads.test.ts) for the three-way
    // GA→Ads→null branch; the component just feeds it BOTH ids.
    expect(src).toMatch(/resolveGtagLoadId\(GA_MEASUREMENT_ID, GOOGLE_ADS_ID\)/);
  });
});

describe("early-access conversion gate (source pin)", () => {
  // SCRUM-569: the honeypot→phantom-conversion fix lives in TWO places — the
  // server returns `tracked` only for a genuine lead (pinned in route.test.ts),
  // and the CLIENT fires the conversion only behind that flag. The signup page
  // is un-executable TSX here, so source-pin the gate: a refactor that dropped
  // it would re-introduce phantom conversions with a green server-contract test.
  const signup = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "app", "(auth)", "signup", "page.tsx"),
    "utf8",
  );

  it("fires the lead/ads conversion ONLY behind the server's `tracked` flag", () => {
    expect(signup).toMatch(/if \(json\.tracked\)/);
    expect(signup).toMatch(/trackEarlyAccessRequest\(\)/);
  });

  it("commits the success UX (setEaSubmitted) BEFORE analytics — telemetry can't undo it", () => {
    const submittedIdx = signup.indexOf("setEaSubmitted(true)");
    const trackIdx = signup.indexOf("trackEarlyAccessRequest()");
    expect(submittedIdx).toBeGreaterThan(-1);
    expect(trackIdx).toBeGreaterThan(submittedIdx);
  });
});
