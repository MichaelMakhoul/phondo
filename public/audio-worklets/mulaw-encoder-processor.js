/**
 * AudioWorklet processor that captures PCM audio, downsamples to 8kHz,
 * and encodes to mulaw for transmission to the voice server.
 *
 * Browser test/demo calls ONLY (the production phone path is Twilio -> server and
 * never touches this file). A browser mic streams continuous room "air" between
 * words; the voice model's onset detector is tuned to be sensitive, so that idle
 * noise keeps interrupting the assistant / holding the turn open and the caller
 * hears dead air until they mute. To emulate "mute when not speaking" without
 * asking the user to do it, we gate the mic: real audio is sent only while the
 * caller is actually talking, and clean digital silence is sent otherwise. This
 * also lets the greeting play uninterrupted at the start of the call.
 */

const MULAW_BIAS = 33;
const MULAW_MAX = 0x1fff;
const TARGET_SAMPLE_RATE = 8000;
// Send a chunk every ~20ms (160 samples at 8kHz)
const CHUNK_SIZE = 160;

// ── Voice-activity gate tuning ──
// Open threshold is adaptive: max(absolute floor, learned noise floor * ratio),
// so the gate calibrates to each caller's room instead of a fixed level.
//
// Both bounds matter. Too LOW and idle room noise opens the gate (the bug this
// gate exists to fix). Too HIGH and the caller is silently, permanently muted —
// the worse failure, because the UI still shows an active call and nothing in
// any log explains it. GATE_MAX_THRESH is the structural guarantee against
// that: the open threshold can never climb above a level normal speech clears.
const GATE_ABS_MIN = 0.004; // never open on anything quieter than this RMS
const GATE_MAX_THRESH = 0.03; // ...and never demand more than this (speech RMS ~0.05-0.12)
const GATE_OPEN_RATIO = 3.0; // open when RMS exceeds this multiple of the noise floor
const GATE_HANGOVER_S = 0.35; // keep sending this long after speech drops (word tails / pauses)
const GATE_PREROLL_SAMPLES = 640; // ~80ms lookahead at 8kHz so speech onsets aren't clipped

// The mic is held shut for this long at the start of the call while the
// assistant delivers its greeting. Every frame in the window is therefore
// guaranteed to be room noise, which is the only chance to learn a LOUD room:
// once the gate is open the hangover keeps re-arming it, so a gate that opens
// on ambient before it has calibrated never closes and never learns.
const GATE_CALIBRATION_S = 0.75;
const FLOOR_CALIB = 0.15; // fast, symmetric adaptation during calibration
const FLOOR_DOWN = 0.15; // afterwards: snap down to a quieter room immediately...
const FLOOR_UP = 0.0015; // ...but creep up, so speech can't inflate the floor
const FLOOR_MAX = 0.02; // cap the learned floor; GATE_MAX_THRESH is the real backstop

// Self-healing bypass: if speech-like audio keeps arriving but the gate never
// opens, the gate is mis-calibrated and is muting a real caller. Being heard
// beats perfect gating, so give up on gating for the rest of the session.
//
// Two properties this has to have, both learned the hard way:
//
//   Reachable. The bar must sit strictly BELOW the open threshold, or any audio
//   loud enough to clear it would have opened the gate instead and the rescue
//   can never fire — which is precisely the mute it exists to undo.
//
//   Sustained. Evidence is time spent above the bar, decaying when below it, so
//   a single 2.7ms rustle during a listening pause cannot latch the gate off
//   for the rest of the call and re-create the dead-air bug.
//
// The reference is the ambient MINIMUM over the last few seconds, not the
// running floor: speech modulates (it pauses between words) and room noise does
// not, so the minimum tracks the room even while someone is talking over it. A
// perfectly steady tone is, by design, treated as noise — that is what it is.
const BYPASS_AFTER_S = 3;
const BYPASS_PEAK_RATIO = 1.8; // rescue bar, as a multiple of ambient
const BYPASS_THRESH_FRACTION = 0.8; // ...and never at or above the open threshold
const BYPASS_MIN_LOUD_S = 0.6; // cumulative speech-like time needed to give up
const BYPASS_LOUD_DECAY = 0.5; // evidence bleeds off at half rate when quiet
const AMBIENT_WINDOW_S = 2.0; // min-hold half-window for the ambient estimate

