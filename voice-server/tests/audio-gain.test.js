const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeGainPcm16 } = require("../lib/audio-converter");

// SCRUM-375: boost quiet input audio toward a target RMS so native-audio STT
// detects language + words reliably, without amplifying silence or distorting
// already-loud callers.

function pcmConst(value, n = 160) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(value, i * 2);
  return b;
}
function rms(buf) {
  const n = buf.length >> 1;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); s += v * v; }
  return Math.sqrt(s / n);
}
function maxAbs(buf) {
  const n = buf.length >> 1;
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(buf.readInt16LE(i * 2)));
  return m;
}

describe("normalizeGainPcm16 (SCRUM-375)", () => {
  it("leaves silence / near-silence untouched (no noise pumping)", () => {
    // returned buffer is the SAME reference (no-op) for sub-noise-floor input
    const silence = pcmConst(0);
    assert.equal(normalizeGainPcm16(silence), silence);
    const quietNoise = pcmConst(40);
    assert.equal(normalizeGainPcm16(quietNoise), quietNoise);
  });

  it("boosts a quiet speech frame toward the target RMS", () => {
    const out = normalizeGainPcm16(pcmConst(500)); // rms 500, gain min(6, 2000/500=4)=4
    assert.ok(Math.abs(rms(out) - 2000) < 50, `expected ~2000, got ${rms(out)}`);
  });

  it("caps the gain (does not over-amplify a very quiet frame)", () => {
    const out = normalizeGainPcm16(pcmConst(200)); // gain would be 10, capped at 6 -> ~1200
    assert.ok(Math.abs(rms(out) - 1200) < 50, `expected ~1200 (capped), got ${rms(out)}`);
  });

  it("leaves an already-loud frame untouched", () => {
    const loud = pcmConst(2500); // rms 2500 >= target -> gain <= 1.05 -> unchanged
    assert.equal(normalizeGainPcm16(loud), loud);
  });

  it("never produces a sample outside int16 range", () => {
    for (const v of [300, 500, 1000, 1500, 3000]) {
      assert.ok(maxAbs(normalizeGainPcm16(pcmConst(v))) <= 32767);
    }
  });

  it("handles an empty buffer without throwing", () => {
    assert.doesNotThrow(() => normalizeGainPcm16(Buffer.alloc(0)));
  });
});
