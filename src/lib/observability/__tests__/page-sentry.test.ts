import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { pageSentry } from "../page-sentry";

/**
 * Hoisted shared scope state so tests can assert per-tag values.
 * Same pattern as keep-alive/__tests__/route.test.ts (SCRUM-293).
 */
const sentryState = vi.hoisted(() => ({
  scopeCalls: [] as Array<{
    tags: Record<string, string>;
    extras: Record<string, unknown>;
    level: string | null;
  }>,
  reset() {
    this.scopeCalls = [];
  },
}));

vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn((fn: (scope: any) => void) => {
    const tags: Record<string, string> = {};
    const extras: Record<string, unknown> = {};
    let level: string | null = null;
    fn({
      setTag: (k: string, v: string | number | boolean) => {
        tags[k] = String(v);
      },
      setLevel: (l: string) => {
        level = l;
      },
      setExtras: (e: Record<string, unknown>) => {
        Object.assign(extras, e);
      },
    });
    sentryState.scopeCalls.push({ tags, extras, level });
  }),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

function lastScope() {
  return sentryState.scopeCalls[sentryState.scopeCalls.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  sentryState.reset();
});

describe("pageSentry helper (SCRUM-300)", () => {
  it("routes through captureException when `err` is supplied", () => {
    const err = new Error("boom");
    pageSentry({
      service: "next-api",
      reason: "voice-preview-failed",
      err,
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("routes through captureMessage when `message` is supplied and `err` is undefined", () => {
    pageSentry({
      service: "next-api",
      reason: "voice-preview-upstream-non-2xx",
      message: "upstream returned 502",
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith("upstream returned 502");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("wraps a non-Error `err` value in `new Error(String(err))`", () => {
    pageSentry({
      service: "next-api",
      reason: "voice-preview-failed",
      err: { code: "OPAQUE" },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const passed = vi.mocked(Sentry.captureException).mock.calls[0][0];
    expect(passed).toBeInstanceOf(Error);
  });

  it("emits the right scope tags: service, reason, level, plus extras + custom tags", () => {
    pageSentry({
      service: "next-cron",
      reason: "rate-limit-cleanup-failed",
      level: "warning",
      err: new Error("x"),
      extras: { jobId: "123" },
      tags: { cron: "keep-alive" },
    });
    expect(lastScope().tags).toEqual({
      service: "next-cron",
      reason: "rate-limit-cleanup-failed",
      cron: "keep-alive",
    });
    expect(lastScope().level).toBe("warning");
    expect(lastScope().extras).toEqual({ jobId: "123" });
  });

  it("defaults to level=warning when not specified", () => {
    pageSentry({
      service: "next-api",
      reason: "voice-preview-failed",
      err: new Error("x"),
    });
    expect(lastScope().level).toBe("warning");
  });

  it("honors level=error for config-missing / customer-intent-violation reasons", () => {
    pageSentry({
      service: "next-api",
      reason: "voice-preview-env-missing",
      level: "error",
      message: "required env vars missing",
    });
    expect(lastScope().level).toBe("error");
  });

  it("captureException transport defect logs with `transport_failed` marker, does NOT propagate", () => {
    // SCRUM-300 review: distinguish transport failures from scope-
    // setup failures via distinct log prefixes.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
      throw new Error("sentry transport down");
    });
    expect(() =>
      pageSentry({
        service: "next-api",
        reason: "voice-preview-failed",
        err: new Error("x"),
      }),
    ).not.toThrow();
    // Scope still ran (we got past setup, into the capture call).
    expect(sentryState.scopeCalls).toHaveLength(1);
    // Distinct prefix that a Grafana Loki alert can match.
    expect(errorSpy).toHaveBeenCalledWith(
      "[pageSentry] transport_failed (continuing):",
      expect.stringContaining("sentry transport down"),
    );
    errorSpy.mockRestore();
  });

  it("scope-setup errors log with `scope_setup_failed` marker, does NOT propagate (preserves SCRUM-277 contract)", () => {
    // SCRUM-300 review: caller bugs (Symbol in extras, circular refs)
    // must surface loudly in Loki for Grafana alerting, but MUST NOT
    // crash the caller (a cron mid-job or a route handler) — that
    // would defeat the whole point of Sentry being a side-channel.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(Sentry.withScope).mockImplementationOnce(() => {
      throw new Error("scope setup blew up");
    });
    expect(() =>
      pageSentry({
        service: "next-api",
        reason: "voice-preview-failed",
        err: new Error("x"),
      }),
    ).not.toThrow();
    // Distinct prefix — a Grafana Loki rule on
    // "pageSentry] scope_setup_failed" fires independently of Sentry
    // (which has already failed by this point).
    expect(errorSpy).toHaveBeenCalledWith(
      "[pageSentry] scope_setup_failed — caller bug or SDK regression (continuing):",
      expect.stringContaining("scope setup blew up"),
    );
    errorSpy.mockRestore();
  });

  it("with neither err nor message, fires a fallback captureMessage so alerts still page", () => {
    // SCRUM-300 review: prior "silent no-op" behaviour meant
    // `throw undefined` from an SDK + a catch passing `err` could
    // suppress the alert entirely. Fallback ensures the reason
    // tag always produces a Sentry event.
    pageSentry({
      service: "next-api",
      reason: "voice-preview-failed",
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "pageSentry called with no payload (reason=voice-preview-failed)",
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("err takes precedence over message when both are supplied", () => {
    pageSentry({
      service: "next-api",
      reason: "voice-preview-failed",
      err: new Error("real exception"),
      message: "should not be used",
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
