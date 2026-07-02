import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { safeEncrypt, safeDecrypt } from "@/lib/security/encryption";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import {
  ClinikoClient,
  ClinikoApiKeyError,
  ClinikoAuthError,
  parseClinikoApiKey,
} from "@/lib/calendar/cliniko";
import { syncClinikoCatalog } from "@/lib/calendar/cliniko-sync";
import { mergeIntegrationSettings } from "@/lib/calendar/cliniko-settings";

/**
 * Cliniko CRM integration management (SCRUM-12). Professional+ only.
 * The API key is stored encrypted (safeEncrypt) in calendar_integrations
 * .access_token and NEVER leaves the server in any response.
 */

const ADMIN_TIMEOUT_MS = 10_000;

const connectSchema = z.object({ apiKey: z.string().min(10).max(500) });
const patchSchema = z.object({
  businessId: z.string().min(1).max(50).optional(),
  isActive: z.boolean().optional(),
});

interface AuthedOrg {
  organizationId: string;
}

/**
 * Membership gate. Mutating handlers pass `requireAdmin` — installing or
 * removing a CRM key redirects real patient bookings, so it's owner/admin
 * only, matching the webhook integrations route (POST/PATCH/DELETE there
 * enforce the same roles).
 */
async function requireOrgMember(opts: { requireAdmin?: boolean } = {}): Promise<AuthedOrg | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: membership } = (await supabase
    .from("org_members")
    .select("organization_id, role")
    .eq("user_id", user.id)
    .single()) as { data: { organization_id: string; role?: string } | null };
  if (!membership) {
    return NextResponse.json({ error: "No organization found" }, { status: 404 });
  }
  if (opts.requireAdmin && !["owner", "admin"].includes(membership.role || "")) {
    return NextResponse.json(
      { error: "Only organization owners and admins can manage the Cliniko connection." },
      { status: 403 }
    );
  }
  return { organizationId: membership.organization_id };
}

async function requireCrmAccess(organizationId: string): Promise<NextResponse | null> {
  if (!(await hasFeatureAccess(organizationId, "crmIntegrations"))) {
    return NextResponse.json(
      { error: "CRM integrations are available on the Professional plan and above." },
      { status: 403 }
    );
  }
  return null;
}

interface IntegrationRow {
  id: string;
  is_active?: boolean;
  access_token: string | null;
  settings: Record<string, unknown> | null;
}

async function loadIntegrationRow(organizationId: string): Promise<IntegrationRow | null> {
  const admin = createAdminClient();
  const { data, error } = await (admin as any)
    .from("calendar_integrations")
    .select("id, is_active, access_token, settings")
    .eq("organization_id", organizationId)
    .eq("provider", "cliniko")
    .maybeSingle();
  if (error) {
    console.error("[ClinikoRoute] integration lookup failed:", error.message || error.code);
    return null;
  }
  return (data as IntegrationRow) || null;
}

function keyLast4(key: string): string {
  return key.replace(/-[a-z]{2,3}\d{1,2}$/, "").slice(-4);
}

function clientFor(key: string, shard: string): ClinikoClient {
  return new ClinikoClient({ apiKey: key, shard, timeoutMs: ADMIN_TIMEOUT_MS });
}

/** Map Cliniko client errors to a caller-facing response; rethrows unknown errors. */
function clinikoErrorResponse(err: unknown): NextResponse {
  if (err instanceof ClinikoAuthError) {
    return NextResponse.json(
      { error: "Cliniko rejected that API key. Generate a fresh key in Cliniko (My Info → Manage API keys) and try again." },
      { status: 401 }
    );
  }
  return NextResponse.json(
    { error: "Couldn't reach Cliniko right now. Please try again in a minute." },
    { status: 502 }
  );
}

async function runInitialSync(
  organizationId: string,
  integrationId: string,
  client: ClinikoClient,
  settings: Record<string, unknown>
): Promise<{ sync: Awaited<ReturnType<typeof syncClinikoCatalog>> | null; syncError?: string }> {
  const admin = createAdminClient();
  try {
    const sync = await syncClinikoCatalog(organizationId, client, settings.businessId as string | undefined);
    // SCRUM-489: atomic single-key merge — never clobbers a concurrent at-call
    // reconcile's cursor when this runs on an already-live integration (PATCH).
    const { error: markErr } = await mergeIntegrationSettings(admin, integrationId, { lastSyncedAt: new Date().toISOString(), errorState: null });
    if (markErr) {
      console.error("[ClinikoRoute] initial-sync success-marker merge failed:", markErr.message || markErr.code);
    }
    return { sync };
  } catch (err) {
    console.error("[ClinikoRoute] initial catalog sync failed:", err instanceof Error ? err.message : err);
    const { error: flagErr } = await mergeIntegrationSettings(admin, integrationId, { errorState: "sync_failed" }).catch((e) => ({ error: e as { message?: string; code?: string } }));
    if (flagErr) {
      console.error("[ClinikoRoute] initial-sync errorState flag did not persist:", flagErr.message || flagErr.code);
    }
    return { sync: null, syncError: "Connected, but the first catalog sync failed — use Sync now to retry." };
  }
}

