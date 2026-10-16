"use strict";

/**
 * SCRUM-594 (Task 3): lib/fast-turns.js, the Flux turn engine (spec 4.6).
 *
 * The engine is a pure state machine: Flux TurnInfo events go in, calls on six
 * injected actions come out. Nothing here needs a mock of anything real: a
 * recorder stands in for the session, `live` is the session state the test owns
 * (flip it between events to let time pass), and every expectation is a
 * hand-written list of calls, in order, with their arguments.
 *
 * Layout
 *   1. the rules of spec 4.6 as a table
 *   2. what the table cannot express: one handling per turn, barge-in timing,
 *      speculation off, throwing actions, reset(), wiring contracts
 *   3. INTERRUPT_RE and wordCount, and their parity with the classic echo rule
 *   4. recorded Flux streams (flux-aura-api.md A.11) replayed end to end
 *   5. purity: no clock, timers, console or imports
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createFastTurnEngine, INTERRUPT_RE, wordCount } = require("../lib/fast-turns");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A TurnInfo exactly as services/flux-stt.js delivers it to onTurnInfo. */
const ev = (event, turnIndex, transcript, trigger = "model") => ({
  event,
  turnIndex,
  transcript,
  eotConfidence: 0.5,
  trigger: event === "EndOfTurn" ? trigger : null,
});

/** A step that lets time pass: change what the session reports before the next event. */
const set = (patch) => ({ set: patch });

const IDLE = { aiSpeaking: false, processing: false, expectedInputType: "general" };
const SPEAKING = { aiSpeaking: true };
const PROCESSING = { processing: true };
const BUSY = { aiSpeaking: true, processing: true };

const ACTION_NAMES = ["speculate", "cancelSpeculation", "commit", "bargeIn", "dropEcho", "bufferStructured"];

/**
 * An engine wired to a recorder. `calls` is every action call in order, as
 * [name, ...args]. `overrides` replace single actions (a thrower, an absent one).
 */
function harness({ state = {}, speculationEnabled, actions: overrides = {} } = {}) {
  const calls = [];
  const live = { ...IDLE, ...state };
  const actions = {};
  for (const name of ACTION_NAMES) {
    actions[name] = (...args) => {
      calls.push([name, ...args]);
    };
  }
  Object.assign(actions, overrides);
  const options = { getState: () => ({ ...live }), actions };
  if (speculationEnabled !== undefined) options.speculationEnabled = speculationEnabled;
  const engine = createFastTurnEngine(options);
  /** Events go to the engine; { set } steps change the live session state. */
  const feed = (...steps) => {
    for (const step of steps) {
      if ("set" in step) Object.assign(live, step.set);
      else engine.onTurnInfo(step);
    }
    return calls;
  };
  return { engine, calls, live, feed };
}

// One input type per structured kind CallSession can expect, with something a caller would say.
const STRUCTURED = [
  ["phone", "zero four one two"],
  ["email", "michael at gmail dot com"],
  ["name", "M I C H A E L"],
  ["address", "twelve smith street"],
  ["date_time", "next tuesday at ten"],
];

// One phrase per alternative of the classic regex. Each is two words or fewer, so
// the interrupt rule (and not the word count) is what lets it through.
const INTERRUPTS = ["stop", "Wait.", "Hold on.", "No.", "Cancel", "Nevermind.", "Never mind.", "Excuse me?", "Hello?", "Hey!"];

// Short things callers say that are NOT interruptions: near misses of the words
// ("Nope" is not "no"), and an interrupt word that is not first.
const NOT_INTERRUPTS = ["Nope.", "Nothing.", "Stopped.", "Waiting.", "Cancellation", "Heyyy", "Holding on", "Not now", "Okay, wait", "um stop"];

// ---------------------------------------------------------------------------
// 1. Spec 4.6, rule by rule
// ---------------------------------------------------------------------------

