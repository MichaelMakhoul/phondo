"use strict";

/**
 * SCRUM-594 (Task 2): lib/speculative-reply.js.
 *
 * On Flux's EagerEndOfTurn the fast pipeline starts Claude early as a DRAFT. On
 * the real EndOfTurn it ADOPTS the draft when the caller's words are identical
 * (replaying what was already generated, then streaming the rest) or ABORTS it.
 *
 * The draft runs the real streamClaudeResponse over a mocked network edge
 * (globalThis.fetch with SSE built from real Anthropic event shapes), so what is
 * pinned here is what the phone call will actually do. A few unit cases use a
 * fake `llm` where the point is the draft's own bookkeeping.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { startSpeculativeReply } = require("../lib/speculative-reply");
const { streamClaudeResponse } = require("../services/claude-chat");
const { ev, textTurnEvents, toolTurnEvents, sseResponse, withFakeFetch, installGatedFetch, waitUntil } = require("./anthropic-sse-helpers");

const savedKey = process.env.ANTHROPIC_API_KEY;
before(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});
after(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

const TRANSCRIPT = "Nine is good";
const freshMessages = () => [
  { role: "system", content: "You are the receptionist." },
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Thanks for calling. How can I help?" },
];
const TOOLS = [{ type: "function", function: { name: "check_availability", description: "d", parameters: { type: "object", properties: {} } } }];

/** streamClaudeResponse wrapped so a test sees each chunk the moment the draft buffers it. */
function spyLlm(seen) {
  return (messages, options) =>
    streamClaudeResponse(messages, {
      ...options,
      onSentence: (sentence) => {
        seen.push(sentence);
        options.onSentence(sentence);
      },
    });
}

const start = (overrides = {}) =>
  startSpeculativeReply({ llm: streamClaudeResponse, messages: freshMessages(), transcript: TRANSCRIPT, llmOptions: {}, turnKey: 1, ...overrides });

/** The end of a text reply on the wire. */
const finishText = [ev.blockStop(0), ev.messageDelta("end_turn"), ev.messageStop()];

