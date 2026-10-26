"use strict";

// SCRUM-594 (phone test F5): Charlotte is catalogued as an Australian voice
// (src/lib/voices), but the fast path spoke her with Asteria, an American
// voice. The owner picked Deepgram's Australian Theia in a blind A/B.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { getDeepgramVoice } = require("../lib/voice-mapping");

const CHARLOTTE = "XB0fDUnXU5powFXDhCwa";

test("Charlotte speaks with Deepgram's Australian voice (Theia)", () => {
  assert.equal(getDeepgramVoice(CHARLOTTE), "aura-2-theia-en");
});

test("the web catalog's Charlotte names the same Deepgram voice (the two must not drift)", () => {
  const catalog = fs.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "voices", "index.ts"), "utf8");
  const entry = catalog.slice(catalog.indexOf(`id: "${CHARLOTTE}"`), catalog.indexOf("}", catalog.indexOf(`id: "${CHARLOTTE}"`)));
  assert.match(entry, /accent: "australian"/);
  assert.match(entry, /deepgramVoice: "aura-2-theia-en"/);
});
