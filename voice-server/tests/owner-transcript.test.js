"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-597: the owner's side of a browser session's transcript, from Deepgram.
// Text only, never fatal: finals are forwarded, everything else is dropped, and a
// lost stream says so exactly once — never after our own close.

const { createOwnerTranscriber } = require("../lib/owner-transcript");

function fakeDeepgram({ readyState = 1, throwOnOpen = null } = {}) {
  const dg = { opened: [], ws: null, cb: null };
  dg.open = (apiKey, callbacks, options) => {
    if (throwOnOpen) throw throwOnOpen;
    dg.opened.push({ apiKey, language: callbacks.language, options });
    dg.cb = callbacks;
    dg.ws = {
      readyState,
      sent: [],
      closed: [],
      send(b) { this.sent.push(b); },
      close(code) { this.closed.push(code); this.readyState = 3; },
    };
    return dg.ws;
  };
  return dg;
}

function make(dgOpts, connectTimeoutMs) {
  const dg = fakeDeepgram(dgOpts);
  const finals = [];
  const lost = [];
  const t = createOwnerTranscriber({
    apiKey: "dg-key", openStream: dg.open, industry: "plumbing", onFinal: (x) => finals.push(x), onLost: (w) => lost.push(w),
    ...(connectTimeoutMs ? { connectTimeoutMs } : {}),
  });
  return { t, dg, finals, lost };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("createOwnerTranscriber", () => {
  it("opens one English Deepgram stream with the org's industry for keyterms", () => {
    const { dg, t } = make();
    assert.deepEqual(dg.opened, [{ apiKey: "dg-key", language: "en", options: { industry: "plumbing" } }]);
    assert.equal(t.active, true);
  });

  it("forwards finals only — trimmed, never interims, empty or non-text results", () => {
    const { dg, finals } = make();
    dg.cb.onTranscript({ transcript: "Do I have", isFinal: false });
    dg.cb.onTranscript({ transcript: "  Do I have any other appointments?  ", isFinal: true });
    dg.cb.onTranscript({ transcript: "   ", isFinal: true });
    dg.cb.onTranscript({ transcript: 42, isFinal: true });
    dg.cb.onTranscript({ transcript: "yes", isFinal: "true" });
    dg.cb.onTranscript({ transcript: "Cancel it.", isFinal: true });
    assert.deepEqual(finals, ["Do I have any other appointments?", "Cancel it."]);
  });

  it("forwards audio only while the stream is open", () => {
    const open = make();
    open.t.send(Buffer.from([1, 2]));
    assert.equal(open.dg.ws.sent.length, 1);
    const connecting = make({ readyState: 0 });
    connecting.t.send(Buffer.from([1, 2]));
    assert.equal(connecting.dg.ws.sent.length, 0, "frames before the socket opens are dropped (the greeting plays first)");
  });

  it("an error loses the stream once: onLost, inactive, socket closed, no more finals or audio", () => {
    const { t, dg, finals, lost } = make();
    dg.cb.onError(new Error("401 unauthorized"));
    dg.cb.onError(new Error("again"));
    dg.cb.onClose(1006);
    assert.deepEqual(lost, ["error: 401 unauthorized"]);
    assert.equal(t.active, false);
    assert.deepEqual(dg.ws.closed, [undefined]);
    dg.cb.onTranscript({ transcript: "late", isFinal: true });
    t.send(Buffer.from([1]));
    assert.deepEqual(finals, []);
    assert.equal(dg.ws.sent.length, 0);
  });

  it("ANY close we didn't ask for loses it — a 'normal' 1000/1005 from Deepgram's side too (else the owner's lines vanish)", () => {
    for (const code of [1000, 1005, 1011]) {
      const { t, dg, lost } = make();
      dg.cb.onClose(code);
      assert.deepEqual(lost, [`closed with code ${code}`], `code ${code}`);
      assert.equal(t.active, false);
    }
  });

  it("a stream still connecting after the deadline is lost (a hung handshake would blank every line until it ends)", async () => {
    const { t, dg, lost } = make({ readyState: 0 }, 20);
    assert.equal(t.active, true, "still within the deadline");
    await sleep(60);
    assert.deepEqual(lost, ["did not connect within 20 ms"]);
    assert.equal(t.active, false);
    assert.deepEqual(dg.ws.closed, [undefined], "the stuck socket is closed");
  });

  it("an open stream is never lost by the deadline; close() cancels it", async () => {
    const open = make({ readyState: 1 }, 20);
    await sleep(60);
    assert.deepEqual(open.lost, []);
    assert.equal(open.t.active, true);
    const closing = make({ readyState: 0 }, 20);
    closing.t.close();
    await sleep(60);
    assert.deepEqual(closing.lost, [], "our own close: no onLost from the deadline");
  });

  it("our own close(): 1000 to Deepgram, inactive, and no onLost for the error/close it causes", () => {
    const { t, dg, lost, finals } = make();
    t.close();
    assert.deepEqual(dg.ws.closed, [1000]);
    assert.equal(t.active, false);
    dg.cb.onError(new Error("WebSocket was closed before the connection was established"));
    dg.cb.onClose(1006);
    dg.cb.onTranscript({ transcript: "late", isFinal: true });
    assert.deepEqual(lost, []);
    assert.deepEqual(finals, []);
    t.close();
    assert.deepEqual(dg.ws.closed, [1000], "a second close does nothing");
  });

  it("a stream that can't even open is lost at once (the session goes on with Gemini's text)", () => {
    const { t, lost } = make({ throwOnOpen: new Error("bad url") });
    assert.deepEqual(lost, ["could not open: bad url"]);
    assert.equal(t.active, false);
    assert.doesNotThrow(() => { t.send(Buffer.from([1])); t.close(); });
  });
});