/** Track unhandled rejections for the duration of one test. */
function trackUnhandled(t) {
  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on("unhandledRejection", handler);
  t.after(() => process.off("unhandledRejection", handler));
  return seen;
}
const turnEventLoop = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("the draft: what it sends and what it leaves alone", () => {
  it("answers [...messages, the eager transcript] on a fresh array and never touches the live conversation", async (t) => {
    const calls = withFakeFetch(t, () => sseResponse(textTurnEvents(["Sure, I can help, ", "no problem."])));
    const messages = freshMessages();
    const snapshot = JSON.parse(JSON.stringify(messages));
    Object.freeze(messages);
    messages.forEach(Object.freeze);

    const draft = start({ messages });
    await waitUntil(() => draft.status() === "done", "the draft to finish");

    assert.deepEqual(messages, snapshot, "messages was not mutated");
    assert.equal(messages.length, 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.system, "You are the receptionist.");
    assert.deepEqual(calls[0].body.messages, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Thanks for calling. How can I help?" },
      { role: "user", content: TRANSCRIPT },
    ]);
  });

  it("passes llmOptions (tools, model, maxTokens) through, and none of chunking/signal/onSentence reach the wire", async (t) => {
    const calls = withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const draft = start({ llmOptions: { tools: TOOLS, model: "claude-haiku-5-5", maxTokens: 321 } });
    await waitUntil(() => draft.status() === "done");
    const body = calls[0].body;
    assert.equal(body.model, "claude-haiku-5-5");
    assert.equal(body.max_tokens, 321);
    assert.equal(body.tools[0].name, "check_availability");
    assert.equal(body.stream, true);
    for (const key of ["chunking", "signal", "onSentence"]) assert.equal(key in body, false, `${key} must not be sent to Anthropic`);
  });

  it("always runs the LLM with clause chunking, its own signal and its own sink, whatever llmOptions says", async () => {
    const received = [];
    const callerSignal = new AbortController().signal;
    const callerSink = () => assert.fail("the caller's onSentence must be replaced");
    const llm = async (_messages, options) => {
      received.push(options);
      return { type: "content", content: "ok" };
    };
    const draft = start({ llm, llmOptions: { chunking: "sentence", signal: callerSignal, onSentence: callerSink, tools: TOOLS } });
    await waitUntil(() => draft.status() === "done");
    assert.equal(received.length, 1);
    assert.equal(received[0].chunking, "clause");
    assert.notEqual(received[0].signal, callerSignal);
    assert.equal(received[0].signal instanceof AbortSignal, true);
    assert.notEqual(received[0].onSentence, callerSink);
    assert.equal(received[0].tools, TOOLS, "other options pass through untouched");
  });

  it("the first chunk is clause-sized: the draft starts the voice before the first full sentence exists", async (t) => {
    const net = installGatedFetch(t);
    const seen = [];
    const draft = start({ llm: spyLlm(seen) });
    await net.called;
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Let me check that for you, one moment")]);
    await waitUntil(() => seen.length === 1, "the clause chunk");
    assert.deepEqual(seen, ["Let me check that for you,"]);
    draft.abort("test-cleanup");
  });

  it("exposes turnKey and transcript, and its methods work detached from the handle", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const messages = freshMessages();
    const draft = start({ messages, turnKey: "turn-7" });
    assert.equal(draft.turnKey, "turn-7");
    assert.equal(draft.transcript, TRANSCRIPT);
    const { status, isAdoptable, abort } = draft; // no `this`: callers pass these around as callbacks
    await waitUntil(() => status() === "done");
    assert.equal(isAdoptable(messages, TRANSCRIPT), true);
    abort("cleanup");
    assert.equal(status(), "aborted");
  });

  it("rejects bad input up front, as a TypeError", () => {
    const base = { llm: async () => ({}), messages: freshMessages(), transcript: TRANSCRIPT, llmOptions: {}, turnKey: 1 };
    assert.throws(() => startSpeculativeReply(undefined), TypeError);
    assert.throws(() => startSpeculativeReply({ ...base, llm: undefined }), TypeError);
    assert.throws(() => startSpeculativeReply({ ...base, messages: "nope" }), TypeError);
    assert.throws(() => startSpeculativeReply({ ...base, messages: undefined }), TypeError);
    assert.throws(() => startSpeculativeReply({ ...base, transcript: "" }), TypeError);
    assert.throws(() => startSpeculativeReply({ ...base, transcript: "   " }), TypeError);
    assert.throws(() => startSpeculativeReply({ ...base, transcript: undefined }), TypeError);
    assert.throws(() => startSpeculativeReply({ ...base, transcript: 42 }), TypeError);
  });

  it("a synchronous throw from llm becomes a failed draft, not a crash in the caller", async (t) => {
    t.mock.method(console, "warn", () => {});
    const unhandled = trackUnhandled(t);
    const messages = freshMessages();
    const draft = start({
      messages,
      llm: () => {
        throw new Error("sync boom");
      },
    });
    await waitUntil(() => draft.status() === "done");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
    await assert.rejects(draft.adopt(() => {}), /sync boom/);
    await turnEventLoop();
    assert.deepEqual(unhandled, []);
  });
});

