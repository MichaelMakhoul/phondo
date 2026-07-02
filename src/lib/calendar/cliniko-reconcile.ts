import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { ClinikoAuthError, type ClinikoAppointment, type ClinikoIntegrationSettings } from "./cliniko";
import type { ClinikoContext } from "./cliniko-booking";

export interface ReconcileResult {
  /** false when the freshness gate skipped the run or a failure aborted it. */
  ran: boolean;
  cancelled: number;
  moved: number;
  scanned: number;
}

const RECONCILE_FRESHNESS_MS = 60_000;
const SKEW_OVERLAP_MS = 5 * 60_000;
const COLD_START_LOOKBACK_MS = 62 * 24 * 60 * 60_000;

const SKIP: ReconcileResult = { ran: false, cancelled: 0, moved: 0, scanned: 0 };

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
 * (frees the slot under no_overlapping_appointments), moved → retimed. Never
 * throws: any failure is logged, the cursor is left unadvanced, and the caller
 * proceeds (availability/booking already read live Cliniko).
 */
export async function reconcileClinikoOrg(
  ctx: ClinikoContext,
  organizationId: string,
  opts: { force?: boolean; nowMs?: number } = {}
): Promise<ReconcileResult> {
  const nowMs = opts.nowMs ?? Date.now();
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
    for (const a of changed) byId.set(a.id, a);
    for (const a of deleted) byId.set(a.id, a); // a delete overrides an update for the same id
    const scanned = byId.size;

    let cancelled = 0;
    let moved = 0;

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
            await applyMirrorUpdate(admin, row.id, { start_time: appt.starts_at, end_time: appt.ends_at || null });
            moved++;
          }
        } catch (rowErr) {
          // A single row (e.g. a retime that collides with another mirror row)
          // must not abort the batch. Availability reads live Cliniko regardless.
          Sentry.withScope((scope) => {
            scope.setLevel("error");
            scope.setTag("bug", "cliniko_reconcile_row_failed");
            scope.setExtras({ organizationId, mirrorId: row.id, externalId: row.external_id });
            Sentry.captureException(rowErr);
          });
        }
      }
    }

    // Advance the cursor to poll-start — only on a successful poll, and with a
    // read-before-write spread so shard/businessId/errorState are never clobbered.
    const { error: writeError } = await (admin as any)
      .from("calendar_integrations")
      .update({
        settings: { ...settings, lastReconciledAt: new Date(nowMs).toISOString() },
        updated_at: new Date(nowMs).toISOString(),
      })
      .eq("id", ctx.integrationId);
    if (writeError) {
      console.error("[ClinikoReconcile] cursor write failed:", writeError.message || writeError.code);
    }

    return { ran: true, cancelled, moved, scanned };
  } catch (err) {
    if (err instanceof ClinikoAuthError) {
      // Flag for the dashboard banner without wiping settings. The daily reconcile
      // cron sends the owner email on its next run (avoids a value-import cycle
      // with cliniko-booking's markClinikoAuthFailure).
      await (admin as any)
        .from("calendar_integrations")
        .update({ settings: { ...settings, errorState: "auth_failed" }, updated_at: new Date(nowMs).toISOString() })
        .eq("id", ctx.integrationId)
        .then((r: { error?: unknown }) => r, () => undefined);
    }
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

async function applyMirrorUpdate(admin: unknown, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await (admin as any)
    .from("appointments")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`mirror update failed: ${error.message || error.code}`);
}
