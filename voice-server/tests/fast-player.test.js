"use strict";

/**
 * SCRUM-594 Task 1: the Twilio audio player for the fast path (lib/fast-player.js).
 *
 * Pure unit tests: `sendJson` collects the Twilio messages, `now` is a clock the
 * test owns, and the one timer whenIdle() arms is captured (not waited for) so
 * the deadline arithmetic is asserted exactly. node:test's mock.timers is
 * deliberately avoided (its ExperimentalWarning would dirty the test output).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFastPlayer } = require("../lib/fast-player");

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const STREAM_SID = "MZ0123456789abcdef";

function makePlayer({ start = 1_000_000 } = {}) {
  const sent = [];
  const clock = { now: start, advance(ms) { clock.now += ms; } };
  const player = createFastPlayer({ sendJson: (message) => sent.push(message), streamSid: STREAM_SID, now: () => clock.now });
  return { player, sent, clock };
}

const media = (sent) => sent.filter((m) => m.event === "media");
const marks = (sent) => sent.filter((m) => m.event === "mark");
/** Decoded payload of every media frame, in order. */
const frames = (sent) => media(sent).map((m) => Buffer.from(m.media.payload, "base64"));
/** n bytes whose values cycle 0..255 starting at `from`, so any slip shows up as a diff. */
const bytes = (n, from = 0) => Buffer.from(Array.from({ length: n }, (_, i) => (from + i) % 256));

/**
 * Capture the timers armed INSIDE `during(fn)` instead of scheduling them; all
 * other timers (node:test's own) pass straight through.
 */
function captureTimers(t) {
  const created = [];
  const cleared = [];
  let capturing = false;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...rest) => {
    if (!capturing) return realSetTimeout(fn, ms, ...rest);
    const timer = { fn, ms, unref() {}, ref() {} };
    created.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    if (timer && created.includes(timer)) {
      cleared.push(timer);
      return undefined;
    }
    return realClearTimeout(timer);
  });
  return {
    created,
    cleared,
    during(fn) {
      capturing = true;
      try {
        return fn();
      } finally {
        capturing = false;
      }
    },
  };
}

/** "pending" if the promise has not settled by the next macrotask turn. */
async function state(promise) {
  return Promise.race([promise.then(() => "resolved"), new Promise((resolve) => setImmediate(() => resolve("pending")))]);
}

// ── Construction ────────────────────────────────────────────────────────────

test("createFastPlayer needs a sendJson function and a streamSid", () => {
  assert.throws(() => createFastPlayer({ streamSid: STREAM_SID }), /sendJson/);
  assert.throws(() => createFastPlayer({ sendJson: () => {} }), /streamSid/);
  assert.throws(() => createFastPlayer(/** @type {any} */ (undefined)), /sendJson/);
});

// ── push(): re-chunking into 160-byte Twilio frames ─────────────────────────

test("push: bytes under one frame are held back, a frame is sent the moment 160 are there", () => {
  const { player, sent } = makePlayer();
  player.push(bytes(100));
  assert.deepEqual(sent, [], "100 bytes is not a frame yet");
  player.push(bytes(300, 100)); // 400 total -> 2 frames + 80 held
  assert.equal(media(sent).length, 2);
  assert.ok(frames(sent).every((f) => f.length === 160));
  assert.deepEqual(Buffer.concat(frames(sent)), bytes(320), "byte-exact, in order");
});

test("push: every media message is exactly {event, streamSid, media:{payload}} with base64 audio", () => {
  const { player, sent } = makePlayer();
  player.push(bytes(160));
  assert.deepEqual(sent, [{ event: "media", streamSid: STREAM_SID, media: { payload: bytes(160).toString("base64") } }]);
});

test("push: Deepgram's odd frame sizes (290/320/30) are re-chunked to 160 with nothing lost or reordered", () => {
  const { player, sent } = makePlayer();
  const parts = [bytes(290, 0), bytes(320, 290), bytes(320, 610), bytes(30, 930)]; // 960 bytes = 6 frames
  for (const part of parts) player.push(part);
  assert.equal(media(sent).length, 6);
  assert.ok(frames(sent).every((f) => f.length === 160));
  assert.deepEqual(Buffer.concat(frames(sent)), bytes(960));
  assert.deepEqual(marks(sent), []);
});

test("push: a single huge push and a stream of 1-byte pushes both frame correctly", () => {
  const big = makePlayer();
  big.player.push(bytes(1000));
  assert.equal(media(big.sent).length, 6, "1000 bytes = 6 frames + 40 held");
  big.player.endUtterance();
  assert.deepEqual(frames(big.sent).map((f) => f.length), [160, 160, 160, 160, 160, 160, 40]);
  assert.deepEqual(Buffer.concat(frames(big.sent)), bytes(1000));

  const tiny = makePlayer();
  for (let i = 0; i < 500; i++) tiny.player.push(bytes(1, i));
  assert.equal(media(tiny.sent).length, 3);
  tiny.player.endUtterance();
  assert.deepEqual(Buffer.concat(frames(tiny.sent)), bytes(500));
});