describe("adopt(): replay what is buffered, then stream the rest", () => {
  it("replays the buffered chunks in order and SYNCHRONOUSLY, then forwards live ones", async (t) => {
    const net = installGatedFetch(t);
    const seen = [];
    const draft = start({ llm: spyLlm(seen), turnKey: 3 });
    await net.called;
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Sure, I can help, no problem. See you")]);
    await waitUntil(() => seen.length === 2, "two buffered chunks");
    assert.equal(draft.status(), "running");

    const spoken = [];
    const outcome = draft.adopt((sentence) => spoken.push(sentence));
    // Delivered before adopt() returned control: no await has happened since the call.
    assert.deepEqual(spoken, ["Sure, I can help,", "no problem."]);
    assert.equal(draft.status(), "adopted");

    net.push([ev.textDelta(" at nine tomorrow. Bye")]);
    await waitUntil(() => spoken.length === 3, "a live chunk");
    assert.equal(spoken[2], "See you at nine tomorrow.", "live chunks follow the replay, never before it");

    net.push(finishText);
    net.end();
    const result = await outcome;
    assert.deepEqual(spoken, ["Sure, I can help,", "no problem.", "See you at nine tomorrow.", "Bye"]);
    assert.deepEqual(result, { type: "content", content: "Sure, I can help, no problem. See you at nine tomorrow. Bye" });
    assert.equal(draft.status(), "adopted");
  });

  it("adopting a draft that already finished replays everything at once and resolves with the result", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Sure, I can help, no problem. ", "See you at nine."])));
    const draft = start();
    await waitUntil(() => draft.status() === "done");

    const spoken = [];
    const outcome = draft.adopt((s) => spoken.push(s));
    assert.deepEqual(spoken, ["Sure, I can help,", "no problem.", "See you at nine."], "all replayed synchronously");
    assert.deepEqual(await outcome, { type: "content", content: "Sure, I can help, no problem. See you at nine." });
  });

  it("adopting before the model has said anything streams everything live", async (t) => {
    const net = installGatedFetch(t);
    const draft = start();
    await net.called;
    const spoken = [];
    const outcome = draft.adopt((s) => spoken.push(s));
    assert.deepEqual(spoken, []);
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Okay so sure, I can help.")]);
    net.push(finishText);
    net.end();
    const result = await outcome;
    assert.deepEqual(spoken, ["Okay so sure,", "I can help."]);
    assert.equal(result.type, "content");
  });

  it("can be called once: a second adopt() rejects and replays nothing", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const draft = start();
    await waitUntil(() => draft.status() === "done");
    const first = [];
    await draft.adopt((s) => first.push(s));
    const second = [];
    await assert.rejects(draft.adopt((s) => second.push(s)), /adopted once/);
    assert.deepEqual(first, ["Fine."]);
    assert.deepEqual(second, []);
  });

  it("adopt() without a function rejects with TypeError and leaves the draft adoptable", async (t) => {
    const net = installGatedFetch(t);
    const messages = freshMessages();
    const draft = start({ messages });
    await net.called;
    await assert.rejects(draft.adopt(undefined), TypeError);
    await assert.rejects(draft.adopt("speak"), TypeError);
    assert.equal(draft.status(), "running");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), true);
    const spoken = [];
    const outcome = draft.adopt((s) => spoken.push(s));
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Fine."), ...finishText]);
    net.end();
    assert.equal((await outcome).type, "content");
    assert.deepEqual(spoken, ["Fine."]);
  });

  it("the sink throwing during the replay: adopt() rejects with that error, replay stops, the connection is released", async (t) => {
    const net = installGatedFetch(t);
    const seen = [];
    const messages = freshMessages();
    const draft = start({ llm: spyLlm(seen), messages });
    await net.called;
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Sure, I can help, no problem. See")]);
    await waitUntil(() => seen.length === 2);

    const boom = new Error("tts socket closed");
    const spoken = [];
    await assert.rejects(
      draft.adopt((s) => {
        spoken.push(s);
        throw boom;
      }),
      (err) => err === boom,
    );
    assert.deepEqual(spoken, ["Sure, I can help,"], "no chunk is handed over after the sink failed");
    assert.equal(net.signal.aborted, true, "the stream is cancelled so the connection is not left open");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
  });

  it("the sink throwing on a live chunk: adopt() rejects with that error and the stream is cancelled", async (t) => {
    const net = installGatedFetch(t);
    const draft = start();
    await net.called;
    const boom = new Error("tts socket closed");
    const spoken = [];
    const outcome = draft.adopt((s) => {
      spoken.push(s);
      if (spoken.length === 2) throw boom;
    });
    const settled = outcome.then(
      () => ({ ok: true }),
      (err) => ({ ok: false, err }),
    );
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("First one. Second one. Third one. Fourth")]);
    const verdict = await settled;
    assert.equal(verdict.ok, false);
    assert.equal(verdict.err, boom);
    assert.deepEqual(spoken, ["First one.", "Second one."], "nothing is delivered after the failing chunk");
    assert.equal(net.signal.aborted, true);
  });

  it("a sink that aborts the draft during the replay stops the replay; adopt() resolves aborted", async (t) => {
    const net = installGatedFetch(t);
    const seen = [];
    const draft = start({ llm: spyLlm(seen) });
    await net.called;
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Sure, I can help, no problem. See")]);
    await waitUntil(() => seen.length === 2);
    const spoken = [];
    const result = await draft.adopt((s) => {
      spoken.push(s);
      draft.abort("barge-in");
    });
    assert.deepEqual(spoken, ["Sure, I can help,"]);
    assert.deepEqual(result, { type: "aborted" });
  });
});

