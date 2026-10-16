"use strict";

/**
 * SCRUM-594: clause-level first chunk in services/claude-chat.js.
 *
 * `chunking: "clause"` lets the FIRST spoken chunk of a reply end at a clause
 * boundary (one of , ; : em dash en dash, followed by whitespace, once the chunk
 * holds 3 words) so TTS can start before the first full sentence exists. Later
 * chunks stay sentence-sized.
 *
 * ConversationRelay also calls streamClaudeResponse, so the DEFAULT mode is
 * pinned two ways: hand-written expectations, and a differential test against a
 * verbatim copy of the pre-change algorithm over many texts and delta splits.
 *
 * What the model streams is mocked at the network edge (globalThis.fetch) with
 * SSE built from real Anthropic event shapes; the segmentation sweeps drive the
 * same pure reducers parseClaudeStream uses.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { streamClaudeResponse, _test } = require("../services/claude-chat");
const { ev, textTurnEvents, toolTurnEvents, sseResponse, withFakeFetch, installGatedFetch, waitUntil } = require("./anthropic-sse-helpers");

const { makeStreamState, handleClaudeEvent, finalizeClaude } = _test;

const savedKey = process.env.ANTHROPIC_API_KEY;
before(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});
after(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

const MESSAGES = [
  { role: "system", content: "You are a receptionist." },
  { role: "user", content: "When do you open?" },
];
const TOOLS = [{ type: "function", function: { name: "check_availability", description: "d", parameters: { type: "object", properties: {} } } }];

// ---- oracle: the chunking algorithm exactly as it was before SCRUM-594 --------

const LEGACY_SENTENCE_BREAK = /(?<=[.!?؟،。！？])\s+/;
function legacyFlush(buffer, out) {
  const parts = buffer.split(LEGACY_SENTENCE_BREAK);
  while (parts.length > 1) {
    const sentence = parts.shift();
    if (sentence.trim()) out.push(sentence.trim());
  }
  return parts[0];
}
/** Chunks the old code emitted for these deltas. A tool turn never flushed its tail. */
function legacyChunks(deltas, { toolCalls = false } = {}) {
  const out = [];
  let buffer = "";
  for (const d of deltas) buffer = legacyFlush(buffer + d, out);
  if (!toolCalls && buffer.trim()) out.push(buffer.trim());
  return out;
}

// ---- helpers ------------------------------------------------------------------

/** Feed text deltas through the reducers exactly as parseClaudeStream does. */
function reduce(deltas, { chunking, tool = false } = {}) {
  const state = makeStreamState(chunking);
  const chunks = [];
  const onSentence = (s) => chunks.push(s);
  for (const d of deltas) handleClaudeEvent(state, ev.textDelta(d), onSentence);
  if (tool) {
    handleClaudeEvent(state, ev.toolStart(1, "toolu_1", "check_availability"));
    handleClaudeEvent(state, ev.toolDelta(1, "{}"));
  }
  const result = finalizeClaude(state, onSentence);
  return { chunks, result };
}

const whole = (text) => [text];
const perChar = (text) => [...text];
const perWord = (text) => text.match(/\S+\s*|\s+/g) ?? [];
/** Every way to cut the text into two deltas. */
function twoWay(text) {
  const out = [];
  for (let i = 1; i < text.length; i++) out.push([text.slice(0, i), text.slice(i)]);
  return out;
}
/** Deterministic random cuts (mulberry32), so a failure reproduces. */
function randomCuts(text, seed, runs) {
  let a = seed;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  for (let r = 0; r < runs; r++) {
    const cuts = new Set();
    const n = 2 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) cuts.add(1 + Math.floor(rand() * Math.max(text.length - 1, 1)));
    const sorted = [...cuts].filter((c) => c < text.length).sort((x, y) => x - y);
    const pieces = [];
    let prev = 0;
    for (const c of sorted) {
      pieces.push(text.slice(prev, c));
      prev = c;
    }
    pieces.push(text.slice(prev));
    out.push(pieces);
  }
  return out;
}
function segmentations(text) {
  return [whole(text), perChar(text), perWord(text), ...twoWay(text), ...randomCuts(text, 594, 12)];
}

// ---- table: [name, text, expected clause-mode chunks] ---------------------------