test("push: ignores empty and non-buffer input", () => {
  const { player, sent } = makePlayer();
  player.push(Buffer.alloc(0));
  player.push(/** @type {any} */ (null));
  player.push(/** @type {any} */ (undefined));
  assert.deepEqual(sent, []);
  assert.equal(player.isPlaying(), false);
  assert.deepEqual(player.stats(), { firstAudioAt: null, bytesSent: 0 });
});

test("push: a bare Uint8Array works too, including a view into a larger ArrayBuffer (offset respected)", () => {
  const { player, sent } = makePlayer();
  const backing = new Uint8Array(bytes(400));
  player.push(backing.subarray(100, 360)); // 260 bytes, starting at byteOffset 100
  player.endUtterance();
  assert.deepEqual(Buffer.concat(frames(sent)), bytes(260, 100));
});

test("push: the held remainder is a COPY (a caller reusing its buffer cannot corrupt queued audio)", () => {
  const { player, sent } = makePlayer();
  const first = Buffer.alloc(100, 0x11);
  player.push(first);
  first.fill(0x99); // the caller recycles its buffer
  player.push(Buffer.alloc(100, 0x22));
  assert.deepEqual(frames(sent)[0], Buffer.concat([Buffer.alloc(100, 0x11), Buffer.alloc(60, 0x22)]));
});

// ── endUtterance(): flush the tail, then a mark ─────────────────────────────

test("endUtterance: sends the partial tail first, then {event:'mark', mark:{name:'fast-<n>'}}", () => {
  const { player, sent } = makePlayer();
  player.push(bytes(200));
  const name = player.endUtterance();

  assert.match(name, /^fast-\d+$/);
  assert.deepEqual(sent.map((m) => m.event), ["media", "media", "mark"]);
  assert.deepEqual(frames(sent).map((f) => f.length), [160, 40], "the 40-byte tail is flushed, unpadded");
  assert.deepEqual(sent[2], { event: "mark", streamSid: STREAM_SID, mark: { name } });
});

test("endUtterance: names are unique and increasing; with no tail only the mark is sent; with no audio it still marks", () => {
  const { player, sent } = makePlayer();
  player.push(bytes(320));
  const a = player.endUtterance();
  const b = player.endUtterance();
  const c = player.endUtterance();
  assert.deepEqual([a, b, c], ["fast-1", "fast-2", "fast-3"]);
  assert.equal(media(sent).length, 2, "no tail, nothing extra");
  assert.equal(marks(sent).length, 3);
});

// ── onMark() / isPlaying() ──────────────────────────────────────────────────

test("isPlaying: true as soon as audio is handed over, until its mark comes back", () => {
  const { player } = makePlayer();
  assert.equal(player.isPlaying(), false, "idle at start");

  player.push(bytes(100));
  assert.equal(player.isPlaying(), true, "a partial frame already counts: the AI is mid-utterance");

  player.push(bytes(500, 100));
  assert.equal(player.isPlaying(), true, "audio streaming in, no mark yet (the first Twilio mark must not end it)");

  const name = player.endUtterance();
  assert.equal(player.isPlaying(), true, "marked but not yet played");

  assert.equal(player.onMark(name), true);
  assert.equal(player.isPlaying(), false);
});

test("isPlaying: audio pushed AFTER a mark keeps it true when that earlier mark returns (the classic tts-done bug)", () => {
  const { player } = makePlayer();
  player.push(bytes(320));
  const first = player.endUtterance();
  player.push(bytes(320)); // next utterance already streaming in
  assert.equal(player.onMark(first), true);
  assert.equal(player.isPlaying(), true, "unmarked audio is still queued");
  const second = player.endUtterance();
  assert.equal(player.onMark(second), true);
  assert.equal(player.isPlaying(), false);
});

test("onMark: false for anything that is not an outstanding fast mark (tts-done, unknown, repeats, junk)", () => {
  const { player } = makePlayer();
  player.push(bytes(160));
  const name = player.endUtterance();

  assert.equal(player.onMark("tts-done"), false);
  assert.equal(player.onMark("fast-999"), false);
  assert.equal(player.onMark(/** @type {any} */ (undefined)), false);
  assert.equal(player.onMark(/** @type {any} */ (null)), false);
  assert.equal(player.isPlaying(), true, "none of those touched the state");

  assert.equal(player.onMark(name), true);
  assert.equal(player.onMark(name), false, "a repeat of a consumed mark");
});

