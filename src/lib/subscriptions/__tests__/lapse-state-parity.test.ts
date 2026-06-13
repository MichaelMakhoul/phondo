import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeLapseState as tsCompute,
  DEFAULT_GRACE_DAYS as TS_GRACE,
  DEFAULT_RECLAIM_DAYS as TS_RECLAIM,
  type LapseSubscription,
  type LapseConfig,
} from "../lapse-state";

// The voice server ships standalone (Fly) and cannot import from src/, so it
// carries a hand-written CommonJS port. This test is the keep-in-sync guard:
// it require()s the JS port and import()s the TS module, then runs BOTH over a
// shared fixture matrix asserting byte-identical JSON output. If you change one
// file and not the other, this fails.
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const jsPort = require(path.join(here, "../../../../voice-server/lib/lapse-state.js")) as {
  computeLapseState: (sub: unknown, now: number, cfg?: unknown) => unknown;
  DEFAULT_GRACE_DAYS: number;
  DEFAULT_RECLAIM_DAYS: number;
};

const DAY = 86_400_000;
const ANCHOR_ISO = "2026-06-01T00:00:00.000Z";
const ANCHOR = Date.parse(ANCHOR_ISO);
const GRACE_MS = TS_GRACE * DAY;
const RECLAIM_MS = TS_RECLAIM * DAY;

// Every status × every shape of anchor data (present / null / missing / unparseable).
const SUB_FIXTURES: Array<LapseSubscription | null | undefined> = [
  null,
  undefined,
  {},
  { status: undefined },
  { status: "active" },
  { status: "active", trial_end: ANCHOR_ISO, current_period_end: ANCHOR_ISO, service_ended_at: ANCHOR_ISO },
  { status: "past_due", current_period_end: ANCHOR_ISO },
  { status: "incomplete" },
  { status: "paused" },
  { status: "mystery_status_we_dont_know" },
  { status: "trialing", trial_end: ANCHOR_ISO },
  { status: "trialing", trial_end: null },
  { status: "trialing", trial_end: "not-a-date" },
  { status: "trialing" },
  { status: "canceled", service_ended_at: ANCHOR_ISO },
  { status: "canceled", service_ended_at: ANCHOR_ISO, current_period_end: "2099-01-01T00:00:00.000Z" },
  { status: "canceled", service_ended_at: null, current_period_end: ANCHOR_ISO },
  { status: "canceled", service_ended_at: "garbage", current_period_end: ANCHOR_ISO },
  { status: "canceled", service_ended_at: null, current_period_end: null },
  { status: "canceled" },
  { status: "unpaid", current_period_end: ANCHOR_ISO },
  { status: "unpaid" },
  { status: "incomplete_expired", current_period_end: ANCHOR_ISO },
  { status: "incomplete_expired", current_period_end: "garbage" },
];

// Edges around every boundary the machine cares about.
const NOW_FIXTURES: number[] = [
  ANCHOR - DAY,
  ANCHOR - 1,
  ANCHOR,
  ANCHOR + 1,
  ANCHOR + GRACE_MS - 1,
  ANCHOR + GRACE_MS,
  ANCHOR + GRACE_MS + 1,
  ANCHOR + RECLAIM_MS - 1,
  ANCHOR + RECLAIM_MS,
  ANCHOR + RECLAIM_MS + 1,
  ANCHOR + 10 * RECLAIM_MS,
];

const CFG_FIXTURES: Array<LapseConfig | undefined> = [
  undefined,
  { graceDays: 1, reclaimDays: 2 },
  { graceDays: 14 },
  { reclaimDays: 30 },
  { graceDays: 0, reclaimDays: 0 },
];

describe("lapse-state TS ↔ JS port parity", () => {
  it("exports identical constants", () => {
    expect(jsPort.DEFAULT_GRACE_DAYS).toBe(TS_GRACE);
    expect(jsPort.DEFAULT_RECLAIM_DAYS).toBe(TS_RECLAIM);
  });

  it("produces byte-identical JSON across the full status × edge × config matrix", () => {
    const mismatches: string[] = [];
    let cases = 0;

    for (const sub of SUB_FIXTURES) {
      for (const now of NOW_FIXTURES) {
        for (const cfg of CFG_FIXTURES) {
          cases++;
          const tsOut = JSON.stringify(tsCompute(sub, now, cfg));
          const jsOut = JSON.stringify(jsPort.computeLapseState(sub, now, cfg));
          if (tsOut !== jsOut) {
            mismatches.push(
              `sub=${JSON.stringify(sub)} now=${now} cfg=${JSON.stringify(cfg)}\n  ts=${tsOut}\n  js=${jsOut}`
            );
          }
        }
      }
    }

    // Sanity: the matrix actually ran (guards against an empty-loop false pass).
    expect(cases).toBe(SUB_FIXTURES.length * NOW_FIXTURES.length * CFG_FIXTURES.length);
    expect(mismatches).toEqual([]);
  });
});