const EM = "—";
const EN = "–";
const CLAUSE_CASES = [
  ["breaks at the first clause once it has 3+ words", "Let me check that for you, one moment please.", ["Let me check that for you,", "one moment please."]],
  ["exactly three words is enough", "I can help, and more.", ["I can help,", "and more."]],
  ["two words is not enough (no early break)", "I can, help you now.", ["I can, help you now."]],
  ["skips a too-short clause and takes the next qualifying one", "Yes, sure, absolutely, I can do that.", ["Yes, sure, absolutely,", "I can do that."]],
  ["semicolon", "Here is what I found; we open at nine.", ["Here is what I found;", "we open at nine."]],
  ["colon followed by whitespace", "These are the options: morning or afternoon.", ["These are the options:", "morning or afternoon."]],
  ["spaced em dash", `Let me check ${EM} one moment please.`, [`Let me check ${EM}`, "one moment please."]],
  ["spaced en dash", `Let me check ${EN} one moment please.`, [`Let me check ${EN}`, "one moment please."]],
  ["an unspaced dash is not a boundary", `Hold on${EM}let me check, one moment.`, [`Hold on${EM}let me check,`, "one moment."]],
  [
    "9:30 and 1,500 are never split",
    "Your appointment is at 9:30 on Thursday, and the fee is 1,500 dollars.",
    ["Your appointment is at 9:30 on Thursday,", "and the fee is 1,500 dollars."],
  ],
  ["nothing to split stays one chunk", "It costs 1,500 or 9:30 sharp", ["It costs 1,500 or 9:30 sharp"]],
  ["a sentence break still wins when it comes first", "Yes. Okay, I can help you with that.", ["Yes.", "Okay, I can help you with that."]],
  [
    "a sentence break wins even when a LATER clause would have 3+ words",
    "Yes. Sure thing, I can help you.",
    ["Yes.", "Sure thing, I can help you."],
  ],
  [
    "later chunks are sentence-sized",
    "Sure, I can help with that, no problem at all. We open at nine, close at five, and the clinic is on Main Street. Anything else?",
    ["Sure, I can help with that,", "no problem at all.", "We open at nine, close at five, and the clinic is on Main Street.", "Anything else?"],
  ],
  ["a bare dash does not count as a word", `Well ${EM} okay, fine.`, [`Well ${EM} okay, fine.`]],
  ["a newline after the comma is whitespace", "Okay so sure,\nI can help.", ["Okay so sure,", "I can help."]],
  ["Arabic sentence punctuation is unchanged", "مرحبا بكم، كيف أساعدك؟ شكرا", ["مرحبا بكم،", "كيف أساعدك؟", "شكرا"]],
  ["leading whitespace is trimmed", "  Sure thing, I can help, no problem.", ["Sure thing, I can help,", "no problem."]],
  ["a short reply with no punctuation", "Nine is good", ["Nine is good"]],
  [
    "no chunk ends after the abbreviation Dr.",
    "Dr. Smith is in on Thursday, if you like.",
    ["Dr. Smith is in on Thursday,", "if you like."],
  ],
  [
    "no chunk ends after the abbreviation a.m.",
    "We can come at 9 a.m. tomorrow, does that suit?",
    ["We can come at 9 a.m. tomorrow,", "does that suit?"],
  ],
  [
    "an opening bracket or quote does not hide an abbreviation",
    'Pick a time (e.g. morning), or say "Dr. Lee" please.',
    ["Pick a time (e.g. morning),", 'or say "Dr. Lee" please.'],
  ],
  ["an abbreviation at the very end of a reply is still spoken", "We close at 5 p.m. ", ["We close at 5 p.m."]],
  ["a trailing clause with nothing after it", "Ends with a comma and space, ", ["Ends with a comma and space,"]],
];