describe("abort outranks a sink failure (R1: an abort never makes adopt() reject)", () => {
  it("a sink that aborts the draft and then throws: adopt() resolves aborted", async (t) => {
    const net = installGatedFetch(t);
    const seen = [];
    const draft = start({ llm: spyLlm(seen) });
    await net.called;
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Sure, I can help, no problem. See")]);
    await waitUntil(() => seen.length === 2);
    const result = await draft.adopt(() => {
      draft.abort("barge-in");
      throw new Error("socket closed");
    });
    assert.deepEqual(result, { type: "aborted" });
  });

  it("a live sink that aborts the draft and then throws: adopt() resolves aborted", async (t) => {
    const net = installGatedFetch(t);
    const draft = start();
    await net.called;
    const outcome = draft.adopt(() => {
      draft.abort("barge-in");
      throw new Error("socket closed");
    });
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("First one. Second one. ")]);
    assert.deepEqual(await outcome, { type: "aborted" });
  });
});

describe("a tool_calls result is stored, never executed", () => {
  it("is held until adoption, handed over untouched, and no second request is made", async (t) => {
    const calls = withFakeFetch(t, () =>
      sseResponse(toolTurnEvents({ preamble: ["Let me check that for you"], json: ['{"date":', '"2026-10-20"}'] })),
    );
    const executeToolCall = t.mock.fn(async () => ({ result: "executed" }));
    const messages = freshMessages();
    const draft = start({ messages, llmOptions: { tools: TOOLS, executeToolCall } });
    await waitUntil(() => draft.status() === "done");

    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), true);
    assert.equal(executeToolCall.mock.callCount(), 0, "the draft never runs a tool");
    assert.equal(calls.length, 1, "the draft does not call the model again with a tool result");
    assert.equal(messages.length, 3, "and does not append the assistant/tool messages");

    const spoken = [];
    const result = await draft.adopt((s) => spoken.push(s));
    assert.deepEqual(spoken, ["Let me check that for you"], "the preamble before the tool call is not lost");
    assert.equal(result.type, "tool_calls");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, "check_availability");
    assert.equal(result.toolCalls[0].function.arguments, '{"date":"2026-10-20"}');
    assert.equal(result.message.role, "assistant");
    assert.equal(executeToolCall.mock.callCount(), 0);
    assert.equal(calls.length, 1);
  });
});

