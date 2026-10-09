"use strict";

/**
 * SCRUM-588 — the Gemini Live setup message for the 3.8 Live default.
 *
 * Pins, on the wire:
 *   - the default model and the GEMINI_LIVE_MODEL revert lever (read at load,
 *     so each case re-requires the service fresh);
 *   - no sampling params (Google deprecated them 2026-07-21);
 *   - behavior "BLOCKING" on every function declaration — 3.8 Live defaults
 *     to NON_BLOCKING, which ends the model's turn at each tool call and, after
 *     end_call, had it speak "I've ended the call." into the close drain.
 *
 * Fake `ws` injected via require.cache BEFORE requiring the service (the
 * repo's established pattern — see gemini-live-setup-complete.test.js).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const created = [];

class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.readyState = FakeWebSocket.OPEN;
    created.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

const wsPath = require.resolve("ws");
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket };

process.env.GEMINI_API_KEY = "test-key";
const savedModelEnv = process.env.GEMINI_LIVE_MODEL;
test.after(() => {
  if (savedModelEnv === undefined) delete process.env.GEMINI_LIVE_MODEL;
  else process.env.GEMINI_LIVE_MODEL = savedModelEnv;
});

const TOOLS = [
  { type: "function", function: { name: "check_availability", description: "Check slots", parameters: { type: "object", properties: { date: { type: "string" } }, required: ["date"] } } },
  { type: "function", function: { name: "end_call", description: "Hang up", parameters: { type: "object", properties: {} } } },
];

/** Fresh-require gemini-live under the given GEMINI_LIVE_MODEL and return the setup it sends. */
function setupFor(modelEnv) {
  if (modelEnv === undefined) delete process.env.GEMINI_LIVE_MODEL;
  else process.env.GEMINI_LIVE_MODEL = modelEnv;
  const servicePath = require.resolve("../services/gemini-live");
  delete require.cache[servicePath];
  const gemini = require(servicePath);
  gemini.createGeminiSession(
    { systemPrompt: "prompt", tools: TOOLS, voiceName: "Kore" },
    {
      onAudio: () => {}, onToolCall: async () => ({}), onTranscriptIn: () => {}, onTranscriptOut: () => {},
      onInterrupted: () => {}, onTurnComplete: () => {}, onError: () => {}, onClose: () => {},
    }
  );
  const ws = created[created.length - 1];
  ws.emit("open");
  const setupMsg = ws.sent.find((m) => m.setup);
  assert.ok(setupMsg, "setup must be sent on open");
  return { setup: setupMsg.setup, exported: gemini.GEMINI_MODEL };
}

test("default model is Gemini 3.8 Live, and the export is what was dialed", () => {
  const { setup, exported } = setupFor(undefined);
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.equal(exported, "models/gemini-3.8-live");
});

test("GEMINI_LIVE_MODEL is the revert lever (read at load)", () => {
  const { setup, exported } = setupFor("models/gemini-3.1-flash-live-preview");
  assert.equal(setup.model, "models/gemini-3.1-flash-live-preview");
  assert.equal(exported, "models/gemini-3.1-flash-live-preview");
});

test("no sampling params in generationConfig (deprecated by Google 2026-07-21)", () => {
  const { setup } = setupFor(undefined);
  for (const key of ["temperature", "topP", "topK", "top_p", "top_k"]) {
    assert.equal(key in setup.generationConfig, false, `${key} must not be sent`);
  }
  assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
});

test("every function declaration is BLOCKING — the sequential tool semantics the guards assume", () => {
  const { setup } = setupFor(undefined);
  const decls = setup.tools[0].functionDeclarations;
  assert.deepEqual(decls.map((d) => d.name), ["check_availability", "end_call"]);
  for (const d of decls) assert.equal(d.behavior, "BLOCKING", d.name);
  // The rest of the declaration is untouched by the new field.
  assert.deepEqual(decls[0].parameters.required, ["date"]);
});

test("server.js logs the model actually in use — no hardcoded version string", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(serverSrc, /Gemini 3\.1 Flash Live/, "stale hardcoded model name in a log line");
  assert.match(serverSrc, /\(Gemini Live: \$\{GEMINI_MODEL\}\)/, "startup log must print GEMINI_MODEL");
  assert.match(serverSrc, /\[TestGeminiLive\] Initializing Gemini Live \(\$\{GEMINI_MODEL\}\)/, "test-call log must print GEMINI_MODEL");
});

test("the revert model gets the SAME setup as the default except `model` — no model-specific branches", () => {
  // GEMINI_LIVE_MODEL must revert to the exact setup probed on 3.1
  // (2026-10-09), not merely to a different model string.
  const { setup: def } = setupFor(undefined);
  const { setup: rev } = setupFor("models/gemini-3.1-flash-live-preview");
  assert.equal(rev.model, "models/gemini-3.1-flash-live-preview");
  assert.deepEqual({ ...rev, model: undefined }, { ...def, model: undefined });
});
