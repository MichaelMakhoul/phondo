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
const OWNER_ASSISTANT_DIR = join(process.cwd(), "src/lib/owner-assistant");
const pageSource = readFileSync(join(SETTINGS_DIR, "page.tsx"), "utf-8");
const cardSource = readFileSync(join(SETTINGS_DIR, "owner-line-card.tsx"), "utf-8");
const lineFormSource = readFileSync(join(OWNER_ASSISTANT_DIR, "line-form.ts"), "utf-8");
const pinRulesSource = readFileSync(join(OWNER_ASSISTANT_DIR, "pin-rules.ts"), "utf-8");

// Every module a source file pulls in: static imports, `export … from`,
// side-effect imports, dynamic import() and require(). Comments are dropped
// first so prose that mentions a module cannot count as, or hide, an import.
function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = [
    ...code.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...code.matchAll(/\bimport\s+["']([^"']+)["']/g),
    ...code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  return [...new Set(found)].sort();
}

describe("Settings page — owner line wiring", () => {
  it("selects explicit non-secret columns from owner_access, never *", () => {
    // Migration 00171 withholds pin_hash/pin_salt from `authenticated`, so a
    // `select('*')` from the user-bound client fails with 42501 — and the page
    // would then show an already-configured owner a load error instead of
    // their line.
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

  it("routes a failed owner_access read to the card's failure state, never to the empty form", () => {
    // A read error (42501 from a column-grant regression, an outage) must
    // not look like "no row yet": the empty form says "Not set up yet." and its
    // next save would overwrite a stored PIN through the service-role API with a
    // success toast. The unit tests in line-form.test.ts pin that
    // resolveOwnerLineInitial turns an error into null; these pin that the page
    // really hands it the read and the card the result.
    expect(pageSource).toMatch(/let ownerLine: OwnerLineInitial \| null = null;/);
    expect(pageSource).toMatch(
      /ownerLine = resolveOwnerLineInitial\(\{\s*data: access,\s*error: accessError\s*\}\);/,
    );
    expect(pageSource).toMatch(/initial=\{ownerLine\}/);
    // The page never builds the empty default itself, so no error branch can fall back to it.
    expect(pageSource).not.toMatch(/configured:\s*false/);
  });

  it("logs the failed read before handing it to the card", () => {
    const log = pageSource.indexOf('console.error("[Settings] owner_access read failed:"');
    expect(log).toBeGreaterThan(-1);
    expect(log).toBeLessThan(pageSource.indexOf("resolveOwnerLineInitial({"));
  });
});

describe("Owner line card — client bundle and PIN hygiene", () => {
  it("never imports the Node-crypto hasher into the client bundle", () => {
    expect(cardSource).not.toMatch(/owner-assistant\/pin["']/);
  });

  // Everything the card imports lands in the browser bundle. line-form.ts is the
  // card's logic and pin-rules.ts is shared with the API route, so each is held
  // to a fixed import list: an extra one (above all ./pin, which pulls in Node
  // crypto) fails here instead of in a client build.
  it("keeps line-form.ts importing only the phone normaliser and pin-rules", () => {
    expect(importSpecifiers(lineFormSource)).toEqual(["@/lib/owner-assistant/pin-rules", "@/lib/phone/normalize"]);
  });

  it("keeps pin-rules.ts free of imports altogether", () => {
    expect(importSpecifiers(pinRulesSource)).toEqual([]);
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

describe("Owner line card — the pause switch", () => {
  const cardText = cardSource.replace(/\s+/g, " ");

  it("says an unsaved toggle is not applied yet, and ties that notice to the switch for screen readers", () => {
    expect(cardText).toContain("const enabledPending = enabled !== savedEnabled;");
    expect(cardText).toMatch(/\{enabledPending && \( <p id="owner-line-enabled-pending"/);
    expect(cardText).toContain("Not applied yet — press Save changes.");
    expect(cardText).not.toContain("click Save changes");
    // The switch's description includes the notice, so assistive tech announces it with the switch.
    expect(cardText).toMatch(/aria-describedby=\{[^}]*owner-line-enabled-pending[^}]*\}/);
  });
});

describe("Owner line card — load failure state", () => {
  // The body of a top-level `function name(...) { ... }`: from its signature to
  // the first closing brace in column 0.
  function functionBody(source: string, name: string): string {
    const start = source.indexOf(`function ${name}(`);
    expect(start, `function ${name} not found`).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    expect(end, `end of function ${name} not found`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("takes a nullable initial and switches to the failure state before any form renders", () => {
    expect(cardSource).toMatch(/initial: OwnerLineInitial \| null;/);
    expect(functionBody(cardSource, "OwnerLineCard")).toMatch(/if \(initial === null\) return <OwnerLineLoadFailed \/>;/);
  });

  it("shows the agreed message in an alert and offers nothing to save, remove or edit", () => {
    const failed = functionBody(cardSource, "OwnerLineLoadFailed");
    expect(failed).toContain("{LOAD_FAILED_MESSAGE}");
    expect(failed).toContain('<Alert variant="destructive">');
    // Never the empty form, Save or Remove, any field, or a request.
    for (const forbidden of [
      "Not set up yet",
      "Set up assistant line",
      "Save",
      "Remove",
      "<Button",
      "<Input",
      "<Switch",
      "<Dialog",
      "fetch(",
    ]) {
      expect(failed, `the failure state must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("keeps the empty-state copy and the Save and Remove controls inside the form component", () => {
    const form = functionBody(cardSource, "OwnerLineForm");
    for (const required of ["Not set up yet.", "Set up assistant line", "Remove assistant line", "handleSave", "handleRemove"]) {
      expect(form, `the form component must contain ${required}`).toContain(required);
    }
    // The switch in front of it renders none of that either.
    expect(functionBody(cardSource, "OwnerLineCard")).not.toContain("Not set up yet");
  });
});
