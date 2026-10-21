"use strict";

/**
 * SCRUM-594 (phone test F9): services/aura-router.js, a stream per voice behind
 * the one-stream interface the fast path always had. The streams are fakes with
 * the AuraStream surface (the real client has its own suite, aura-stream.test.js);
 * what is tested here is the order, the hand-overs and the failures.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createAuraRouter } = require("../services/aura-router");

const BASE = "aura-2-theia-en";
const SPANISH = "aura-2-selena-es";
const FRENCH = "aura-2-agathe-fr";
const GERMAN = "aura-2-elara-de";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Fake Aura streams: each opens at once unless `opens(voice)` says not; a test opens or fails it.
 * @param {{ opens?: (voice: string) => boolean }} [o]
 */
function fakeStreams(o = {}) {
  const opened = [];
  const said = [];
  const openStream = (apiKey, options) => {
    /** @type {() => void} */
    let resolveReady = () => {};
    /** @type {(err: Error) => void} */
    let rejectReady = () => {};
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});
    const handle = {
      open: false,
      spoken: [],
      flushes: [],
      clears: 0,
      closes: 0,
      nextSeq: 0,
      refuse: false,
      closeThrows: false,
      ready,
      isOpen() { return this.open; },
      speak(text) { if (!this.open || typeof text !== "string" || !text.trim()) return false; this.spoken.push(text); said.push([options.voice, text]); return true; },
      flush() { if (!this.open || this.refuse) return null; const seq = this.nextSeq++; this.flushes.push(seq); return seq; },
      flushesInLastMinute() { return this.flushes.length; },
      clear() { if (!this.open) return false; this.clears += 1; return true; },
      close() { this.closes += 1; this.open = false; if (this.closeThrows) throw new Error(`closing ${options.voice} threw`); },
      /** The socket opens. */
      opens() { this.open = true; resolveReady(); },
      /** It never opens: ready rejects, then onError, then onClose — as aura-stream does. */
      fails(err = new Error("Unexpected server response: 400")) { rejectReady(err); options.onError(err); options.onClose(1006, "", { initiatedByUs: false }); },
    };
    if (!o.opens || o.opens(options.voice)) handle.opens();
    opened.push({ apiKey, options, handle });
    return handle;
  };
  const of = (voice) => opened.filter((a) => a.options.voice === voice).at(-1);
  /** Aura confirms a voice's flushes, oldest first (all of them by default). */
  const confirm = (voice, count = Infinity) => {
    const a = of(voice);
    for (let i = 0; i < count && (a.handle.confirmed ?? 0) < a.handle.flushes.length; i++) {
      const seq = a.handle.flushes[a.handle.confirmed ?? 0];
      a.handle.confirmed = (a.handle.confirmed ?? 0) + 1;
      a.options.onFlushed(seq);
    }
  };
  return { opened, said, openStream, of, confirm };
}

/** A router over fake streams, recording what it reports. */
function makeRouter(o = {}) {
  const streams = fakeStreams(o);
  const events = { flushed: [], audio: [], warnings: [], errors: [], closes: [], failedVoices: [] };
  const router = createAuraRouter("dg-key", {
    voice: BASE,
    host: "api.au.deepgram.com",
    openStream: streams.openStream,
    openTimeoutMs: o.openTimeoutMs ?? 60_000,
    quietMs: o.quietMs ?? 25,
    handoverWaitMs: o.handoverWaitMs ?? 60_000,
    maxVoices: o.maxVoices,
    onAudio: (audio, voice) => events.audio.push([voice, audio.length]),
    onFlushed: o.onFlushed || ((seq) => events.flushed.push(seq)),
    onWarning: (warning) => events.warnings.push(warning),
    onError: (err) => events.errors.push(err.message),
    onClose: (code, reason, info) => events.closes.push([code, info.initiatedByUs]),
    onVoiceFailed: (voice, err) => events.failedVoices.push([voice, err.message]),
    rerouteText: o.rerouteText,
  });
  return { router, streams, events };
}

