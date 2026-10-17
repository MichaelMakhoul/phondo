"use strict";

// SCRUM-594 gate M4b: speech Flux reports no turns for (lib/no-turn-watchdog.js).
// Pure: time is passed in with the audio, so these run on an injected clock.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createNoTurnWatchdog, WINDOW_MS, SPEECH_MS, RMS_THRESHOLD, NOISE_WINDOW_MS, NOISE_PERCENTILE, NOISE_FACTOR } = require("../lib/no-turn-watchdog");

/** 20 ms of loud speech (mulaw 0x00 decodes to near full scale: RMS 32223). */
const SPEECH = Buffer.alloc(160, 0x00);
/** 20 ms of silence (mulaw 0xff decodes to 99). */
const SILENCE = Buffer.alloc(160, 0xff);
/** 20 ms of a steady noisy line, a van or a site (mulaw 0xcf decodes to 1023: well above RMS 300). */
const NOISE = Buffer.alloc(160, 0xcf);
/**
 * The counting rules below on a fixed threshold (RMS 300): continuous full-scale "speech"
 * would raise the line's own noise floor, which the relative threshold is tested for apart.
 */
const fixed = (options = {}) => createNoTurnWatchdog({ noiseFactor: 0, ...options });

/** Feed `ms` of `frame` every 20 ms from `from`; the value of the last onAudio. */
function feed(w, frame, from, ms, aiSpeaking = false) {
  let tripped = false;
  for (let t = from; t < from + ms; t += 20) tripped = w.onAudio(frame, t, aiSpeaking);
  return tripped;
}

describe("the no-turn watchdog (gate M4b)", () => {
  it("its production values: 3 s of speech within 8 s; a frame is speech at 4 times the line's noise floor (its 20th-percentile RMS over 10 s), and never below RMS 300", () => {
    assert.equal(WINDOW_MS, 8000);
    assert.equal(SPEECH_MS, 3000);
    assert.equal(RMS_THRESHOLD, 300);
    assert.equal(NOISE_WINDOW_MS, 10_000);
    assert.equal(NOISE_PERCENTILE, 20);
    assert.equal(NOISE_FACTOR, 4);
  });

  it("never trips on silence, however long", () => {
    const w = fixed();
    assert.equal(feed(w, SILENCE, 0, 60_000), false);
    assert.equal(w.speechMs(), 0);
  });

  it("trips once 3 s of speech have gone by with no turn event", () => {
    const w = fixed();
    assert.equal(feed(w, SPEECH, 0, 2_980), false, "2.98 s: not yet");
    assert.equal(w.onAudio(SPEECH, 2_980, false), true, "the 150th speech frame");
  });

  it("speech while the AI speaks is not counted (its own voice coming back)", () => {
    const w = fixed();
    assert.equal(feed(w, SPEECH, 0, 10_000, true), false);
    assert.equal(w.speechMs(), 0);
  });

  it("a turn event starts the count again", () => {
    const w = fixed();
    feed(w, SPEECH, 0, 2_900);
    w.onTurn();
    assert.equal(w.speechMs(), 0);
    assert.equal(feed(w, SPEECH, 2_900, 2_900), false);
  });

  it("only speech within the last 8 s counts: the same 3 s spread thinly never trips", () => {
    const w = fixed();
    let tripped = false;
    for (let second = 0; second < 30; second++) {
      tripped = feed(w, SPEECH, second * 1_000, 300) || tripped; // 0.3 s of speech each second: 2.4 s per 8 s
      tripped = feed(w, SILENCE, second * 1_000 + 300, 700) || tripped;
    }
    assert.equal(tripped, false);
    assert.ok(w.speechMs() <= 2_400 + 20, String(w.speechMs()));
  });

  it("a frame just under the threshold is not speech, one at it is", () => {
    const quiet = fixed({ rmsThreshold: 40_000 });
    assert.equal(feed(quiet, SPEECH, 0, 5_000), false, "nothing reaches an impossible threshold");
    const w = fixed({ speechMs: 20 });
    assert.equal(w.onAudio(SPEECH, 0, false), true);
  });

  it("counts each 20 ms frame of a longer buffer, and ignores what is not audio", () => {
    const w = fixed();
    w.onAudio(Buffer.concat([SPEECH, SPEECH, SILENCE, SPEECH]), 0, false);
    assert.equal(w.speechMs(), 60);
    assert.equal(w.onAudio(/** @type {any} */ ("not audio"), 0, false), false);
    assert.equal(w.onAudio(SPEECH, Number.NaN, false), false);
  });
});

describe("the no-turn watchdog's threshold follows the line (gate N2)", () => {
  it("a steady noisy line (RMS 1023, above the old fixed 300) never trips it, however long", () => {
    const w = createNoTurnWatchdog();
    assert.equal(feed(w, NOISE, 0, 60_000), false);
    assert.equal(w.speechMs(), 0);
    assert.equal(w.threshold(), 4 * 1023, "4 times the line's floor");
    const old = fixed();
    assert.equal(feed(old, NOISE, 0, 4_000), true, "a fixed RMS 300 would have taken the noise for speech");
  });

  it("speech over that noise still counts: it trips once 3 s of it have gone by", () => {
    const w = createNoTurnWatchdog();
    feed(w, NOISE, 0, 2_000); // the line's floor
    let tripped = false;
    let t = 2_000;
    while (!tripped && t < 10_000) {
      for (let i = 0; i < 4 && !tripped; i++, t += 20) tripped = w.onAudio(SPEECH, t, false); // four frames of speech ...
      w.onAudio(NOISE, t, false); // ... and one of the noise between words
      t += 20;
    }
    assert.equal(tripped, true);
    assert.ok(t >= 2_000 + 3_000 && t <= 2_000 + 3_000 * 1.25 + 40, `after 3 s of speech: ${t}`);
  });

  it("on a quiet line it is 4 times the floor, and never below the minimum", () => {
    const w = createNoTurnWatchdog();
    assert.equal(w.threshold(), 300, "before any audio: the minimum");
    feed(w, SILENCE, 0, 1_000); // this decoder's silence is RMS 99
    assert.equal(w.threshold(), 4 * 99);
    const floored = createNoTurnWatchdog({ rmsThreshold: 500 });
    feed(floored, SILENCE, 0, 1_000);
    assert.equal(floored.threshold(), 500);
  });

  it("frames while the AI is busy feed the floor, but never count as speech", () => {
    const w = createNoTurnWatchdog();
    assert.equal(feed(w, SPEECH, 0, 10_000, true), false);
    assert.equal(w.speechMs(), 0);
  });
});
