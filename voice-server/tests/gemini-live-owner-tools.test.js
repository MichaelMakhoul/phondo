// voice-server/tests/gemini-live-owner-tools.test.js
"use strict";
// SCRUM-587 — what the owner flow needs from the Gemini adapter (services/gemini-live.js),
// driven through a fake `ws` injected via require.cache (as gemini-live-setup-complete.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const created = [];
class FakeWebSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; this.readyState = FakeWebSocket.OPEN; created.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
const wsPath = require.resolve("ws");
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket };

process.env.GEMINI_API_KEY = "test-key";
process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
const { createGeminiSession } = require("../services/gemini-live");
const { buildOwnerTools } = require("../lib/owner-tools");

function makeSession(callbacks, tools = []) {
  createGeminiSession(
    { systemPrompt: "prompt", tools, voiceName: "Kore" },
    { onAudio() {}, onToolCall: async () => ({}), onTranscriptIn() {}, onTranscriptOut() {}, onInterrupted() {}, onTurnComplete() {}, onError() {}, onClose() {}, ...callbacks },
  );
  return created[created.length - 1];
}

const settle = () => new Promise((r) => setImmediate(r));

// Final review, test lens: the Gemini adapter is unchanged by PR C, yet the owner flow rides on
// two of its behaviours no test pinned — (1) a tool result's `data` (appointment ids, a write's
// data.outcome) reaches the model, and (2) `confirmed` is declared to Gemini as a BOOLEAN (PR B
// treats the string "true" as needs_confirmation, so a string would mean no write ever happens).
test("an owner tool's result goes to Gemini WHOLE — message and data (the appointment ids ride in data)", async () => {
  const result = { message: "1 job today.", data: { count: 1, appointments: [{ appointment_id: "a1", when: "Friday at 3 PM" }] } };
  const ws = makeSession({ onToolCall: async () => result });
  ws.emit("open");
  ws.emit("message", JSON.stringify({ setupComplete: {} }));
  ws.emit("message", JSON.stringify({ toolCall: { functionCalls: [{ id: "t1", name: "owner_list_appointments", args: { range: "today" } }] } }));
  await settle();
  const frame = ws.sent.find((m) => m.toolResponse);
  assert.ok(frame, "no toolResponse sent");
  assert.deepEqual(frame.toolResponse.functionResponses, [{ id: "t1", name: "owner_list_appointments", response: { result } }]);
});

test("a write's outcome reaches Gemini too, and a plain string result is wrapped as { message }", async () => {
  const outcomes = {
    owner_cancel_appointment: { message: "Cancelled.", data: { outcome: "cancelled", customer_notified: false } },
    get_current_datetime: "It is Thursday 15 October, 1:30 am.",
  };
  const ws = makeSession({ onToolCall: async ({ name }) => outcomes[name] });
  ws.emit("open");
  ws.emit("message", JSON.stringify({ setupComplete: {} }));
  ws.emit("message", JSON.stringify({ toolCall: { functionCalls: [
    { id: "t1", name: "owner_cancel_appointment", args: { appointment_id: "a1", confirmed: true } },
    { id: "t2", name: "get_current_datetime", args: {} },
  ] } }));
  await settle();
  const [cancel, now] = ws.sent.find((m) => m.toolResponse).toolResponse.functionResponses;
  assert.deepEqual(cancel.response.result.data, { outcome: "cancelled", customer_notified: false });
  assert.deepEqual(now.response.result, { message: "It is Thursday 15 October, 1:30 am." });
});

test("the owner tools are declared to Gemini with the types PR B's gate depends on: confirmed is a BOOLEAN, range an enum", () => {
  const ws = makeSession({}, buildOwnerTools());
  ws.emit("open");
  const setup = ws.sent.find((m) => m.setup);
  const decls = Object.fromEntries(setup.setup.tools[0].functionDeclarations.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(decls).sort(), ["check_availability", "end_call", "get_current_datetime", "owner_cancel_appointment", "owner_list_appointments", "owner_list_messages", "owner_reschedule_appointment"]);
  assert.equal(decls.owner_cancel_appointment.parameters.properties.confirmed.type, "BOOLEAN");
  assert.equal(decls.owner_reschedule_appointment.parameters.properties.confirmed.type, "BOOLEAN");
  assert.deepEqual(decls.owner_list_appointments.parameters.properties.range.enum, ["today", "tomorrow", "this_week", "date"]);
  assert.deepEqual(decls.owner_reschedule_appointment.parameters.required, ["appointment_id", "new_datetime"]);
});

// Silent-failure lens SF4: toolCallCancellation was only logged, so an owner write the owner
// talked over still ran. The adapter now hands the cancelled ids to the call site.
test("a toolCallCancellation frame hands the cancelled ids to onToolCallCancellation", () => {
  const seen = [];
  const ws = makeSession({ onToolCallCancellation: (ids) => seen.push(ids) });
  ws.emit("open");
  ws.emit("message", JSON.stringify({ setupComplete: {} }));
  ws.emit("message", JSON.stringify({ toolCallCancellation: { ids: ["fc-1", "fc-2"] } }));
  assert.deepEqual(seen, [["fc-1", "fc-2"]]);
});

test("a malformed cancellation is an empty list; a call site without the callback, or one that throws, never breaks the session", () => {
  const seen = [];
  const ws = makeSession({ onToolCallCancellation: (ids) => seen.push(ids) });
  ws.emit("open");
  ws.emit("message", JSON.stringify({ setupComplete: {} }));
  ws.emit("message", JSON.stringify({ toolCallCancellation: {} }));
  assert.deepEqual(seen, [[]]);
  const quiet = makeSession({});
  quiet.emit("open");
  quiet.emit("message", JSON.stringify({ toolCallCancellation: { ids: ["fc-1"] } }));
  const errors = [];
  const thrower = makeSession({ onToolCallCancellation: () => { throw new Error("boom"); }, onError: (e) => errors.push(e) });
  thrower.emit("open");
  const realError = console.error;
  console.error = () => {};
  try {
    thrower.emit("message", JSON.stringify({ toolCallCancellation: { ids: ["fc-1"] } }));
  } finally {
    console.error = realError;
  }
  assert.deepEqual(errors, [], "a throwing call site is logged, not turned into a session error");
});
