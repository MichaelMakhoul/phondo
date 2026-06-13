import { describe, it, expect } from "vitest";
import {
  computeLapseState,
  DEFAULT_GRACE_DAYS,
  DEFAULT_RECLAIM_DAYS,
  type LapseSubscription,
} from "../lapse-state";

const DAY = 86_400_000;
const ANCHOR_ISO = "2026-06-01T00:00:00.000Z";
const ANCHOR = Date.parse(ANCHOR_ISO);
const GRACE_MS = DEFAULT_GRACE_DAYS * DAY; // 7d
const RECLAIM_MS = DEFAULT_RECLAIM_DAYS * DAY; // 90d

const iso = (ms: number) => new Date(ms).toISOString();

describe("computeLapseState — constants", () => {
  it("exposes the documented default windows", () => {
    expect(DEFAULT_GRACE_DAYS).toBe(7);
    expect(DEFAULT_RECLAIM_DAYS).toBe(90);
  });
});

describe("computeLapseState — fail-open defaults", () => {
  it("null sub → active + callable, no anchors", () => {
    expect(computeLapseState(null, ANCHOR)).toEqual({
      state: "active",
      anchorAt: null,
      graceEndsAt: null,
      releaseEligibleAt: null,
      callable: true,
    });
  });

  it("undefined sub → active + callable", () => {
    expect(computeLapseState(undefined, ANCHOR)).toEqual({
      state: "active",
      anchorAt: null,
      graceEndsAt: null,
      releaseEligibleAt: null,
      callable: true,
    });
  });

  it("unknown status → active + callable", () => {
    expect(computeLapseState({ status: "frobnicate" } as LapseSubscription, ANCHOR)).toEqual({
      state: "active",
      anchorAt: null,
      graceEndsAt: null,
      releaseEligibleAt: null,
      callable: true,
    });
  });
});

describe("computeLapseState — active-family statuses are always callable", () => {
  // These statuses never enter the machine: they short-circuit to active.
  for (const status of ["active", "past_due", "incomplete", "paused"]) {
    it(`${status} → active + callable (ignores any timestamps)`, () => {
      const sub: LapseSubscription = {
        status,
        trial_end: ANCHOR_ISO,
        current_period_end: ANCHOR_ISO,
        canceled_at: ANCHOR_ISO,
      };
      // Far in the future — proves these statuses never lapse.
      expect(computeLapseState(sub, ANCHOR + 10 * RECLAIM_MS)).toEqual({
        state: "active",
        anchorAt: null,
        graceEndsAt: null,
        releaseEligibleAt: null,
        callable: true,
      });
    });
  }

  it("past_due is DELIBERATELY callable (Stripe dunning grace)", () => {
    const r = computeLapseState({ status: "past_due", current_period_end: ANCHOR_ISO }, ANCHOR + 5 * DAY);
    expect(r.state).toBe("active");
    expect(r.callable).toBe(true);
  });
});

describe("computeLapseState — trialing", () => {
  const sub: LapseSubscription = { status: "trialing", trial_end: ANCHOR_ISO };

  it("now < trial_end → active (full shape, grace window still computed)", () => {
    expect(computeLapseState(sub, ANCHOR - DAY)).toEqual({
      state: "active",
      anchorAt: ANCHOR_ISO,
      graceEndsAt: iso(ANCHOR + GRACE_MS),
      releaseEligibleAt: null,
      callable: true,
    });
  });

  it("now == trial_end (edge) → still active", () => {
    const r = computeLapseState(sub, ANCHOR);
    expect(r.state).toBe("active");
    expect(r.callable).toBe(true);
  });

  it("now == trial_end + 1ms → in_grace", () => {
    const r = computeLapseState(sub, ANCHOR + 1);
    expect(r.state).toBe("in_grace");
    expect(r.callable).toBe(true);
  });

  it("now == trial_end + grace exactly (edge) → in_grace", () => {
    const r = computeLapseState(sub, ANCHOR + GRACE_MS);
    expect(r.state).toBe("in_grace");
    expect(r.callable).toBe(true);
  });

  it("now == trial_end + grace + 1ms → lapsed (not callable)", () => {
    expect(computeLapseState(sub, ANCHOR + GRACE_MS + 1)).toEqual({
      state: "lapsed",
      anchorAt: ANCHOR_ISO,
      graceEndsAt: iso(ANCHOR + GRACE_MS),
      releaseEligibleAt: null,
      callable: false,
    });
  });

  it("trialing NEVER reaches release_pending, even far past reclaim", () => {
    const r = computeLapseState(sub, ANCHOR + 10 * RECLAIM_MS);
    expect(r.state).toBe("lapsed");
    expect(r.releaseEligibleAt).toBeNull();
  });

  it("no trial_end → active (fail-open, no anchor)", () => {
    expect(computeLapseState({ status: "trialing", trial_end: null }, ANCHOR)).toEqual({
      state: "active",
      anchorAt: null,
      graceEndsAt: null,
      releaseEligibleAt: null,
      callable: true,
    });
  });

  it("unparseable trial_end → active (fail-open)", () => {
    const r = computeLapseState({ status: "trialing", trial_end: "not-a-date" }, ANCHOR + 100 * DAY);
    expect(r.state).toBe("active");
    expect(r.anchorAt).toBeNull();
  });
});

