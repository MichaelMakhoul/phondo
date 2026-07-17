import { describe, it, expect } from "vitest";
import { humanizeEndedReason } from "@/lib/notifications/humanize-ended-reason";

// SCRUM-496: the failed-call email said "The call ended unexpectedly
// (gemini-error)." — raw internal provider codes must never reach customers.

describe("humanizeEndedReason (SCRUM-496)", () => {
  it("maps every pipeline's error/setup-timeout code to the same neutral copy", () => {
    const expected = "The AI assistant encountered a technical error and couldn't take the call.";
    for (const reason of [
      "gemini-error",
      "grok-error",
      "openai-error",
      "gemini-setup-timeout",
      "grok-setup-timeout",
      "openai-setup-timeout",
    ]) {
      expect(humanizeEndedReason(reason)).toBe(expected);
    }
  });

  it("maps every pipeline's session-closed code to neutral copy", () => {
    const expected = "The AI assistant disconnected unexpectedly during the call.";
    for (const reason of ["gemini-session-closed", "grok-session-closed", "openai-session-closed"]) {
      expect(humanizeEndedReason(reason)).toBe(expected);
    }
  });

  it("NEVER echoes an unknown internal code into the copy", () => {
    for (const reason of ["gemini-error", "some-new-internal-code", "xai_403_unauthorized"]) {
      const copy = humanizeEndedReason(reason);
      expect(copy).not.toContain(reason);
      expect(copy.toLowerCase()).not.toMatch(/gemini|grok|openai|xai/);
    }
  });

  it("keeps the long-standing specific mappings", () => {
    expect(humanizeEndedReason("stt-error")).toBe("The speech recognition system failed during the call.");
    expect(humanizeEndedReason("llm-error")).toBe("The AI assistant encountered a technical error and couldn't respond.");
    expect(humanizeEndedReason("tts-error")).toBe("The voice system failed during the call.");
    expect(humanizeEndedReason("server-error")).toBe("The voice server encountered an error processing the call.");
  });

  it("handles a missing reason with neutral copy", () => {
    expect(humanizeEndedReason(undefined)).toBe("The call ended unexpectedly due to a technical issue.");
    expect(humanizeEndedReason("")).toBe("The call ended unexpectedly due to a technical issue.");
  });

  it("hallucinated-action reasons keep their call-to-action instead of generic copy (review P2)", () => {
    for (const reason of ["hallucinated_booking", "hallucinated_callback", "hallucinated_cancellation"]) {
      const copy = humanizeEndedReason(reason);
      expect(copy).toContain("review the call");
      expect(copy).toContain("contact the caller");
      expect(copy).not.toContain(reason);
    }
  });

  it("booking-state-mismatch (SCRUM-559) gets the must-act copy, never the generic technical-issue line", () => {
    const copy = humanizeEndedReason("booking-state-mismatch");
    expect(copy).toMatch(/review the call and contact the caller/);
    expect(copy).not.toMatch(/technical issue/);
  });

  it("stt-connection-lost maps to the specific STT copy, not the generic fallback", () => {
    expect(humanizeEndedReason("stt-connection-lost")).toBe("The speech recognition system failed during the call.");
  });
});
