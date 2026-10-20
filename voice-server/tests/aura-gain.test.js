const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { boostAura, auraGainDb, gainTable, decodeMulaw, DEFAULT_GAIN_DB } = require("../lib/aura-gain");
const { encodeMulawSample } = require("../lib/audio-converter");

const saved = process.env.AURA_GAIN_DB;
afterEach(() => {
  if (saved === undefined) delete process.env.AURA_GAIN_DB;
  else process.env.AURA_GAIN_DB = saved;
});

/** The speech level (RMS, dBFS) of mulaw bytes. */
function levelDb(mulaw) {
  let p = 0;
  for (const code of mulaw) p += decodeMulaw(code) ** 2;
  return 10 * Math.log10(p / mulaw.length / 32768 ** 2);
}

/** A 1 kHz tone at `db` dBFS RMS, as mulaw. */
function tone(db, samples = 8000) {
  const amp = 32768 * 10 ** (db / 20) * Math.SQRT2;
  return Buffer.from(Array.from({ length: samples }, (_, i) => encodeMulawSample(Math.round(amp * Math.sin((2 * Math.PI * 1000 * i) / 8000)))));
}

describe("aura-gain — phone test F7 (the voice was too quiet to follow)", () => {
  it("AURA_GAIN_DB: unset or blank is the default, numbers are clamped to 0-12, anything else is the default", () => {
    delete process.env.AURA_GAIN_DB;
    assert.equal(auraGainDb(), DEFAULT_GAIN_DB);
    assert.equal(DEFAULT_GAIN_DB, 6);
    for (const [raw, want] of [["", 6], ["  ", 6], ["4", 4], ["0", 0], ["-3", 0], ["20", 12], ["7.5", 7.5], ["loud", 6]]) {
      process.env.AURA_GAIN_DB = raw;
      assert.equal(auraGainDb(), want, JSON.stringify(raw));
    }
  });

  it("decodeMulaw is the exact inverse of encodeMulawSample", () => {
    for (let code = 0; code < 256; code++) {
      // + 0: mulaw has a negative zero (0x7f), which strict equality tells apart from 0
      assert.equal(decodeMulaw(encodeMulawSample(decodeMulaw(code))) + 0, decodeMulaw(code) + 0, `code ${code}`);
    }
  });

  it("speech gets the gain: a -21 dBFS tone comes out about 6 dB louder", () => {
    delete process.env.AURA_GAIN_DB;
    const quiet = tone(-21);
    const louder = boostAura(quiet);
    assert.ok(Math.abs(levelDb(louder) - levelDb(quiet) - 6) < 0.5, `${levelDb(quiet).toFixed(1)} -> ${levelDb(louder).toFixed(1)} dBFS`);
  });

  it("loud peaks bend toward G.711's ceiling instead of clipping: monotonic, sign kept, never past full scale", () => {
    for (const db of [4, 6, 12]) {
      const table = gainTable(db);
      for (const sign of [1, -1]) {
        let prev = -1;
        for (let step = 0; step < 128; step++) {
          const code = sign > 0 ? 0xff - step : 0x7f - step; // quiet to loud
          const out = decodeMulaw(table[code]);
          assert.ok(Math.sign(out) === sign || out === 0, `sign kept (${db} dB, code ${code})`);
          assert.ok(Math.abs(out) >= prev, `monotonic (${db} dB, code ${code})`);
          assert.ok(Math.abs(out) <= 32124, "within G.711");
          prev = Math.abs(out);
        }
      }
    }
    const fullScale = tone(-3);
    const out = boostAura(fullScale);
    assert.ok(levelDb(out) > levelDb(fullScale), "a loud tone still gets louder, just less than 6 dB");
    assert.ok(levelDb(out) - levelDb(fullScale) < 6);
  });

  it("the limiter bends, never flattens or expands: the loudest codes stay distinct, and above the knee the output sits below plain gain", () => {
    const table = gainTable(6);
    const gain = 10 ** (6 / 20);
    // The 16 loudest positive codes (G.711's top segment): a hard clip would map them all to one code.
    const top = new Set(Array.from({ length: 16 }, (_, i) => table[0x80 + i]));
    assert.ok(top.size >= 3, `distinct outputs for the loudest inputs: ${top.size}`);
    for (let code = 0; code < 256; code++) {
      const linear = Math.abs(decodeMulaw(code)) * gain;
      const out = Math.abs(decodeMulaw(table[code]));
      if (linear >= 1.6 * 0.6 * 32635) assert.ok(out < linear - 512, `code ${code}: ${out} vs plain gain ${Math.round(linear)}`);
    }
  });

  it("returns a new buffer and leaves the input alone; 0 dB returns the input itself", () => {
    delete process.env.AURA_GAIN_DB;
    const input = tone(-21, 160);
    const copy = Buffer.from(input);
    const out = boostAura(input);
    assert.notEqual(out, input);
    assert.equal(out.length, input.length);
    assert.deepEqual(input, copy, "input unchanged");
    process.env.AURA_GAIN_DB = "0";
    assert.equal(boostAura(input), input, "off: the same bytes, no copy");
    assert.equal(boostAura(Buffer.alloc(0)).length, 0);
  });

  it("the REST client returns boosted audio (the greeting, the disclosure, fallbacks)", async () => {
    delete process.env.AURA_GAIN_DB;
    const raw = tone(-21, 800);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) }));
    try {
      const { synthesizeSpeech } = require("../services/deepgram-tts");
      const audio = await synthesizeSpeech("KEY", "Thanks for calling.");
      assert.deepEqual(audio, boostAura(raw));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