describe("computeLapseState — canceled (the only path to release_pending)", () => {
  const sub: LapseSubscription = { status: "canceled", canceled_at: ANCHOR_ISO };

  it("now == anchor (period not yet ended) → in_grace, full shape incl. releaseEligibleAt", () => {
    expect(computeLapseState(sub, ANCHOR)).toEqual({
      state: "in_grace",
      anchorAt: ANCHOR_ISO,
      graceEndsAt: iso(ANCHOR + GRACE_MS),
      releaseEligibleAt: iso(ANCHOR + RECLAIM_MS),
      callable: true,
    });
  });

  it("now == anchor + grace exactly (edge) → in_grace", () => {
    const r = computeLapseState(sub, ANCHOR + GRACE_MS);
    expect(r.state).toBe("in_grace");
    expect(r.callable).toBe(true);
  });

  it("now == anchor + grace + 1ms → lapsed", () => {
    const r = computeLapseState(sub, ANCHOR + GRACE_MS + 1);
    expect(r.state).toBe("lapsed");
    expect(r.callable).toBe(false);
  });

  it("now == anchor + reclaim exactly (edge) → lapsed", () => {
    const r = computeLapseState(sub, ANCHOR + RECLAIM_MS);
    expect(r.state).toBe("lapsed");
    expect(r.callable).toBe(false);
  });

  it("now == anchor + reclaim + 1ms → release_pending (full shape)", () => {
    expect(computeLapseState(sub, ANCHOR + RECLAIM_MS + 1)).toEqual({
      state: "release_pending",
      anchorAt: ANCHOR_ISO,
      graceEndsAt: iso(ANCHOR + GRACE_MS),
      releaseEligibleAt: iso(ANCHOR + RECLAIM_MS),
      callable: false,
    });
  });

  it("canceled_at null → falls back to current_period_end as the anchor", () => {
    const r = computeLapseState(
      { status: "canceled", canceled_at: null, current_period_end: ANCHOR_ISO },
      ANCHOR + GRACE_MS + 1
    );
    expect(r).toEqual({
      state: "lapsed",
      anchorAt: ANCHOR_ISO,
      graceEndsAt: iso(ANCHOR + GRACE_MS),
      releaseEligibleAt: iso(ANCHOR + RECLAIM_MS),
      callable: false,
    });
  });

  it("canceled_at present takes precedence over current_period_end", () => {
    const r = computeLapseState(
      { status: "canceled", canceled_at: ANCHOR_ISO, current_period_end: "2099-01-01T00:00:00.000Z" },
      ANCHOR
    );
    expect(r.anchorAt).toBe(ANCHOR_ISO);
  });

  it("missing anchor (both timestamps absent) → active (fail-open, no spurious lapsed)", () => {
    expect(computeLapseState({ status: "canceled" }, ANCHOR + 10 * RECLAIM_MS)).toEqual({
      state: "active",
      anchorAt: null,
      graceEndsAt: null,
      releaseEligibleAt: null,
      callable: true,
    });
  });

  it("both timestamps null → active (fail-open)", () => {
    const r = computeLapseState(
      { status: "canceled", canceled_at: null, current_period_end: null },
      ANCHOR + 10 * RECLAIM_MS
    );
    expect(r.state).toBe("active");
    expect(r.callable).toBe(true);
  });
});

describe("computeLapseState — unpaid / incomplete_expired (never release_pending)", () => {
  for (const status of ["unpaid", "incomplete_expired"]) {
    const sub: LapseSubscription = { status, current_period_end: ANCHOR_ISO };

    it(`${status}: now == anchor + grace exactly → in_grace`, () => {
      expect(computeLapseState(sub, ANCHOR + GRACE_MS)).toEqual({
        state: "in_grace",
        anchorAt: ANCHOR_ISO,
        graceEndsAt: iso(ANCHOR + GRACE_MS),
        releaseEligibleAt: null,
        callable: true,
      });
    });

    it(`${status}: now == anchor + grace + 1ms → lapsed`, () => {
      expect(computeLapseState(sub, ANCHOR + GRACE_MS + 1)).toEqual({
        state: "lapsed",
        anchorAt: ANCHOR_ISO,
        graceEndsAt: iso(ANCHOR + GRACE_MS),
        releaseEligibleAt: null,
        callable: false,
      });
    });

    it(`${status}: far past reclaim stays lapsed (never release_pending)`, () => {
      const r = computeLapseState(sub, ANCHOR + 10 * RECLAIM_MS);
      expect(r.state).toBe("lapsed");
      expect(r.releaseEligibleAt).toBeNull();
    });

    it(`${status}: missing current_period_end → active (fail-open)`, () => {
      expect(computeLapseState({ status }, ANCHOR + 100 * DAY)).toEqual({
        state: "active",
        anchorAt: null,
        graceEndsAt: null,
        releaseEligibleAt: null,
        callable: true,
      });
    });
  }
});

describe("computeLapseState — custom config windows", () => {
  it("honours overridden graceDays / reclaimDays", () => {
    const sub: LapseSubscription = { status: "canceled", canceled_at: ANCHOR_ISO };
    const cfg = { graceDays: 1, reclaimDays: 2 };
    // Day 0.5 → within 1-day grace
    expect(computeLapseState(sub, ANCHOR + DAY / 2, cfg).state).toBe("in_grace");
    // Day 1.5 → past grace, within 2-day reclaim
    expect(computeLapseState(sub, ANCHOR + 1.5 * DAY, cfg).state).toBe("lapsed");
    // Day 3 → past reclaim
    const r = computeLapseState(sub, ANCHOR + 3 * DAY, cfg);
    expect(r.state).toBe("release_pending");
    expect(r.releaseEligibleAt).toBe(iso(ANCHOR + 2 * DAY));
  });
});