describe("abort(): stops the fetch through the signal, and an aborted draft stays silent", () => {
  it("mid-stream: the request signal aborts, buffered chunks are dropped, adopt() resolves {type:'aborted'}", async (t) => {
    const unhandled = trackUnhandled(t);
    const net = installGatedFetch(t);
    const seen = [];
    const messages = freshMessages();
    const draft = start({ llm: spyLlm(seen), messages });
    await net.called;
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Sure, I can help, no problem. See")]);
    await waitUntil(() => seen.length === 2);
    assert.equal(net.signal.aborted, false);

    draft.abort("resumed");
    assert.equal(net.signal.aborted, true, "the draft's controller is the signal streamClaudeResponse handed to fetch");
    assert.equal(draft.status(), "aborted");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
    assert.equal(net.push([ev.textDelta(" ignored by the client")]), false, "the aborted body takes no more bytes, like a real connection");

    const spoken = [];
    const result = await draft.adopt((s) => spoken.push(s));
    assert.deepEqual(result, { type: "aborted" }, "R1: adopt() after an abort resolves aborted, it never rejects");
    assert.deepEqual(spoken, [], "an aborted draft is never replayed");
    await turnEventLoop();
    assert.deepEqual(unhandled, []);
  });

  it("before the response headers arrive: fetch is cancelled and nothing is left pending", async (t) => {
    const unhandled = trackUnhandled(t);
    const net = installGatedFetch(t, { holdHeaders: true });
    const draft = start();
    await net.called;
    draft.abort("new-turn");
    assert.equal(net.signal.aborted, true);
    assert.deepEqual(await draft.adopt(() => assert.fail("must not speak")), { type: "aborted" });
    await turnEventLoop();
    assert.deepEqual(unhandled, []);
  });

  it("the abort reason travels on the signal as an AbortError", async (t) => {
    const net = installGatedFetch(t);
    const draft = start();
    await net.called;
    draft.abort("resumed");
    assert.equal(net.signal.reason.name, "AbortError");
    assert.equal(net.signal.reason.message, "resumed");
    await draft.adopt(() => {});
  });

  it("with no reason the signal carries the platform's default AbortError", async (t) => {
    const net = installGatedFetch(t);
    const draft = start();
    await net.called;
    draft.abort();
    assert.equal(net.signal.aborted, true);
    assert.equal(net.signal.reason.name, "AbortError");
    await draft.adopt(() => {});
  });

  it("an already-finished draft can be discarded too", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine, thanks."])));
    const messages = freshMessages();
    const draft = start({ messages });
    await waitUntil(() => draft.status() === "done");
    draft.abort("mismatch");
    assert.equal(draft.status(), "aborted");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
    assert.deepEqual(await draft.adopt(() => assert.fail("must not speak")), { type: "aborted" });
  });

  it("after adoption, mid-stream (barge-in): no further chunk reaches the sink and adopt() resolves aborted", async (t) => {
    const net = installGatedFetch(t);
    const draft = start();
    await net.called;
    const spoken = [];
    const outcome = draft.adopt((s) => spoken.push(s));
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("First one. Second")]);
    await waitUntil(() => spoken.length === 1);

    draft.abort("barge-in");
    assert.equal(draft.status(), "aborted");
    net.push([ev.textDelta(" one. Third one. ")]);
    assert.deepEqual(await outcome, { type: "aborted" });
    assert.deepEqual(spoken, ["First one."]);
  });

  it("a sink that aborts the draft on a live chunk: the rest of the same network chunk is not delivered", async (t) => {
    const net = installGatedFetch(t);
    const draft = start();
    await net.called;
    const spoken = [];
    const outcome = draft.adopt((s) => {
      spoken.push(s);
      draft.abort("barge-in");
    });
    // One network chunk carries three finished sentences, so the parser keeps handing chunks over
    // after the sink has already aborted the draft; none of them may reach the sink.
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("First one. Second one. Third one. ")]);
    assert.deepEqual(await outcome, { type: "aborted" });
    assert.deepEqual(spoken, ["First one."]);
  });

  it("is idempotent, and a no-op once the adopter has its result", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const draft = start();
    await waitUntil(() => draft.status() === "done");
    const result = await draft.adopt(() => {});
    assert.equal(result.type, "content");
    draft.abort("cleanup");
    draft.abort("cleanup");
    assert.equal(draft.status(), "adopted", "nothing left to cancel: the status stays adopted");

    const other = start();
    other.abort("a");
    other.abort("b");
    assert.equal(other.status(), "aborted");
  });

  it("chunks produced after the abort are suppressed even if the llm ignores its signal", async () => {
    let produceLate;
    const gate = new Promise((resolve) => {
      produceLate = resolve;
    });
    const llm = async (_messages, options) => {
      options.onSentence("early chunk");
      await gate;
      options.onSentence("late chunk");
      return { type: "content", content: "early chunk late chunk" };
    };
    const draft = start({ llm });
    draft.abort("resumed");
    produceLate();
    await turnEventLoop();
    const spoken = [];
    assert.deepEqual(await draft.adopt((s) => spoken.push(s)), { type: "aborted" });
    assert.deepEqual(spoken, []);
  });

  it("an AbortError thrown by the llm itself is swallowed: aborted, not failed, nothing logged", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const unhandled = trackUnhandled(t);
    const messages = freshMessages();
    const draft = start({
      messages,
      llm: async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      },
    });
    await waitUntil(() => draft.status() === "aborted");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
    assert.deepEqual(await draft.adopt(() => {}), { type: "aborted" });
    await turnEventLoop();
    assert.deepEqual(unhandled, []);
    assert.equal(warn.mock.callCount(), 0);
  });
});