describe("clause chunking: where the first chunk ends", () => {
  for (const [name, text, expected] of CLAUSE_CASES) {
    it(`${name}`, () => {
      const { chunks, result } = reduce(whole(text), { chunking: "clause" });
      assert.deepEqual(chunks, expected);
      assert.equal(result.content, text, "the returned content is the model's text, untouched by chunking");
    });
  }

  it("the same chunks come out however the deltas are cut (whole, per char, per word, every 2-way cut, seeded random cuts)", () => {
    for (const [name, text, expected] of CLAUSE_CASES) {
      for (const deltas of segmentations(text)) {
        const { chunks, result } = reduce(deltas, { chunking: "clause" });
        assert.deepEqual(chunks, expected, `${name}: deltas ${JSON.stringify(deltas)}`);
        assert.equal(result.content, text);
      }
    }
  });

  it("does not break before the third word, however the deltas arrive", () => {
    // "Sure," is one word and "Sure thing," two: no clause chunk may be emitted yet.
    for (const deltas of [["Sure, I"], ["Sure,", " I"], ["Sure th", "ing, I", " can"]]) {
      const state = makeStreamState("clause");
      const seen = [];
      for (const d of deltas) handleClaudeEvent(state, ev.textDelta(d), (s) => seen.push(s));
      assert.deepEqual(seen, [], `nothing may be spoken yet for ${JSON.stringify(deltas)}`);
    }
  });

  it("waits for the whitespace after the punctuation: 'at 9:' then '30', '1,' then '500' never split", () => {
    const { chunks } = reduce(["It costs 1,", "500 or 9:", "30 sharp"], { chunking: "clause" });
    assert.deepEqual(chunks, ["It costs 1,500 or 9:30 sharp"]);
  });

  it("emits the clause as soon as the whitespace after it arrives, not at the end of the reply", () => {
    const state = makeStreamState("clause");
    const seen = [];
    handleClaudeEvent(state, ev.textDelta("Let me check that for you,"), (s) => seen.push(s));
    assert.deepEqual(seen, [], "the comma is the last character: it could still be a thousands separator");
    handleClaudeEvent(state, ev.textDelta(" one"), (s) => seen.push(s));
    assert.deepEqual(seen, ["Let me check that for you,"]);
  });

  it("only the FIRST chunk may end at a clause boundary (a second clause in the same reply stays whole)", () => {
    const { chunks } = reduce(["Sure, I can help with that, no problem. We open at nine, close at five, and the clinic is open."], { chunking: "clause" });
    assert.equal(chunks.length, 3);
    assert.equal(chunks[2], "We open at nine, close at five, and the clinic is open.");
  });
});

describe("clause mode: an abbreviation is not the end of a chunk", () => {
  const ABBREVIATIONS = ["a.m.", "p.m.", "Dr.", "Mr.", "Mrs.", "Ms.", "St.", "e.g.", "i.e."];
  const forms = (abbr) => [...new Set([abbr, abbr.toUpperCase(), abbr.toLowerCase(), abbr[0].toUpperCase() + abbr.slice(1).toLowerCase()])];

  for (const abbr of ABBREVIATIONS) {
    it(`${abbr} in any case, followed by a space, does not end a chunk; the default mode still splits there`, () => {
      for (const form of forms(abbr)) {
        const text = `Please ask ${form} Lee about it. Thanks.`;
        assert.deepEqual(reduce(whole(text), { chunking: "clause" }).chunks, [`Please ask ${form} Lee about it.`, "Thanks."], form);
        // Default mode is the old behaviour: it does end a chunk right after the abbreviation.
        assert.deepEqual(reduce(whole(text), {}).chunks, [`Please ask ${form}`, "Lee about it.", "Thanks."], form);
        assert.deepEqual(reduce(whole(text), {}).chunks, legacyChunks(whole(text)), form);
      }
    });
  }

  it("a word that merely ENDS like an abbreviation is still a sentence end", () => {
    assert.deepEqual(reduce(whole("We were fast. Then slow."), { chunking: "clause" }).chunks, ["We were fast.", "Then slow."]);
    assert.deepEqual(reduce(whole("I met Madr. Then left."), { chunking: "clause" }).chunks, ["I met Madr.", "Then left."]);
    assert.deepEqual(reduce(whole("They gave alms. Then left."), { chunking: "clause" }).chunks, ["They gave alms.", "Then left."]);
  });

  it("the abbreviation guard applies to later chunks as well, not only the first", () => {
    const text = "Sure. Dr. Smith will see you at 9 a.m. tomorrow. Anything else?";
    assert.deepEqual(reduce(whole(text), { chunking: "clause" }).chunks, ["Sure.", "Dr. Smith will see you at 9 a.m. tomorrow.", "Anything else?"]);
  });

  it("the same chunks come out however the deltas are cut, with the abbreviation split across deltas too", () => {
    const text = "Dr. Smith will see you at 9 a.m. tomorrow, e.g. after lunch. Thanks.";
    const expected = reduce(whole(text), { chunking: "clause" }).chunks;
    assert.deepEqual(expected, ["Dr. Smith will see you at 9 a.m. tomorrow,", "e.g. after lunch.", "Thanks."]);
    for (const deltas of segmentations(text)) {
      assert.deepEqual(reduce(deltas, { chunking: "clause" }).chunks, expected, JSON.stringify(deltas));
    }
  });
});

