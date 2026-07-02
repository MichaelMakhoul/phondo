import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { ClinikoAuthError } from "@/lib/calendar/cliniko";
import { getActiveClinikoIntegration } from "@/lib/calendar/cliniko-booking";
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

    const ctx = await getActiveClinikoIntegration(membership.organization_id);
    if (!ctx) {
      return NextResponse.json(
        { error: "Cliniko isn't connected and active for this organization." },
        { status: 409 }
      );
    }

    const admin = createAdminClient();
    const readSettings = async (): Promise<Record<string, unknown>> => {
      const { data } = await (admin as any)
        .from("calendar_integrations")
        .select("settings")
        .eq("id", ctx.integrationId)
        .maybeSingle();
      return { ...((data?.settings as Record<string, unknown>) || {}) };
    };

    try {
      const sync = await syncClinikoCatalog(membership.organization_id, ctx.client);
      const settings = await readSettings();
      await (admin as any)
        .from("calendar_integrations")
        .update({
          settings: { ...settings, lastSyncedAt: new Date().toISOString(), errorState: null },
          updated_at: new Date().toISOString(),
        })
        .eq("id", ctx.integrationId);
      return NextResponse.json({ sync });
    } catch (err) {
      const settings = await readSettings();
      const errorState = err instanceof ClinikoAuthError ? "auth_failed" : "sync_failed";
      await (admin as any)
        .from("calendar_integrations")
        .update({
          settings: { ...settings, errorState },
          updated_at: new Date().toISOString(),
        })
        .eq("id", ctx.integrationId);
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
