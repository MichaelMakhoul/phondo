import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

const pageSentryMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/page-sentry", () => ({ pageSentry: pageSentryMock }));

import { requireCronAuth } from "../cron-auth";

/** Minimal NextRequest stub — requireCronAuth only reads the `authorization` header. */
function reqWith(authHeader?: string): NextRequest {
  return {
    headers: { get: (k: string) => (k === "authorization" ? authHeader ?? null : null) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireCronAuth (SCRUM-324)", () => {
  it("pages at error level AND returns 500 when CRON_SECRET is unset", () => {
    vi.stubEnv("CRON_SECRET", ""); // falsy → misconfigured
    const res = requireCronAuth(reqWith("Bearer anything"), "keep-alive");
    expect(res?.status).toBe(500);
    expect(pageSentryMock).toHaveBeenCalledTimes(1);
    expect(pageSentryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "next-cron",
        reason: "cron-secret-missing",
        level: "error",
        tags: { cron: "keep-alive" },
      }),
    );
  });

  it("returns 401 and does NOT page when the bearer token is wrong", () => {
    vi.stubEnv("CRON_SECRET", "s3cr3t");
    const res = requireCronAuth(reqWith("Bearer wrong"), "expire-callbacks");
    expect(res?.status).toBe(401);
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("returns 401 and does NOT page when no Authorization header is present", () => {
    vi.stubEnv("CRON_SECRET", "s3cr3t");
    const res = requireCronAuth(reqWith(undefined), "daily-summary");
    expect(res?.status).toBe(401);
    expect(pageSentryMock).not.toHaveBeenCalled();
  });

  it("returns null (authenticated) when the bearer token matches", () => {
    vi.stubEnv("CRON_SECRET", "s3cr3t");
    const res = requireCronAuth(reqWith("Bearer s3cr3t"), "health-check");
    expect(res).toBeNull();
    expect(pageSentryMock).not.toHaveBeenCalled();
  });
});
