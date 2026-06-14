import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeLapseState, type LapseConfig } from "@/lib/subscriptions/lapse-state";
import { releaseNumber } from "@/lib/twilio/client";
import * as Sentry from "@sentry/nextjs";

/**
 * SCRUM-479 (subscription-lapse epic SCRUM-474) — the DESTRUCTIVE step.
 *
 * Releasing a real Twilio number is IRREVERSIBLE and is permanent customer
 * churn, so EVERY check here is fail-closed: a number is released only when
 * ALL guards can be POSITIVELY evaluated and ALL pass; if any check errors or
 * can't be evaluated, the number is SKIPPED. The guards (all required):
 *
 *   1. Subscription is `canceled` AND computeLapseState === 'release_pending'
 *      (now is past the cancellation anchor + RECLAIM_WINDOW_DAYS, default 90).
 *   2. The phone row is a PURCHASED Twilio number (source_type='purchased' —
 *      never a 'forwarded'/customer-owned number), still is_active, with a
 *      non-empty twilio_sid.
 *   3. The `release_warning` dunning email was CONFIRMED delivered for the org
 *      (cron_send_ledger row, job_name='subscription-dunning',
 *      period_key LIKE 'release_warning:%', delivered_at NOT NULL). We never
 *      release without a confirmed warning.
 *   4. SAFETY VETO: NO inbound call landed on the number in the last
 *      INBOUND_VETO_DAYS days — a published, still-live line is never reclaimed.
 *
 * MASTER GUARDRAIL — dormant by default: nothing is actually released unless
 * ENABLE_NUMBER_RELEASE_SWEEP is exactly "true". Otherwise the cron computes
 * full eligibility and logs a DRY-RUN line per number, making NO carrier call
 * and NO DB mutation. This mirrors the dormant-by-default ENFORCE_SUBSCRIPTION_GATE.
 */

// Matches daily-summary / subscription-dunning: 60s is the Hobby plan ceiling
// (vercel.json sets no per-function override).
export const maxDuration = 60;

const JOB_NAME = "number-release-sweep";
// The dunning cron writes the release_warning ledger rows we gate on.
const DUNNING_JOB_NAME = "subscription-dunning";
const DAY_MS = 86_400_000;

// Safety-veto lookback (guard 4): a purchased number with ANY inbound call in
// this window is treated as a still-published live line and is NEVER released.
const INBOUND_VETO_DAYS = 30;

// Bound the scan (LIMIT + next-day recovery, mirroring subscription-dunning).
// Canceled subs ordered by current_period_end ascending → the longest-overdue
// (deepest into release_pending) numbers are reclaimed first; anything past the
// limit recovers on the next daily run. Already soft-released numbers fall out
// of the per-row guard (is_active=false) so they never re-consume a slot.
const MAX_CANCELED_SUBS_PER_RUN = 500;

/**
 * Master guardrail. Read at REQUEST time (not module load) so the Vercel env
 * can be flipped without a redeploy and tests can toggle it — same posture as
 * the voice gate's ENFORCE_SUBSCRIPTION_GATE. Only the exact string "true"
 * arms the sweep; unset / anything-else stays in dry-run.
 */
function releaseSweepEnabled(): boolean {
  return process.env.ENABLE_NUMBER_RELEASE_SWEEP === "true";
}

/**
 * Optional grace/reclaim overrides parsed exactly like the voice gate's
 * readLapseConfig (finite & strictly-positive only) so the sweep, the call
 * gate and the dunning cron all measure the SAME active→…→release_pending
 * timeline. A fat-fingered non-positive value is ignored, falling back to the
 * machine's DEFAULT_RECLAIM_DAYS rather than collapsing the window.
 */
function readLapseConfig(): LapseConfig {
  const cfg: LapseConfig = {};
  const grace = Number(process.env.GRACE_WINDOW_DAYS);
  if (Number.isFinite(grace) && grace > 0) cfg.graceDays = grace;
  const reclaim = Number(process.env.RECLAIM_WINDOW_DAYS);
  if (Number.isFinite(reclaim) && reclaim > 0) cfg.reclaimDays = reclaim;
  return cfg;
}

