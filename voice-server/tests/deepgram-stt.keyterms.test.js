"use strict";

/**
 * SCRUM-594: buildKeytermsParam, Nova-3 vs Flux.
 *
 * Nova-3 takes `keyterm=word:boost`. Flux takes PLAIN terms (Deepgram's Flux
 * docs: "Do not append a weight such as term:0.15"), so buildKeytermsParam grew
 * an option, `{ weights: false }`, that the Flux URL uses. The default output
 * must stay BYTE-IDENTICAL: it feeds the two Nova call sites (the live stream
 * in openDeepgramStream and the post-call pre-recorded request in
 * transcribeRecording), which this change must not touch.
 *
 * The "before" snapshots below were taken from the code as it stood before the
 * option existed (the dental one literally; the others as sha256 digests).
 *
 * A fake `ws` is injected via require.cache BEFORE deepgram-stt loads so the
 * live-stream URL can be read without a network (the repo's established idiom;
 * `node --test` runs each file in its own process, so it stays isolated).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const created = [];
class FakeWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    created.push(this);
  }
  send() {}
  close() {}
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;
const wsPath = require.resolve("ws");
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket };

const { buildKeytermsParam, openDeepgramStream, transcribeRecording, INDUSTRY_KEYWORDS } = require("../services/deepgram-stt");

/** buildKeytermsParam("dental") exactly as it was before the `weights` option existed. */
const DENTAL_WEIGHTED =
  "&keyterm=appointment%3A1.5&keyterm=callback%3A1.5&keyterm=reschedule%3A1.5&keyterm=cancel%3A1.5&keyterm=available%3A1.5" +
  "&keyterm=urgent%3A1.5&keyterm=emergency%3A1.5&keyterm=Monday%3A1&keyterm=Tuesday%3A1&keyterm=Wednesday%3A1&keyterm=Thursday%3A1" +
  "&keyterm=Friday%3A1&keyterm=Saturday%3A1&keyterm=Sunday%3A1&keyterm=appointment%3A2&keyterm=cleaning%3A1.5&keyterm=extraction%3A2" +
  "&keyterm=crown%3A1.5&keyterm=filling%3A1.5&keyterm=denture%3A1.5&keyterm=orthodontist%3A2&keyterm=hygienist%3A1.5&keyterm=checkup%3A1.5" +
  "&keyterm=x-ray%3A1.5&keyterm=toothache%3A1.5&keyterm=cavity%3A1.5&keyterm=root%20canal%3A2&keyterm=dental%3A1.5";

/** sha256 of buildKeytermsParam(industry) before the change; "undefined" is no industry, "unknown_industry" is the _common-only path. */
const NOVA_DIGESTS = {
  undefined: "cca4761b589212852745035972867ba9b0b2d06aec2b87bc1f0c86017b751e16",
  unknown_industry: "cca4761b589212852745035972867ba9b0b2d06aec2b87bc1f0c86017b751e16",
  dental: "026909ac02f7811d60f22ef2ca11e2e0709cc0f88c26e9f857f3d89554f850b9",
  medical: "fbe2c07d47c95c2b830166f7abee7fca99e898ae3963053788cc8563b2d2c4ff",
  legal: "814614c2d93875e849a7c586db1db51b12c3c33fb2ae17f4be86cf577316f8e1",
  home_services: "dc0503041087c7bae57211a20481eb037095a18deca12404208ba4307b2c94b4",
  real_estate: "cc2cb7d1daba03f8f0ddffb215158ce52985070e8b393e9274853b3b52704b4b",
  _common: "9d18547a2952dc915fb66230320d4db78bb368ed152da74777a90747c840472d",
};

/** The decoded keyterm values of a `&keyterm=...` param string. */
const termsOf = (param) => new URLSearchParams(param.slice(1)).getAll("keyterm");

// ── Nova stays exactly as it was ────────────────────────────────────────────

test("Nova: buildKeytermsParam('dental') is byte-identical to the output from before the weights option existed", () => {
  assert.equal(buildKeytermsParam("dental"), DENTAL_WEIGHTED);
  assert.equal(buildKeytermsParam("dental", {}), DENTAL_WEIGHTED, "an empty options object changes nothing");
  assert.equal(buildKeytermsParam("dental", { weights: true }), DENTAL_WEIGHTED, "weights defaults to ON");
});

