import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { ClinikoAuthError } from "@/lib/calendar/cliniko";
import { getActiveClinikoIntegration } from "@/lib/calendar/cliniko-booking";
import { mergeIntegrationSettings } from "@/lib/calendar/cliniko-settings";
import { syncClinikoCatalog } from "@/lib/calendar/cliniko-sync";

/** POST — manual "Sync now" for the connected Cliniko catalog (SCRUM-12). */
export async function POST(request: Request) {
  try {
    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations/cliniko/sync", "standard");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { data: membership } = (await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single()) as { data: { organization_id: string } | null };
    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    if (!(await hasFeatureAccess(membership.organization_id, "crmIntegrations"))) {
      return NextResponse.json(
        { error: "CRM integrations are available on the Professional plan and above." },
        { status: 403 }
      );
    }

    const resolution = await getActiveClinikoIntegration(membership.organization_id);
    if (resolution.kind === "error") {
      return NextResponse.json(
        { error: "Couldn't reach the Cliniko connection right now. Please try again shortly." },
        { status: 503 }
      );
    }
    if (resolution.kind === "none") {
      return NextResponse.json(
        { error: "Cliniko isn't connected and active for this organization." },
        { status: 409 }
      );
    }
    const ctx = resolution.ctx;

    const admin = createAdminClient();

    try {
      const sync = await syncClinikoCatalog(membership.organization_id, ctx.client, ctx.businessId);
      // SCRUM-489: atomic merge patches only these markers, so a concurrent
      // at-call reconcile's lastReconciledAt survives (no read-before-write).
      const { error: markErr } = await mergeIntegrationSettings(admin, ctx.integrationId, { lastSyncedAt: new Date().toISOString(), errorState: null });
      if (markErr) {
        console.error("[ClinikoSyncRoute] success-marker merge failed (stale banner may persist):", markErr.message || markErr.code);
      }
      return NextResponse.json({ sync });
    } catch (err) {
      const errorState = err instanceof ClinikoAuthError ? "auth_failed" : "sync_failed";
      const { error: flagErr } = await mergeIntegrationSettings(admin, ctx.integrationId, { errorState }).catch((e) => ({ error: e as { message?: string; code?: string } }));
      if (flagErr) {
        console.error("[ClinikoSyncRoute] errorState flag did not persist:", flagErr.message || flagErr.code);
      }
      if (err instanceof ClinikoAuthError) {
        return NextResponse.json(
          { error: "Cliniko rejected the stored API key — reconnect with a fresh key." },
          { status: 401 }
        );
      }
      console.error("[ClinikoSyncRoute] sync failed:", err instanceof Error ? err.message : err);
      return NextResponse.json(
        { error: "Sync failed — Cliniko may be unreachable. Try again shortly." },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error("[ClinikoSyncRoute] error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
