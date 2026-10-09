import { afterEach, describe, expect, it, vi } from "vitest";
import { isOwnerAssistantUiEnabled } from "@/lib/feature-flags";

// The owner line gates PIN registration, so the flag must stay dark unless an
// operator sets exactly "true" — not any truthy string — and it is read at call
// time so the route/page see a flip without a re-import.
describe("isOwnerAssistantUiEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when OWNER_ASSISTANT_UI_ENABLED is unset (dark by default)", () => {
    vi.stubEnv("OWNER_ASSISTANT_UI_ENABLED", undefined);
    expect(isOwnerAssistantUiEnabled()).toBe(false);
  });

  it('is on for the exact string "true"', () => {
    vi.stubEnv("OWNER_ASSISTANT_UI_ENABLED", "true");
    expect(isOwnerAssistantUiEnabled()).toBe(true);
  });

  it.each(["false", "", "TRUE", "True", "1", "yes", " true", "true "])(
    "stays off for %j",
    (value) => {
      vi.stubEnv("OWNER_ASSISTANT_UI_ENABLED", value);
      expect(isOwnerAssistantUiEnabled()).toBe(false);
    }
  );

  it("re-reads the env on every call instead of freezing it at import", () => {
    vi.stubEnv("OWNER_ASSISTANT_UI_ENABLED", "true");
    expect(isOwnerAssistantUiEnabled()).toBe(true);
    vi.stubEnv("OWNER_ASSISTANT_UI_ENABLED", "false");
    expect(isOwnerAssistantUiEnabled()).toBe(false);
  });
});