describe("default mode is byte-identical to the pre-SCRUM-594 behaviour (ConversationRelay depends on it)", () => {
  it("chunks match a verbatim copy of the old algorithm for every text and every delta split", () => {
    const extraTexts = [
      "Sure thing. I can book that for you. What time works?",
      "Hello there, how are you today; I hope you are well: thanks for calling — one moment please.",
      "Wait – let me check that, one second.",
      "A, B, C, and D.",
      "  leading space. Then more  text here. ",
      "No punctuation at all here",
      "Yes.",
    ];
    const texts = [...CLAUSE_CASES.map(([, text]) => text), ...extraTexts];
    for (const text of texts) {
      for (const deltas of segmentations(text)) {
        for (const chunking of [undefined, null]) {
          const { chunks, result } = reduce(deltas, { chunking });
          assert.deepEqual(chunks, legacyChunks(deltas), `text ${JSON.stringify(text)} deltas ${JSON.stringify(deltas)}`);
          assert.equal(result.content, text);
        }
      }
    }
  });

  it("the first chunk is still the whole first sentence (clause punctuation is ignored)", () => {
    assert.deepEqual(reduce(whole("Let me check that for you, one moment please."), {}).chunks, ["Let me check that for you, one moment please."]);
    assert.deepEqual(reduce(whole("I can help, and more. Next."), {}).chunks, ["I can help, and more.", "Next."]);
  });

  it("a tool turn: whatever the old code did not flush before returning tool_calls is still not flushed", () => {
    // PINNED CURRENT BEHAVIOUR: the unterminated tail before a tool_use block is dropped
    // in default mode, and ConversationRelay depends on that, so changing it is a
    // deliberate decision rather than a side effect. Clause mode speaks it (tested below).
    for (const text of ["Let me check that for you", "Let me check that for you.", "Sure. Let me check that for you."]) {
      for (const deltas of segmentations(text)) {
        const { chunks, result } = reduce(deltas, { tool: true });
        assert.deepEqual(chunks, legacyChunks(deltas, { toolCalls: true }), `text ${JSON.stringify(text)}`);
        assert.equal(result.type, "tool_calls");
      }
    }
    assert.deepEqual(reduce(whole("Let me check that for you"), { tool: true }).chunks, []);
    assert.deepEqual(reduce(whole("Let me check that for you."), { tool: true }).chunks, []);
    assert.deepEqual(reduce(whole("Sure. Let me check that for you."), { tool: true }).chunks, ["Sure."]);
  });

  it("makeStreamState() with no argument is the default mode", () => {
    const state = makeStreamState();
    const out = [];
    handleClaudeEvent(state, ev.textDelta("Hello there, friend. More"), (s) => out.push(s));
    assert.deepEqual(out, ["Hello there, friend."]);
  });

  it("an empty reply still throws 'no content'", () => {
    assert.throws(() => finalizeClaude(makeStreamState("clause")), /no content/);
    assert.throws(() => finalizeClaude(makeStreamState()), /no content/);
  });
});

