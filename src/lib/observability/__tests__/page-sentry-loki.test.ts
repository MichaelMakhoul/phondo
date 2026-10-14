import { describe, it, expect, vi, beforeEach } from "vitest";
import { pageSentry } from "../page-sentry";
import { pushToLoki } from "../loki-push";

// Vercel Hobby has no log drain, so pushToLoki IS the delivery path to Grafana,
// and the "Next.js — error logged" rule queries {service_name="phondo-next"}.
vi.mock("../loki-push", () => ({ pushToLoki: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  withScope: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("pageSentry -> Loki delivery wiring", () => {
  it("pushes the exact [ALERT:error] line with the labels the Grafana rule queries", () => {
    pageSentry({ service: "next-api", reason: "voice-preview-failed", level: "error", message: "boom" });

    expect(pushToLoki).toHaveBeenCalledTimes(1);
    expect(pushToLoki).toHaveBeenCalledWith(
      "[ALERT:error] [next-api] boom | reason=voice-preview-failed",
      { service_name: "phondo-next", level: "error" },
    );
  });

  it("labels default-level pages as warning", () => {
    pageSentry({ service: "next-cron", reason: "supabase-ping-failed", message: "x" });

    expect(pushToLoki).toHaveBeenCalledWith(
      expect.stringMatching(/^\[ALERT:warning\] /),
      { service_name: "phondo-next", level: "warning" },
    );
  });
});
