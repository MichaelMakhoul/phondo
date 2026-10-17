"use strict";

// SCRUM-594 gate M4b: speech Flux reports no turns for (lib/no-turn-watchdog.js).
// Pure: time is passed in with the audio, so these run on an injected clock.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createNoTurnWatchdog, WINDOW_MS, SPEECH_MS, RMS_THRESHOLD } = require("../lib/no-turn-watchdog");

/** 20 ms of loud speech (mulaw 0x00 decodes to near full scale). */
const SPEECH = Buffer.alloc(160, 0x00);
/** 20 ms of silence (mulaw 0xff decodes to ~0). */
const SILENCE = Buffer.alloc(160, 0xff);

/** Feed `ms` of `frame` every 20 ms from `from`; the value of the last onAudio. */
function feed(w, frame, from, ms, aiSpeaking = false) {
  let tripped = false;
  for (let t = from; t < from + ms; t += 20) tripped = w.onAudio(frame, t, aiSpeaking);
  return tripped;
}

describe("the no-turn watchdog (gate M4b)", () => {
  it("its production values: 3 s of speech within 8 s, frames of RMS 300 or more", () => {
    assert.equal(WINDOW_MS, 8000);
    assert.equal(SPEECH_MS, 3000);
    assert.equal(RMS_THRESHOLD, 300);
  });

  it("never trips on silence, however long", () => {
    const w = createNoTurnWatchdog();
    assert.equal(feed(w, SILENCE, 0, 60_000), false);
    assert.equal(w.speechMs(), 0);
  });

  it("trips once 3 s of speech have gone by with no turn event", () => {
    const w = createNoTurnWatchdog();
    assert.equal(feed(w, SPEECH, 0, 2_980), false, "2.98 s: not yet");
    assert.equal(w.onAudio(SPEECH, 2_980, false), true, "the 150th speech frame");
  });

  it("speech while the AI speaks is not counted (its own voice coming back)", () => {
    const w = createNoTurnWatchdog();
    assert.equal(feed(w, SPEECH, 0, 10_000, true), false);
    assert.equal(w.speechMs(), 0);
  });

  it("a turn event starts the count again", () => {
    const w = createNoTurnWatchdog();
    feed(w, SPEECH, 0, 2_900);
    w.onTurn();
    assert.equal(w.speechMs(), 0);
    assert.equal(feed(w, SPEECH, 2_900, 2_900), false);
  });

  it("only speech within the last 8 s counts: the same 3 s spread thinly never trips", () => {
    const w = createNoTurnWatchdog();
    let tripped = false;
    for (let second = 0; second < 30; second++) {
      tripped = feed(w, SPEECH, second * 1_000, 300) || tripped; // 0.3 s of speech each second: 2.4 s per 8 s
      tripped = feed(w, SILENCE, second * 1_000 + 300, 700) || tripped;
    }
    assert.equal(tripped, false);
    assert.ok(w.speechMs() <= 2_400 + 20, String(w.speechMs()));
  });

  it("a frame just under the threshold is not speech, one at it is", () => {
    const quiet = createNoTurnWatchdog({ rmsThreshold: 40_000 });
    assert.equal(feed(quiet, SPEECH, 0, 5_000), false, "nothing reaches an impossible threshold");
    const w = createNoTurnWatchdog({ speechMs: 20 });
    assert.equal(w.onAudio(SPEECH, 0, false), true);
  });

  it("counts each 20 ms frame of a longer buffer, and ignores what is not audio", () => {
    const w = createNoTurnWatchdog();
    w.onAudio(Buffer.concat([SPEECH, SPEECH, SILENCE, SPEECH]), 0, false);
    assert.equal(w.speechMs(), 60);
    assert.equal(w.onAudio(/** @type {any} */ ("not audio"), 0, false), false);
    assert.equal(w.onAudio(SPEECH, Number.NaN, false), false);
  });
});