describe("buffered text with no sentence break is spoken, not dropped", () => {
  it("end of content, either mode: the unterminated remainder is emitted through onSentence", () => {
    for (const chunking of [undefined, "clause"]) {
      assert.deepEqual(reduce(whole("Nine is good"), { chunking }).chunks, ["Nine is good"], `chunking=${chunking}`);
      assert.deepEqual(reduce(whole("We open at nine."), { chunking }).chunks, ["We open at nine."], `chunking=${chunking}`);
      assert.deepEqual(reduce(["Yes. Nine is", " good"], { chunking }).chunks, ["Yes.", "Nine is good"], `chunking=${chunking}`);
    }
  });

  it("clause mode: a preamble with NO final punctuation is emitted before tool_calls is returned", () => {
    const { chunks, result } = reduce(whole("Let me check that for you"), { chunking: "clause", tool: true });
    assert.deepEqual(chunks, ["Let me check that for you"]);
    assert.equal(result.type, "tool_calls");
    assert.equal(result.message.content, "Let me check that for you", "the transcript record is unchanged");
  });

  it("clause mode: a final sentence that has its period but no trailing whitespace is emitted too", () => {
    // A text block ends right after the period, so SENTENCE_BREAK (which needs whitespace) never fires.
    assert.deepEqual(reduce(whole("Let me check that for you."), { chunking: "clause", tool: true }).chunks, ["Let me check that for you."]);
    assert.deepEqual(reduce(whole("Sure. Let me check that for you."), { chunking: "clause", tool: true }).chunks, ["Sure.", "Let me check that for you."]);
  });

  it("clause mode: the preamble is clause-chunked like any first chunk, and the rest is flushed before tool_calls", () => {
    assert.deepEqual(
      reduce(whole("Let me check that for you, one moment"), { chunking: "clause", tool: true }).chunks,
      ["Let me check that for you,", "one moment"],
    );
  });

  it("clause mode: no preamble, or a whitespace-only one, emits nothing before tool_calls", () => {
    assert.deepEqual(reduce([], { chunking: "clause", tool: true }).chunks, []);
    assert.deepEqual(reduce(whole("   "), { chunking: "clause", tool: true }).chunks, []);
  });

  it("the tail is emitted BEFORE finalizeClaude returns the tool_calls result", () => {
    const state = makeStreamState("clause");
    const order = [];
    handleClaudeEvent(state, ev.textDelta("Let me check"), (s) => order.push(`emit:${s}`));
    handleClaudeEvent(state, ev.toolStart(1, "toolu_1", "check_availability"));
    const result = finalizeClaude(state, (s) => order.push(`emit:${s}`));
    order.push(`return:${result.type}`);
    assert.deepEqual(order, ["emit:Let me check", "return:tool_calls"]);
  });

  it("no onSentence: collect-all mode neither speaks nor throws, in both modes", () => {
    for (const chunking of [undefined, "clause"]) {
      const state = makeStreamState(chunking);
      handleClaudeEvent(state, ev.textDelta("Let me check that for you, one moment"), undefined);
      const result = finalizeClaude(state, undefined);
      assert.equal(result.content, "Let me check that for you, one moment");
    }
  });
});

