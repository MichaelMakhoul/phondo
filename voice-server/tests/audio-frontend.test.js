// SCRUM-555 (package B) — inbound audio front-end tests.
//
// These are FUNCTIONAL tests: they load the real RNNoise wasm and push real
// mulaw audio through the full chain (mulaw 8k → 48k → denoise → 16k → AGC).
// If the wasm cannot load in this environment the suite fails loudly — a
// silently-skipped front-end is exactly the regression we don't want.

const { test, describe, before } = require("node:test");
const assert = require("node:assert");

const {
  initAudioFrontend,
  createSessionFrontend,
  AudioFrontend,
  _resetForTests,
  _setTestOverrides,
} = require("../lib/audio-frontend");
const { pcm16ToMulaw, twilioToGemini, mulawToPcm16 } = require("../lib/audio-converter");

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Deterministic pseudo-noise (LCG) so the suite never flakes. */
function makeNoiseFrame(samples, amplitude, seedRef) {
  const pcm = Buffer.alloc(samples * 2);
  let s = seedRef.seed;
  for (let i = 0; i < samples; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = Math.round(((s / 0x7fffffff) * 2 - 1) * amplitude);
    pcm.writeInt16LE(v, i * 2);
  }
  seedRef.seed = s;
  return pcm;
}

function makeSineFrame(samples, amplitude, freq, rate, phaseRef) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(amplitude * Math.sin(phaseRef.phase));
    pcm.writeInt16LE(v, i * 2);
    phaseRef.phase += (2 * Math.PI * freq) / rate;
  }
  return pcm;
}

function toTwilioBase64(pcm8k) {
  return pcm16ToMulaw(pcm8k).toString("base64");
}

function rmsOfBase64Pcm(b64) {
  const buf = Buffer.from(b64, "base64");
  const n = buf.length >> 1;
  if (!n) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / n);
}

