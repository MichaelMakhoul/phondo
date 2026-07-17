/**
 * SCRUM-555 (package B) — inbound audio front-end for the Gemini pipeline.
 *
 * Per 10ms block: mulaw 8k → PCM16 8k → upsample ×6 (48k) → RNNoise denoise
 * (+ per-frame voice probability) → downsample ÷3 (16k) → VAD-gated smoothed
 * AGC → base64 PCM16 16k for Gemini.
 *
 * Why: real train calls (SCRUM-554 evidence) carried rumble/hiss that both
 * degraded Gemini's hearing and starved quiet callers once VAD onset moved to
 * LOW. RNNoise removes stationary noise; the AGC re-levels quiet callers the
 * way SCRUM-375's per-frame normalizer did, but with temporal smoothing (no
 * frame-to-frame gain pumping) and gated on RNNoise's voice probability so
 * background noise between words is never amplified.
 *
 * Flag: AUDIO_FRONTEND — unset or "on" = enabled; "off" = disabled (calls run
 * the legacy twilioToGemini path, byte-identical to pre-SCRUM-555 behavior).
 *
 * FAIL-OPEN: if the wasm fails to load, or a session hits repeated processing
 * errors, audio falls back to the legacy path — a broken front-end must never
 * break calls. The wasm (@shiguredo/rnnoise-wasm) is compiled for browsers, so
 * load() briefly shims window/self/document; the shims are removed in a
 * finally block and a regression test pins that nothing leaks into globals.
 *
 * The per-frame voice probability is exposed via lastSpeechProb / avgSpeechProb
 * — package C (SCRUM-556, custom turn-taking) consumes it.
 */

const { mulawToPcm16, twilioToGemini } = require("./audio-converter");

// ── tuning constants ─────────────────────────────────────────────────────────
const BLOCK_8K = 80; // 10ms at 8kHz — one RNNoise frame after ×6 upsample
const RN_FRAME = 480; // RNNoise frame size at 48kHz
const BLOCK_16K = 160; // 10ms at 16kHz (output block)
const AGC_TARGET_RMS = 2600; // speech target level at 16k (int16 scale)
const AGC_MAX_GAIN = 8;
const AGC_FLOOR_RMS = 180; // below this a "speech" frame is treated as silence
const AGC_VAD_GATE = 0.6; // only adapt gain when RNNoise says this is a voice
const AGC_ATTACK = 0.35; // per-block smoothing when gain must DROP (fast)
const AGC_RELEASE = 0.02; // per-block smoothing when gain may RISE (slow)
const MAX_SESSION_ERRORS = 5; // after this many processing errors, go legacy

// ── wasm singleton ───────────────────────────────────────────────────────────
let rnnoiseInstance = null; // Rnnoise | null once load settles
let loadPromise = null;

/**
 * Load the RNNoise wasm once. Safe to call repeatedly. Resolves to
 * { enabled: boolean, reason: string }. Never rejects.
 */
function initAudioFrontend() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (!flagEnabled()) return { enabled: false, reason: "AUDIO_FRONTEND=off" };
    // The package's emscripten glue is built for the web and refuses to run
    // when it detects Node. Shim the minimal browser globals for the duration
    // of the load, then restore. processFrame afterwards only touches the wasm
    // heap — a test pins that it still works with the shims removed.
    const hadWindow = "window" in globalThis;
    const hadSelf = "self" in globalThis;
    const hadDocument = "document" in globalThis;
    const prev = { window: globalThis.window, self: globalThis.self, document: globalThis.document };
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { baseURI: `file://${process.cwd()}/`, currentScript: null };
    try {
      const { Rnnoise } = await import("@shiguredo/rnnoise-wasm");
      const instance = await Rnnoise.load();
      if (instance.frameSize !== RN_FRAME) {
        throw new Error(`unexpected RNNoise frameSize ${instance.frameSize} (expected ${RN_FRAME})`);
      }
      rnnoiseInstance = instance;
      return { enabled: true, reason: "loaded" };
    } catch (err) {
      console.error("[AudioFrontend] RNNoise load failed — calls will use the legacy audio path:", err && err.message);
      return { enabled: false, reason: `load failed: ${err && err.message}` };
    } finally {
      if (hadWindow) globalThis.window = prev.window; else delete globalThis.window;
      if (hadSelf) globalThis.self = prev.self; else delete globalThis.self;
      if (hadDocument) globalThis.document = prev.document; else delete globalThis.document;
    }
  })();
  return loadPromise;
}