describe("aura-router: one voice is the one stream it always was", () => {
  it("opens the assistant's voice at once, on the host; ready and isOpen are that stream's", async () => {
    const { router, streams } = makeRouter({ opens: () => false });
    assert.equal(streams.opened.length, 1);
    assert.deepEqual([streams.opened[0].apiKey, streams.opened[0].options.voice, streams.opened[0].options.host], ["dg-key", BASE, "api.au.deepgram.com"]);
    assert.equal(router.isOpen(), false);
    assert.equal(router.speak("Hello."), false, "nothing is queued for a stream that is not open");
    streams.of(BASE).handle.opens();
    await router.ready;
    assert.equal(router.isOpen(), true);
  });

  it("speaks at once and flushes with the stream's own sequence ids; a Flushed reports its id", () => {
    const { router, streams, events } = makeRouter();
    assert.equal(router.speak("Sure, Tuesday at ten."), true);
    assert.deepEqual(streams.of(BASE).handle.spoken, ["Sure, Tuesday at ten."]);
    assert.equal(router.flush(), 0);
    assert.equal(router.speak("Anything else?", BASE), true);
    assert.equal(router.flush(), 1);
    streams.confirm(BASE);
    assert.deepEqual(events.flushed, [0, 1]);
    assert.equal(router.flushesInLastMinute(), 2);
    assert.deepEqual(router.voicesUsed(), [BASE]);
  });

  it("a refused flush is null, as before; a Flushed it never asked for still reaches the server", () => {
    const { router, streams, events } = makeRouter();
    router.speak("Hi.");
    streams.of(BASE).handle.refuse = true;
    assert.equal(router.flush(), null);
    streams.of(BASE).handle.refuse = false;
    assert.equal(router.flush(), 0, "no id was used up by the refusal");
    streams.of(BASE).options.onFlushed(null);
    streams.of(BASE).options.onFlushed(7);
    assert.deepEqual(events.flushed, [0, 7], "a Flushed without an id is the oldest flush; one for no flush passes as it came");
  });

  it("empty text, a non-string, a closed router: nothing queued", () => {
    const { router } = makeRouter();
    assert.equal(router.speak("   "), false);
    assert.equal(router.speak(/** @type {any} */ (42)), false);
    router.close();
    assert.equal(router.speak("Hi."), false);
    assert.equal(router.flush(), null);
    assert.equal(router.clear(), false);
    assert.equal(router.isOpen(), false);
  });

  it("the stream's audio reaches onAudio with its voice; its errors and closes are the router's", () => {
    const { router, streams, events } = makeRouter();
    streams.of(BASE).options.onAudio(Buffer.alloc(320));
    assert.deepEqual(events.audio, [[BASE, 320]]);
    streams.of(BASE).options.onError(new Error("aura down"));
    streams.of(BASE).options.onClose(1011, "boom", { initiatedByUs: false });
    assert.deepEqual(events.errors, ["aura down"]);
    assert.deepEqual(events.closes, [[1011, false]]);
    router.close();
    streams.of(BASE).options.onClose(1000, "", { initiatedByUs: true });
    assert.deepEqual(events.closes, [[1011, false], [1000, true]], "our own close passes too: the server ignores it");
  });
});

