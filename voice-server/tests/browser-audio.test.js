// SCRUM-619: the owner's bubble isn't a phone line — wideband audio at Aura's own level,
// announced to the page first; and a caller's number is read back the way people say it.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  BROWSER_WIDEBAND,
  PHONE_BYTES_PER_MS,
  audioFormatMessage,
  browserTtsOptions,
  browserAudioMs,
} = require("../lib/browser-audio");
const { spokenPhoneNumber } = require("../lib/spoken-phone");
const { generateHoldAudio } = require("../lib/hold-audio");
const { encodeMulawSample } = require("../lib/audio-converter");

describe("BROWSER_WIDEBAND", () => {
  it("is 24 kHz 16-bit PCM: 48 bytes a millisecond, and can't be changed", () => {
    assert.deepEqual({ ...BROWSER_WIDEBAND }, { encoding: "linear16", sampleRate: 24000, bytesPerMs: 48 });
    assert.equal(BROWSER_WIDEBAND.bytesPerMs, (BROWSER_WIDEBAND.sampleRate * 2) / 1000);
    assert.ok(Object.isFrozen(BROWSER_WIDEBAND));
    assert.equal(PHONE_BYTES_PER_MS, 8);
  });
});

describe("audioFormatMessage", () => {
  it("is the page's audio_format message: the encoding and the rate, nothing else", () => {
    assert.deepEqual(JSON.parse(audioFormatMessage(BROWSER_WIDEBAND)), { type: "audio_format", encoding: "linear16", sampleRate: 24000 });
  });
});

describe("browserTtsOptions", () => {
  it("a session that wasn't told wideband: its voice only — the phone's format and boost", () => {
    assert.deepEqual(browserTtsOptions({ deepgramVoice: "aura-2-theia-en" }), { voice: "aura-2-theia-en" });
    assert.deepEqual(browserTtsOptions({ deepgramVoice: null }), { voice: undefined });
    assert.deepEqual(browserTtsOptions(null), { voice: undefined });
  });

  it("wideband: the format, no phone boost, and the session's host", () => {
    assert.deepEqual(
      browserTtsOptions({ deepgramVoice: "aura-2-theia-en", browserAudio: BROWSER_WIDEBAND, ttsHost: "api.au.deepgram.com" }),
      { voice: "aura-2-theia-en", host: "api.au.deepgram.com", encoding: "linear16", sampleRate: 24000, boost: false }
    );
  });

  it("a host without wideband is passed on, the format left alone", () => {
    assert.deepEqual(browserTtsOptions({ deepgramVoice: "v", ttsHost: "h" }), { voice: "v", host: "h" });
  });
});

describe("browserAudioMs", () => {
  it("the phone's mulaw: 8 bytes a millisecond", () => {
    assert.equal(browserAudioMs({}, 8000), 1000);
    assert.equal(browserAudioMs(null, 1600), 200);
  });

  it("wideband: 48 bytes a millisecond", () => {
    assert.equal(browserAudioMs({ browserAudio: BROWSER_WIDEBAND }, 48_000), 1000);
    assert.equal(browserAudioMs({ browserAudio: BROWSER_WIDEBAND }, 8000), 167);
  });
});

describe("spokenPhoneNumber", () => {
  it("an Australian mobile: 0414 141 883", () => {
    assert.equal(spokenPhoneNumber("+61414141883"), "0414 141 883");
    assert.equal(spokenPhoneNumber(" +61400000001 "), "0400 000 001");
  });

  it("an Australian landline, every area code: 02 9555 1234", () => {
    assert.equal(spokenPhoneNumber("+61295551234"), "02 9555 1234");
    assert.equal(spokenPhoneNumber("+61395551234"), "03 9555 1234");
    assert.equal(spokenPhoneNumber("+61755551234"), "07 5555 1234");
    assert.equal(spokenPhoneNumber("+61855551234"), "08 5555 1234");
  });

  it("a US number: (415) 555-1234", () => {
    assert.equal(spokenPhoneNumber("+14155551234"), "(415) 555-1234");
  });

  it("anything else has no spoken form: other countries, national or short numbers, wrong lengths, non-strings", () => {
    for (const value of [
      "+442071234567",
      "0414141883",
      "+6141414188",
      "+614141418830",
      "+61514141883",
      "+1415555123",
      "+61 414 141 883",
      "",
      null,
      undefined,
      61414141883,
      {},
    ]) {
      assert.equal(spokenPhoneNumber(value), null, String(value));
    }
  });
});