function flagEnabled() {
  const v = (process.env.AUDIO_FRONTEND || "on").toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/** Test hook: reset the singleton so load paths can be re-exercised. */
function _resetForTests() {
  rnnoiseInstance = null;
  loadPromise = null;
}

// ── per-session front-end ────────────────────────────────────────────────────

/**
 * Create a front-end for one call session, or null when the front-end is
 * disabled or the wasm isn't ready (sessions then use the legacy path for
 * their whole lifetime — no mid-call path switching).
 */
function createSessionFrontend() {
  if (!flagEnabled() || !rnnoiseInstance) return null;
  try {
    return new AudioFrontend(rnnoiseInstance);
  } catch (err) {
    console.error("[AudioFrontend] session init failed — using legacy path:", err && err.message);
    return null;
  }
}

class AudioFrontend {
  constructor(rnnoise) {
    this.state = rnnoise.createDenoiseState();
    this.destroyed = false;
    this.dead = false; // too many errors — permanent legacy fallback
    this.errorCount = 0;
    this.gain = 1;
    this.fifo = []; // pending Int16 samples at 8k, < BLOCK_8K long
    this.frame48 = new Float32Array(RN_FRAME); // reused per block
    this.lastSpeechProb = 0;
    this._probSum = 0;
    this._probCount = 0;
  }

  /**
   * Process one Twilio media frame (base64 mulaw 8k). Returns base64 PCM16
   * 16k ready for Gemini, or null when the accumulated input is still smaller
   * than one 10ms block (the samples are buffered for the next call).
   */
  processTwilioFrame(twilioBase64) {
    if (this.destroyed || this.dead) return twilioToGemini(twilioBase64);
    try {
      const pcm8k = mulawToPcm16(Buffer.from(twilioBase64, "base64"));
      for (let i = 0; i < pcm8k.length; i += 2) this.fifo.push(pcm8k.readInt16LE(i));

      const blocks = Math.floor(this.fifo.length / BLOCK_8K);
      if (blocks === 0) return null;
      const out = Buffer.alloc(blocks * BLOCK_16K * 2);
      for (let b = 0; b < blocks; b++) {
        const block = this.fifo.splice(0, BLOCK_8K);
        this._processBlock(block, out, b * BLOCK_16K * 2);
      }
      return out.toString("base64");
    } catch (err) {
      this.errorCount++;
      if (this.errorCount <= 2) {
        console.error("[AudioFrontend] frame processing error — bypassing frame:", err && err.message);
      }
      if (this.errorCount >= MAX_SESSION_ERRORS && !this.dead) {
        this.dead = true;
        console.error(`[AudioFrontend] ${MAX_SESSION_ERRORS} processing errors — legacy path for the rest of this call`);
      }
      // Fail-open: the caller must still be heard even if the DSP chain breaks.
      return twilioToGemini(twilioBase64);
    }
  }

  /** One 10ms block: 80 samples (8k) in, 160 samples (16k) written to out. */
  _processBlock(block8k, out, outOffset) {
    // upsample ×6 with linear interpolation (phone audio is band-limited to
    // ~3.4kHz, so simple interpolation is adequate for RNNoise's input)
    const f = this.frame48;
    for (let i = 0; i < BLOCK_8K; i++) {
      const s0 = block8k[i];
      const s1 = i + 1 < BLOCK_8K ? block8k[i + 1] : s0;
      const base = i * 6;
      for (let k = 0; k < 6; k++) {
        f[base + k] = s0 + ((s1 - s0) * k) / 6;
      }
    }

    // denoise in place; returns voice probability 0..1
    const vad = this.state.processFrame(f);
    this.lastSpeechProb = vad;
    this._probSum += vad;
    this._probCount++;

    // downsample ÷3 (48k → 16k) with 3-sample averaging (matches the repo's
    // existing downsample24kTo8k style) + measure block RMS for the AGC
    const block16 = new Int16Array(BLOCK_16K);
    let sumSq = 0;
    for (let j = 0; j < BLOCK_16K; j++) {
      const idx = j * 3;
      let v = (f[idx] + f[idx + 1] + f[idx + 2]) / 3;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      block16[j] = v;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / BLOCK_16K);

    this._updateGain(vad, rms);
    const g = this.gain;
    for (let j = 0; j < BLOCK_16K; j++) {
      let v = Math.round(block16[j] * g);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out.writeInt16LE(v, outOffset + j * 2);
    }
  }

  /**
   * VAD-gated smoothed AGC: adapt only on voiced blocks above the floor;
   * the current smoothed gain is applied to EVERY block (no per-frame
   * pumping — the SCRUM-375 normalizer's weakness). Exposed as a method so
   * the adaptation curve is unit-testable without driving the wasm.
   */
  _updateGain(vad, rms) {
    if (vad >= AGC_VAD_GATE && rms >= AGC_FLOOR_RMS) {
      const desired = Math.min(AGC_MAX_GAIN, Math.max(1, AGC_TARGET_RMS / rms));
      const alpha = desired < this.gain ? AGC_ATTACK : AGC_RELEASE;
      this.gain += (desired - this.gain) * alpha;
    }
  }

  /** Average voice probability over the session (package C consumes this). */
  avgSpeechProb() {
    return this._probCount ? this._probSum / this._probCount : 0;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.state.destroy();
    } catch (err) {
      console.error("[AudioFrontend] destroy failed:", err && err.message);
    }
  }
}

module.exports = {
  initAudioFrontend,
  createSessionFrontend,
  AudioFrontend,
  _resetForTests,
};
