import { describe, it, expect } from "vitest";
import { classifyCallNotification } from "../classify-call";

describe("classifyCallNotification", () => {
  it("technical failure → failed", () => {
    expect(
      classifyCallNotification({
        status: "failed",
        durationSeconds: 3,
        hasTranscript: false,
      })
    ).toBe("failed");
  });

  it("failed status wins even with a transcript + successEvaluation", () => {
    // A technical failure can still have a partial transcript — status is the
    // strongest signal, so it must take precedence.
    expect(
      classifyCallNotification({
        status: "failed",
        durationSeconds: 30,
        hasTranscript: true,
        successEvaluation: "unsuccessful",
      })
    ).toBe("failed");
  });

  it("AI engaged but rated unsuccessful → unsuccessful (the SCRUM-299 case)", () => {
    // The dd477053 scenario: 41s, transcript present, analyzer said "partial".
    expect(
      classifyCallNotification({
        status: "completed",
        durationSeconds: 41,
        hasTranscript: true,
        successEvaluation: "partial",
      })
    ).toBe("unsuccessful");
    expect(
      classifyCallNotification({
        status: "completed",
        durationSeconds: 41,
        hasTranscript: true,
        successEvaluation: "unsuccessful",
      })
    ).toBe("unsuccessful");
  });

  it("truly missed (very short, no transcript) → missed", () => {
    expect(
      classifyCallNotification({
        status: "completed",
        durationSeconds: 3,
        hasTranscript: false,
      })
    ).toBe("missed");
  });

  it("short engaged call with null eval → unsuccessful, NOT missed (SCRUM-299 + regression #1)", () => {
    // Don't mislabel an AI-engaged call as missed; and don't go silent just
    // because post-call analysis returned null (which it does on failure).
    expect(
      classifyCallNotification({
        status: "completed",
        durationSeconds: 7,
        hasTranscript: true,
        successEvaluation: null,
      })
    ).toBe("unsuccessful");
  });

  it("short engaged call rated successful → none (respect the rating)", () => {
    expect(
      classifyCallNotification({
        status: "completed",
        durationSeconds: 7,
        hasTranscript: true,
        successEvaluation: "successful",
      })
    ).toBe("none");
  });

  it("successful conversation → none (booking/callback fire their own emails)", () => {
    expect(
      classifyCallNotification({
        status: "completed",
        durationSeconds: 120,
        hasTranscript: true,
        successEvaluation: "successful",
      })
    ).toBe("none");
  });

  it("long call with no transcript and no eval → none (not missed past the threshold)", () => {
    expect(
      classifyCallNotification({
        status: "completed",
        durationSeconds: 45,
        hasTranscript: false,
      })
    ).toBe("none");
  });

  it("case-insensitive on successEvaluation", () => {
    expect(
      classifyCallNotification({
        status: "completed",
        durationSeconds: 20,
        hasTranscript: true,
        successEvaluation: "UNSUCCESSFUL",
      })
    ).toBe("unsuccessful");
  });
});
