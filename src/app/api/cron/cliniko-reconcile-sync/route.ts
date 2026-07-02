import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeDecrypt } from "@/lib/security/encryption";
import { ClinikoClient } from "@/lib/calendar/cliniko";
import { reconcileClinikoOrg } from "@/lib/calendar/cliniko-reconcile";

/**
 * SCRUM-482: daily backstop for Cliniko change reconciliation. The at-call path
 * keeps active orgs fresh; this catches orgs with no recent calls. Vercel Hobby
 * allows only daily crons — revisit cadence on Pro. Per-org isolation; one org's
 * failure never blocks the rest; auth failures flag the integration banner.
 */
export const maxDuration = 60;

// Cliniko calls are the slow part; a cap bounds the run inside maxDuration. The
// least-recently-updated orgs go first so a hit cap self-heals across days.
const MAX_ORGS_PER_RUN = 50;

interface IntegrationRow {
  id: string;
  organization_id: string;
  access_token: string | null;
  settings: Record<string, unknown> | null;
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request, "cliniko-reconcile-sync");
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
    console.error("[ClinikoReconcileCron] integration scan failed:", error.message || error.code);
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
      // reconcileClinikoOrg never throws and owns its own auth/Sentry handling;
      // ran=false here (force bypasses the freshness gate) means it aborted on a
      // Cliniko/DB failure it already logged, so surface that as not-ok.
      const result = await reconcileClinikoOrg(
        { client, businessId: String(settings.businessId), integrationId: row.id, organizationId: row.organization_id },
        { force: true }
      );
      results.push({ organizationId: row.organization_id, ok: result.ran });
    } catch (err) {
      // Only the pre-reconcile setup (decrypt / missing config / bad shard) can
      // throw here. Mirror the sibling catalog cron: log + Sentry, keep going.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ClinikoReconcileCron] org ${row.organization_id} failed:`, message);
      Sentry.captureException(err);
      results.push({ organizationId: row.organization_id, ok: false, error: message });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}