/** Mask all but the last 4 digits (parity with the dunning email mask). */
function maskNumber(raw: string | null | undefined): string {
  if (!raw) return "(unknown)";
  return raw.replace(/\d(?=\d{4})/g, "•");
}

/**
 * Guard 3: true when a release_warning dunning email is CONFIRMED delivered for
 * the org FOR THE CURRENT LAPSE CYCLE.
 *
 * The dunning cron mints a cycle-specific ledger key
 * `release_warning:<anchorYYYYMMDD>` (one per cancellation anchor). We bind the
 * guard to the CURRENT cycle's anchor with an exact `.eq(period_key, …)` rather
 * than a `LIKE 'release_warning:%'`. A wildcard would let a STALE warning from a
 * PRIOR cancel→resubscribe→re-cancel cycle (a different anchor) satisfy the
 * guard for a new cycle whose warning was never delivered — and release a number
 * we never warned about. `anchorKey` is derived from the SAME computeLapseState
 * anchor the dunning cron uses, so the keys line up exactly.
 *
 * Returns null on a query error so the caller can fail CLOSED (skip) rather than
 * treat an unverifiable warning as present.
 */
async function releaseWarningDelivered(
  supabase: any,
  organizationId: string,
  anchorKey: string
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("cron_send_ledger")
    .select("period_key")
    .eq("job_name", DUNNING_JOB_NAME)
    .eq("organization_id", organizationId)
    .eq("period_key", `release_warning:${anchorKey}`)
    .not("delivered_at", "is", null)
    .limit(1);
  if (error) return null;
  return (data?.length ?? 0) > 0;
}

/**
 * Guard 4: true when the number received >=1 inbound call within
 * INBOUND_VETO_DAYS. Counts ANY inbound call (no status / spam filter) — any
 * inbound traffic means the line is still published and must not be reclaimed.
 * Returns null on a query error so the caller can fail CLOSED (skip).
 */
