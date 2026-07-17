"use strict";

/**
 * SCRUM-555 — server.js boot wiring for the audio front-end.
 *
 * Deleting the boot init leaves rnnoiseInstance null forever: every call
 * silently runs the legacy path while the feature looks shipped, and the
 * Sentry load-failure warning disappears with it — the exact "silently
 * skipped front-end" failure mode. Source-regex pins, per the repo's
 * established wiring-test pattern.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

describe("server.js audio front-end boot wiring (SCRUM-555)", () => {
  it("requires and kicks off initAudioFrontend at boot, before server.listen", () => {
    assert.match(
      serverSource,
      /\{ initAudioFrontend \} = require\("\.\/lib\/audio-frontend"\)/,
      "audio-frontend require missing from server.js"
    );
    const initIdx = serverSource.indexOf("initAudioFrontend().then(");
    const listenIdx = serverSource.indexOf("server.listen(");
    assert.ok(initIdx !== -1, "boot must warm the wasm or every call silently runs the legacy path");
    assert.ok(listenIdx !== -1 && initIdx < listenIdx, "init must start before listen so the first call gets the front-end");
  });

  it("Sentry-warns on load failure but NOT for the operator kill-switch", () => {
    assert.match(
      serverSource,
      /if \(!enabled && reason !== "AUDIO_FRONTEND=off"\) \{\s*Sentry\.captureMessage\(`AudioFrontend disabled: \$\{reason\}`, "warning"\)/,
      "load-failure Sentry warning (with the flag-off exemption) missing"
    );
  });
});