test("onMark: Twilio plays in order, so a later mark also retires the earlier ones (a lost echo cannot wedge isPlaying)", () => {
  const { player } = makePlayer();
  const names = [];
  for (let i = 0; i < 3; i++) {
    player.push(bytes(160));
    names.push(player.endUtterance());
  }
  assert.equal(player.onMark(names[2]), true);
  assert.equal(player.isPlaying(), false);
  assert.equal(player.onMark(names[0]), false, "already retired by the later mark");
  assert.equal(player.onMark(names[1]), false);
});

// ── stop() ──────────────────────────────────────────────────────────────────

test("stop: sends Twilio {event:'clear'} (even when it thinks nothing is playing) and the player is idle", () => {
  const { player, sent } = makePlayer();
  player.stop();
  assert.deepEqual(sent, [{ event: "clear", streamSid: STREAM_SID }]);

  player.push(bytes(500));
  player.endUtterance();
  assert.equal(player.isPlaying(), true);
  player.stop();
  assert.equal(sent.at(-1).event, "clear");
  assert.equal(player.isPlaying(), false);
});

test("stop: drops the held partial frame (it belongs to the interrupted reply)", () => {
  const { player, sent } = makePlayer();
  player.push(bytes(100, 0x40));
  player.stop();
  sent.length = 0;

  player.push(bytes(60, 0x70));
  player.endUtterance();
  assert.deepEqual(frames(sent), [bytes(60, 0x70)], "only the new 60 bytes, none of the old 100");
});

test("stop: empties the outstanding marks and never reuses a mark name (Twilio echoes the cleared ones late)", () => {
  const { player } = makePlayer();
  player.push(bytes(160));
  const stale = player.endUtterance(); // fast-1
  player.stop();

  player.push(bytes(160));
  const fresh = player.endUtterance();
  assert.notEqual(fresh, stale, "a stale echo must not be mistaken for the new mark");
  assert.equal(player.onMark(stale), false, "the cleared mark's late echo is ignored");
  assert.equal(player.isPlaying(), true, "and it did not end the new utterance");
  assert.equal(player.onMark(fresh), true);
  assert.equal(player.isPlaying(), false);
});

test("stop: resets the utterance stats", () => {
  const { player } = makePlayer();
  player.push(bytes(320));
  assert.notDeepEqual(player.stats(), { firstAudioAt: null, bytesSent: 0 });
  player.stop();
  assert.deepEqual(player.stats(), { firstAudioAt: null, bytesSent: 0 });
});

// ── stats() ─────────────────────────────────────────────────────────────────

test("stats: firstAudioAt is when the first byte was handed over; bytesSent counts bytes put on the wire", () => {
  const { player, clock } = makePlayer({ start: 5_000 });
  assert.deepEqual(player.stats(), { firstAudioAt: null, bytesSent: 0 });

  player.push(bytes(100)); // handed over at 5000, nothing on the wire yet
  assert.deepEqual(player.stats(), { firstAudioAt: 5_000, bytesSent: 0 });

  clock.advance(80);
  player.push(bytes(300, 100)); // 2 frames go out (320 bytes), 80 held
  assert.deepEqual(player.stats(), { firstAudioAt: 5_000, bytesSent: 320 }, "firstAudioAt does not move");

  clock.advance(80);
  player.endUtterance(); // the 80-byte tail goes out
  assert.deepEqual(player.stats(), { firstAudioAt: 5_000, bytesSent: 400 });
});

test("stats: they describe the current utterance; the next utterance's first push starts a fresh one", () => {
  const { player, clock } = makePlayer({ start: 1_000 });
  player.push(bytes(320));
  player.endUtterance();
  clock.advance(600);
  assert.deepEqual(player.stats(), { firstAudioAt: 1_000, bytesSent: 320 }, "still readable after the mark (the caller logs it then)");

  player.push(bytes(160));
  assert.deepEqual(player.stats(), { firstAudioAt: 1_600, bytesSent: 160 });
});

// ── whenIdle() ──────────────────────────────────────────────────────────────

test("whenIdle: resolves at once when nothing is playing, arming no timer", async (t) => {
  const timers = captureTimers(t);
  const { player } = makePlayer();
  const p = timers.during(() => player.whenIdle(5_000));
  assert.equal(await state(p), "resolved");
  assert.equal(timers.created.length, 0);
});

test("whenIdle: waits for the mark, then resolves and disarms its timer", async (t) => {
  const timers = captureTimers(t);
  const { player } = makePlayer();
  player.push(bytes(1600));
  const name = player.endUtterance();

  const p = timers.during(() => player.whenIdle(2_000));
  assert.equal(timers.created.length, 1);
  assert.equal(await state(p), "pending");

  player.onMark(name);
  assert.equal(await state(p), "resolved");
  assert.deepEqual(timers.cleared, timers.created, "the deadline timer does not outlive the wait");
});