async function hasRecentInbound(
  supabase: any,
  phoneNumberId: string,
  now: number
): Promise<boolean | null> {
  const since = new Date(now - INBOUND_VETO_DAYS * DAY_MS).toISOString();
  const { data, error } = await supabase
    .from("calls")
    .select("id")
    .eq("phone_number_id", phoneNumberId)
    .eq("direction", "inbound")
    .gte("created_at", since)
    .limit(1);
  if (error) return null;
  return (data?.length ?? 0) > 0;
}

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req, JOB_NAME);
  if (authFail) return authFail;

  const supabase = createAdminClient();
  const now = Date.now();
  const cfg = readLapseConfig();
  const enabled = releaseSweepEnabled();

  // ARMING FOOT-GUN PREFLIGHT (armed path only). The soft-release UPDATE writes
  // `released_at`, which only exists after migration 00158. If the owner flips
  // ENABLE_NUMBER_RELEASE_SWEEP=true BEFORE applying 00158, every carrier
  // release would still succeed (IRREVERSIBLE) but the follow-up soft-release
  // UPDATE would error — stranding "lying" rows (released at carrier, still
  // is_active). So before touching a single number, prove the column exists with
  // a cheap probe; if it is missing (the probe errors), abort the WHOLE run
  // loudly without releasing anything. Dry-run never writes, so it skips this.
  if (enabled) {
    const { error: preflightError } = await (supabase as any)
      .from("phone_numbers")
      .select("released_at")
      .limit(1);
    if (preflightError) {
      console.error(
        "[release-sweep] aborting: migration 00158 not applied — released_at column missing",
        preflightError
      );
      Sentry.captureMessage(
        "[release-sweep] aborting: migration 00158 not applied — released_at column missing",
        "error"
      );
      return NextResponse.json(
        {
          error:
            "released_at column missing — migration 00158 not applied; sweep aborted before any release",
        },
        { status: 500 }
      );
    }
  }

  // Only `canceled` subscriptions ever reach release_pending (computeLapseState
  // contract) — scan just those, longest-overdue first.
  const { data: subs, error } = await (supabase as any)
    .from("subscriptions")
    .select("organization_id, status, trial_end, current_period_end, service_ended_at")
    .eq("status", "canceled")
    .order("current_period_end", { ascending: true })
    .limit(MAX_CANCELED_SUBS_PER_RUN);

  if (error) {
    console.error("[release-sweep] Failed to query canceled subscriptions:", error);
    return NextResponse.json({ error: "Failed to query subscriptions" }, { status: 500 });
  }

  if (subs && subs.length === MAX_CANCELED_SUBS_PER_RUN) {
    console.warn(
      `[release-sweep] Hit ${MAX_CANCELED_SUBS_PER_RUN}-subscription scan limit — more may be eligible and will be processed next run`
    );
  }

  let released = 0; // numbers actually released at the carrier (live mode only)
  let wouldRelease = 0; // numbers that passed every guard (dry-run accounting)
  let skipped = 0; // a guard blocked release (state / source / sid / warning / veto)
  let failed = 0; // carrier or DB error during an actual release

  for (const sub of subs ?? []) {
    const organizationId = sub.organization_id;
    try {
      // GUARD 1 — must be canceled AND past the reclaim window. The query
      // already filters status, but re-assert defensively (the guard contract
      // is status==='canceled' AND state==='release_pending').
      if (sub.status !== "canceled") {
        skipped++;
        continue;
      }
      const lapse = computeLapseState(sub, now, cfg);
      if (lapse.state !== "release_pending") {
        skipped++;
        continue;
      }

      // Bind GUARD 3 to THIS lapse cycle. The dunning cron mints a
      // cycle-specific ledger key release_warning:<anchorYYYYMMDD> from the SAME
      // computeLapseState anchor, so derive the identical key here and match it
      // exactly. release_pending always carries a non-null anchor
      // (computeLapseState fails open to `active` when the anchor is missing);
      // if it is somehow null we cannot cycle-bind the guard → skip
      // (fail-closed) rather than risk matching a stale warning.
      const anchorKey = lapse.anchorAt
        ? lapse.anchorAt.slice(0, 10).replace(/-/g, "")
        : null;
      if (!anchorKey) {
        console.error(
          `[release-sweep] release_pending org=${organizationId} but lapse anchor is missing — skipping (cannot cycle-bind the warning guard)`
        );
        skipped++;
        continue;
      }

      // GUARD 3 (per-org) — a release_warning email was CONFIRMED delivered FOR
      // THIS CYCLE. Checked before loading phone rows: no confirmed warning →
      // never release, whatever the number's state. Fail closed on a query error.
      const warned = await releaseWarningDelivered(supabase, organizationId, anchorKey);
      if (warned === null) {
        console.error(
          `[release-sweep] Could not verify release_warning delivery for org=${organizationId} — skipping (fail-closed)`
        );
        skipped++;
        continue;
      }
      if (!warned) {
        skipped++;
        continue;
      }

      // Load the org's phone numbers and guard each one individually. Query by
      // org only — the source_type / is_active / twilio_sid gate lives in code
      // (single source of truth, fully tested) below.
      const { data: phones, error: phonesError } = await (supabase as any)
        .from("phone_numbers")
        .select("id, phone_number, twilio_sid, source_type, is_active")
        .eq("organization_id", organizationId);
      if (phonesError) {
        console.error(
          `[release-sweep] Could not load phone numbers for org=${organizationId} — skipping (fail-closed):`,
          phonesError
        );
        skipped++;
        continue;
      }

      for (const phone of phones ?? []) {
        const masked = maskNumber(phone.phone_number);

        // GUARD 2 — purchased Twilio number, still active, with a SID. NEVER a
        // forwarded / customer-owned number.
        if (phone.source_type !== "purchased") {
          skipped++;
          continue;
        }
        if (phone.is_active !== true) {
          skipped++;
          continue;
        }
        const twilioSid = typeof phone.twilio_sid === "string" ? phone.twilio_sid.trim() : "";
        if (!twilioSid) {
          skipped++;
          continue;
        }

        // GUARD 4 — safety veto: no inbound call to this number in the window.
        // Fail closed on a query error (cannot prove the line is dormant).
        const recentInbound = await hasRecentInbound(supabase, phone.id, now);
        if (recentInbound === null) {
          console.error(
            `[release-sweep] Could not check recent inbound calls for ${masked} org=${organizationId} — skipping (fail-closed)`
          );
          skipped++;
          continue;
        }
        if (recentInbound) {
          console.log(
            `[release-sweep] SKIP ${masked} org=${organizationId} — inbound call within ${INBOUND_VETO_DAYS}d (still a live line)`
          );
          skipped++;
          continue;
        }

        // Every guard passed.
        if (!enabled) {
          // MASTER GUARDRAIL: dry-run — no carrier call, no DB mutation.
          console.log(
            `[release-sweep] DRY-RUN would release ${masked} org=${organizationId} (reclaim met, warning delivered, no recent calls)`
          );
          wouldRelease++;
          continue;
        }

        // LIVE — carrier release FIRST, then soft-release the row. A Twilio
        // failure on one number is logged and the sweep CONTINUES to the next
        // (the whole cron never throws on a single number).
        let reconciledAlreadyGone = false;
        try {
          await releaseNumber(twilioSid);
        } catch (carrierErr) {
          // SELF-HEAL on a 404. releaseNumber does a bare .remove() that THROWS
          // a 404 (RestException status 404 / code 20404) when the SID is
          // already released. That happens when a PRIOR run released the number
          // at the carrier but its soft-release UPDATE failed — leaving a row
          // that "lies" (is_active still true). Re-attempting would 404 every
          // day and be counted failed forever. On THAT specific error, fall
          // through to the soft-release UPDATE and count it RECONCILED, turning
          // the daily re-attempt into a real heal. Any OTHER error stays
          // failed + continue (the cron never throws on a single number).
          const e = carrierErr as { status?: number; code?: number } | null;
          const alreadyGone = e?.status === 404 || e?.code === 20404;
          if (!alreadyGone) {
            console.error(
              `[release-sweep] Twilio release FAILED for ${masked} org=${organizationId} — continuing to next number:`,
              carrierErr
            );
            Sentry.captureMessage(
              `Number release sweep: Twilio release failed for org ${organizationId}`,
              "error"
            );
            failed++;
            continue;
          }
          reconciledAlreadyGone = true;
          console.warn(
            `[release-sweep] ${masked} org=${organizationId} already released at carrier (404) — reconciling the soft-release row`
          );
        }

        // SOFT-release: keep the row (calls FK + audit), mark it inactive +
        // stamp released_at. Do NOT delete. Reached both after a fresh carrier
        // release AND on the 404 self-heal path above.
        const { error: updateError } = await (supabase as any)
          .from("phone_numbers")
          .update({ is_active: false, released_at: new Date().toISOString() })
          .eq("id", phone.id);
        if (updateError) {
          // Carrier already released but the row still says active — it now
          // lies. A later run re-attempts release; the carrier 404 is detected
          // above and RECONCILED (heals this row), so this is loud but
          // self-correcting (never a double charge, never a permanent failure).
          console.error(
            `[release-sweep] Released ${masked} at carrier but FAILED to soft-release the row for org=${organizationId} — row now lies (is_active still true):`,
            updateError
          );
          Sentry.captureMessage(
            `Number release sweep: soft-release DB update failed after carrier release for org ${organizationId}`,
            "error"
          );
          failed++;
          continue;
        }

        console.log(
          reconciledAlreadyGone
            ? `[release-sweep] RECONCILED ${masked} org=${organizationId} (already released at carrier; row healed)`
            : `[release-sweep] RELEASED ${masked} org=${organizationId}`
        );
        released++;
      }
    } catch (err) {
      console.error(`[release-sweep] Error processing org=${organizationId}:`, err);
      failed++;
    }
  }

  console.log(
    `[release-sweep] ${enabled ? "LIVE" : "DRY-RUN"} — released ${released}, wouldRelease ${wouldRelease}, skipped ${skipped}, failed ${failed}`
  );

  return NextResponse.json({ enabled, released, wouldRelease, skipped, failed });
}