describe("SCRUM-555 — audio front-end (RNNoise + VAD-gated AGC)", () => {
  before(async () => {
    const { enabled, reason } = await initAudioFrontend();
    assert.ok(enabled, `RNNoise wasm must load in this environment (got: ${reason})`);
  });

  test("loading the web-built wasm leaves NO browser shims in Node globals", () => {
    assert.strictEqual(typeof window, "undefined", "window leaked into globals");
    assert.strictEqual(typeof self, "undefined", "self leaked into globals");
    assert.strictEqual(typeof document, "undefined", "document leaked into globals");
  });

  test("wasm still processes frames AFTER the shims were removed", () => {
    const fe = createSessionFrontend();
    assert.ok(fe, "front-end should be available");
    const phase = { phase: 0 };
    const out = fe.processTwilioFrame(toTwilioBase64(makeSineFrame(160, 6000, 400, 8000, phase)));
    assert.ok(typeof out === "string" && out.length > 0, "no output produced");
    fe.destroy();
  });

  test("AUDIO_FRONTEND=off disables the front-end (legacy path)", () => {
    const prev = process.env.AUDIO_FRONTEND;
    process.env.AUDIO_FRONTEND = "off";
    try {
      assert.strictEqual(createSessionFrontend(), null);
    } finally {
      if (prev === undefined) delete process.env.AUDIO_FRONTEND;
      else process.env.AUDIO_FRONTEND = prev;
    }
  });

  test("standard Twilio frames (20ms/160 samples): output is 16k PCM, exactly 2x samples, int16-bounded", () => {
    const fe = createSessionFrontend();
    const phase = { phase: 0 };
    let inSamples = 0;
    let outSamples = 0;
    for (let i = 0; i < 50; i++) {
      const frame = makeSineFrame(160, 6000, 400, 8000, phase);
      inSamples += 160;
      const out = fe.processTwilioFrame(toTwilioBase64(frame));
      assert.ok(out, "steady-state 160-sample frames must always produce output");
      const buf = Buffer.from(out, "base64");
      outSamples += buf.length / 2;
      for (let j = 0; j < buf.length; j += 2) {
        const v = buf.readInt16LE(j);
        assert.ok(v >= -32768 && v <= 32767 && Number.isFinite(v), "sample out of int16 range");
      }
    }
    assert.strictEqual(outSamples, inSamples * 2, "16k output must be exactly 2x the 8k input samples");
    assert.ok(
      Number.isFinite(fe.lastSpeechProb) && fe.lastSpeechProb >= 0 && fe.lastSpeechProb <= 1,
      "real RNNoise processFrame must return a 0..1 voice probability — AGC gating and package C both depend on it"
    );
    fe.destroy();
  });

  test("odd-sized chunks (browser path) are re-blocked without loss beyond the <10ms fifo remainder", () => {
    const fe = createSessionFrontend();
    const phase = { phase: 0 };
    let inSamples = 0;
    let outSamples = 0;
    for (let i = 0; i < 40; i++) {
      const frame = makeSineFrame(100, 6000, 400, 8000, phase); // 100-sample chunks
      inSamples += 100;
      const out = fe.processTwilioFrame(toTwilioBase64(frame));
      if (out) outSamples += Buffer.from(out, "base64").length / 2;
    }
    const leftover = inSamples % 80;
    assert.strictEqual(outSamples, (inSamples - leftover) * 2, "all whole 10ms blocks must be emitted");
    fe.destroy();
  });

  test("stationary noise is strongly suppressed (the train-rumble case)", () => {
    const fe = createSessionFrontend();
    const seed = { seed: 1234567 };
    let inRms = 0;
    let outRms = 0;
    let outFrames = 0;
    const N = 100; // 2s of pure noise
    for (let i = 0; i < N; i++) {
      const frame = makeNoiseFrame(160, 3000, seed);
      const inB64 = toTwilioBase64(frame);
      inRms += rmsOfBase64Pcm(Buffer.from(inB64, "base64").length ? mulawToPcm16(Buffer.from(inB64, "base64")).toString("base64") : "");
      const out = fe.processTwilioFrame(inB64);
      if (out) {
        outRms += rmsOfBase64Pcm(out);
        outFrames++;
      }
    }
    inRms /= N;
    outRms /= outFrames;
    assert.ok(
      outRms < inRms * 0.5,
      `noise not suppressed enough: in RMS ${inRms.toFixed(0)} → out RMS ${outRms.toFixed(0)} (want < 50%)`
    );
    fe.destroy();
  });

  test("AGC adaptation curve: boosts quiet speech slowly, backs off loud speech fast, bounded, VAD-gated", () => {
    const fe = new AudioFrontend({ createDenoiseState: () => ({ processFrame: () => 0, destroy() {} }) });
    // non-speech blocks never adapt
    for (let i = 0; i < 100; i++) fe._updateGain(0.1, 400);
    assert.strictEqual(fe.gain, 1, "gain must not adapt on non-speech");
    // quiet speech (rms 400 → desired 6.5): rises slowly toward it
    fe._updateGain(0.9, 400);
    const afterOne = fe.gain;
    assert.ok(afterOne > 1 && afterOne < 1.3, `release must be slow (got ${afterOne})`);
    for (let i = 0; i < 400; i++) fe._updateGain(0.9, 400);
    assert.ok(fe.gain > 5 && fe.gain <= 8, `gain should converge near 6.5 (got ${fe.gain})`);
    // loud speech: attack pulls it down fast
    fe._updateGain(0.9, 8000);
    const drop1 = fe.gain;
    assert.ok(drop1 < 5, `attack must be fast (got ${drop1})`);
    for (let i = 0; i < 30; i++) fe._updateGain(0.9, 8000);
    assert.ok(fe.gain >= 1 && fe.gain < 1.5, `gain should settle near 1 for loud input (got ${fe.gain})`);
    // silence below the floor never adapts even with high VAD
    const g = fe.gain;
    fe._updateGain(0.95, 50);
    assert.strictEqual(fe.gain, g, "sub-floor frames must not adapt the gain");
    fe.destroy();
  });

  test("the smoothed gain is APPLIED to output samples — on every block, including unvoiced ones", () => {
    // VAD stub returns 0 → _updateGain never adapts, so each front-end's gain
    // stays pinned where we set it. Kills two mutants: deleting the gain
    // application loop, and applying gain only on voiced blocks (which would
    // reintroduce the SCRUM-375 pumping this design exists to avoid).
    const identityStub = { createDenoiseState: () => ({ processFrame: () => 0, destroy() {} }) };
    const feUnity = new AudioFrontend(identityStub);
    const feBoost = new AudioFrontend(identityStub);
    feBoost.gain = 4;
    const phase1 = { phase: 0 };
    const phase2 = { phase: 0 };
    const outUnity = feUnity.processTwilioFrame(toTwilioBase64(makeSineFrame(160, 1000, 400, 8000, phase1)));
    const outBoost = feBoost.processTwilioFrame(toTwilioBase64(makeSineFrame(160, 1000, 400, 8000, phase2)));
    const ratio = rmsOfBase64Pcm(outBoost) / rmsOfBase64Pcm(outUnity);
    assert.ok(
      ratio > 3.9 && ratio < 4.1,
      `gain=4 must yield ~4x output RMS (got ${ratio.toFixed(2)}x) — the AGC must actually touch the samples`
    );
    feUnity.destroy();
    feBoost.destroy();
  });

  test("voice-probability contract (package C): lastSpeechProb tracks the newest block, avgSpeechProb averages the session", () => {
    let call = 0;
    const probs = [0.25, 0.75]; // exact binary fractions — the average is exactly 0.5
    const fe = new AudioFrontend({
      createDenoiseState: () => ({ processFrame: () => probs[call++], destroy() {} }),
    });
    assert.strictEqual(fe.avgSpeechProb(), 0, "no blocks yet must give 0, not NaN");
    const phase = { phase: 0 };
    fe.processTwilioFrame(toTwilioBase64(makeSineFrame(160, 1000, 400, 8000, phase))); // 160 samples = 2 blocks
    assert.strictEqual(fe.lastSpeechProb, 0.75, "lastSpeechProb must be the most recent block's VAD");
    assert.strictEqual(fe.avgSpeechProb(), 0.5, "avgSpeechProb must average all blocks");
    fe.destroy();
  });

  test("onBlock hook (SCRUM-556 contract): called once per 10ms block with (prob, rms); a throwing hook flows into the error machinery", () => {
    const calls = [];
    const fe = new AudioFrontend(
      { createDenoiseState: () => ({ processFrame: () => 0.7, destroy() {} }) },
      { onBlock: (prob, rms) => calls.push({ prob, rms }) }
    );
    const phase = { phase: 0 };
    fe.processTwilioFrame(toTwilioBase64(makeSineFrame(160, 6000, 400, 8000, phase))); // 2 blocks
    assert.strictEqual(calls.length, 2, "one onBlock call per 10ms block");
    assert.ok(calls.every((c) => c.prob === 0.7 && c.rms > 0), "hook must receive the block's prob and a real RMS");
    fe.destroy();

    // a throwing hook must NOT be silently disabled — it rides the per-frame
    // fail-open (legacy output) and counts toward the 5-error dead path
    const feThrow = new AudioFrontend(
      { createDenoiseState: () => ({ processFrame: () => 0.7, destroy() {} }) },
      { onBlock: () => { throw new Error("gate bug"); } }
    );
    const frame = toTwilioBase64(makeSineFrame(160, 6000, 400, 8000, { phase: 0 }));
    assert.strictEqual(feThrow.processTwilioFrame(frame), twilioToGemini(frame), "hook errors fall back to legacy for the frame");
    assert.strictEqual(feThrow.errorCount, 1, "hook errors must count toward the dead threshold");
    feThrow.destroy();
  });

  test("onDead hook fires exactly once when the session hits the 5-error legacy fallback", () => {
    let deadCalls = 0;
    const fe = new AudioFrontend(
      { createDenoiseState: () => ({ processFrame: () => { throw new Error("boom"); }, destroy() {} }) },
      { onDead: () => deadCalls++ }
    );
    const frame = toTwilioBase64(makeSineFrame(160, 6000, 400, 8000, { phase: 0 }));
    for (let i = 0; i < 7; i++) fe.processTwilioFrame(frame);
    assert.strictEqual(fe.dead, true);
    assert.strictEqual(deadCalls, 1, "onDead must fire exactly once (custom VAD's loud-failure signal)");
    fe.destroy();
  });

  test("fifo is cleared on a processing error — recovery after an error never duplicates audio", () => {
    // The legacy fallback covers the ENTIRE errored frame, so samples that
    // frame already queued must be dropped. Without the clear, the next
    // successful frame re-emits ~10ms of already-sent audio (repro'd in
    // review). Throw on the SECOND block of a 3-frame stream of 120-sample
    // chunks (fifo carries a 40-sample leftover into frame 2, so the error
    // frame genuinely has queued samples to leak).
    let blockCalls = 0;
    const fe = new AudioFrontend({
      createDenoiseState: () => ({
        processFrame: () => {
          blockCalls++;
          if (blockCalls === 2) throw new Error("boom");
          return 0;
        },
        destroy() {},
      }),
    });
    const phase = { phase: 0 };
    const mkFrame = () => toTwilioBase64(makeSineFrame(120, 6000, 400, 8000, phase));

    const out1 = fe.processTwilioFrame(mkFrame()); // 1 block out, 40-sample leftover
    assert.strictEqual(Buffer.from(out1, "base64").length / 2, 160);

    const errFrame = mkFrame();
    const out2 = fe.processTwilioFrame(errFrame); // throws on its first processed block
    assert.strictEqual(out2, twilioToGemini(errFrame), "errored frame must fall back to legacy for the whole frame");
    assert.strictEqual(fe.fifo.length, 0, "the fifo must be cleared on error — leftover samples would replay");

    const out3 = fe.processTwilioFrame(mkFrame()); // fresh start: 120 samples → 1 block, 40 leftover
    assert.strictEqual(
      Buffer.from(out3, "base64").length / 2,
      160,
      "post-error frame must only emit its own samples — a larger block count means duplicated audio"
    );
    fe.destroy();
  });

  test("fail-open: a processing error yields the LEGACY conversion for that frame; 5 errors go legacy permanently + ALERT once", async () => {
    // Other tests also kill sessions, so normalize the module's dead-session
    // counter first: reset the singleton and reload the real wasm, making the
    // dead session below deadSessions #1 — the alert must fire exactly once,
    // and a second dead session (#2, not a multiple of 25) must not.
    _setTestOverrides();
    _resetForTests();
    const { enabled } = await initAudioFrontend();
    assert.ok(enabled, "real wasm must reload for the alert-cadence test");
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      const killSession = () => {
        const fe = createSessionFrontend();
        const phase = { phase: 0 };
        const frame = toTwilioBase64(makeSineFrame(160, 6000, 400, 8000, phase));
        const legacy = twilioToGemini(frame);
        fe.state.processFrame = () => {
          throw new Error("boom");
        };
        for (let i = 0; i < 5; i++) {
          assert.strictEqual(fe.processTwilioFrame(frame), legacy, "errored frame must fall back to the legacy conversion");
        }
        assert.strictEqual(fe.dead, true, "5 errors must switch the session to the legacy path");
        // dead sessions keep working via legacy — the caller is still heard
        assert.strictEqual(fe.processTwilioFrame(frame), legacy);
        fe.destroy();
      };
      killSession();
      const alerts = () => warns.filter((w) => /\[ALERT:warning\].*AudioFrontend session went legacy/.test(w));
      assert.strictEqual(alerts().length, 1, "the FIRST dead session must emit exactly one alertable warning");
      assert.match(alerts()[0], /1 dead sessions/, "the alert must carry the dead-session count");
      killSession(); // dead session #2 — below the every-25th cadence
      assert.strictEqual(alerts().length, 1, "a second dead session must NOT alert again (cadence: 1st, then every 25th)");
    } finally {
      console.warn = origWarn;
    }
  });

  test("a hung wasm load times out: shims restored, enabled:false with a loud reason, no unhandled rejection", async () => {
    _resetForTests();
    // The fake load outlives the 60ms timeout (so the race times out) but DOES
    // settle at 150ms — a truly never-settling promise would trip node:test's
    // pending-promise detector at loop drain. Its late failure exercises the
    // post-timeout swallow path.
    _setTestOverrides({
      importer: () =>
        new Promise((resolve) => {
          // deliberately NOT unref'd: the timer must fire so the promise
          // settles before the test process drains (pending-promise detector)
          setTimeout(
            () => resolve({ Rnnoise: { load: () => Promise.reject(new Error("late failure after timeout")) } }),
            150
          );
        }),
      timeoutMs: 60,
    });
    try {
      const { enabled, reason } = await initAudioFrontend();
      assert.strictEqual(enabled, false, "a hung load must report disabled, not hang forever");
      assert.match(reason, /load timeout after 60ms/, "the reason must name the timeout");
      assert.strictEqual(typeof window, "undefined", "window shim must be restored on timeout");
      assert.strictEqual(typeof self, "undefined", "self shim must be restored on timeout");
      assert.strictEqual(typeof document, "undefined", "document shim must be restored on timeout");
      assert.strictEqual(createSessionFrontend(), null, "sessions must run legacy after a timed-out load");
    } finally {
      // restore the real importer and reload the wasm for any later test
      _setTestOverrides();
      _resetForTests();
      const { enabled } = await initAudioFrontend();
      assert.ok(enabled, "real wasm must reload after the timeout test");
    }
  });

  test("destroy is idempotent and a destroyed front-end still returns legacy audio", () => {
    const fe = createSessionFrontend();
    fe.destroy();
    fe.destroy();
    const phase = { phase: 0 };
    const frame = toTwilioBase64(makeSineFrame(160, 6000, 400, 8000, phase));
    assert.strictEqual(fe.processTwilioFrame(frame), twilioToGemini(frame));
  });

  test("CPU: 10s of audio processes in a small fraction of realtime", () => {
    const fe = createSessionFrontend();
    const phase = { phase: 0 };
    const frames = [];
    for (let i = 0; i < 500; i++) frames.push(toTwilioBase64(makeSineFrame(160, 6000, 400, 8000, phase)));
    const t0 = process.hrtime.bigint();
    for (const f of frames) fe.processTwilioFrame(f);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`[bench] 10s of audio processed in ${ms.toFixed(1)}ms (${(ms / 10000 * 100).toFixed(1)}% of realtime)`);
    assert.ok(ms < 3000, `front-end too slow for realtime: ${ms.toFixed(0)}ms for 10s of audio`);
    fe.destroy();
  });
});
