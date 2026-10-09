import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// SCRUM-585: source pins for the owner-line wiring. The repo's vitest env
// (node, no DOM, JSX left as "preserve") can't execute TSX components or the
// async server page, so the wiring is pinned against source — same idiom as
// demo-cta.source.test.ts. The card's logic is tested for real in
// src/lib/owner-assistant/__tests__/line-form.test.ts; these pins cover only
// what lives outside it and would fail silently if it regressed.

const SETTINGS_DIR = join(process.cwd(), "src/app/(dashboard)/settings");
const pageSource = readFileSync(join(SETTINGS_DIR, "page.tsx"), "utf-8");
const cardSource = readFileSync(join(SETTINGS_DIR, "owner-line-card.tsx"), "utf-8");

describe("Settings page — owner line wiring", () => {
  it("selects explicit non-secret columns from owner_access, never *", () => {
    // Migration 00171 withholds pin_hash/pin_salt from `authenticated`, so a
    // `select('*')` from the user-bound client fails with 42501 — and the page
    // would then show an already-configured owner the empty state.
    const reads = [...pageSource.matchAll(/\.from\("owner_access"\)\s*\.select\(([^)]*)\)/g)];
    expect(reads).toHaveLength(1);
    expect(reads[0][1].trim()).toBe('"phone_e164, pin_length, enabled"');
  });

  it("shows the card only to the org owner, and only while the UI flag is on", () => {
    expect(pageSource).toMatch(
      /const showOwnerLine\s*=\s*membership\.role === "owner"\s*&&\s*isOwnerAssistantUiEnabled\(\)/,
    );
  });

  it("reads owner_access and the Phondo number only inside that gate", () => {
    const gate = pageSource.indexOf("if (showOwnerLine) {");
    expect(gate).toBeGreaterThan(-1);
    expect(pageSource.indexOf('.from("owner_access")')).toBeGreaterThan(gate);
    expect(pageSource.indexOf('.from("phone_numbers")')).toBeGreaterThan(gate);
  });

  it("renders the card only behind the same gate", () => {
    const jsxGate = pageSource.indexOf("{showOwnerLine && (");
    expect(jsxGate).toBeGreaterThan(-1);
    expect(pageSource.indexOf("<OwnerLineCard")).toBeGreaterThan(jsxGate);
    expect(pageSource.match(/<OwnerLineCard/g)).toHaveLength(1);
  });

  it("gives the card the same US-else-AU country rule the API validates the phone against", () => {
    expect(pageSource).toContain('country={organization.country === "US" ? "US" : "AU"}');
  });
});

describe("Owner line card — client bundle and PIN hygiene", () => {
  it("never imports the Node-crypto hasher into the client bundle", () => {
    expect(cardSource).not.toMatch(/owner-assistant\/pin["']/);
  });

  it("never reads the server-only UI flag (it is always false in the browser)", () => {
    expect(cardSource).not.toContain("isOwnerAssistantUiEnabled");
    expect(cardSource).not.toContain("OWNER_ASSISTANT_UI_ENABLED");
  });

  it("keeps both PIN inputs as write-only numeric password fields", () => {
    expect(cardSource.match(/type="password"/g)).toHaveLength(2);
    expect(cardSource.match(/inputMode="numeric"/g)).toHaveLength(2);
    expect(cardSource.match(/autoComplete="new-password"/g)).toHaveLength(2);
  });

  it("puts no length cap on the PIN inputs, so a pasted long PIN is rejected, not silently truncated", () => {
    // maxLength would let the browser cut "402719583" down to the valid, strong
    // "40271958" — a PIN the owner never chose. validateOwnerLineForm rejects it.
    expect(cardSource).not.toMatch(/maxLength\s*=/);
  });

  it("never renders, interpolates or logs the PIN", () => {
    // Not as JSX text, not inside a template literal …
    expect(cardSource).not.toMatch(/>\s*\{pin(Confirm)?\}\s*</);
    expect(cardSource).not.toMatch(/\$\{pin(Confirm)?\b/);
    // … and no console call mentions it or the request body that carries it.
    const consoleCalls = cardSource.match(/console\.\w+\([^;]*;/g) ?? [];
    expect(consoleCalls.length).toBeGreaterThan(0);
    for (const call of consoleCalls) {
      expect(call).not.toMatch(/\bpin\b|pinConfirm|\bbody\b/i);
    }
  });
});

describe("Owner line card — copy that must stay true", () => {
  // JSX text wraps across lines in source, so compare on collapsed whitespace.
  const cardText = cardSource.replace(/\s+/g, " ");

  it("says assistant calls follow the call-recording setting, never that every call is recorded", () => {
    // recording_consent_mode='never' skips recording (voice-server/server.js), so
    // an unconditional "are recorded" is false for those orgs.
    expect(cardText).toContain("Calls to your assistant follow your call-recording setting, like every other call.");
    expect(cardText).not.toMatch(/are recorded/);
  });

  it("describes the lockout the PIN flow really has", () => {
    // 5 wrong tries per 15 minutes (20 per day), an email on lockout, and saving
    // a new PIN clears the lock.
    expect(cardText).toContain(
      "It only works from the mobile above. After too many wrong PINs the line locks and we email you — saving a new PIN unlocks it.",
    );
  });
});
