const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { noteOwnerWebAudio, ownerWebBargeIn } = require("../lib/owner-web-barge-in");
const { BROWSER_WIDEBAND } = require("../lib/browser-audio");

// SCRUM-618: the owner talking over the assistant in the bubble stops it on the
// classic pipeline, as Gemini's barge-in did. The reply plays in real time
// (8 kHz μ-law, 8 bytes a millisecond) after what was already queued.

function ws() {
  return { readyState: 1, sent: [], send(x) { this.sent.push(JSON.parse(x)); } };
}

describe("noteOwnerWebAudio", () => {
  it("audio plays after what's queued: two seconds then one more second", () => {
    const s = {};
    noteOwnerWebAudio(s, 16_000, 1, 1_000);
    assert.equal(s.webAudioUntil, 3_000);
    noteOwnerWebAudio(s, 8_000, 1, 1_500);
    assert.equal(s.webAudioUntil, 4_000, "queued behind the first, not from now");
    noteOwnerWebAudio(s, 8_000, 2, 10_000);
    assert.equal(s.webAudioUntil, 11_000, "after the queue has played out, from now");
    assert.equal(s.webAudioTurn, 2, "and whose audio is playing");
  });

  it("SCRUM-619: wideband audio is timed at its own rate (48 bytes a millisecond), not the phone's", () => {
    const s = { browserAudio: BROWSER_WIDEBAND };
    noteOwnerWebAudio(s, 96_000, 1, 1_000);
    assert.equal(s.webAudioUntil, 3_000, "two seconds of wideband, not twelve");
  });
});

describe("ownerWebBargeIn", () => {
  it("the owner talking over the reply: the browser drops it, and this turn is marked barged in", () => {
    const s = { webAudioUntil: 5_000, webTurnSeq: 3 };
    const w = ws();
    assert.equal(ownerWebBargeIn(s, w, "no I meant Thursday", 2_000), true);
    assert.deepEqual(w.sent, [{ type: "clear" }]);
    assert.equal(s.webBargeInSeq, 3);
    assert.equal(s.webAudioUntil, 0, "nothing is playing any more");
  });

  it("a stop word on its own barges in; two other words (the speaker's own echo) don't", () => {
    for (const said of ["stop", "Wait", "hold on", "no", "hey"]) {
      const s = { webAudioUntil: 5_000, webTurnSeq: 1 };
      assert.equal(ownerWebBargeIn(s, ws(), said, 2_000), true, said);
    }
    for (const said of ["two jobs", "okay", "", "   "]) {
      const s = { webAudioUntil: 5_000, webTurnSeq: 1 };
      const w = ws();
      assert.equal(ownerWebBargeIn(s, w, said, 2_000), false, JSON.stringify(said));
      assert.deepEqual(w.sent, []);
      assert.equal(s.webBargeInSeq, undefined);
    }
  });

  it("nothing playing (its audio has played out, or none was sent): owner speech is just their next turn", () => {
    for (const until of [undefined, 0, 2_000, 1_999]) {
      const s = { webAudioUntil: until, webTurnSeq: 1 };
      const w = ws();
      assert.equal(ownerWebBargeIn(s, w, "and what about tomorrow then", 2_000), false, String(until));
      assert.deepEqual(w.sent, []);
    }
  });

  // Silent lens (round 2): a barge-in on turn N's tail while turn N+1 thinks must not mute N+1.
  it("the turn marked is the one whose audio is playing — never a newer turn the owner hasn't heard", () => {
    const s = { webAudioUntil: 5_000, webAudioTurn: 4, webTurnSeq: 5 };
    assert.equal(ownerWebBargeIn(s, ws(), "stop that one", 2_000), true);
    assert.equal(s.webBargeInSeq, 4);
  });

  it("a closed socket gets nothing sent, but the turn is still marked (the rest of the reply isn't said)", () => {
    const s = { webAudioUntil: 5_000, webTurnSeq: 2 };
    const w = { readyState: 3, sent: [], send() { throw new Error("must not send on a closed socket"); } };
    assert.equal(ownerWebBargeIn(s, w, "stop please", 2_000), true);
    assert.equal(s.webBargeInSeq, 2);
  });
});
