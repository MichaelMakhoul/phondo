import { describe, it, expect, vi } from "vitest";
import { setReasonTag } from "../sentry-tags";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import type { Scope } from "@sentry/nextjs";

/** Minimal fake scope that records the last reason tag it received. */
function makeScope() {
  const tags: Record<string, unknown> = {};
  const scope = {
    setTag: vi.fn((k: string, v: unknown) => {
      tags[k] = v;
    }),
  } as unknown as Scope;
  return { scope, tags };
}

describe("setReasonTag (SCRUM-297)", () => {
  it("sets the reason tag to the constant's wire value", () => {
    const { scope, tags } = makeScope();
    setReasonTag(scope, SENTRY_REASONS.RATE_LIMIT_DISTRIBUTED_FAILED);
    expect(tags.reason).toBe("rate-limit-distributed-failed");
  });

  it("falls back to the loud sentinel when reason is undefined (typo / as-any bypass)", () => {
    const { scope, tags } = makeScope();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Simulate a typo'd constant access that produced undefined and a
    // caller that bypassed the typechecker with `as any`.
    setReasonTag(scope, undefined as unknown as (typeof SENTRY_REASONS)[keyof typeof SENTRY_REASONS]);
    // Critical: the tag is set to the sentinel, NOT left unset — an
    // unset reason tag would silently break the Grafana alert rule.
    expect(tags.reason).toBe("invalid-reason-passed");
    expect(errorSpy).toHaveBeenCalledWith(
      "[setReasonTag] reason is not a non-empty string (typo or missing constant):",
      undefined,
    );
    errorSpy.mockRestore();
  });

  it("falls back to the sentinel for an empty-string reason", () => {
    const { scope, tags } = makeScope();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setReasonTag(scope, "" as unknown as (typeof SENTRY_REASONS)[keyof typeof SENTRY_REASONS]);
    expect(tags.reason).toBe("invalid-reason-passed");
    errorSpy.mockRestore();
  });
});
