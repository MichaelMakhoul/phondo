/**
 * SCRUM-556 (package C) — turn-taking gate for custom VAD.
 *
 * Consumes one (voiceProbability, blockRms) pair per 10ms block from the
 * audio front-end (SCRUM-555) and decides when a caller TURN opens and
 * closes. gemini-live translates the events into manual activityStart /
 * activityEnd markers with Gemini's automatic VAD disabled.
 *
 * Why this exists: Gemini's automatic VAD — even at the SCRUM-554 LOW onset —
 * has no concept of the call's ambient noise level. This gate does: a rolling
 * NOISE FLOOR is learned from non-speech blocks, and a turn only opens when
 * the audio is BOTH speech-like (RNNoise probability) AND dominant (energy a
 * margin above the learned floor, so train announcements at background volume
 * never open turns even when they contain real speech).
 *
 * State machine (all thresholds in blocks of 10ms):
 *   closed → open: OPEN_BLOCKS consecutive blocks with prob ≥ OPEN_PROB and
 *                  rms ≥ max(floor × DOMINANCE_MARGIN, ABS_MIN_RMS) → "start"
 *   open → closed: CLOSE_BLOCKS consecutive blocks with prob < CLOSE_PROB or
 *                  rms below ~the floor → "end"
 * Brief dips shorter than CLOSE_BLOCKS never close a turn (hangover), and
 * isolated qualifying blocks shorter than OPEN_BLOCKS never open one.
 *
 * Pure logic, no I/O — fully unit-testable. Ships DARK behind CUSTOM_VAD
 * (default off) until tuned against owner test calls.
 */

// ── tuning constants ─────────────────────────────────────────────────────────
const OPEN_PROB = 0.85; // RNNoise voice probability required to open
const CLOSE_PROB = 0.4; // below this a block counts toward closing
const OPEN_BLOCKS = 12; // 120ms of sustained qualifying speech opens a turn
const CLOSE_BLOCKS = 80; // 800ms of sustained non-speech closes it
const FLOOR_ALPHA = 0.03; // EMA rate for the noise floor (non-speech blocks only)
const FLOOR_INIT = 200; // starting noise floor (int16 RMS scale)
const FLOOR_MIN = 100;
const FLOOR_MAX = 20000;
const DOMINANCE_MARGIN = 2.5; // ~8dB: speech must stand this far above the floor
const CLOSE_ENERGY_FACTOR = 1.2; // open turns count blocks near the floor as silence
const ABS_MIN_RMS = 300; // absolute minimum energy to ever open a turn

class TurnGate {
  constructor() {
    this.open = false;
    this.floor = FLOOR_INIT;
    this.openStreak = 0;
    this.closeStreak = 0;
  }

  /**
   * Feed one 10ms block. Returns "start" when a turn opens, "end" when it
   * closes, or null.
   * @param {number} prob - RNNoise voice probability 0..1
   * @param {number} rms - block RMS (int16 scale, post-denoise, pre-AGC)
   * @returns {"start"|"end"|null}
   */
  push(prob, rms) {
    // Learn the ambient floor from non-speech blocks only, so long turns
    // don't drag the floor up toward speech level.
    if (prob < 0.5) {
      this.floor += (rms - this.floor) * FLOOR_ALPHA;
      if (this.floor < FLOOR_MIN) this.floor = FLOOR_MIN;
      else if (this.floor > FLOOR_MAX) this.floor = FLOOR_MAX;
    }

    if (!this.open) {
      const dominant = rms >= Math.max(this.floor * DOMINANCE_MARGIN, ABS_MIN_RMS);
      this.openStreak = prob >= OPEN_PROB && dominant ? this.openStreak + 1 : 0;
      if (this.openStreak >= OPEN_BLOCKS) {
        this.open = true;
        this.openStreak = 0;
        this.closeStreak = 0;
        return "start";
      }
    } else {
      const silent = prob < CLOSE_PROB || rms < this.floor * CLOSE_ENERGY_FACTOR;
      this.closeStreak = silent ? this.closeStreak + 1 : 0;
      if (this.closeStreak >= CLOSE_BLOCKS) {
        this.open = false;
        this.openStreak = 0;
        this.closeStreak = 0;
        return "end";
      }
    }
    return null;
  }
}

/** CUSTOM_VAD env flag — DEFAULT OFF; "on"/"true"/"1" enables. */
function customVadEnabled() {
  const v = (process.env.CUSTOM_VAD || "off").toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

module.exports = { TurnGate, customVadEnabled };
