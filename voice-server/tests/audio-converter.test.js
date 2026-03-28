const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  mulawToPcm16, pcm16ToMulaw,
  upsample8kTo16k, downsample24kTo8k,
  twilioToGemini, geminiToTwilio,
} = require("../lib/audio-converter");

describe("mulawToPcm16", () => {
  it("should decode silence (mulaw 0xFF = ~0)", () => {
    const mulaw = Buffer.from([0xff]);
    const pcm = mulawToPcm16(mulaw);
    assert.equal(pcm.length, 2);
    // mulaw 0xFF should decode to a very small value near 0
    const sample = pcm.readInt16LE(0);
    assert.ok(Math.abs(sample) < 100, `Expected near-zero, got ${sample}`);
  });

  it("should produce 2x bytes output", () => {
    const mulaw = Buffer.alloc(100, 0xff);
    const pcm = mulawToPcm16(mulaw);
    assert.equal(pcm.length, 200);
  });

  it("should decode known mulaw values", () => {
    // mulaw 0x00 = max positive, 0x80 = max negative
    const mulaw = Buffer.from([0x00, 0x80]);
    const pcm = mulawToPcm16(mulaw);
    const sample0 = pcm.readInt16LE(0);
    const sample1 = pcm.readInt16LE(2);
    assert.ok(sample0 < 0, "0x00 should decode to negative");
    assert.ok(sample1 > 0, "0x80 should decode to positive");
    assert.ok(Math.abs(sample0) > 8000, `Expected large magnitude, got ${sample0}`);
  });
});

describe("pcm16ToMulaw", () => {
  it("should encode silence (0 → ~0xFF)", () => {
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(0, 0);
    const mulaw = pcm16ToMulaw(pcm);
    assert.equal(mulaw.length, 1);
    // 0 encodes to ~0xFF (mulaw silence)
    assert.ok(mulaw[0] >= 0xfe, `Expected 0xFF, got 0x${mulaw[0].toString(16)}`);
  });

  it("should produce half-length output", () => {
    const pcm = Buffer.alloc(200);
    const mulaw = pcm16ToMulaw(pcm);
    assert.equal(mulaw.length, 100);
  });
});

describe("round-trip mulaw↔PCM16", () => {
  it("should approximately round-trip", () => {
    // mulaw is lossy — round-trip won't be exact, but should be close
    const original = Buffer.from([0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0]);
    const pcm = mulawToPcm16(original);
    const roundTrip = pcm16ToMulaw(pcm);
    // Each value should be within ±1 of original due to mulaw quantization
    for (let i = 0; i < original.length; i++) {
      assert.ok(
        Math.abs(roundTrip[i] - original[i]) <= 8, // mulaw is non-linear 8-bit lossy — higher values have more quantization error
        `Sample ${i}: original=0x${original[i].toString(16)} roundtrip=0x${roundTrip[i].toString(16)}`
      );
    }
  });
});

describe("upsample8kTo16k", () => {
  it("should double the number of samples", () => {
    const pcm8k = Buffer.alloc(10 * 2); // 10 samples
    const pcm16k = upsample8kTo16k(pcm8k);
    assert.equal(pcm16k.length, 20 * 2); // 20 samples
  });

  it("should interpolate between samples", () => {
    const pcm8k = Buffer.alloc(4); // 2 samples
    pcm8k.writeInt16LE(0, 0);
    pcm8k.writeInt16LE(1000, 2);
    const pcm16k = upsample8kTo16k(pcm8k);
    // Output: [0, interpolated(~500), 1000, interpolated(~1000)]
    const s0 = pcm16k.readInt16LE(0);
    const s1 = pcm16k.readInt16LE(2);
    const s2 = pcm16k.readInt16LE(4);
    assert.equal(s0, 0);
    assert.equal(s1, 500); // average of 0 and 1000
    assert.equal(s2, 1000);
  });
});

describe("downsample24kTo8k", () => {
  it("should reduce to 1/3 of samples", () => {
    const pcm24k = Buffer.alloc(9 * 2); // 9 samples
    const pcm8k = downsample24kTo8k(pcm24k);
    assert.equal(pcm8k.length, 3 * 2); // 3 samples
  });

  it("should average 3 adjacent samples (anti-aliasing)", () => {
    const pcm24k = Buffer.alloc(6 * 2); // 6 samples: 100, 200, 300, 400, 500, 600
    for (let i = 0; i < 6; i++) pcm24k.writeInt16LE((i + 1) * 100, i * 2);
    const pcm8k = downsample24kTo8k(pcm24k);
    assert.equal(pcm8k.readInt16LE(0), 200); // avg(100,200,300) = 200
    assert.equal(pcm8k.readInt16LE(2), 500); // avg(400,500,600) = 500
  });
});

describe("twilioToGemini pipeline", () => {
  it("should accept base64 mulaw and return base64 PCM16", () => {
    const mulaw = Buffer.alloc(160, 0xff); // 20ms of silence at 8kHz
    const b64in = mulaw.toString("base64");
    const b64out = twilioToGemini(b64in);
    assert.ok(typeof b64out === "string");
    // Output should be 4x input size (mulaw→pcm16 = 2x, upsample 8k→16k = 2x)
    const outBuf = Buffer.from(b64out, "base64");
    assert.equal(outBuf.length, 160 * 4);
  });
});

describe("geminiToTwilio pipeline", () => {
  it("should accept base64 PCM16 24kHz and return base64 mulaw 8kHz", () => {
    const pcm24k = Buffer.alloc(480 * 2); // 480 samples at 24kHz = 20ms
    const b64in = pcm24k.toString("base64");
    const b64out = geminiToTwilio(b64in);
    assert.ok(typeof b64out === "string");
    // Output: 480/3 = 160 PCM samples → 160 mulaw bytes
    const outBuf = Buffer.from(b64out, "base64");
    assert.equal(outBuf.length, 160);
  });
});
