import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { type ClinikoAppointment, type ClinikoContext, type ClinikoIntegrationSettings, type PagedResult } from "./cliniko";
import { mergeIntegrationSettings } from "./cliniko-settings";

export interface ReconcileResult {
  /** false when the freshness gate skipped the run or a failure aborted it. */
  ran: boolean;
  cancelled: number;
  moved: number;
  scanned: number;
  /** mirror rows that failed to update mid-batch (each Sentry'd individually). */
  failed: number;
}

const RECONCILE_FRESHNESS_MS = 60_000;
const SKEW_OVERLAP_MS = 5 * 60_000;
const COLD_START_LOOKBACK_MS = 62 * 24 * 60 * 60_000;

const SKIP: ReconcileResult = { ran: false, cancelled: 0, moved: 0, scanned: 0, failed: 0 };

interface MirrorRow {
  id: string;
  external_id: string;
  start_time: string;
  status: string;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * SCRUM-482: pull-based reconciliation (Cliniko has no webhooks). Polls Cliniko
 * for upcoming appointments changed since the per-integration cursor and drags
 * the matching mirror rows back in line — cancelled/deleted → status='cancelled'
 * (frees the slot under no_overlapping_practitioner_appointments, since Cliniko
 * mirror rows always carry a practitioner_id), moved → retimed. Never throws:
 * any failure is logged + Sentry'd, the cursor is left unadvanced, and the caller
 * proceeds (availability/booking already read live Cliniko).
 *
 * Auth failures are deliberately NOT flagged here — the caller's own downstream
 * Cliniko call raises the same 401 and routes to markClinikoAuthFailure (which
 * flags the banner AND emails the owner, deduped on errorState). Flagging here
 * would trip that dedupe and suppress the owner email.
 */
export async function reconcileClinikoOrg(
  ctx: ClinikoContext,
  opts: { force?: boolean; nowMs?: number } = {}
): Promise<ReconcileResult> {
  const { organizationId } = ctx;
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const admin = createAdminClient();

  // Read settings fresh — the cursor + freshness marker live here, not on ctx.
  const { data: intRow, error: readError } = await (admin as any)
    .from("calendar_integrations")
    .select("settings")
    .eq("id", ctx.integrationId)
    .single();
  if (readError) {
    console.error("[ClinikoReconcile] settings read failed:", readError.message || readError.code);
    return SKIP;
  }
  const settings = (intRow?.settings || {}) as ClinikoIntegrationSettings;
  const lastMs = settings.lastReconciledAt ? Date.parse(settings.lastReconciledAt) : 0;

  if (!opts.force && lastMs && nowMs - lastMs < RECONCILE_FRESHNESS_MS) {
    return SKIP;
  }

  const sinceMs = lastMs
    ? Math.max(lastMs - SKEW_OVERLAP_MS, nowMs - COLD_START_LOOKBACK_MS)
    : nowMs - COLD_START_LOOKBACK_MS;
  const since = new Date(sinceMs).toISOString();

  try {
    const [changed, deleted] = await Promise.all([
      ctx.client.listChangedAppointments({ since, today: isoDate(nowMs), businessId: ctx.businessId }),
      ctx.client.listDeletedAppointments({ since }),
    ]);

    const byId = new Map<string, ClinikoAppointment>();
    for (const a of changed.items) byId.set(a.id, a);
    for (const a of deleted.items) byId.set(a.id, a); // a delete overrides an update for the same id
    const scanned = byId.size;

    let cancelled = 0;
    let moved = 0;
    let failed = 0;

    if (scanned > 0) {
      const ids = [...byId.keys()];
      const { data: mirrors, error: mirrorError } = await (admin as any)
        .from("appointments")
        .select("id, external_id, start_time, status")
        .eq("organization_id", organizationId)
        .eq("provider", "cliniko")
        .in("external_id", ids)
        .in("status", ["confirmed", "pending"]);
      if (mirrorError) throw new Error(`mirror load failed: ${mirrorError.message || mirrorError.code}`);

      for (const row of (mirrors || []) as MirrorRow[]) {
        const appt = byId.get(row.external_id);
        if (!appt) continue;
        try {
          if (appt.cancelled_at || appt.deleted_at) {
            await applyMirrorUpdate(admin, row.id, { status: "cancelled" });
            cancelled++;
          } else if (appt.starts_at && Date.parse(appt.starts_at) !== Date.parse(row.start_time)) {
            // Only overwrite end_time when Cliniko actually gave us one (a moved
            // appointment always does); never blank a known end on a null.
            const patch: Record<string, unknown> = { start_time: appt.starts_at };
            if (appt.ends_at) patch.end_time = appt.ends_at;
            await applyMirrorUpdate(admin, row.id, patch);
            moved++;
          }
        } catch (rowErr) {
          // A single row (e.g. a retime that collides with another mirror row)
          // must not abort the batch. Availability reads live Cliniko regardless.
          failed++;
          Sentry.withScope((scope) => {
            scope.setLevel("error");
            scope.setTag("bug", "cliniko_reconcile_row_failed");
            scope.setExtras({ organizationId, mirrorId: row.id, externalId: row.external_id });
            Sentry.captureException(rowErr);
          });
        }
      }
    }

    // Decide how far the cursor may safely advance.
    // - A per-row update failure (transient DB error) must be retried, so HOLD
    //   the cursor entirely and re-poll the whole window next run.
    // - A truncated poll (page cap hit) with no row failures made forward
    //   progress: because the polls are sorted oldest-change-first, everything up
    //   to the NEWEST record we fetched is fully resolved, and the dropped tail
    //   is strictly newer. Advance to that watermark (never backward) so the next
    //   run continues from there instead of re-reading the same 2000 forever
    //   (SCRUM-490). Still surface it — a truncating org needs attention.
    // - A complete, successful poll advances to poll-start.
    const truncatedFloorMs = truncatedWatermarkMs(changed, deleted);
    if (failed > 0) {
      reportIncomplete(ctx, organizationId, changed, deleted, failed, "held");
    } else if (truncatedFloorMs !== null) {
      // Report AFTER the write so the disposition reflects reality: if the cursor
      // write itself fails, the cursor is really "held", not "advanced", and the
      // monitoring must not claim progress that didn't persist.
      const advanceMs = Math.max(truncatedFloorMs, lastMs);
      const advanced = advanceMs > lastMs && (await writeCursor(admin, ctx.integrationId, new Date(advanceMs).toISOString(), settings));
      reportIncomplete(ctx, organizationId, changed, deleted, failed, advanced ? "advanced" : "held");
    } else {
      await writeCursor(admin, ctx.integrationId, nowIso, settings);
    }

    return { ran: true, cancelled, moved, scanned, failed };
  } catch (err) {
    // Includes ClinikoAuthError — intentionally NOT flagged here (see the header
    // comment); the caller's own 401 handling owns the flag + owner email.
    console.error("[ClinikoReconcile] reconcile failed:", err instanceof Error ? err.message : String(err));
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("bug", "cliniko_reconcile_failed");
      scope.setExtras({ organizationId, integrationId: ctx.integrationId });
      Sentry.captureException(err);
    });
    return SKIP;
  }
}