const RULES = [
  // ---- Rule 1: ignore empty transcripts ----
  { rule: 1, name: "an empty EndOfTurn commits nothing", steps: [ev("EndOfTurn", 0, "")], want: [] },
  { rule: 1, name: "a whitespace-only EndOfTurn commits nothing", steps: [ev("EndOfTurn", 0, " \n\t ")], want: [] },
  { rule: 1, name: "an empty EagerEndOfTurn starts no draft", steps: [ev("EagerEndOfTurn", 0, "")], want: [] },
  {
    rule: 1,
    name: "an ignored empty EndOfTurn does not use the turn up: the real one still commits",
    steps: [ev("EndOfTurn", 2, ""), ev("EndOfTurn", 2, "yes please")],
    want: [["commit", "yes please", 2, "model"]],
  },
  {
    rule: 1,
    name: "an empty StartOfTurn or Update never barges in",
    state: SPEAKING,
    steps: [ev("StartOfTurn", 1, ""), ev("Update", 1, "   ")],
    want: [],
  },
  {
    rule: 1,
    name: "an empty TurnResumed still cancels: it is not transcript-driven, and a dead draft must not linger",
    steps: [ev("EagerEndOfTurn", 0, "book me in"), ev("TurnResumed", 0, "")],
    want: [["speculate", "book me in", 0], ["cancelSpeculation", "resumed"]],
  },

  // ---- Rule 2: a new turn cancels any draft from another turn ----
  {
    rule: 2,
    name: "StartOfTurn for a new turnIndex cancels the old draft",
    steps: [ev("EagerEndOfTurn", 1, "book me in"), ev("StartOfTurn", 2, "hi")],
    want: [["speculate", "book me in", 1], ["cancelSpeculation", "new-turn"]],
  },
  {
    rule: 2,
    name: "events of the draft's own turn leave it alone",
    steps: [ev("EagerEndOfTurn", 1, "book me in"), ev("Update", 1, "book me in"), ev("Update", 1, "book me in")],
    want: [["speculate", "book me in", 1]],
  },
  {
    rule: 2,
    name: "EndOfTurn for a different turnIndex cancels the old draft, then commits",
    steps: [ev("EagerEndOfTurn", 1, "book me in"), ev("EndOfTurn", 2, "yes")],
    want: [["speculate", "book me in", 1], ["cancelSpeculation", "new-turn"], ["commit", "yes", 2, "model"]],
  },
  {
    rule: 2,
    name: "EagerEndOfTurn for a new turn cancels the old draft BEFORE starting the new one (a late cancel would kill the new draft)",
    steps: [ev("EagerEndOfTurn", 1, "book me in"), ev("EagerEndOfTurn", 2, "yes please")],
    want: [["speculate", "book me in", 1], ["cancelSpeculation", "new-turn"], ["speculate", "yes please", 2]],
  },
  {
    rule: 2,
    name: "the first Update of a new turn cancels the old draft too (the StartOfTurn was missed)",
    steps: [ev("EagerEndOfTurn", 1, "book me in"), ev("Update", 2, "yes")],
    want: [["speculate", "book me in", 1], ["cancelSpeculation", "new-turn"]],
  },
  {
    rule: 2,
    name: "a cancelled draft is forgotten: later turns do not cancel it again",
    steps: [ev("EagerEndOfTurn", 1, "book me in"), ev("StartOfTurn", 2, "hi"), ev("StartOfTurn", 3, "hello")],
    want: [["speculate", "book me in", 1], ["cancelSpeculation", "new-turn"]],
  },
  {
    rule: 2,
    name: "no draft, nothing to cancel: a new turn alone makes no call",
    steps: [ev("StartOfTurn", 1, "hi"), ev("StartOfTurn", 2, "hello")],
    want: [],
  },

  // ---- Rule 3: barge-in, once per turn ----
  {
    rule: 3,
    name: "while the AI speaks, the first Update to reach 3 words barges in, once",
    state: SPEAKING,
    steps: [
      ev("StartOfTurn", 0, "Yeah."),
      ev("Update", 0, "Yeah. Morning"),
      ev("Update", 0, "Yeah. Morning is good"),
      ev("Update", 0, "Yeah. Morning is good."),
      ev("Update", 0, "Yeah. Morning is good. Maybe"),
    ],
    want: [["bargeIn"]],
  },
  {
    rule: 3,
    name: "2 words are not enough to interrupt",
    state: SPEAKING,
    steps: [ev("StartOfTurn", 0, "Yeah."), ev("Update", 0, "Yeah. Morning")],
    want: [],
  },
  { rule: 3, name: "3 words are enough (boundary)", state: SPEAKING, steps: [ev("Update", 0, "one two three")], want: [["bargeIn"]] },
  {
    rule: 3,
    name: "StartOfTurn can barge in when its first decode already has 3 words",
    state: SPEAKING,
    steps: [ev("StartOfTurn", 0, "I need to")],
    want: [["bargeIn"]],
  },
  {
    rule: 3,
    name: "while the AI is still processing (not yet speaking), barging in aborts the turn in flight",
    state: PROCESSING,
    steps: [ev("Update", 0, "actually can you")],
    want: [["bargeIn"]],
  },
  {
    rule: 3,
    name: "an idle line: a long Update is just the caller talking",
    steps: [ev("StartOfTurn", 0, "I would like to book"), ev("Update", 0, "I would like to book a table for four")],
    want: [],
  },
  {
    rule: 3,
    name: "each turn barges in once: the next turn barges in again",
    state: SPEAKING,
    steps: [
      ev("Update", 0, "I need to"),
      ev("Update", 0, "I need to change"),
      ev("EndOfTurn", 0, "I need to change it."),
      ev("Update", 1, "and also my"),
      ev("Update", 1, "and also my number"),
    ],
    want: [["bargeIn"], ["commit", "I need to change it.", 0, "model"], ["bargeIn"]],
  },
  {
    rule: 3,
    name: "once per turnIndex, not once per quiet spell: speaking, idle, speaking again inside one turn is still one barge-in",
    steps: [set(SPEAKING), ev("StartOfTurn", 4, "stop"), set({ aiSpeaking: false }), set(SPEAKING), ev("Update", 4, "stop it right now")],
    want: [["bargeIn"]],
  },
  {
    rule: 3,
    name: "only Update and StartOfTurn barge in: EagerEndOfTurn makes no call while speaking",
    state: SPEAKING,
    steps: [ev("EagerEndOfTurn", 0, "I need to change that")],
    want: [],
  },
  {
    rule: 3,
    name: "only Update and StartOfTurn barge in: TurnResumed only cancels",
    state: SPEAKING,
    steps: [ev("TurnResumed", 0, "I need to change that now")],
    want: [["cancelSpeculation", "resumed"]],
  },
  {
    rule: 3,
    name: "only Update and StartOfTurn barge in: a substantial EndOfTurn commits without barging in",
    state: SPEAKING,
    steps: [ev("EndOfTurn", 0, "I need to change that.")],
    want: [["commit", "I need to change that.", 0, "model"]],
  },
  { rule: 3, name: "an interrupt word is recognised after trimming", state: SPEAKING, steps: [ev("StartOfTurn", 0, "  stop ")], want: [["bargeIn"]] },
  ...INTERRUPTS.map((said) => ({
    rule: 3,
    name: `interrupt phrase ${JSON.stringify(said)} barges in at StartOfTurn though it is under 3 words`,
    state: SPEAKING,
    steps: [ev("StartOfTurn", 0, said)],
    want: [["bargeIn"]],
  })),
  ...NOT_INTERRUPTS.map((said) => ({
    rule: 3,
    name: `${JSON.stringify(said)} is not an interruption`,
    state: SPEAKING,
    steps: [ev("StartOfTurn", 0, said), ev("Update", 0, said)],
    want: [],
  })),

  // ---- Rule 4: EagerEndOfTurn starts a draft ----
  { rule: 4, name: "an idle line with general input: EagerEndOfTurn starts a draft", steps: [ev("EagerEndOfTurn", 7, "book me in")], want: [["speculate", "book me in", 7]] },
  { rule: 4, name: "no draft while the AI is speaking", state: SPEAKING, steps: [ev("EagerEndOfTurn", 7, "book me in")], want: [] },
  { rule: 4, name: "no draft while the AI is still processing the previous turn", state: PROCESSING, steps: [ev("EagerEndOfTurn", 7, "book me in")], want: [] },
  { rule: 4, name: "no draft while the AI is both speaking and processing", state: BUSY, steps: [ev("EagerEndOfTurn", 7, "book me in")], want: [] },
  ...STRUCTURED.map(([type, said]) => ({
    rule: 4,
    name: `no draft while the AI expects "${type}" input`,
    state: { expectedInputType: type },
    steps: [ev("EagerEndOfTurn", 7, said)],
    want: [],
  })),
  {
    rule: 4,
    name: "a missing expectedInputType means general, as in CallSession",
    state: { expectedInputType: undefined },
    steps: [ev("EagerEndOfTurn", 7, "book me in")],
    want: [["speculate", "book me in", 7]],
  },
  {
    rule: 4,
    name: "speculation off: EagerEndOfTurn makes no call at all",
    speculationEnabled: false,
    steps: [ev("EagerEndOfTurn", 7, "book me in")],
    want: [],
  },
  {
    rule: 4,
    name: "the session state is read when the event arrives, not captured at construction",
    steps: [ev("EagerEndOfTurn", 0, "book me in"), set(SPEAKING), ev("EagerEndOfTurn", 1, "yes please")],
    want: [["speculate", "book me in", 0], ["cancelSpeculation", "new-turn"]],
  },

  // ---- Rule 5: TurnResumed cancels ----
  {
    rule: 5,
    name: "TurnResumed cancels the draft",
    steps: [ev("EagerEndOfTurn", 0, "book me in"), ev("TurnResumed", 0, "book me in on")],
    want: [["speculate", "book me in", 0], ["cancelSpeculation", "resumed"]],
  },
  {
    rule: 5,
    name: "TurnResumed asks for the cancel even with no draft of ours (the session treats it as a no-op)",
    steps: [ev("TurnResumed", 0, "book me in on")],
    want: [["cancelSpeculation", "resumed"]],
  },
  {
    rule: 5,
    name: "a draft cancelled by TurnResumed is forgotten: the next turn does not cancel it again",
    steps: [ev("EagerEndOfTurn", 0, "book me in"), ev("TurnResumed", 0, "book me in on"), ev("StartOfTurn", 1, "hi")],
    want: [["speculate", "book me in", 0], ["cancelSpeculation", "resumed"]],
  },
  {
    rule: 5,
    name: "after TurnResumed, the next EagerEndOfTurn of the same turn drafts again",
    steps: [ev("EagerEndOfTurn", 0, "book me in"), ev("TurnResumed", 0, "book me in on"), ev("EagerEndOfTurn", 0, "book me in on friday")],
    want: [["speculate", "book me in", 0], ["cancelSpeculation", "resumed"], ["speculate", "book me in on friday", 0]],
  },
  { rule: 5, name: "speculation off: TurnResumed makes no call", speculationEnabled: false, steps: [ev("TurnResumed", 0, "book me in on")], want: [] },

  // ---- Rule 6: EndOfTurn: echo drop, structured buffering, commit ----
  {
    rule: 6,
    name: "speaking + 1 word: dropped as echo, and the draft cancelled",
    state: SPEAKING,
    steps: [ev("EndOfTurn", 3, "Okay.")],
    want: [["dropEcho", "Okay."], ["cancelSpeculation", "echo"]],
  },
  {
    rule: 6,
    name: "speaking + 2 words: dropped (boundary)",
    state: SPEAKING,
    steps: [ev("EndOfTurn", 3, "Thank you.")],
    want: [["dropEcho", "Thank you."], ["cancelSpeculation", "echo"]],
  },
  {
    rule: 6,
    name: "speaking + 3 words: committed (boundary)",
    state: SPEAKING,
    steps: [ev("EndOfTurn", 3, "Thank you so")],
    want: [["commit", "Thank you so", 3, "model"]],
  },
  {
    rule: 6,
    name: "speaking and processing + 1 word: dropped",
    state: BUSY,
    steps: [ev("EndOfTurn", 3, "Yes.")],
    want: [["dropEcho", "Yes."], ["cancelSpeculation", "echo"]],
  },
  {
    rule: 6,
    name: "the echo rule is for a speaking AI only: an idle line commits 1 word",
    steps: [ev("EndOfTurn", 3, "Okay.")],
    want: [["commit", "Okay.", 3, "model"]],
  },
  {
    rule: 6,
    name: "processing is not speaking: a short answer to a busy AI still commits (CallSession queues it)",
    state: PROCESSING,
    steps: [ev("EndOfTurn", 3, "Yes.")],
    want: [["commit", "Yes.", 3, "model"]],
  },
  {
    rule: 6,
    name: "processing + a long answer commits too",
    state: PROCESSING,
    steps: [ev("EndOfTurn", 3, "yes that works for me")],
    want: [["commit", "yes that works for me", 3, "model"]],
  },
  {
    rule: 6,
    name: "an interrupt word is exempt from the echo drop, also after trimming",
    state: SPEAKING,
    steps: [ev("EndOfTurn", 3, "  Stop. ")],
    want: [["commit", "Stop.", 3, "model"]],
  },
  ...INTERRUPTS.map((said) => ({
    rule: 6,
    name: `speaking: interrupt phrase ${JSON.stringify(said)} is committed, not dropped`,
    state: SPEAKING,
    steps: [ev("EndOfTurn", 9, said)],
    want: [["commit", said, 9, "model"]],
  })),
  ...NOT_INTERRUPTS.map((said) => ({
    rule: 6,
    name: `speaking: ${JSON.stringify(said)} is not an interrupt phrase, so it is dropped as echo`,
    state: SPEAKING,
    steps: [ev("EndOfTurn", 9, said)],
    want: [["dropEcho", said], ["cancelSpeculation", "echo"]],
  })),
  ...STRUCTURED.map(([type, said]) => ({
    rule: 6,
    name: `expectedInputType "${type}": cancel the draft, then hand the words to bufferStructured`,
    state: { expectedInputType: type },
    steps: [ev("EndOfTurn", 4, said)],
    want: [["cancelSpeculation", "structured"], ["bufferStructured", said]],
  })),
  {
    rule: 6,
    name: "the echo drop wins over a structured type: 2 words while the AI speaks are dropped",
    state: { aiSpeaking: true, expectedInputType: "phone" },
    steps: [ev("EndOfTurn", 4, "zero four")],
    want: [["dropEcho", "zero four"], ["cancelSpeculation", "echo"]],
  },
  {
    rule: 6,
    name: "4 words of digits while the AI speaks are structured input, not echo",
    state: { aiSpeaking: true, expectedInputType: "phone" },
    steps: [ev("EndOfTurn", 4, "zero four one two")],
    want: [["cancelSpeculation", "structured"], ["bufferStructured", "zero four one two"]],
  },
  {
    rule: 6,
    name: "structured input cancels a draft made before the expected type changed",
    steps: [ev("EagerEndOfTurn", 1, "zero four one"), set({ expectedInputType: "phone" }), ev("EndOfTurn", 1, "zero four one")],
    want: [["speculate", "zero four one", 1], ["cancelSpeculation", "structured"], ["bufferStructured", "zero four one"]],
  },
  {
    rule: 6,
    name: "an echo drop cancels a draft made before the AI started speaking",
    steps: [ev("EagerEndOfTurn", 1, "yes"), set(SPEAKING), ev("EndOfTurn", 1, "yes")],
    want: [["speculate", "yes", 1], ["dropEcho", "yes"], ["cancelSpeculation", "echo"]],
  },
  {
    rule: 6,
    name: "speculation off: structured input is buffered with no cancel",
    speculationEnabled: false,
    state: { expectedInputType: "phone" },
    steps: [ev("EndOfTurn", 4, "zero four one two")],
    want: [["bufferStructured", "zero four one two"]],
  },
  {
    rule: 6,
    name: "a general EndOfTurn commits with its turnIndex and trigger",
    steps: [ev("EndOfTurn", 12, "book me in", "model")],
    want: [["commit", "book me in", 12, "model"]],
  },
  ...["manual", "timeout", "some-future-trigger"].map((trigger) => ({
    rule: 6,
    name: `the commit carries trigger ${JSON.stringify(trigger)} unchanged (an open enum)`,
    steps: [ev("EndOfTurn", 12, "book me in", trigger)],
    want: [["commit", "book me in", 12, trigger]],
  })),
  {
    rule: 6,
    name: "an EndOfTurn without a trigger commits with null",
    steps: [{ event: "EndOfTurn", turnIndex: 12, transcript: "book me in" }],
    want: [["commit", "book me in", 12, null]],
  },
  {
    rule: 6,
    name: "a commit hands the matching draft over: the engine does not cancel it",
    steps: [ev("EagerEndOfTurn", 0, "book me in"), ev("EndOfTurn", 0, "book me in")],
    want: [["speculate", "book me in", 0], ["commit", "book me in", 0, "model"]],
  },
  {
    rule: 6,
    name: "a commit hands the draft over for good: the next turn does not cancel it (that would abort the reply being generated)",
    steps: [ev("EagerEndOfTurn", 0, "book me in"), ev("EndOfTurn", 0, "book me in"), ev("StartOfTurn", 1, "hi")],
    want: [["speculate", "book me in", 0], ["commit", "book me in", 0, "model"]],
  },
  {
    rule: 6,
    name: "actions get the trimmed transcript, and eager and final get the identical string (isAdoptable compares with ===)",
    steps: [ev("EagerEndOfTurn", 0, " book me in "), ev("EndOfTurn", 0, "book me in  ")],
    want: [["speculate", "book me in", 0], ["commit", "book me in", 0, "model"]],
  },
];

