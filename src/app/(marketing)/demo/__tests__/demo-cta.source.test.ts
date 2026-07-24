import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// SCRUM-570: source-pins for the /demo conversion fixes. The repo's vitest env
// (node, no DOM) can't execute TSX components, so page-level wiring is
// pinned against source — same idiom as analytics-component-wiring.test.ts.
//
// Why these pins exist: ads delivered ~14 AU visitors/week to /demo while
// test_call_started fired twice a fortnight. Replays showed nobody pressed the
// card buttons at all, so the fixes are (1) an instant hero CTA that skips the
// industry decision, (2) microcopy that invites instead of warns, (3) a mic
// disclosure at the moment the browser actually asks, (4) a consent banner
// that no longer floats over the mobile CTA zone.

const demoPageSource = readFileSync(
  join(process.cwd(), "src/app/(marketing)/demo/page.tsx"),
  "utf-8"
);

const consentSource = readFileSync(
  join(process.cwd(), "src/components/analytics/cookie-consent.tsx"),
  "utf-8"
);

describe("SCRUM-570: /demo hero instant-call CTA", () => {
  it("hero has a primary CTA that starts the dental demo directly (no industry pick)", () => {
    expect(demoPageSource).toContain('handleStartDemo("dental")');
    expect(demoPageSource).toContain("Talk to it now");
  });

  it("hero CTA is disabled when AudioWorklet is unsupported, like the card buttons", () => {
    // Both the hero CTA and the three card buttons must gate on audioSupported —
    // an always-enabled hero button would dead-end unsupported browsers.
    const disabledGates = demoPageSource.match(/disabled=\{!audioSupported\}/g) ?? [];
    expect(disabledGates.length).toBeGreaterThanOrEqual(2);
  });

  it("hero subtitle no longer opens with the pick-an-industry decision", () => {
    expect(demoPageSource).not.toContain("Pick an industry and have a real conversation");
  });

  it("hero CTA renders only in the select state", () => {
    // Bounded proximity: the CTA must sit inside the select-state guard. A
    // refactor that lifts it out would leave a pulsing call button rendered
    // mid-call — and every other pin would still pass.
    expect(demoPageSource).toMatch(
      /demoState === "select" && \([\s\S]{0,1200}?Talk to it now/
    );
  });

  it("hero microcopy explains the dead button on unsupported browsers", () => {
    // Silent-failure review: when AudioWorklet is missing the hero CTA renders
    // disabled with the "Browser not supported" banner below the fold on small
    // phones — the microcopy under the button must carry the explanation
    // instead of promising a call the button can't start.
    expect(demoPageSource).toMatch(
      /audioSupported\s*\?\s*"30-second live conversation/
    );
    expect(demoPageSource).toContain("Live calls need a modern browser");
  });
});

describe("SCRUM-570: microcopy invites instead of warns", () => {
  it("the mic warning label under the buttons is gone", () => {
    expect(demoPageSource).not.toContain("Uses your browser microphone");
  });

  it("value microcopy replaces it on BOTH surfaces (hero + cards)", () => {
    expect((demoPageSource.match(/no signup/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("card buttons say the action, not the hedge", () => {
    expect(demoPageSource).not.toContain("Try It Now");
    expect(demoPageSource).toContain("Call the AI now");
  });

  it("mic disclosure moved to the connecting state, where the browser prompt appears", () => {
    // Pin the CONDITIONALITY, not just the phrase — an unconditional line
    // would show "tap Allow" during the live call and pass a bare toContain.
    expect(demoPageSource).toMatch(
      /status === "connecting"\s*\?\s*"Your browser will ask to use your microphone/
    );
  });
});

describe("SCRUM-570: consent banner is a slim bottom bar on mobile", () => {
  it("mobile layout pins to the viewport bottom edge instead of floating over content", () => {
    expect(consentSource).toMatch(/[\s"]bottom-0\b/);
    // Floating-card treatment must be desktop-only (md:) — the old mobile
    // `bottom-4 left-4 right-4` card covered the demo CTA zone on first paint.
    // Bare (unprefixed) bottom-4 is banned; md:bottom-4 is the desktop variant.
    expect(consentSource).not.toMatch(/[\s"]bottom-4\b/);
    expect(consentSource).toContain("md:bottom-4");
  });

  it("consent semantics are untouched — same setConsent(true/false) pair", () => {
    expect(consentSource).toContain("setConsent(false)");
    expect(consentSource).toContain("setConsent(true)");
  });
});