test("whenIdle: the deadline is max(estimated remaining playback, 0) + capMs", (t) => {
  const timers = captureTimers(t);
  const { player, clock } = makePlayer();

  player.push(bytes(800)); // 800 bytes of 8 kHz mulaw = 100 ms of audio, sent at t0
  player.endUtterance();

  clock.advance(40); // 60 ms of it still to play
  timers.during(() => player.whenIdle(250));
  assert.equal(timers.created.at(-1).ms, 60 + 250);

  clock.advance(500); // long since played out: remaining floors at 0, never negative
  timers.during(() => player.whenIdle(250));
  assert.equal(timers.created.at(-1).ms, 250);
});

test("whenIdle: the estimate accumulates back-to-back audio but not across an idle gap", (t) => {
  const timers = captureTimers(t);
  const { player, clock } = makePlayer();

  player.push(bytes(800)); // t0: plays t0..t0+100
  clock.advance(20);
  player.push(bytes(800)); // queued behind it: plays until t0+200
  timers.during(() => player.whenIdle(0));
  assert.equal(timers.created.at(-1).ms, 180, "180 ms of audio still queued at t0+20");

  clock.advance(1_000); // everything has played; a new utterance starts from NOW
  player.push(bytes(800));
  timers.during(() => player.whenIdle(0));
  assert.equal(timers.created.at(-1).ms, 100, "100 ms, not 100 + whatever was left over");
});

test("whenIdle: the default cap is 2000 ms", (t) => {
  const timers = captureTimers(t);
  const { player } = makePlayer();
  player.push(bytes(160)); // 20 ms
  timers.during(() => player.whenIdle());
  assert.equal(timers.created.at(-1).ms, 20 + 2_000);
});

test("whenIdle: a negative, NaN or infinite cap falls back to the default instead of arming a nonsense timer", (t) => {
  const timers = captureTimers(t);
  const { player } = makePlayer();
  player.push(bytes(160)); // 20 ms
  for (const bad of [-5, NaN, Infinity, "soon"]) {
    timers.during(() => player.whenIdle(/** @type {any} */ (bad)));
    assert.equal(timers.created.at(-1).ms, 20 + 2_000, String(bad));
  }
  timers.during(() => player.whenIdle(0));
  assert.equal(timers.created.at(-1).ms, 20, "zero is a legitimate cap");
});

test("whenIdle: gives up at the deadline when the mark never comes (state is left alone)", async (t) => {
  const timers = captureTimers(t);
  const { player } = makePlayer();
  player.push(bytes(160));
  player.endUtterance();

  const p = timers.during(() => player.whenIdle(100));
  assert.equal(await state(p), "pending");
  timers.created[0].fn(); // the deadline passes
  assert.equal(await state(p), "resolved");
  assert.equal(player.isPlaying(), true, "giving up waiting does not pretend the audio finished");
});

test("whenIdle: stop() releases every waiter", async (t) => {
  const timers = captureTimers(t);
  const { player } = makePlayer();
  player.push(bytes(1600));
  player.endUtterance();

  const a = timers.during(() => player.whenIdle(2_000));
  const b = timers.during(() => player.whenIdle(2_000));
  assert.equal(await state(a), "pending");
  assert.equal(await state(b), "pending");

  player.stop();
  assert.equal(await state(a), "resolved");
  assert.equal(await state(b), "resolved");
  assert.deepEqual(timers.cleared, timers.created);
});

test("whenIdle: waits for the audio streaming in AFTER the last mark too", async (t) => {
  const timers = captureTimers(t);
  const { player } = makePlayer();
  player.push(bytes(320));
  const first = player.endUtterance();
  player.push(bytes(320)); // unmarked audio queued behind the first mark

  const p = timers.during(() => player.whenIdle(2_000));
  player.onMark(first);
  assert.equal(await state(p), "pending", "the second utterance is still playing");
  const second = player.endUtterance();
  player.onMark(second);
  assert.equal(await state(p), "resolved");
});

// ── Failure containment ─────────────────────────────────────────────────────

test("a failing sendJson surfaces to the caller, and the audio after it continues in place (nothing replayed)", () => {
  const sent = [];
  let failNext = false;
  const player = createFastPlayer({
    sendJson: (message) => {
      if (failNext) {
        failNext = false;
        throw new Error("twilio socket closed");
      }
      sent.push(message);
    },
    streamSid: STREAM_SID,
    now: () => 0,
  });

  player.push(bytes(100, 0)); // held
  failNext = true;
  assert.throws(() => player.push(bytes(100, 100)), /twilio socket closed/); // frame 0..159 cannot be sent and is lost
  player.push(bytes(160, 200));
  assert.deepEqual(frames(sent), [bytes(160, 160)], "the next frame starts right after the lost one, with no replay of bytes 0..99");
});