describe("spec 4.6, rule by rule", () => {
  for (const row of RULES) {
    it(`rule ${row.rule}: ${row.name}`, () => {
      const h = harness({ state: row.state, speculationEnabled: row.speculationEnabled });
      h.feed(...row.steps);
      assert.deepEqual(h.calls, row.want);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. What the table cannot express
// ---------------------------------------------------------------------------

describe("a turn is handled once", () => {
  it("a late duplicate EndOfTurn does not commit twice", () => {
    const h = harness();
    h.feed(ev("EndOfTurn", 3, "book me in on friday"), ev("EndOfTurn", 3, "book me in on friday"));
    assert.deepEqual(h.calls, [["commit", "book me in on friday", 3, "model"]]);
  });

  it("... nor drop the same echo twice", () => {
    const h = harness({ state: SPEAKING });
    h.feed(ev("EndOfTurn", 3, "okay"), ev("EndOfTurn", 3, "okay"));
    assert.deepEqual(h.calls, [["dropEcho", "okay"], ["cancelSpeculation", "echo"]]);
  });

  it("... nor buffer structured input twice (a phone number would be doubled)", () => {
    const h = harness({ state: { expectedInputType: "phone" } });
    h.feed(ev("EndOfTurn", 3, "zero four one two"), ev("EndOfTurn", 3, "zero four one two"));
    assert.deepEqual(h.calls, [["cancelSpeculation", "structured"], ["bufferStructured", "zero four one two"]]);
  });

  it("a second EndOfTurn of the same turn with different words is stale too: the first one wins", () => {
    const h = harness();
    h.feed(ev("EndOfTurn", 3, "yes"), ev("EndOfTurn", 3, "no"));
    assert.deepEqual(h.calls, [["commit", "yes", 3, "model"]]);
  });

  it("an EndOfTurn for an earlier turn than one that already ended is stale", () => {
    const h = harness();
    h.feed(ev("EndOfTurn", 5, "yes please"), ev("EndOfTurn", 4, "no thanks"));
    assert.deepEqual(h.calls, [["commit", "yes please", 5, "model"]]);
  });

  it("the next turn is not affected by the one that ended", () => {
    const h = harness();
    h.feed(ev("EndOfTurn", 5, "yes please"), ev("EndOfTurn", 6, "no thanks"));
    assert.deepEqual(h.calls, [["commit", "yes please", 5, "model"], ["commit", "no thanks", 6, "model"]]);
  });

  it("late events of an ended turn do nothing: a straggler cannot cut off the AI's reply to that very turn", () => {
    const h = harness();
    h.feed(
      ev("EndOfTurn", 5, "book me in on friday"),
      set(PROCESSING),
      ev("StartOfTurn", 5, "book me in on"),
      ev("Update", 5, "book me in on friday please"),
      set({ processing: false }),
      ev("EagerEndOfTurn", 5, "book me in on friday"),
      ev("TurnResumed", 5, "book me in on friday please"),
    );
    assert.deepEqual(h.calls, [["commit", "book me in on friday", 5, "model"]]);
  });
});

describe("barge-in timing", () => {
  it("fires on the first Update that reaches 3 words: not before, not after", () => {
    const h = harness({ state: SPEAKING });
    const callsAfterEach = [];
    for (const step of [
      ev("StartOfTurn", 0, "Yeah."),
      ev("Update", 0, "Yeah. Morning"),
      ev("Update", 0, "Yeah. Morning is good"),
      ev("Update", 0, "Yeah. Morning is good."),
    ]) {
      h.feed(step);
      callsAfterEach.push(h.calls.length);
    }
    assert.deepEqual(callsAfterEach, [0, 0, 1, 1]);
    assert.deepEqual(h.calls, [["bargeIn"]]);
  });
});

describe("speculation off", () => {
  it("never calls speculate or cancelSpeculation on any path, and does not need them", () => {
    const h = harness({ speculationEnabled: false, actions: { speculate: undefined, cancelSpeculation: undefined } });
    h.feed(
      ev("EagerEndOfTurn", 0, "book me in"),
      ev("TurnResumed", 0, "book me in on"),
      ev("EagerEndOfTurn", 0, "book me in on friday"),
      ev("EndOfTurn", 0, "book me in on friday"),
      ev("StartOfTurn", 1, "yes"),
      set(SPEAKING),
      ev("EndOfTurn", 1, "yes"),
      set({ aiSpeaking: false, expectedInputType: "phone" }),
      ev("EndOfTurn", 2, "zero four one two"),
      set({ expectedInputType: "general" }),
      ev("StartOfTurn", 3, "wait"),
    );
    h.engine.reset();
    assert.deepEqual(h.calls, [
      ["commit", "book me in on friday", 0, "model"],
      ["dropEcho", "yes"],
      ["bufferStructured", "zero four one two"],
    ]);
  });

  it("is on by default", () => {
    const calls = [];
    const record = (name) => (...args) => calls.push([name, ...args]);
    const engine = createFastTurnEngine({
      getState: () => ({ ...IDLE }),
      actions: Object.fromEntries(ACTION_NAMES.map((name) => [name, record(name)])),
    });
    engine.onTurnInfo(ev("EagerEndOfTurn", 0, "book me in"));
    assert.deepEqual(calls, [["speculate", "book me in", 0]]);
  });
});

describe("an action that throws", () => {
  it("surfaces to the caller, and a duplicate EndOfTurn does not retry the commit", () => {
    let attempts = 0;
    const h = harness({
      actions: {
        commit() {
          attempts += 1;
          throw new Error("boom");
        },
      },
    });
    assert.throws(() => h.feed(ev("EndOfTurn", 3, "book me in")), /boom/);
    h.feed(ev("EndOfTurn", 3, "book me in"));
    assert.equal(attempts, 1);
  });

  it("a barge-in that throws is not retried by the next Update of the same turn", () => {
    let attempts = 0;
    const h = harness({
      state: SPEAKING,
      actions: {
        bargeIn() {
          attempts += 1;
          throw new Error("boom");
        },
      },
    });
    assert.throws(() => h.feed(ev("Update", 4, "stop it right now")), /boom/);
    h.feed(ev("Update", 4, "stop it right now please"));
    assert.equal(attempts, 1);
  });

  it("a speculate that throws may have left a draft: the engine still cancels it when the turn moves on", () => {
    const h = harness({
      actions: {
        speculate() {
          throw new Error("boom");
        },
      },
    });
    assert.throws(() => h.feed(ev("EagerEndOfTurn", 1, "book me in")), /boom/);
    h.feed(ev("StartOfTurn", 2, "hi"));
    assert.deepEqual(h.calls, [["cancelSpeculation", "new-turn"]]);
  });
});

describe("reset()", () => {
  it("makes the turn indexes of a new Flux connection (they restart at 0) new turns again", () => {
    const h = harness();
    h.feed(ev("EndOfTurn", 0, "hello there"));
    h.engine.reset();
    h.feed(ev("EndOfTurn", 0, "hello again"));
    assert.deepEqual(h.calls, [["commit", "hello there", 0, "model"], ["commit", "hello again", 0, "model"]]);
  });

  it("re-arms barge-in for a turn index it had already used", () => {
    const h = harness({ state: SPEAKING });
    h.feed(ev("StartOfTurn", 0, "stop"));
    h.engine.reset();
    h.feed(ev("StartOfTurn", 0, "stop"));
    assert.deepEqual(h.calls, [["bargeIn"], ["bargeIn"]]);
  });

  it("cancels a draft it still holds, once", () => {
    const h = harness();
    h.feed(ev("EagerEndOfTurn", 1, "book me in"));
    h.engine.reset();
    h.engine.reset();
    h.feed(ev("StartOfTurn", 2, "hi"));
    assert.deepEqual(h.calls, [["speculate", "book me in", 1], ["cancelSpeculation", "reset"]]);
  });

  it("makes no call when it holds no draft", () => {
    const h = harness();
    h.feed(ev("EndOfTurn", 0, "hello there"));
    h.engine.reset();
    assert.deepEqual(h.calls, [["commit", "hello there", 0, "model"]]);
  });
});

describe("wiring contracts", () => {
  it("onTurnInfo and reset work detached from the engine (they are handed around as callbacks)", () => {
    const calls = [];
    const engine = createFastTurnEngine({
      getState: () => ({ ...IDLE }),
      actions: Object.fromEntries(ACTION_NAMES.map((name) => [name, (...args) => calls.push([name, ...args])])),
    });
    const { onTurnInfo, reset } = engine;
    onTurnInfo(ev("EagerEndOfTurn", 0, "book me in"));
    reset();
    assert.deepEqual(calls, [["speculate", "book me in", 0], ["cancelSpeculation", "reset"]]);
  });

  it("calls the actions as methods of the object it was given, so a class instance works", () => {
    class Recorder {
      constructor() {
        this.calls = [];
      }
      speculate(...args) {
        this.calls.push(["speculate", ...args]);
      }
      cancelSpeculation(...args) {
        this.calls.push(["cancelSpeculation", ...args]);
      }
      commit(...args) {
        this.calls.push(["commit", ...args]);
      }
      bargeIn(...args) {
        this.calls.push(["bargeIn", ...args]);
      }
      dropEcho(...args) {
        this.calls.push(["dropEcho", ...args]);
      }
      bufferStructured(...args) {
        this.calls.push(["bufferStructured", ...args]);
      }
    }
    const recorder = new Recorder();
    const live = { ...IDLE };
    const engine = createFastTurnEngine({ getState: () => ({ ...live }), actions: recorder });
    // One pass that reaches all six actions.
    engine.onTurnInfo(ev("EagerEndOfTurn", 0, "book me in"));
    live.aiSpeaking = true;
    engine.onTurnInfo(ev("StartOfTurn", 1, "stop"));
    engine.onTurnInfo(ev("EndOfTurn", 1, "stop"));
    engine.onTurnInfo(ev("EndOfTurn", 2, "okay"));
    live.aiSpeaking = false;
    live.expectedInputType = "phone";
    engine.onTurnInfo(ev("EndOfTurn", 3, "zero four one two"));
    assert.deepEqual(recorder.calls, [
      ["speculate", "book me in", 0],
      ["cancelSpeculation", "new-turn"],
      ["bargeIn"],
      ["commit", "stop", 1, "model"],
      ["dropEcho", "okay"],
      ["cancelSpeculation", "echo"],
      ["cancelSpeculation", "structured"],
      ["bufferStructured", "zero four one two"],
    ]);
  });

  it("ignores events it cannot read, without throwing, and they leave a held draft alone", () => {
    // A draft is held and the AI is busy, so any event that WAS read would cancel the
    // draft (it is for another turn) or barge in (4 words).
    const h = harness();
    h.feed(ev("EagerEndOfTurn", 1, "book me in"), set(BUSY));
    const unreadable = [
      undefined,
      null,
      5,
      "Update",
      {},
      { event: "Update", transcript: "a b c d" },
      { event: "Update", turnIndex: "2", transcript: "a b c d" },
      { event: "Update", turnIndex: Number.NaN, transcript: "a b c d" },
      { event: "Update", turnIndex: 2.5, transcript: "a b c d" },
      { event: "Connected", turnIndex: 2, transcript: "a b c d" },
      { event: "Update", turnIndex: 2, transcript: undefined },
      { event: "Update", turnIndex: 2, transcript: 42 },
      { event: "EndOfTurn", turnIndex: 2, transcript: null },
    ];
    for (const evt of unreadable) assert.doesNotThrow(() => h.engine.onTurnInfo(evt));
    assert.deepEqual(h.calls, [["speculate", "book me in", 1]]);
  });
});

describe("construction", () => {
  const getState = () => ({ ...IDLE });
  const noop = () => {};
  const allActions = () => ({ speculate: noop, cancelSpeculation: noop, commit: noop, bargeIn: noop, dropEcho: noop, bufferStructured: noop });

  it("rejects missing options and a getState that is not a function", () => {
    assert.throws(() => createFastTurnEngine(), { name: "TypeError", message: /getState/ });
    assert.throws(() => createFastTurnEngine({ actions: allActions() }), { name: "TypeError", message: /getState/ });
    assert.throws(() => createFastTurnEngine({ getState: {}, actions: allActions() }), { name: "TypeError", message: /getState/ });
  });

  it("rejects missing actions", () => {
    assert.throws(() => createFastTurnEngine({ getState }), { name: "TypeError", message: /actions/ });
  });

  for (const name of ACTION_NAMES) {
    it(`rejects a missing actions.${name}, so a typo fails at construction and not in the middle of a call`, () => {
      const actions = allActions();
      delete actions[name];
      assert.throws(() => createFastTurnEngine({ getState, actions }), { name: "TypeError", message: new RegExp(`actions\\.${name}\\b`) });
    });
  }

  it("does not need speculate or cancelSpeculation when speculation is off", () => {
    const actions = allActions();
    delete actions.speculate;
    delete actions.cancelSpeculation;
    assert.doesNotThrow(() => createFastTurnEngine({ getState, actions, speculationEnabled: false }));
  });

  it("rejects a speculationEnabled that is not a boolean", () => {
    for (const bad of ["yes", 1, null, 0.4]) {
      assert.throws(() => createFastTurnEngine({ getState, actions: allActions(), speculationEnabled: bad }), { name: "TypeError", message: /speculationEnabled/ });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. INTERRUPT_RE and wordCount
// ---------------------------------------------------------------------------

describe("INTERRUPT_RE", () => {
  it("is exactly the classic echo regex: same source, same flags", () => {
    assert.equal(INTERRUPT_RE.source, String.raw`^(stop|wait|hold on|no|cancel|nevermind|never mind|excuse me|hello|hey)\b`);
    assert.equal(INTERRUPT_RE.flags, "i");
  });

  for (const said of [...INTERRUPTS, "STOP", "no, that's wrong", "Hello there"]) {
    it(`matches ${JSON.stringify(said)}`, () => {
      assert.equal(INTERRUPT_RE.test(said), true);
    });
  }

  for (const said of NOT_INTERRUPTS) {
    it(`does not match ${JSON.stringify(said)}`, () => {
      assert.equal(INTERRUPT_RE.test(said), false);
    });
  }
});

describe("wordCount", () => {
  const cases = [
    ["", 0],
    ["   ", 0],
    ["\n\t", 0],
    ["hello", 1],
    ["  hello  ", 1],
    ["a b", 2],
    ["a  b", 2],
    ["a\tb\nc d", 4],
    ["one" + String.fromCharCode(160) + "two", 2], // a no-break space is whitespace to \s, as in the classic split
    ["Yeah. Morning is good.", 4],
    ["zero four one two", 4],
  ];
  for (const [text, expected] of cases) {
    it(`counts ${JSON.stringify(text)} as ${expected}`, () => {
      assert.equal(wordCount(text), expected);
    });
  }

  it("counts anything that is not a string as 0", () => {
    for (const notText of [undefined, null, 5, {}, []]) assert.equal(wordCount(notText), 0);
  });
});

// The classic path (server.js) cannot import the engine's copy, so nothing but this
// test keeps the two rules the same. If one fails: change BOTH places, deliberately.
describe("parity with the classic echo rule in server.js", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  it("every INTERRUPT_RE copy in server.js is the engine's regex", () => {
    const copies = [...server.matchAll(/const (INTERRUPT_RE\w*) = (\/.+\/[a-z]*);/g)];
    assert.ok(copies.length >= 1, "no INTERRUPT_RE literal found in server.js: the classic echo rule moved, update this pin");
    for (const [, name, literal] of copies) {
      const closing = literal.lastIndexOf("/");
      assert.equal(literal.slice(1, closing), INTERRUPT_RE.source, `${name} in server.js has drifted from lib/fast-turns.js`);
      assert.equal(literal.slice(closing + 1), INTERRUPT_RE.flags, `${name} flags in server.js have drifted from lib/fast-turns.js`);
    }
  });

  it("the classic rule drops 2 words or fewer, the threshold the rule table pins for the engine", () => {
    const thresholds = [...server.matchAll(/\.split\(\/\\s\+\/\)\.length <= (\d+) && !INTERRUPT_RE\w*\.test\(/g)];
    assert.ok(thresholds.length >= 1, "no classic word-count check found in server.js: the classic echo rule moved, update this pin");
    for (const [, limit] of thresholds) assert.equal(limit, "2", "the classic echo threshold changed: change ECHO_MAX_WORDS in lib/fast-turns.js and the 2/3-word rows above");
  });
});

// ---------------------------------------------------------------------------
// 4. Recorded Flux streams (flux-aura-api.md A.11) through the whole engine
// ---------------------------------------------------------------------------

describe("recorded Flux streams", () => {
  const T1 = "Yeah. Morning is good. Maybe ten AM is good.";
  const T2 = "Yeah. Morning is good. Maybe ten AM is good. No. I said ten AM.";
  const T3 = "No. I said ten AM.";

  it("run 2: eager, resumed, eager, end: one draft cancelled and one committed", () => {
    const h = harness();
    h.feed(
      ev("Update", 0, ""),
      ev("StartOfTurn", 0, "Yeah."),
      ev("Update", 0, "Yeah. Morning"),
      ev("Update", 0, "Yeah. Morning is good"),
      ev("Update", 0, "Yeah. Morning is good."),
      ev("Update", 0, "Yeah. Morning is good. Maybe ten AM is good"),
      ev("Update", 0, T1),
      ev("EagerEndOfTurn", 0, T1),
      ev("Update", 0, T1),
      ev("Update", 0, T1),
      ev("TurnResumed", 0, "Yeah. Morning is good. Maybe ten AM is good. No"),
      ev("Update", 0, "Yeah. Morning is good. Maybe ten AM is good. No."),
      ev("Update", 0, "Yeah. Morning is good. Maybe ten AM is good. No. I said"),
      ev("Update", 0, "Yeah. Morning is good. Maybe ten AM is good. No. I said ten"),
      ev("Update", 0, T2),
      ev("EagerEndOfTurn", 0, T2),
      ev("Update", 0, T2),
      ev("EndOfTurn", 0, T2, "model"),
      ev("Update", 1, ""),
    );
    assert.deepEqual(h.calls, [
      ["speculate", T1, 0],
      ["cancelSpeculation", "resumed"],
      ["speculate", T2, 0],
      ["commit", T2, 0, "model"],
    ]);
  });

  it("run 1: two turns, the caller talks over the AI's reply to the first", () => {
    const h = harness();
    h.feed(
      ev("StartOfTurn", 0, "Yeah."),
      ev("Update", 0, "Yeah. Morning is good"),
      ev("EagerEndOfTurn", 0, T1),
      ev("Update", 0, T1),
      ev("EndOfTurn", 0, T1, "model"),
      // The AI is now working on turn 0 ...
      set(PROCESSING),
      ev("Update", 1, ""),
      ev("StartOfTurn", 1, "No."),
      ev("Update", 1, "No. I said"),
      ev("Update", 1, "No. I said ten"),
      ev("Update", 1, T3),
      // ... the barge-in aborted it, so the line is quiet again.
      set({ processing: false }),
      ev("EagerEndOfTurn", 1, T3),
      ev("Update", 1, T3),
      ev("EndOfTurn", 1, T3, "model"),
    );
    assert.deepEqual(h.calls, [
      ["speculate", T1, 0],
      ["commit", T1, 0, "model"],
      ["bargeIn"],
      ["speculate", T3, 1],
      ["commit", T3, 1, "model"],
    ]);
  });

  it("a back-channel while the AI speaks is dropped, then a real interruption barges in and is answered", () => {
    const h = harness({ state: SPEAKING });
    h.feed(
      ev("StartOfTurn", 3, "Yeah."),
      ev("Update", 3, "Yeah."),
      ev("EagerEndOfTurn", 3, "Yeah."),
      ev("EndOfTurn", 3, "Yeah."),
      ev("StartOfTurn", 4, "Actually"),
      ev("Update", 4, "Actually I want"),
      set({ aiSpeaking: false }),
      ev("Update", 4, "Actually I want Friday instead"),
      ev("EagerEndOfTurn", 4, "Actually I want Friday instead."),
      ev("EndOfTurn", 4, "Actually I want Friday instead."),
    );
    assert.deepEqual(h.calls, [
      ["dropEcho", "Yeah."],
      ["cancelSpeculation", "echo"],
      ["bargeIn"],
      ["speculate", "Actually I want Friday instead.", 4],
      ["commit", "Actually I want Friday instead.", 4, "model"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Purity
// ---------------------------------------------------------------------------

/** A script that reaches every branch of the engine. */
function runEveryBranch(h) {
  h.feed(
    ev("StartOfTurn", 0, "Yeah."),
    ev("EagerEndOfTurn", 0, "Yeah. Morning is good."),
    ev("TurnResumed", 0, "Yeah. Morning is good. No"),
    ev("EagerEndOfTurn", 0, "Yeah. Morning is good. No."),
    ev("EndOfTurn", 0, "Yeah. Morning is good. No."),
    set(PROCESSING),
    ev("StartOfTurn", 1, "No."),
    set({ processing: false, aiSpeaking: true }),
    ev("EndOfTurn", 1, "Okay."),
    set({ aiSpeaking: false, expectedInputType: "phone" }),
    ev("EndOfTurn", 2, "zero four one two"),
    set({ expectedInputType: "general" }),
    ev("EagerEndOfTurn", 3, "book me in"),
    ev("StartOfTurn", 4, "hello"),
    ev("EndOfTurn", 4, "hello"),
    ev("EndOfTurn", 4, "hello"),
    ev("EagerEndOfTurn", 5, "yes please"),
  );
  h.engine.reset();
}

describe("purity", () => {
  it("the script used below reaches every action and every cancel reason", () => {
    const h = harness();
    runEveryBranch(h);
    assert.deepEqual(new Set(h.calls.map(([name]) => name)), new Set(ACTION_NAMES));
    assert.deepEqual(new Set(h.calls.filter(([name]) => name === "cancelSpeculation").map(([, reason]) => reason)), new Set(["resumed", "new-turn", "echo", "structured", "reset"]));
  });

  it("touches no clock, timer, randomness or console while it runs", () => {
    const targets = [
      [globalThis, "setTimeout"],
      [globalThis, "setInterval"],
      [globalThis, "setImmediate"],
      [globalThis, "queueMicrotask"],
      [Date, "now"],
      [Math, "random"],
      [console, "log"],
      [console, "info"],
      [console, "warn"],
      [console, "error"],
      [console, "debug"],
    ];
    const saved = targets.map(([target, key]) => [target, key, target[key]]);
    const touched = [];
    for (const [target, key] of targets) {
      target[key] = () => {
        touched.push(key);
      };
    }
    try {
      runEveryBranch(harness());
    } finally {
      for (const [target, key, original] of saved) target[key] = original;
    }
    assert.deepEqual(touched, []);
  });

  it("imports nothing and names no global with side effects", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "lib", "fast-turns.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [/\brequire\b/, /\bimport\b/, /\bprocess\b/, /\bconsole\b/, /\bSentry\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bsetImmediate\b/, /\bDate\b/, /\bperformance\b/, /\bfetch\b/, /Math\.random/]) {
      assert.doesNotMatch(code, forbidden);
    }
  });
});