function maxTs(items: ClinikoAppointment[], key: "updated_at" | "deleted_at"): number {
  let max = 0;
  for (const a of items) {
    const raw = a[key];
    const t = raw ? Date.parse(raw) : 0;
    if (t > max) max = t;
  }
  return max;
}

/**
 * The newest timestamp we can safely advance the cursor to given truncation.
 * For each truncated (incomplete) list, everything up to its newest FETCHED
 * record is resolved and the dropped tail is strictly newer (lists are sorted
 * ascending). The safe watermark is the MIN across truncated lists — advancing
 * past a non-truncated list's later records is fine (they were fully read), but
 * never past a truncated list's fetched window. Null when nothing truncated.
 */
function truncatedWatermarkMs(
  changed: PagedResult<ClinikoAppointment>,
  deleted: PagedResult<ClinikoAppointment>
): number | null {
  const bounds: number[] = [];
  if (changed.truncated) bounds.push(maxTs(changed.items, "updated_at"));
  if (deleted.truncated) bounds.push(maxTs(deleted.items, "deleted_at"));
  return bounds.length ? Math.min(...bounds) : null;
}

function reportIncomplete(
  ctx: ClinikoContext,
  organizationId: string,
  changed: PagedResult<ClinikoAppointment>,
  deleted: PagedResult<ClinikoAppointment>,
  failed: number,
  cursor: "advanced" | "held"
): void {
  Sentry.withScope((scope) => {
    scope.setLevel("warning");
    scope.setTag("bug", "cliniko_reconcile_incomplete");
    scope.setExtras({
      organizationId,
      integrationId: ctx.integrationId,
      changedTruncated: changed.truncated,
      deletedTruncated: deleted.truncated,
      failed,
      cursor,
    });
    Sentry.captureMessage(`Cliniko reconcile poll incomplete — cursor ${cursor}`);
  });
}

/**
 * Advance the cursor via an atomic single-key merge (SCRUM-489) so a concurrent
 * writer's shard/businessId/lastSyncedAt is never clobbered. A successful poll
 * proves auth works, so clear a stale auth_failed too (its own single-key patch,
 * never reverting a concurrent sync_failed).
 */
async function writeCursor(
  admin: unknown,
  integrationId: string,
  iso: string,
  settings: ClinikoIntegrationSettings
): Promise<boolean> {
  const patch: Record<string, unknown> = { lastReconciledAt: iso };
  if (settings.errorState === "auth_failed") patch.errorState = null;
  const { error } = await mergeIntegrationSettings(admin, integrationId, patch);
  if (error) {
    // Not data loss — the window is idempotently re-polled next run — but a
    // PERSISTENT write failure means the org re-reads its whole window forever
    // (frozen cursor, wasted Cliniko budget), so alert, don't just console.
    console.error("[ClinikoReconcile] cursor write failed:", error.message || error.code);
    Sentry.withScope((scope) => {
      scope.setLevel("warning");
      scope.setTag("bug", "cliniko_reconcile_cursor_write_failed");
      scope.setExtras({ integrationId, error: error.message || error.code });
      Sentry.captureMessage("Cliniko reconcile cursor write failed — org will re-poll the full window until it succeeds");
    });
    return false;
  }
  return true;
}

async function applyMirrorUpdate(admin: unknown, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await (admin as any)
    .from("appointments")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`mirror update failed: ${error.message || error.code}`);
}