describe("isAdoptable(currentMessages, transcript)", () => {
  it("is true while the draft is live, on the same array at the same length, with an identical transcript", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const messages = freshMessages();
    const draft = start({ messages });
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), true, "while running");
    await waitUntil(() => draft.status() === "done");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), true, "and once finished");
  });

  it("is false once aborted", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const messages = freshMessages();
    const draft = start({ messages });
    draft.abort("resumed");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
  });

  it("is false for a different array object, even with identical contents", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const messages = freshMessages();
    const draft = start({ messages });
    assert.equal(draft.isAdoptable([...messages], TRANSCRIPT), false);
    assert.equal(draft.isAdoptable(freshMessages(), TRANSCRIPT), false);
    assert.equal(draft.isAdoptable(undefined, TRANSCRIPT), false);
    assert.equal(draft.isAdoptable(null, TRANSCRIPT), false);
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), true);
  });

  it("is false when the same array has grown", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const messages = freshMessages();
    const draft = start({ messages });
    messages.push({ role: "user", content: TRANSCRIPT });
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false, "the committed user message was already appended");
  });

  it("is false when the same array has shrunk", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const messages = freshMessages();
    const draft = start({ messages });
    messages.pop();
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
  });

  it("is false unless the transcript is === the draft's", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const messages = freshMessages();
    const draft = start({ messages });
    for (const different of ["nine is good", "Nine is good.", "Nine is good ", " Nine is good", "Nine is goo", "", undefined, null, 9]) {
      assert.equal(draft.isAdoptable(messages, different), false, JSON.stringify(different));
    }
    // == would accept a String wrapper; === must not.
    assert.equal(draft.isAdoptable(messages, new String(TRANSCRIPT)), false);
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), true);
  });

  it("is false once adopted (a draft is spent after one adoption)", async (t) => {
    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const messages = freshMessages();
    const draft = start({ messages });
    await waitUntil(() => draft.status() === "done");
    await draft.adopt(() => {});
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
  });

  it("is false when the draft failed, so the caller makes a fresh live call instead", async (t) => {
    t.mock.method(console, "warn", () => {});
    const messages = freshMessages();
    const draft = start({
      messages,
      llm: async () => {
        throw new Error("Anthropic API error 529 (overloaded_error: Overloaded)");
      },
    });
    await waitUntil(() => draft.status() === "done");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
  });
});

describe("status(): running, done, aborted, adopted", () => {
  it("running while the stream is open, done once it ends, adopted after adopt()", async (t) => {
    const net = installGatedFetch(t);
    const draft = start();
    await net.called;
    assert.equal(draft.status(), "running");
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Fine."), ...finishText]);
    await turnEventLoop();
    assert.equal(draft.status(), "running", "the model is still connected until the stream closes");
    net.end();
    await waitUntil(() => draft.status() === "done");
    const outcome = draft.adopt(() => {});
    assert.equal(draft.status(), "adopted");
    await outcome;
    assert.equal(draft.status(), "adopted");
  });

  it("aborted from running, from done, and from adopted-in-flight", async (t) => {
    const net = installGatedFetch(t);
    const running = start();
    await net.called;
    running.abort("a");
    assert.equal(running.status(), "aborted");

    withFakeFetch(t, () => sseResponse(textTurnEvents(["Fine."])));
    const done = start();
    await waitUntil(() => done.status() === "done");
    done.abort("b");
    assert.equal(done.status(), "aborted");

    const net2 = installGatedFetch(t);
    const inFlight = start();
    await net2.called;
    const outcome = inFlight.adopt(() => {});
    assert.equal(inFlight.status(), "adopted");
    inFlight.abort("c");
    assert.equal(inFlight.status(), "aborted");
    assert.deepEqual(await outcome, { type: "aborted" });
  });
});