describe("aura-router: a sentence in another voice", () => {
  it("opens that voice's stream at once; the sentence goes once the voice before it has finished (its Flushed)", () => {
    const { router, streams, events } = makeRouter();
    router.speak("Of course.");
    router.speak("¡Claro! Puedo ayudarle en español.", SPANISH);
    assert.ok(streams.of(SPANISH), "the connect overlaps the hand-over");
    assert.equal(streams.of(SPANISH).options.host, "api.au.deepgram.com");
    assert.deepEqual(streams.of(BASE).handle.flushes, [0], "the English was flushed for the hand-over");
    assert.deepEqual(streams.of(SPANISH).handle.spoken, [], "not before the English audio is all out");
    const seq = router.flush();
    assert.equal(seq, 0);
    streams.confirm(BASE);
    assert.deepEqual(streams.of(SPANISH).handle.spoken, ["¡Claro! Puedo ayudarle en español."]);
    assert.deepEqual(streams.of(SPANISH).handle.flushes, [0], "the router's flush followed it there");
    assert.deepEqual(events.flushed, [], "a hand-over flush is the router's own");
    streams.confirm(SPANISH);
    assert.deepEqual(events.flushed, [0]);
    streams.of(SPANISH).options.onAudio(Buffer.alloc(160));
    assert.deepEqual(events.audio, [[SPANISH, 160]]);
    assert.deepEqual(router.voicesUsed(), [BASE, SPANISH]);
  });

  it("sentences keep their order across voices, and so do the router's flushes", () => {
    const { router, streams, events } = makeRouter();
    router.speak("One.");
    const a = router.flush();
    router.speak("Dos.", SPANISH);
    const b = router.flush();
    router.speak("Three.");
    const c = router.flush();
    assert.deepEqual([a, b, c], [0, 1, 2]);
    assert.deepEqual(streams.said, [[BASE, "One."]]);
    streams.confirm(BASE);
    assert.deepEqual(streams.said, [[BASE, "One."], [SPANISH, "Dos."]]);
    streams.confirm(SPANISH);
    assert.deepEqual(streams.said, [[BASE, "One."], [SPANISH, "Dos."], [BASE, "Three."]]);
    streams.confirm(BASE);
    assert.deepEqual(events.flushed, [0, 1, 2]);
  });

  it("a voice still connecting holds its sentence (and what follows) until it opens", async () => {
    const { router, streams } = makeRouter({ opens: (voice) => voice === BASE });
    router.speak("Hola.", SPANISH);
    router.speak("Bye.");
    assert.deepEqual(streams.said, []);
    streams.of(SPANISH).handle.opens();
    await settle();
    assert.deepEqual(streams.said, [[SPANISH, "Hola."]]);
    router.flush();
    streams.confirm(SPANISH);
    assert.deepEqual(streams.said, [[SPANISH, "Hola."], [BASE, "Bye."]]);
  });

  it("prepare opens a voice before its first sentence; never the assistant's own, never twice", () => {
    const { router, streams } = makeRouter();
    router.prepare(SPANISH);
    router.prepare(SPANISH);
    router.prepare(BASE);
    assert.deepEqual(streams.opened.map((a) => a.options.voice), [BASE, SPANISH]);
    router.speak("Hola.", SPANISH);
    assert.deepEqual(streams.of(SPANISH).handle.spoken, ["Hola."], "already open: at once");
  });

  it("a refused hand-over flush: the next voice waits until the last one's audio has been quiet for quietMs", async () => {
    const { router, streams } = makeRouter({ quietMs: 30 });
    router.speak("Of course.");
    streams.of(BASE).handle.refuse = true;
    router.speak("Claro.", SPANISH);
    assert.deepEqual(streams.of(SPANISH).handle.spoken, []);
    await sleep(20);
    streams.of(BASE).options.onAudio(Buffer.alloc(160)); // still talking: the quiet starts again
    await sleep(20);
    assert.deepEqual(streams.of(SPANISH).handle.spoken, []);
    await sleep(30);
    assert.deepEqual(streams.of(SPANISH).handle.spoken, ["Claro."]);
  });

  it("a router flush that its stream refuses later is reported once that stream goes quiet", async () => {
    const { router, streams, events } = makeRouter({ quietMs: 20 });
    router.speak("Of course.");
    router.speak("Claro.", SPANISH);
    const seq = router.flush();
    streams.of(SPANISH).handle.refuse = true;
    streams.confirm(BASE);
    assert.deepEqual(streams.of(SPANISH).handle.spoken, ["Claro."]);
    assert.deepEqual(events.flushed, []);
    await sleep(40);
    assert.deepEqual(events.flushed, [seq]);
  });

  it("a Flushed that never comes gives way after handoverWaitMs, with a warning; the flushes owed are reported", async () => {
    const { router, streams, events } = makeRouter({ handoverWaitMs: 30 });
    router.speak("Of course.");
    const seq = router.flush();
    router.speak("Claro.", SPANISH);
    await sleep(50);
    assert.deepEqual(streams.of(SPANISH).handle.spoken, ["Claro."]);
    assert.deepEqual(events.warnings.map((w) => [w.code, w.voice]), [["HANDOVER_TIMEOUT", BASE]]);
    assert.deepEqual(events.flushed, [seq]);
  });
});

