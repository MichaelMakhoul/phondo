import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeDecrypt } from "@/lib/security/encryption";
import { ClinikoClient, ClinikoAuthError } from "@/lib/calendar/cliniko";
import { syncClinikoCatalog } from "@/lib/calendar/cliniko-sync";
import { mergeIntegrationSettings } from "@/lib/calendar/cliniko-settings";
import * as Sentry from "@sentry/nextjs";

/**
 * SCRUM-12: daily Cliniko catalog re-sync for every active integration —
 * practitioner/appointment-type changes made in Cliniko flow into the local
 * catalog without anyone pressing "Sync now". One org's failure never blocks
 * the rest; auth failures flag the integration for the dashboard banner.
 */

export const maxDuration = 60;

// Cliniko calls are the slow part (2 list endpoints + upserts per org). A cap
// bounds the run inside maxDuration; the least-recently-updated orgs go first
// so a hit cap self-heals across days.
const MAX_ORGS_PER_RUN = 50;

interface IntegrationRow {
  id: string;
  organization_id: string;
  access_token: string | null;
  settings: Record<string, unknown> | null;
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request, "cliniko-catalog-sync");
  if (authError) return authError;

  const admin = createAdminClient();
  const { data, error } = await (admin as any)
    .from("calendar_integrations")
    .select("id, organization_id, access_token, settings")
    .eq("provider", "cliniko")
    .eq("is_active", true)
    .order("updated_at", { ascending: true })
    .limit(MAX_ORGS_PER_RUN);

  if (error) {
    console.error("[ClinikoCron] integration scan failed:", error.message || error.code);
    return NextResponse.json({ error: "scan failed" }, { status: 500 });
  }

  const rows = (data || []) as IntegrationRow[];
  const results: Array<{ organizationId: string; ok: boolean; error?: string }> = [];

  for (const row of rows) {
    const settings = (row.settings || {}) as Record<string, unknown>;
    try {
      const apiKey = row.access_token ? safeDecrypt(row.access_token) : null;
      if (!apiKey || !settings.shard || !settings.businessId) {
        throw new Error("integration row is missing key/shard/business");
      }
      const client = new ClinikoClient({ apiKey, shard: String(settings.shard), timeoutMs: 10_000 });
      await syncClinikoCatalog(row.organization_id, client, String(settings.businessId));
      // SCRUM-489: atomic merge — patch only the markers this cron owns so a
      // concurrent at-call reconcile's lastReconciledAt isn't clobbered.
      await mergeIntegrationSettings(admin, row.id, { lastSyncedAt: new Date().toISOString(), errorState: null });
      results.push({ organizationId: row.organization_id, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorState = err instanceof ClinikoAuthError ? "auth_failed" : "sync_failed";
      try {
        await mergeIntegrationSettings(admin, row.id, { errorState });
      } catch (flagErr) {
        console.error("[ClinikoCron] failed to flag errorState:", flagErr instanceof Error ? flagErr.message : flagErr);
      }
      console.error("[ClinikoCron] org sync failed:", { organizationId: row.organization_id, message });
      Sentry.captureException(err);
      results.push({ organizationId: row.organization_id, ok: false, error: message });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({
    scanned: rows.length,
    succeeded: rows.length - failed,
    failed,
    results,
  });
}
