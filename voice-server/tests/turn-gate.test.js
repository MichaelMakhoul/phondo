// SCRUM-556 — turn-gate unit tests (pure logic, no wasm).
//
// The gate is the safety-critical core of custom VAD: with Gemini's automatic
// detection disabled, these transitions are the ONLY thing that opens and
// closes caller turns. Every rule is pinned: sustained-speech opening, burst
// rejection, noise-floor dominance (background speech at ambient volume must
// never open a turn), hangover, and floor adaptation.

const { test, describe } = require("node:test");
const assert = require("node:assert");

const { TurnGate, customVadEnabled } = require("../lib/turn-gate");

const SPEECH = { prob: 0.9, rms: 4000 };
const SILENCE = { prob: 0.05, rms: 120 };

function pushN(gate, n, { prob, rms }) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const e = gate.push(prob, rms);
    if (e) events.push(e);
  }
  return events;
}

describe("SCRUM-556 — turn gate", () => {
  test("CUSTOM_VAD is DEFAULT OFF and only 'on'/'true'/'1' enable it", () => {
    const prev = process.env.CUSTOM_VAD;
    try {
      delete process.env.CUSTOM_VAD;
      assert.strictEqual(customVadEnabled(), false, "unset must be OFF — this feature ships dark");
      for (const v of ["off", "false", "0", "banana"]) {
        process.env.CUSTOM_VAD = v;
        assert.strictEqual(customVadEnabled(), false, `${v} must be OFF`);
      }
      for (const v of ["on", "true", "1", "ON"]) {
        process.env.CUSTOM_VAD = v;
        assert.strictEqual(customVadEnabled(), true, `${v} must be ON`);
      }
    } finally {
      if (prev === undefined) delete process.env.CUSTOM_VAD;
      else process.env.CUSTOM_VAD = prev;
    }
  });

  test("sustained dominant speech opens a turn after exactly 120ms (12 blocks)", () => {
    const gate = new TurnGate();
    for (let i = 0; i < 11; i++) {
      assert.strictEqual(gate.push(SPEECH.prob, SPEECH.rms), null, `block ${i + 1} must not open yet`);
    }
    assert.strictEqual(gate.push(SPEECH.prob, SPEECH.rms), "start", "12th consecutive block must open the turn");
  });

  test("short bursts never open a turn (door slams, single shouted words)", () => {
    const gate = new TurnGate();
    for (let round = 0; round < 5; round++) {
      assert.deepStrictEqual(pushN(gate, 8, SPEECH), [], "8-block burst must not open");
      assert.deepStrictEqual(pushN(gate, 3, SILENCE), [], "the streak must reset on silence");
    }
  });

  test("dominance gate: speech-like audio at ambient volume never opens — loud direct speech does", () => {
    const gate = new TurnGate();
    // a noisy environment: the floor learns ~1500 from sustained background
    pushN(gate, 300, { prob: 0.2, rms: 1500 });
    assert.ok(gate.floor > 1200, `floor should have adapted up (got ${gate.floor.toFixed(0)})`);
    // background speech (an announcement) at ambient level: high prob, NOT dominant
    assert.deepStrictEqual(
      pushN(gate, 50, { prob: 0.95, rms: 2000 }),
      [],
      "speech below the dominance margin over the floor must never open a turn"
    );
    // the actual caller, close to the mic: clearly above the floor margin
    const events = pushN(gate, 12, { prob: 0.95, rms: 6000 });
    assert.deepStrictEqual(events, ["start"], "dominant speech must open");
  });

  test("quiet room: a quiet caller still opens (absolute minimum, not the margin, binds)", () => {
    const gate = new TurnGate();
    pushN(gate, 200, SILENCE); // floor settles low
    const events = pushN(gate, 12, { prob: 0.9, rms: 400 });
    assert.deepStrictEqual(events, ["start"], "a quiet caller in a quiet room must still open a turn");
  });

  test("hangover: dips shorter than 800ms never close; sustained silence closes exactly once", () => {
    const gate = new TurnGate();
    pushN(gate, 12, SPEECH); // open
    for (let round = 0; round < 4; round++) {
      assert.deepStrictEqual(pushN(gate, 79, SILENCE), [], "79 silent blocks (790ms) must not close");
      assert.deepStrictEqual(pushN(gate, 5, SPEECH), [], "speech resets the close streak");
    }
    const events = pushN(gate, 80, SILENCE);
    assert.deepStrictEqual(events, ["end"], "800ms of sustained silence must close the turn");
  });

  test("the noise floor never learns from speech blocks (long turns can't drag it up)", () => {
    const gate = new TurnGate();
    pushN(gate, 100, SILENCE);
    const floorBefore = gate.floor;
    pushN(gate, 500, SPEECH); // 5s of continuous speech
    assert.ok(
      Math.abs(gate.floor - floorBefore) < 1,
      `floor must not adapt during speech (was ${floorBefore.toFixed(1)}, now ${gate.floor.toFixed(1)})`
    );
  });

  test("full cycle: open → close → re-open works repeatedly with full re-arming", () => {
    // Streak resets at BOTH transitions are load-bearing: each one alone looks
    // redundant, but deleting the pair makes every turn after the first open
    // on a single block (burst rejection gone) or close on a single dip
    // (hangover gone). Pin the exact timing per cycle.
    const gate = new TurnGate();
    for (let i = 0; i < 3; i++) {
      assert.deepStrictEqual(pushN(gate, 11, SPEECH), [], `cycle ${i + 1}: 110ms must not open`);
      assert.deepStrictEqual(pushN(gate, 1, SPEECH), ["start"], `cycle ${i + 1}: block 12 opens`);
      assert.deepStrictEqual(pushN(gate, 79, SILENCE), [], `cycle ${i + 1}: 790ms must not close`);
      assert.deepStrictEqual(pushN(gate, 1, SILENCE), ["end"], `cycle ${i + 1}: 800ms closes`);
    }
  });

  test("a closed gate emits nothing through long silence or ambient noise (no spurious 'end')", () => {
    // An activityEnd with no open activity, sent to a detector-disabled Gemini
    // session, is protocol-undefined — the close logic must be unreachable
    // while the gate is closed.
    const gate = new TurnGate();
    assert.deepStrictEqual(pushN(gate, 400, SILENCE), [], "silence from closed must emit nothing");
    assert.deepStrictEqual(pushN(gate, 400, { prob: 0.2, rms: 1500 }), [], "ambient noise from closed must emit nothing");
  });

  test("each close-condition leg works alone: prob leg (silent caller, loud room) and energy leg (floor-level chatter)", () => {
    // The close disjunct is prob < CLOSE_PROB || rms < floor*1.2 — SILENCE
    // satisfies both legs at once, so either leg could be deleted invisibly
    // without these per-leg pins.
    const probLeg = new TurnGate();
    pushN(probLeg, 12, SPEECH);
    assert.deepStrictEqual(
      pushN(probLeg, 80, { prob: 0.05, rms: 4000 }),
      ["end"],
      "caller stopped speaking in a loud room: the probability leg alone must close"
    );
    const energyLeg = new TurnGate();
    pushN(energyLeg, 12, SPEECH);
    assert.deepStrictEqual(
      pushN(energyLeg, 80, { prob: 0.9, rms: 150 }),
      ["end"],
      "floor-level background chatter: the energy leg alone must close"
    );
  });
});