describe("aura-router: failures", () => {
  it("a voice refused before it opens: onVoiceFailed once; its sentences go to the assistant's voice, in order, from then on", () => {
    const { router, streams, events } = makeRouter({ opens: (voice) => voice === BASE });
    router.speak("Hola.", SPANISH);
    router.speak("¿Qué tal?", SPANISH);
    const seq = router.flush();
    streams.of(SPANISH).handle.fails();
    assert.deepEqual(events.failedVoices, [[SPANISH, "Unexpected server response: 400"]]);
    assert.deepEqual(events.errors, [], "a failed voice is no router failure");
    assert.deepEqual(streams.said, [[BASE, "Hola."], [BASE, "¿Qué tal?"]]);
    streams.confirm(BASE);
    assert.deepEqual(events.flushed, [seq]);
    router.speak("Gracias.", SPANISH);
    router.prepare(SPANISH);
    assert.deepEqual(streams.said.at(-1), [BASE, "Gracias."]);
    assert.equal(streams.opened.filter((a) => a.options.voice === SPANISH).length, 1, "never tried again");
  });

  it("security review: what waited for a failed voice goes through the server's speech guard, in order (\"\" drops it)", () => {
    let apologised = false;
    const rerouteText = (text) => (/[ぁ-ん]/.test(text) ? (apologised ? "" : ((apologised = true), "Sorry, English only.")) : text);
    const { router, streams, events } = makeRouter({ opens: (voice) => voice === BASE, rerouteText });
    router.speak("はい。", "aura-2-uzume-ja");
    router.speak("ありがとうございます。", "aura-2-uzume-ja");
    router.speak("Bye.");
    streams.of("aura-2-uzume-ja").handle.fails();
    assert.deepEqual(events.failedVoices.map(([voice]) => voice), ["aura-2-uzume-ja"]);
    assert.deepEqual(streams.said, [[BASE, "Sorry, English only."], [BASE, "Bye."]]);
  });

  it("a speech guard that throws fails the router (reported), and the sentence keeps its words", () => {
    const { router, streams, events } = makeRouter({ opens: (voice) => voice === BASE, rerouteText: () => { throw new Error("guard bug"); } });
    router.speak("Hola.", SPANISH);
    streams.of(SPANISH).handle.fails();
    assert.deepEqual(events.errors, ["guard bug"]);
    assert.deepEqual(streams.said, [[BASE, "Hola."]]);
  });

  it("a voice that does not open within openTimeoutMs fails the same way, and is closed", async () => {
    const { router, streams, events } = makeRouter({ openTimeoutMs: 20, opens: (voice) => voice === BASE });
    router.speak("Hola.", SPANISH);
    await sleep(40);
    assert.deepEqual(events.failedVoices.map(([voice]) => voice), [SPANISH]);
    assert.match(events.failedVoices[0][1], /did not open within 20 ms/);
    assert.equal(streams.of(SPANISH).handle.closes, 1);
    assert.deepEqual(streams.said, [[BASE, "Hola."]]);
  });

  it("another voice failing while it still owes audio fails the router (the server's fallback says it again)", () => {
    const { router, streams, events } = makeRouter();
    router.speak("Hola.", SPANISH);
    router.flush();
    streams.of(SPANISH).options.onError(new Error("socket hang up"));
    streams.of(SPANISH).options.onClose(1006, "", { initiatedByUs: false });
    assert.deepEqual(events.errors, ["socket hang up"]);
    assert.deepEqual(events.failedVoices, []);
  });

  it("an idle voice whose stream closes is forgotten, with a warning, and opened again for its next sentence", () => {
    const { router, streams, events } = makeRouter();
    router.speak("Hola.", SPANISH);
    router.flush();
    streams.confirm(SPANISH);
    streams.of(SPANISH).options.onClose(1000, "idle", { initiatedByUs: false });
    assert.deepEqual(events.errors, []);
    assert.deepEqual(events.warnings.map((w) => [w.code, w.voice]), [["VOICE_CLOSED", SPANISH]]);
    router.speak("Otra vez.", SPANISH);
    assert.equal(streams.opened.filter((a) => a.options.voice === SPANISH).length, 2);
    assert.deepEqual(streams.of(SPANISH).handle.spoken, ["Otra vez."]);
  });

  it("a server callback that throws in a timer is routed to onError, never thrown", async () => {
    const errors = [];
    const streams = fakeStreams();
    const router = createAuraRouter("dg-key", {
      voice: BASE,
      openStream: streams.openStream,
      quietMs: 10,
      onFlushed: () => { throw new Error("server bug"); },
      onError: (err) => errors.push(err.message),
    });
    router.speak("Of course.");
    router.speak("Claro.", SPANISH);
    router.flush();
    streams.of(SPANISH).handle.refuse = true;
    streams.confirm(BASE);
    await sleep(30);
    assert.deepEqual(errors, ["server bug"]);
  });
});

