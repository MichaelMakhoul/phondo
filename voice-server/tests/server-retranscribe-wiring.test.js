"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// SCRUM-550: source-pin the /internal/retranscribe wiring in server.js. The
// handler logic is unit-tested in tests/route-handlers/retranscribe.test.js;
// this pins that server.js actually mounts it, guards it with the internal
// secret, validates callId, delegates inside try/catch, and constructs the deps
// (esp. the RETRANSCRIBE_ENABLED flag + DEEPGRAM_API_KEY) correctly — none of
// which the unit test can see.

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

describe("server.js /internal/retranscribe wiring (SCRUM-550)", () => {
  it("mounts the route", () => {
    assert.match(serverSource, /app\.post\("\/internal\/retranscribe",\s*async \(req, res\) => \{/);
  });

  it("guards with the internal secret (constant-time) and 401s", () => {
    assert.match(
      serverSource,
      /\/internal\/retranscribe[\s\S]{0,400}timingSafeEqualStr\(req\.headers\["x-internal-secret"\], INTERNAL_API_SECRET\)[\s\S]{0,120}status\(401\)/,
    );
  });

  it("validates callId is a non-empty string (400 otherwise)", () => {
    assert.match(
      serverSource,
      /\/internal\/retranscribe[\s\S]{0,600}const callId = req\.body && req\.body\.callId;[\s\S]{0,160}status\(400\)/,
    );
  });

  it("delegates to handleRetranscribe inside a try/catch", () => {
    assert.match(serverSource, /try \{\s*const result = await handleRetranscribe\(\{/);
    // the catch is the last-resort net (handler is designed not to throw)
    assert.match(serverSource, /\} catch \(err\) \{[\s\S]{0,400}reason: "handler-error"/);
  });

  it("constructs deps: the RETRANSCRIBE_ENABLED kill-switch (default on) + DEEPGRAM_API_KEY", () => {
    assert.match(serverSource, /retranscribeEnabled: process\.env\.RETRANSCRIBE_ENABLED !== "false"/);
    assert.match(serverSource, /deepgramApiKey: process\.env\.DEEPGRAM_API_KEY/);
  });

  it("SCRUM-553: wires the content-loss judge into deps", () => {
    assert.match(serverSource, /judgeContentLoss: judgeTranscriptContentLoss/);
    assert.match(
      serverSource,
      /analyzeCallTranscript, judgeTranscriptContentLoss \} = require\("\.\/services\/post-call-analysis"\)/,
    );
  });

  it("imports the wiring pieces (transcribeRecording, applyReanalysis, handleRetranscribe, buildTwoSidedTranscript)", () => {
    assert.match(serverSource, /openDeepgramStream, transcribeRecording \} = require\("\.\/services\/deepgram-stt"\)/);
    assert.match(serverSource, /applyReanalysis \} = require\("\.\/lib\/call-logger"\)/);
    assert.match(serverSource, /handleRetranscribe \} = require\("\.\/lib\/route-handlers\/retranscribe"\)/);
    assert.match(serverSource, /buildTwoSidedTranscript \} = require\("\.\/lib\/transcript-from-utterances"\)/);
  });
});