describe("generateHoldAudio in a browser's wideband format", () => {
  it("wideband: 16-bit PCM at 24 kHz, two bytes a sample, fading in from silence", () => {
    const buf = generateHoldAudio(2000, "neutral", BROWSER_WIDEBAND);
    assert.equal(buf.length, 2000 * 48);
    assert.equal(buf.readInt16LE(0), 0, "the fade-in starts at silence");
    let peak = 0;
    for (let i = 0; i < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    assert.ok(peak > 0 && peak <= 32767, `a soft sound, never clipped: ${peak}`);
  });

  it("no format, or the phone's: mulaw at 8 kHz, one byte a sample (unchanged)", () => {
    assert.equal(generateHoldAudio(2000, "neutral").length, 16_000);
    assert.equal(generateHoldAudio(2000, "neutral", { encoding: "mulaw", sampleRate: 24000 }).length, 16_000);
    assert.equal(generateHoldAudio(2000, "neutral", null).length, 16_000);
  });

  it("a silent preset stays silent in either format", () => {
    assert.equal(generateHoldAudio(2000, "silent", BROWSER_WIDEBAND), null);
  });
});

describe("synthesizeSpeech's format (services/deepgram-tts.js)", () => {
  const savedFetch = globalThis.fetch;
  const savedGain = process.env.AURA_GAIN_DB;
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedGain === undefined) delete process.env.AURA_GAIN_DB;
    else process.env.AURA_GAIN_DB = savedGain;
  });

  /** A mulaw-like body loud enough for the phone boost to change it. */
  const BODY = Buffer.from(Array.from({ length: 400 }, (_, i) => encodeMulawSample(Math.round(6000 * Math.sin(i / 5)))));

  function stubFetch() {
    const urls = [];
    globalThis.fetch = /** @type {any} */ (async (url) => {
      urls.push(new URL(url));
      return { ok: true, arrayBuffer: async () => BODY.buffer.slice(BODY.byteOffset, BODY.byteOffset + BODY.length) };
    });
    return urls;
  }

  it("by default: the phone's mulaw at 8 kHz, boosted to line level", async () => {
    process.env.AURA_GAIN_DB = "6";
    const urls = stubFetch();
    const { synthesizeSpeech } = require("../services/deepgram-tts");
    const out = await synthesizeSpeech("KEY", "Hello there.", { voice: "aura-2-theia-en" });
    assert.equal(urls[0].searchParams.get("encoding"), "mulaw");
    assert.equal(urls[0].searchParams.get("sample_rate"), "8000");
    assert.equal(urls[0].searchParams.get("container"), "none");
    assert.notDeepEqual(out, BODY, "the phone boost applies");
  });

  it("wideband for a browser: linear16 at its rate, at Aura's own level (never the mulaw gain table)", async () => {
    process.env.AURA_GAIN_DB = "6";
    const urls = stubFetch();
    const { synthesizeSpeech } = require("../services/deepgram-tts");
    const out = await synthesizeSpeech("KEY", "Hello there.", { voice: "aura-2-theia-en", encoding: "linear16", sampleRate: 24000, boost: false });
    assert.equal(urls[0].searchParams.get("encoding"), "linear16");
    assert.equal(urls[0].searchParams.get("sample_rate"), "24000");
    assert.equal(urls[0].searchParams.get("mip_opt_out"), "true", "SCRUM-595 still applies");
    assert.deepEqual(out, BODY);
    // linear16 is never run through the mulaw table, even when boost isn't turned off.
    const unboosted = await synthesizeSpeech("KEY", "Hello there.", { voice: "aura-2-theia-en", encoding: "linear16", sampleRate: 24000 });
    assert.deepEqual(unboosted, BODY);
  });

  it("mulaw with boost off: as Aura sent it", async () => {
    process.env.AURA_GAIN_DB = "6";
    stubFetch();
    const { synthesizeSpeech } = require("../services/deepgram-tts");
    assert.deepEqual(await synthesizeSpeech("KEY", "Hi.", { voice: "aura-2-theia-en", boost: false }), BODY);
  });

  it("an unknown encoding is the phone's mulaw; linear16 without a whole-number rate is 8 kHz", async () => {
    const urls = stubFetch();
    const { synthesizeSpeech } = require("../services/deepgram-tts");
    await synthesizeSpeech("KEY", "Hi.", { encoding: /** @type {any} */ ("opus"), sampleRate: 48000 });
    await synthesizeSpeech("KEY", "Hi.", { encoding: "linear16", sampleRate: 24000.5 });
    assert.deepEqual(urls.map((u) => [u.searchParams.get("encoding"), u.searchParams.get("sample_rate")]), [
      ["mulaw", "8000"],
      ["linear16", "8000"],
    ]);
  });

  it("the host option still picks the API host (the bubble's Sydney host)", async () => {
    const urls = stubFetch();
    const { synthesizeSpeech } = require("../services/deepgram-tts");
    await synthesizeSpeech("KEY", "Hi.", { host: "api.au.deepgram.com", encoding: "linear16", sampleRate: 24000, boost: false });
    assert.equal(urls[0].host, "api.au.deepgram.com");
  });
});
