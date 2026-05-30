import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVapiClient, buildVapiServerConfig } from "@/lib/vapi";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";

/**
 * POST /api/v1/assistants/sync-server-url
 * Re-syncs the Vapi server URL for the caller's org assistants AND all
 * account-wide Vapi tools. Used after a deploy if assistants/tools were created
 * with a localhost URL.
 *
 * SCRUM-362: PLATFORM-ADMIN ONLY. The tool resync below calls vapi.listTools(),
 * which is account-wide (single Vapi key per deployment) and would let any
 * authenticated tenant force a resync touching every org's tools. This is an
 * operational/maintenance action, not a per-tenant feature, so it's gated.
 */
export async function POST(request: NextRequest) {
  try {
    const { allowed, headers } = withRateLimit(request, "/api/v1/assistants/sync-server-url", "expensive");
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

    // SCRUM-362: gate this account-wide ops action behind platform-admin.
    if (!(await isPlatformAdmin(user.id))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: membership, error: membershipError } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single();

    if (membershipError && membershipError.code !== "PGRST116") {
      console.error("Failed to look up org membership:", membershipError);
      return NextResponse.json({ error: "Failed to look up organization" }, { status: 500 });
    }

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    const orgId = membership.organization_id;

    const serverConfig = buildVapiServerConfig();
    if (!serverConfig) {
      return NextResponse.json(
        { error: "NEXT_PUBLIC_APP_URL is not configured" },
        { status: 500 }
      );
    }

    const { data: assistants, error } = await (supabase as any)
      .from("assistants")
      .select("id, name, vapi_assistant_id")
      .eq("organization_id", orgId)
      .not("vapi_assistant_id", "is", null);

    if (error || !assistants) {
      console.error("Failed to fetch assistants:", error);
      return NextResponse.json(
        { error: "Failed to fetch assistants" },
        { status: 500 }
      );
    }

    const vapi = getVapiClient();
    const results: { id: string; name: string; success: boolean; error?: string }[] = [];

    for (const assistant of assistants) {
      try {
        await vapi.updateAssistant(assistant.vapi_assistant_id, {
          server: serverConfig,
        });
        results.push({ id: assistant.id, name: assistant.name, success: true });
      } catch (err) {
        results.push({
          id: assistant.id,
          name: assistant.name,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const updated = results.filter((r) => r.success).length;

    // Also sync standalone tool server URLs (e.g. calendar tools created with localhost)
    // Note: listTools() is account-wide (single Vapi API key per deployment)
    const toolResults: { id: string; name: string; success: boolean; error?: string }[] = [];
    let toolsSyncError: string | null = null;
    try {
      const tools = await vapi.listTools();
      for (const tool of tools) {
        if (tool.server?.url && tool.server.url !== serverConfig.url) {
          try {
            await vapi.updateTool(tool.id, { server: serverConfig });
            toolResults.push({
              id: tool.id,
              name: tool.function?.name || tool.id,
              success: true,
            });
          } catch (err) {
            toolResults.push({
              id: tool.id,
              name: tool.function?.name || tool.id,
              success: false,
              error: err instanceof Error ? err.message : "Unknown error",
            });
          }
        }
      }
    } catch (err) {
      console.error("Failed to list/sync Vapi tools:", err);
      toolsSyncError = "Failed to list tools from Vapi. Tool server URLs were not synced.";
    }

    const toolsUpdated = toolResults.filter((r) => r.success).length;

    return NextResponse.json({
      serverUrl: serverConfig.url,
      assistants: { updated, failed: results.length - updated, results },
      tools: {
        updated: toolsUpdated,
        failed: toolResults.length - toolsUpdated,
        results: toolResults,
        ...(toolsSyncError && { error: toolsSyncError }),
      },
    });
  } catch (error) {
    console.error("Sync server URL failed:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred while syncing server URLs" },
      { status: 500 }
    );
  }
}