test("Nova: every industry's output is byte-identical (sha256 snapshot taken before the change)", () => {
  assert.deepEqual(
    Object.keys(NOVA_DIGESTS).sort(),
    ["undefined", "unknown_industry", ...Object.keys(INDUSTRY_KEYWORDS)].sort(),
    "the snapshot must cover every industry key (add a digest when an industry is added)",
  );
  for (const [key, digest] of Object.entries(NOVA_DIGESTS)) {
    const industry = key === "undefined" ? undefined : key;
    const actual = crypto.createHash("sha256").update(buildKeytermsParam(industry)).digest("hex");
    assert.equal(actual, digest, `buildKeytermsParam(${key}) drifted`);
  }
});

test("Nova call site (live stream, openDeepgramStream): the URL still ends with the WEIGHTED terms", () => {
  openDeepgramStream("test-key", { onTranscript() {}, onError() {}, onClose() {} }, { industry: "dental" });
  const { url } = created.at(-1);
  assert.ok(url.startsWith("wss://api.deepgram.com/v1/listen?"), url);
  assert.ok(url.endsWith(DENTAL_WEIGHTED), "Nova must keep sending keyterm=word:boost");
});

test("Nova call site (post-call pre-recorded, transcribeRecording): the URL still ends with the WEIGHTED terms", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const urls = [];
  globalThis.fetch = /** @type {any} */ (async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ results: { channels: [{}], utterances: [] } }), text: async () => "" };
  });

  await transcribeRecording("test-key", Buffer.from("mp3"), { industry: "dental" });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith("https://api.deepgram.com/v1/listen?"), urls[0]);
  assert.ok(urls[0].endsWith(DENTAL_WEIGHTED), "Nova must keep sending keyterm=word:boost");
});

// ── { weights: false } is what Flux gets ────────────────────────────────────

test("weights:false: every industry yields plain terms: no ':' in any value, none repeated", () => {
  for (const industry of [undefined, "unknown_industry", ...Object.keys(INDUSTRY_KEYWORDS)]) {
    const values = termsOf(buildKeytermsParam(industry, { weights: false }));
    assert.ok(values.length > 0, String(industry));
    assert.deepEqual(values.filter((v) => v.includes(":")), [], `${industry}: a weight reached the output`);
    assert.equal(new Set(values).size, values.length, `${industry}: repeats in ${values.join(", ")}`);
  }
});

test("weights:false: dental is exactly the stripped list, de-duplicated, in first-occurrence order", () => {
  assert.deepEqual(termsOf(buildKeytermsParam("dental", { weights: false })), [
    "appointment", "callback", "reschedule", "cancel", "available", "urgent", "emergency",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "cleaning", "extraction", "crown", "filling", "denture", "orthodontist", "hygienist",
    "checkup", "x-ray", "toothache", "cavity", "root canal", "dental",
  ]);
});

test("weights:false: stripping creates duplicates (appointment in dental and medical, emergency in home_services) and they collapse to one", () => {
  for (const [industry, term] of [["dental", "appointment"], ["medical", "appointment"], ["home_services", "emergency"]]) {
    const weighted = termsOf(buildKeytermsParam(industry)).filter((v) => v.startsWith(`${term}:`));
    assert.equal(weighted.length, 2, `${industry}: the weighted output carries ${term} twice (the common boost and the industry boost)`);
    const plain = termsOf(buildKeytermsParam(industry, { weights: false })).filter((v) => v === term);
    assert.equal(plain.length, 1, `${industry}: ${term} must appear once for Flux`);
  }
});

test("weights:false: a multi-word term stays ONE value (encoded %20), never split on the space", () => {
  const cases = { dental: "root canal", medical: "blood test", legal: "power of attorney", home_services: "air conditioning" };
  for (const [industry, phrase] of Object.entries(cases)) {
    const param = buildKeytermsParam(industry, { weights: false });
    assert.ok(termsOf(param).includes(phrase), `${industry}: ${phrase}`);
    assert.ok(param.includes(`&keyterm=${phrase.replace(/ /g, "%20")}`), `${industry}: encoded as one value`);
  }
});

test("weights:false: same format as Nova (&keyterm=<encoded term>), only the :boost is gone", () => {
  const plain = buildKeytermsParam("dental", { weights: false });
  assert.ok(plain.startsWith("&keyterm=appointment&keyterm=callback&keyterm=reschedule"), plain.slice(0, 80));
  assert.ok(plain.endsWith("&keyterm=root%20canal&keyterm=dental"), plain.slice(-60));
  assert.ok(!plain.includes("%3A"), "no encoded colon either");
});
