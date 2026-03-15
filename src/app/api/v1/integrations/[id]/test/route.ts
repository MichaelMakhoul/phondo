import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { safeDecrypt } from "@/lib/security/encryption";
import { isUrlAllowed, isValidUUID } from "@/lib/security/validation";
import { signPayload } from "@/lib/integrations/webhook-delivery";
import type { OrgMembership } from "@/lib/integrations/types";

function buildSamplePayload() {
  return {
    event: "call.completed",
    timestamp: new Date().toISOString(),
    data: {
      call_id: "00000000-0000-0000-0000-000000000000",
      caller_phone: "+61400000000",
      caller_name: "Test Caller",
      summary: "This is a test webhook delivery from Phondo.",
      transcript: "AI: Hello, how can I help you today?\nCaller: This is a test call.",
      duration_seconds: 30,
      assistant_name: "Test Assistant",
      outcome: "completed",
      recording_url: null,
      collected_data: { test: true },
    },
  };
}

// POST /api/v1/integrations/[id]/test
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Invalid integration ID" }, { status: 400 });
    }

    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations/test", "testCall");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: membership } = (await supabase
      .from("org_members")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .single()) as { data: OrgMembership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    if (!["owner", "admin"].includes(membership.role || "")) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    const { data: integration, error } = await (supabase.from("integrations") as any)
      .select("id, webhook_url, signing_secret")
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single();

    if (error || !integration) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    }

    const url = safeDecrypt(integration.webhook_url);
    const secret = safeDecrypt(integration.signing_secret);

    if (!url || !isUrlAllowed(url)) {
      return NextResponse.json(
        { error: "Webhook URL is blocked by security policy" },
        { status: 400 }
      );
    }

    if (!secret) {
      return NextResponse.json(
        { error: "Failed to decrypt signing secret" },
        { status: 500 }
      );
    }

    const samplePayload = buildSamplePayload();
    const payloadStr = JSON.stringify(samplePayload);
    const signature = signPayload(payloadStr, secret);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Phondo-Signature": signature,
          "X-Phondo-Event": "call.completed",
          "User-Agent": "Phondo-Webhooks/1.0",
        },
        body: payloadStr,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const responseBody = await response.text().catch((err: Error) => `[Failed to read response: ${err.message}]`);

      // Log the test delivery (use admin client to bypass RLS on integration_logs)
      const adminClient = createAdminClient();
      await (adminClient as any).from("integration_logs").insert({
        integration_id: id,
        event_type: "test",
        payload: samplePayload,
        response_status: response.status,
        response_body: responseBody.slice(0, 1000),
        success: response.ok,
      });

      return NextResponse.json({
        success: response.ok,
        status: response.status,
        message: response.ok
          ? "Test webhook delivered successfully!"
          : `Webhook responded with HTTP ${response.status}`,
      });
    } catch (fetchError) {
      clearTimeout(timeout);
      const message =
        fetchError instanceof Error && fetchError.name === "AbortError"
          ? "Request timed out after 10 seconds"
          : fetchError instanceof Error
            ? fetchError.message
            : "Network error";

      // Log the failed test (use admin client to bypass RLS on integration_logs)
      const adminClient = createAdminClient();
      await (adminClient as any).from("integration_logs").insert({
        integration_id: id,
        event_type: "test",
        payload: samplePayload,
        response_body: message,
        success: false,
      });

      return NextResponse.json({
        success: false,
        message,
      });
    }
  } catch (error) {
    console.error("Error testing integration:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