describe("streamClaudeResponse: the chunking option over real SSE and the request it sends", () => {
  it("clause mode chunks a streamed reply, with SSE lines and multi-byte characters split across network chunks", async (t) => {
    const text = `Sure thing, I can help ${EM} no problem at all. Anything else?`;
    withFakeFetch(t, () => sseResponse(textTurnEvents(text.match(/\S+\s*/g)), { byteChunk: 7 }));
    const chunks = [];
    const result = await streamClaudeResponse(MESSAGES, { chunking: "clause", onSentence: (s) => chunks.push(s) });
    assert.deepEqual(chunks, [`Sure thing, I can help ${EM}`, "no problem at all.", "Anything else?"]);
    assert.deepEqual(result, { type: "content", content: text });
  });

  it("default mode over the same stream is the old behaviour", async (t) => {
    const text = `Sure thing, I can help ${EM} no problem at all. Anything else?`;
    const deltas = text.match(/\S+\s*/g);
    withFakeFetch(t, () => sseResponse(textTurnEvents(deltas), { byteChunk: 7 }));
    const chunks = [];
    const result = await streamClaudeResponse(MESSAGES, { onSentence: (s) => chunks.push(s) });
    assert.deepEqual(chunks, legacyChunks(deltas));
    assert.deepEqual(chunks, [`Sure thing, I can help ${EM} no problem at all.`, "Anything else?"]);
    assert.equal(result.content, text);
  });

  it("chunking: undefined and chunking: null behave exactly like omitting it", async (t) => {
    const deltas = ["Let me check that for you, ", "one moment please. ", "Done."];
    const runs = [];
    for (const opts of [{}, { chunking: undefined }, { chunking: null }]) {
      withFakeFetch(t, () => sseResponse(textTurnEvents(deltas)));
      const chunks = [];
      await streamClaudeResponse(MESSAGES, { ...opts, onSentence: (s) => chunks.push(s) });
      runs.push(chunks);
    }
    assert.deepEqual(runs[0], ["Let me check that for you, one moment please.", "Done."]);
    assert.deepEqual(runs[1], runs[0]);
    assert.deepEqual(runs[2], runs[0]);
  });

  it("the Anthropic request is identical with and without chunking (the option never reaches the wire)", async (t) => {
    const bodies = [];
    for (const chunking of [undefined, "clause"]) {
      const calls = withFakeFetch(t, () => sseResponse(textTurnEvents(["Hello there."])));
      await streamClaudeResponse(MESSAGES, { tools: TOOLS, chunking, onSentence: () => {} });
      assert.equal(calls.length, 1);
      bodies.push(calls[0].init.body);
      assert.equal("chunking" in calls[0].body, false);
    }
    assert.equal(bodies[0], bodies[1], "byte-identical request bodies");
  });

  it("an unknown chunking mode is rejected before any request is made", async (t) => {
    const calls = withFakeFetch(t, () => sseResponse(textTurnEvents(["Hello."])));
    for (const bad of ["clauses", "sentence", "", 1, true]) {
      await assert.rejects(streamClaudeResponse(MESSAGES, { chunking: bad }), /unknown chunking mode/);
    }
    assert.equal(calls.length, 0);
  });

  it("a tool turn in clause mode speaks the preamble, returns the tool call intact, and sends it once", async (t) => {
    const calls = withFakeFetch(t, () =>
      sseResponse(toolTurnEvents({ preamble: ["Let me check", " that for you"], json: ['{"date":', '"2026-10-20"}'] }), { byteChunk: 11 }),
    );
    const chunks = [];
    const result = await streamClaudeResponse(MESSAGES, { tools: TOOLS, chunking: "clause", onSentence: (s) => chunks.push(s) });
    assert.deepEqual(chunks, ["Let me check that for you"]);
    assert.equal(result.type, "tool_calls");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, "check_availability");
    assert.equal(result.toolCalls[0].function.arguments, '{"date":"2026-10-20"}');
    assert.equal(result.message.content, "Let me check that for you");
    assert.equal(calls.length, 1);
  });

  it("the same tool turn in default mode: the old behaviour (the unterminated preamble is not spoken)", async (t) => {
    // PINNED CURRENT BEHAVIOUR for ConversationRelay; flipping it is a deliberate decision, not a side effect.
    withFakeFetch(t, () => sseResponse(toolTurnEvents({ preamble: ["Let me check", " that for you"] })));
    const chunks = [];
    const result = await streamClaudeResponse(MESSAGES, { tools: TOOLS, onSentence: (s) => chunks.push(s) });
    assert.deepEqual(chunks, []);
    assert.equal(result.type, "tool_calls");
  });

  it("aborting mid-stream in clause mode rejects with AbortError; chunks already spoken stay spoken, nothing more is", async (t) => {
    const net = installGatedFetch(t);
    const ctl = new AbortController();
    const chunks = [];
    const pending = streamClaudeResponse(MESSAGES, { chunking: "clause", signal: ctl.signal, onSentence: (s) => chunks.push(s) });
    // Observe the rejection from the start so it can never be reported as unhandled.
    const outcome = pending.then(
      () => ({ rejected: false }),
      (err) => ({ rejected: true, name: err.name }),
    );
    try {
      await net.called;
      net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Let me check that for you, one")]);
      await waitUntil(() => chunks.length === 1, "the first clause chunk");
      ctl.abort();
      net.push([ev.textDelta(" moment please. Done. ")]);
      assert.deepEqual(await outcome, { rejected: true, name: "AbortError" });
      assert.deepEqual(chunks, ["Let me check that for you,"]);
    } finally {
      ctl.abort(); // a failing assertion must not leave the stream open
    }
  });
});