// POST — connect with an API key
export async function POST(request: Request) {
  try {
    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations/cliniko", "standard");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
    }
    const auth = await requireOrgMember({ requireAdmin: true });
    if (auth instanceof NextResponse) return auth;
    const gate = await requireCrmAccess(auth.organizationId);
    if (gate) return gate;

    const parsed = connectSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "An API key is required." }, { status: 400 });
    }

    let key: string, shard: string;
    try {
      ({ key, shard } = parseClinikoApiKey(parsed.data.apiKey));
    } catch (err) {
      if (err instanceof ClinikoApiKeyError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    const client = clientFor(key, shard);
    let businesses;
    try {
      businesses = await client.listBusinesses();
    } catch (err) {
      return clinikoErrorResponse(err);
    }
    if (businesses.length === 0) {
      return NextResponse.json(
        { error: "That Cliniko account has no businesses (locations) to book into." },
        { status: 400 }
      );
    }

    const single = businesses.length === 1 ? businesses[0] : null;
    const settings: Record<string, unknown> = {
      shard,
      keyLast4: keyLast4(key),
      businessId: single?.id ?? null,
      businessName: single?.business_name ?? null,
      errorState: null,
      lastSyncedAt: null,
    };

    const admin = createAdminClient();
    const existing = await loadIntegrationRow(auth.organizationId);
    let integrationId: string;
    if (existing) {
      const { error } = await (admin as any)
        .from("calendar_integrations")
        .update({
          access_token: safeEncrypt(key),
          settings,
          is_active: !!single,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) throw new Error(`integration update failed: ${error.message || error.code}`);
      integrationId = existing.id;
    } else {
      const { data, error } = await (admin as any)
        .from("calendar_integrations")
        .insert({
          organization_id: auth.organizationId,
          provider: "cliniko",
          access_token: safeEncrypt(key),
          settings,
          is_active: !!single,
        })
        .select("id")
        .single();
      if (error) throw new Error(`integration insert failed: ${error.message || error.code}`);
      integrationId = data?.id;
    }

    let syncResult: { sync: Awaited<ReturnType<typeof syncClinikoCatalog>> | null; syncError?: string } = { sync: null };
    if (single) {
      syncResult = await runInitialSync(auth.organizationId, integrationId, client, settings);
    }

    return NextResponse.json({
      connected: true,
      active: !!single,
      businesses: businesses.map((b) => ({ id: b.id, name: b.business_name })),
      business: single ? { id: single.id, name: single.business_name } : null,
      keyLast4: settings.keyLast4,
      sync: syncResult.sync,
      ...(syncResult.syncError && { syncError: syncResult.syncError }),
    });
  } catch (error) {
    console.error("[ClinikoRoute] connect failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH — select business / toggle active
export async function PATCH(request: Request) {
  try {
    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations/cliniko", "standard");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
    }
    const auth = await requireOrgMember({ requireAdmin: true });
    if (auth instanceof NextResponse) return auth;
    const gate = await requireCrmAccess(auth.organizationId);
    if (gate) return gate;

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || (parsed.data.businessId === undefined && parsed.data.isActive === undefined)) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const row = await loadIntegrationRow(auth.organizationId);
    if (!row) {
      return NextResponse.json({ error: "Cliniko is not connected." }, { status: 404 });
    }
    const settings = { ...(row.settings || {}) } as Record<string, unknown>;
    const admin = createAdminClient();

    if (parsed.data.businessId !== undefined) {
      const apiKey = row.access_token ? safeDecrypt(row.access_token) : null;
      if (!apiKey || !settings.shard) {
        return NextResponse.json({ error: "Reconnect Cliniko with a fresh API key first." }, { status: 409 });
      }
      const client = clientFor(apiKey, String(settings.shard));
      let businesses;
      try {
        businesses = await client.listBusinesses();
      } catch (err) {
        return clinikoErrorResponse(err);
      }
      const chosen = businesses.find((b) => b.id === parsed.data.businessId);
      if (!chosen) {
        return NextResponse.json({ error: "That location doesn't exist in this Cliniko account." }, { status: 400 });
      }
      settings.businessId = chosen.id;
      settings.businessName = chosen.business_name;
      settings.errorState = null;

      // SCRUM-489: merge only the settings keys we own (never clobber a
      // concurrent at-call reconcile's cursor when changing location on a live
      // integration); flip is_active in its own column update.
      const { error: mergeErr } = await mergeIntegrationSettings(admin, row.id, {
        businessId: chosen.id,
        businessName: chosen.business_name,
        errorState: null,
      });
      if (mergeErr) throw new Error(`integration settings merge failed: ${mergeErr.message || mergeErr.code}`);
      const { error } = await (admin as any)
        .from("calendar_integrations")
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (error) throw new Error(`integration activate failed: ${error.message || error.code}`);

      const syncResult = await runInitialSync(auth.organizationId, row.id, client, settings);
      return NextResponse.json({
        connected: true,
        active: true,
        business: { id: chosen.id, name: chosen.business_name },
        sync: syncResult.sync,
        ...(syncResult.syncError && { syncError: syncResult.syncError }),
      });
    }

    // isActive toggle only
    if (parsed.data.isActive && !settings.businessId) {
      return NextResponse.json({ error: "Choose a location before activating." }, { status: 400 });
    }
    const { error } = await (admin as any)
      .from("calendar_integrations")
      .update({ is_active: !!parsed.data.isActive, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) throw new Error(`integration toggle failed: ${error.message || error.code}`);
    return NextResponse.json({ connected: true, active: !!parsed.data.isActive });
  } catch (error) {
    console.error("[ClinikoRoute] patch failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET — status for the settings card (renders the upsell state, so no 403 here)
export async function GET(request: Request) {
  try {
    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations/cliniko", "standard");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
    }
    const auth = await requireOrgMember();
    if (auth instanceof NextResponse) return auth;

    const canConnect = await hasFeatureAccess(auth.organizationId, "crmIntegrations");
    const row = await loadIntegrationRow(auth.organizationId);
    if (!row || !row.access_token) {
      return NextResponse.json({ connected: false, canConnect });
    }

    const settings = (row.settings || {}) as Record<string, unknown>;
    const admin = createAdminClient();
    const counts = { practitioners: 0, serviceTypes: 0 };
    for (const [table, prop] of [
      ["practitioners", "practitioners"],
      ["service_types", "serviceTypes"],
    ] as const) {
      const { count } = await (admin as any)
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("organization_id", auth.organizationId)
        .eq("external_provider", "cliniko")
        .eq("is_active", true);
      counts[prop] = count || 0;
    }

    return NextResponse.json({
      connected: true,
      canConnect,
      active: !!row.is_active,
      business: settings.businessId ? { id: settings.businessId, name: settings.businessName } : null,
      keyLast4: settings.keyLast4 ?? null,
      lastSyncedAt: settings.lastSyncedAt ?? null,
      errorState: settings.errorState ?? null,
      counts,
    });
  } catch (error) {
    console.error("[ClinikoRoute] status failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE — disconnect (clears the key; keeps history rows, deactivates catalog)
export async function DELETE(request: Request) {
  try {
    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations/cliniko", "standard");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
    }
    const auth = await requireOrgMember({ requireAdmin: true });
    if (auth instanceof NextResponse) return auth;

    const row = await loadIntegrationRow(auth.organizationId);
    if (!row) {
      return NextResponse.json({ disconnected: true });
    }

    const admin = createAdminClient();
    const settings = { ...(row.settings || {}) } as Record<string, unknown>;
    delete settings.shard;
    settings.businessId = null;
    settings.errorState = null;

    const { error } = await (admin as any)
      .from("calendar_integrations")
      .update({
        is_active: false,
        access_token: null,
        settings,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) throw new Error(`disconnect failed: ${error.message || error.code}`);

    // Stop offering imported catalog entries on calls; history stays intact.
    for (const table of ["practitioners", "service_types"]) {
      const { error: deactivateError } = await (admin as any)
        .from(table)
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("organization_id", auth.organizationId)
        .eq("external_provider", "cliniko");
      if (deactivateError) {
        console.error(`[ClinikoRoute] failed to deactivate ${table} on disconnect:`, deactivateError.message);
      }
    }

    return NextResponse.json({ disconnected: true });
  } catch (error) {
    console.error("[ClinikoRoute] disconnect failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
