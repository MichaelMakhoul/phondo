const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildTwoSidedTranscript, CALLER_RECORDING_CHANNEL } = require("../lib/transcript-from-utterances");

// SCRUM-550: turn Deepgram's channel-tagged, timestamped utterances into the
// same "User: …\nAI: …" string shape call-session.getTranscript() produces, so
// it drops straight into analyzeCallTranscript + the dashboard raw view.

describe("buildTwoSidedTranscript (SCRUM-550)", () => {
  it("interleaves utterances by start time and maps channel→role", () => {
    const out = buildTwoSidedTranscript([
      { start: 1.0, channel: 0, transcript: "I need an appointment" },
      { start: 0.0, channel: 1, transcript: "Thanks for calling, how can I help?" },
      { start: 2.0, channel: 1, transcript: "Sure, what day works?" },
    ]);
    assert.equal(
      out,
      "AI: Thanks for calling, how can I help?\n" +
        "User: I need an appointment\n" +
        "AI: Sure, what day works?",
    );
  });

  it("merges consecutive same-channel utterances into one turn", () => {
    const out = buildTwoSidedTranscript([
      { start: 0, channel: 0, transcript: "Hi" },
      { start: 1, channel: 0, transcript: "it's John" },
      { start: 2, channel: 1, transcript: "Hello John" },
    ]);
    assert.equal(out, "User: Hi it's John\nAI: Hello John");
  });

  it("honors a flipped caller channel", () => {
    const out = buildTwoSidedTranscript(
      [
        { start: 0, channel: 0, transcript: "AI speaking" },
        { start: 1, channel: 1, transcript: "caller speaking" },
      ],
      { callerChannel: 1 },
    );
    assert.equal(out, "AI: AI speaking\nUser: caller speaking");
  });

  it("skips blank/whitespace utterances", () => {
    const out = buildTwoSidedTranscript([
      { start: 0, channel: 0, transcript: "  " },
      { start: 1, channel: 1, transcript: "real text" },
      { start: 2, channel: 0, transcript: "" },
    ]);
    assert.equal(out, "AI: real text");
  });

  it("returns empty string for empty/nullish input", () => {
    assert.equal(buildTwoSidedTranscript([]), "");
    assert.equal(buildTwoSidedTranscript(null), "");
    assert.equal(buildTwoSidedTranscript(undefined), "");
  });

  it("defaults the caller channel to 0", () => {
    assert.equal(CALLER_RECORDING_CHANNEL, 0);
  });
});