describe("failures other than abort", () => {
  it("a failing draft is done-but-unusable: adopt() rejects with the error a live call would raise, and warns once without caller words", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const boom = new Error("Anthropic API error 400 (invalid_request_error: bad request)");
    const transcript = "My name is Zebediah Quirke";
    const messages = freshMessages();
    const draft = start({
      messages,
      transcript,
      turnKey: 9,
      llm: async () => {
        throw boom;
      },
    });
    await waitUntil(() => draft.status() === "done");
    assert.equal(draft.isAdoptable(messages, transcript), false);
    await assert.rejects(draft.adopt(() => assert.fail("nothing to speak")), (err) => err === boom);

    assert.equal(warn.mock.callCount(), 1);
    const logged = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.match(logged, /turn=9/);
    assert.match(logged, /Anthropic API error 400/);
    assert.doesNotMatch(logged, /Zebediah|Quirke/);
  });

  it("an unadopted failing draft leaves no unhandled rejection behind", async (t) => {
    t.mock.method(console, "warn", () => {});
    const unhandled = trackUnhandled(t);
    start({
      llm: async () => {
        throw new Error("boom");
      },
    });
    await turnEventLoop();
    assert.deepEqual(unhandled, []);
  });

  it("an HTTP error from the real client (no retry for 4xx) is a failed draft too", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    withFakeFetch(
      t,
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const messages = freshMessages();
    const draft = start({ messages });
    await waitUntil(() => draft.status() === "done");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
    await assert.rejects(draft.adopt(() => {}), /Anthropic API error 400/);
    assert.equal(warn.mock.callCount(), 1);
  });

  it("a draft that fails after buffering chunks never replays them: adopt() rejects and the sink hears nothing", async (t) => {
    t.mock.method(console, "warn", () => {});
    const net = installGatedFetch(t);
    const seen = [];
    const messages = freshMessages();
    const draft = start({ llm: spyLlm(seen), messages });
    await net.called;
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Sure, I can help, no problem. See")]);
    await waitUntil(() => seen.length === 2, "two buffered chunks");
    net.push([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
    await waitUntil(() => draft.status() === "done");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
    const spoken = [];
    await assert.rejects(draft.adopt((s) => spoken.push(s)), /Overloaded/);
    assert.deepEqual(spoken, []);
  });

  it("the failure warning carries a bounded slice of the error text, not all of it", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const draft = start({
      llm: async () => {
        throw new Error(`Anthropic API error 400 ${"x".repeat(500)}`);
      },
    });
    await waitUntil(() => draft.status() === "done");
    await assert.rejects(draft.adopt(() => {}), /Anthropic API error 400/);
    const logged = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.ok(logged.length < 300, `logged ${logged.length} chars`);
  });

  it("a mid-stream error event fails the draft; a failed draft's connection is released", async (t) => {
    t.mock.method(console, "warn", () => {});
    const net = installGatedFetch(t);
    const messages = freshMessages();
    const draft = start({ messages });
    await net.called;
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Sure, "), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
    await waitUntil(() => draft.status() === "done");
    assert.equal(draft.isAdoptable(messages, TRANSCRIPT), false);
    assert.equal(net.signal.aborted, true, "the dead stream is cancelled");
    await assert.rejects(draft.adopt(() => {}), /Overloaded/);
  });
});

describe("logging: no caller words or model text, ever", () => {
  it("a full run (buffer, adopt, stream, finish) and an aborted run write nothing to the console", async (t) => {
    const spies = ["log", "info", "warn", "error", "debug"].map((name) => t.mock.method(console, name, () => {}));
    const distinctive = "Zebediah Quirke wants a Thursday crown fitting";

    const net = installGatedFetch(t);
    const seen = [];
    const draft = start({ llm: spyLlm(seen), transcript: distinctive });
    await net.called;
    net.push([ev.messageStart(), ev.textStart(0), ev.textDelta("Certainly Zebediah, I can fit that in, no problem. See")]);
    await waitUntil(() => seen.length === 2);
    const outcome = draft.adopt(() => {});
    net.push([ev.textDelta(" you Thursday."), ...finishText]);
    net.end();
    await outcome;

    withFakeFetch(t, () => sseResponse(textTurnEvents(["Certainly Zebediah, no problem."])));
    const second = start({ transcript: distinctive });
    second.abort("resumed");
    await second.adopt(() => {});

    const output = spies.flatMap((s) => s.mock.calls.map((c) => c.arguments.join(" "))).join("\n");
    assert.doesNotMatch(output, /Zebediah|Quirke|Thursday|crown/);
    assert.equal(output, "", "the happy and abort paths are silent");
  });
});
