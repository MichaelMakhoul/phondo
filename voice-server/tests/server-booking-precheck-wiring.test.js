"use strict";

// SCRUM-593 — source pins for the booking pre-check in the server.js monolith
// (idiom: server-owner-mode-wiring.test.js). The behaviour is unit-tested in
// booking-precheck.test.js; these pin WHERE it runs: in both Gemini
// onToolCall handlers, after the owner early-return and the existing guards,
// before anything is remembered or written.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const inboundStart = src.indexOf("onToolCall: async (toolCall) => {");
const inbound = src.slice(inboundStart, src.indexOf("onToolCallCancellation", inboundStart));
const testStart = src.indexOf("onToolCall: async (toolCall) => {", inboundStart + 1);
const testPath = src.slice(testStart, src.indexOf("onTranscriptIn", testStart));

describe("SCRUM-593: booking pre-check wiring", () => {
  it("imports the module", () => {
    assert.match(src, /const \{ applyBookingPrecheck \} = require\("\.\/lib\/booking-precheck"\);/);
  });

  it("inbound: runs after the owner return and the RebookGuard, before rememberDetails and the write", () => {
    const call = inbound.indexOf("await applyBookingPrecheck(session, toolCall, {");
    assert.ok(call > 0, "inbound handler calls applyBookingPrecheck");
    assert.ok(inbound.indexOf("runOwnerToolCall(") < call, "owner calls return first");
    assert.ok(inbound.indexOf("DUPLICATE_REBOOK_MESSAGE") < call, "after the RebookGuard");
    assert.ok(call < inbound.indexOf("session.rememberDetails(toolCall.name, toolCall.args)"), "before details are remembered");
    assert.ok(call < inbound.indexOf("result = await executeToolCall(toolCall.name"), "before the write");
    assert.match(inbound, /pendingUser: pendingUserTranscript,\s*pendingAi: pendingAiTranscript,\s*promptConfig: context\?\.assistant\?\.promptConfig,\s*audit: true,/);
    assert.match(inbound, /if \(!session\) return \{ message: "" \};\s*if \(precheckHold\) return precheckHold;/);
  });

  it("inbound: the goodbye auto-end stays off while the check runs", () => {
    const call = inbound.indexOf("await applyBookingPrecheck(session, toolCall, {");
    const before = inbound.slice(Math.max(0, call - 400), call);
    assert.match(before, /if \(session\) session\._toolCallInFlight = true;/);
    assert.match(inbound.slice(call, call + 600), /finally \{\s*if \(session\) session\._toolCallInFlight = false;/);
  });

  it("inbound: a successful write resets that tool's hold count", () => {
    assert.match(inbound, /if \(successful\) session\.precheckHolds\?\.delete\(toolCall\.name\);/);
  });

  it("/ws/test: runs before the write, without auditing", () => {
    const call = testPath.indexOf("await applyBookingPrecheck(session, toolCall, {");
    assert.ok(call > 0, "test handler calls applyBookingPrecheck");
    assert.ok(call < testPath.indexOf("session.rememberDetails(toolCall.name, toolCall.args)"), "before details are remembered");
    assert.ok(call < testPath.indexOf("executeToolCall(toolCall.name"), "before the write");
    assert.match(testPath, /pendingUser: pendingUserTranscript,\s*pendingAi: pendingAiTranscript,\s*promptConfig: context\?\.assistant\?\.promptConfig,\s*audit: false,/);
    assert.match(testPath, /if \(!session\) return \{ message: "" \};\s*if \(precheckHold\) return precheckHold;/);
  });

  it("the Tier-2 call site passes the business timezone", () => {
    assert.match(src, /spokenResponse: aiTurnText,\s*timezone: session\.organization\?\.timezone \|\| "Australia\/Sydney",/);
  });
});

describe("SCRUM-593: CallSession", () => {
  it("starts every call with an empty hold map", () => {
    const { CallSession } = require("../call-session");
    const s = new CallSession("CAtest");
    assert.ok(s.precheckHolds instanceof Map);
    assert.equal(s.precheckHolds.size, 0);
  });
});