// The same axiom, applied to the evidence rather than the reference: a caller
// pauses between words, so speech never stays above the rescue bar for this
// long without a gap. Audio that does is a new room level (a compressor kicking
// in, a TV, rain) — the rolling minimum lags such a step by up to two windows,
// which is long enough to bank a full 0.6s of bogus "evidence" and hand the
// model an open mic for the rest of the call. Treat a continuous run as noise:
// throw the evidence away and let the floor sprint to the new level.
const BYPASS_MAX_RUN_S = 1.5;

function linearToMulaw(sample) {
  // Clamp to 16-bit range
  sample = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// mulaw encoding of a zero (digital silence) sample.
const MULAW_SILENCE = linearToMulaw(0);

class MulawEncoderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._resampleIndex = 0;
    this._chunk = [];

    // Voice-activity gate state.
    this._noiseFloor = 0.003;
    this._holdUntil = 0; // gate stays open until this currentTime (seconds)
    // Pre-roll ring buffer of recent real mulaw samples, so when the gate opens
    // we emit the ~80ms leading up to it (the onset) instead of silence.
    this._preroll = new Uint8Array(GATE_PREROLL_SAMPLES);
    this._prerollPos = 0;
    this._prerollFilled = false;

    // Rolling minimum of frame energy — the ambient estimate the rescue bar is
    // anchored to. Two half-windows so the min always covers >= AMBIENT_WINDOW_S.
    this._curMin = Infinity;
    this._prevMin = Infinity;
    this._minWindowStart = 0;

    // Mis-calibration watchdog (see BYPASS_AFTER_S).
    this._bypass = false;
    this._everOpened = false;
    this._loudSinceOpen = 0; // seconds of speech-like audio while shut
    this._aboveBarRun = 0; // seconds of *continuous* above-bar audio
    this._lastOpenAt = 0;
    this._calibrateUntil = 0;
    this._started = false;

    // While the assistant is talking, the mic hears its own voice through the
    // caller's speakers. Whatever AEC leaves behind is not the caller, so it
    // must never be counted as evidence that we are wrongly muting them.
    this._assistantSpeaking = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "assistant-speaking") {
        this._assistantSpeaking = !!event.data.speaking;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const pcmData = input[0]; // Float32Array, mono
    const quantumS = pcmData.length / sampleRate;

    if (!this._started) {
      this._started = true;
      this._calibrateUntil = currentTime + GATE_CALIBRATION_S;
      this._minWindowStart = currentTime;
      // Don't count the calibration window against the rescue timer.
      this._lastOpenAt = this._calibrateUntil;
    }

    // 1. Frame energy (RMS) → gate decision for this render quantum.
    let sumSq = 0;
    for (let i = 0; i < pcmData.length; i++) sumSq += pcmData[i] * pcmData[i];
    const rms = Math.sqrt(sumSq / pcmData.length);
    // A single non-finite sample would poison the floor forever — every
    // comparison against NaN is false, so the gate would shut and the rescue
    // would never fire. Drop the frame instead.
    if (!Number.isFinite(rms)) return true;

    const calibrating = currentTime < this._calibrateUntil;
    const wasOpen = this._bypass || currentTime < this._holdUntil;

    // 2. Track the ambient minimum (speech pauses reveal the room).
    if (rms < this._curMin) this._curMin = rms;
    if (currentTime - this._minWindowStart >= AMBIENT_WINDOW_S) {
      this._prevMin = this._curMin;
      this._curMin = rms;
      this._minWindowStart = currentTime;
    }
    const ambient = Math.min(this._curMin, this._prevMin);

    // 3. Learn the noise floor.
    if (calibrating) {
      // Guaranteed room noise: adapt fast, in both directions.
      this._noiseFloor += (rms - this._noiseFloor) * FLOOR_CALIB;
    } else if (!wasOpen) {
      // Asymmetric. Speech that fails to clear the gate is indistinguishable
      // from noise at this point, so a symmetric EMA would let the caller's own
      // voice raise the floor until they are muted for good.
      const rate = rms < this._noiseFloor ? FLOOR_DOWN : FLOOR_UP;
      this._noiseFloor += (rms - this._noiseFloor) * rate;
    }
    if (this._noiseFloor > FLOOR_MAX) this._noiseFloor = FLOOR_MAX;
    if (this._noiseFloor < 0) this._noiseFloor = 0;

    // Bounded on BOTH sides: a noisy room can never raise the bar past what
    // ordinary speech clears, so the gate cannot lock a caller out.
    const openThresh = Math.min(
      GATE_MAX_THRESH,
      Math.max(GATE_ABS_MIN, this._noiseFloor * GATE_OPEN_RATIO)
    );
    if (!calibrating && rms >= openThresh) {
      // Speech (or a loud transient): (re)open and refresh the hangover.
      this._holdUntil = currentTime + GATE_HANGOVER_S;
      this._lastOpenAt = currentTime;
      this._loudSinceOpen = 0;
      this._aboveBarRun = 0;
      if (!this._everOpened) {
        this._everOpened = true;
        this.port.postMessage({ type: "gate", event: "first-open", rms, floor: this._noiseFloor });
      }
    }
    const gateOpen = !calibrating && (this._bypass || currentTime < this._holdUntil);

    if (!gateOpen && !calibrating) {
      // Watchdog: speech-like audio keeps arriving but the gate never opens.
      const bypassThresh = Math.min(
        openThresh * BYPASS_THRESH_FRACTION,
        Math.max(GATE_ABS_MIN, ambient * BYPASS_PEAK_RATIO)
      );

      // Evidence is banked on the FALLING edge of an above-bar run, and only if
      // that run was short enough to have been a word. A plateau therefore can
      // never bank anything — it is reclassified as a new room level long
      // before it ends — while ordinary speech banks a burst every word.
      if (this._assistantSpeaking) {
        // Echo of our own voice. Neither evidence nor a room measurement.
        this._aboveBarRun = 0;
      } else if (rms > bypassThresh) {
        this._aboveBarRun += quantumS;
        if (this._aboveBarRun > BYPASS_MAX_RUN_S) {
          // Unbroken above-bar audio: a room, not a person. Drop the evidence
          // and let the floor sprint to the new level, which lifts openThresh
          // so the gate keeps holding this louder room out.
          this._loudSinceOpen = 0;
          this._noiseFloor += (rms - this._noiseFloor) * FLOOR_CALIB;
          if (this._noiseFloor > FLOOR_MAX) this._noiseFloor = FLOOR_MAX;
        }
      } else {
        if (this._aboveBarRun > 0 && this._aboveBarRun <= BYPASS_MAX_RUN_S) {
          this._loudSinceOpen += this._aboveBarRun;
        }
        this._aboveBarRun = 0;
        this._loudSinceOpen = Math.max(0, this._loudSinceOpen - quantumS * BYPASS_LOUD_DECAY);
      }

      if (
        !this._bypass &&
        currentTime - this._lastOpenAt > BYPASS_AFTER_S &&
        this._loudSinceOpen >= BYPASS_MIN_LOUD_S
      ) {
        this._bypass = true;
        this.port.postMessage({
          type: "gate",
          event: "bypass",
          rms,
          floor: this._noiseFloor,
        });
      }
    }

    // 2. Downsample to 8kHz, run each sample through the pre-roll delay + gate.
    const ratio = sampleRate / TARGET_SAMPLE_RATE;
    for (let i = 0; i < pcmData.length; i++) {
      this._resampleIndex += 1;
      if (this._resampleIndex >= ratio) {
        this._resampleIndex -= ratio;

        const real = linearToMulaw(pcmData[i]);
        // Delay line: read the sample from ~80ms ago, then store the new one in
        // its slot. When the gate is open we emit the delayed (onset) audio;
        // otherwise we emit clean silence.
        const delayed = this._prerollFilled ? this._preroll[this._prerollPos] : MULAW_SILENCE;
        this._preroll[this._prerollPos] = real;
        this._prerollPos += 1;
        if (this._prerollPos >= GATE_PREROLL_SAMPLES) {
          this._prerollPos = 0;
          this._prerollFilled = true;
        }

        this._chunk.push(gateOpen ? delayed : MULAW_SILENCE);
        if (this._chunk.length >= CHUNK_SIZE) {
          this.port.postMessage(new Uint8Array(this._chunk));
          this._chunk = [];
        }
      }
    }

    return true;
  }
}

registerProcessor("mulaw-encoder-processor", MulawEncoderProcessor);
