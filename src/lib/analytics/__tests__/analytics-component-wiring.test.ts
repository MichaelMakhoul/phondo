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

  it("PostHog inits even when GA is dormant: the GA guard only gates the <Script> render, after the hooks", () => {
    const guardIdx = src.indexOf("if (!GA_MEASUREMENT_ID");
    const initIdx = src.indexOf("initAnalytics()");
    expect(initIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(initIdx);
  });
});