describe("aura-router: barge-in, the voices' cap, and cleanup", () => {
  it("clear drops what waits (its flushes never report), Clears only the stream still speaking, and the next voice goes at once", () => {
    const { router, streams, events } = makeRouter();
    router.speak("Of course.");
    router.flush();
    streams.confirm(BASE);
    router.speak("Claro.", SPANISH);
    router.speak("And more.");
    router.flush();
    assert.equal(router.clear(), true);
    assert.equal(streams.of(SPANISH).handle.clears, 1, "speaking: cleared");
    assert.equal(streams.of(BASE).handle.clears, 0, "idle: never (a lost Cleared would mute its next sentence)");
    streams.confirm(SPANISH);
    assert.deepEqual(events.flushed, [0], "a cleared flush never reports");
    router.speak("New reply.");
    assert.deepEqual(streams.of(BASE).handle.spoken, ["Of course.", "New reply."], "no hand-over wait after a clear");
  });

  it("past maxVoices, a new voice closes the least recently used idle one", () => {
    const { router, streams } = makeRouter({ maxVoices: 3 });
    router.speak("Hola.", SPANISH);
    router.flush();
    streams.confirm(SPANISH);
    router.speak("Bonjour.", FRENCH);
    router.flush();
    streams.confirm(FRENCH);
    router.speak("Hallo.", GERMAN);
    assert.equal(streams.of(SPANISH).handle.closes, 1, "the oldest idle one");
    assert.equal(streams.of(FRENCH).handle.closes, 0);
    assert.equal(streams.of(BASE).handle.closes, 0, "never the assistant's own");
  });

  it("security review: a stream still connecting, with a sentence waiting for it, is never the one evicted", () => {
    const { router, streams } = makeRouter({ maxVoices: 3, opens: (voice) => voice === BASE || voice === SPANISH });
    router.speak("Hola.", SPANISH);
    router.flush();
    streams.confirm(SPANISH);
    router.speak("Bonjour.", FRENCH); // connecting, its sentence waiting
    router.speak("Hallo.", GERMAN); // over the cap
    assert.equal(streams.of(FRENCH).handle.closes, 0, "not the one waited for");
    assert.equal(streams.of(SPANISH).handle.closes, 1, "the idle one");
    streams.of(FRENCH).handle.opens();
    return settle().then(() => assert.deepEqual(streams.of(FRENCH).handle.spoken, ["Bonjour."]));
  });

  it("close closes every stream, once; one that throws doesn't stop the others; late callbacks do nothing", () => {
    const { router, streams, events } = makeRouter();
    router.speak("Hola.", SPANISH);
    streams.of(BASE).handle.closeThrows = true;
    assert.throws(() => router.close(), /closing aura-2-theia-en threw/);
    assert.equal(streams.of(SPANISH).handle.closes, 1);
    router.close();
    assert.equal(streams.of(SPANISH).handle.closes, 1, "idempotent");
    streams.of(SPANISH).options.onAudio(Buffer.alloc(160));
    streams.of(SPANISH).options.onFlushed(0);
    streams.of(SPANISH).options.onError(new Error("late"));
    assert.deepEqual([events.audio, events.flushed, events.errors], [[], [], []]);
  });
});
