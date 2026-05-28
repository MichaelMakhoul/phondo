import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { safeEncrypt, safeDecrypt } from "@/lib/security/encryption";
import { isUrlAllowedAsync, isValidUUID } from "@/lib/security/validation";
import type { OrgMembership } from "@/lib/integrations/types";

const updateIntegrationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  webhook_url: z.string().url().max(2000).optional(),
  events: z
    .array(z.enum(["call.completed", "call.started", "call.missed", "voicemail.received"]))
    .min(1)
    .optional(),
  is_active: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

async function getOrgMembership(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = (await supabase
    .from("org_members")
    .select("organization_id, role")
    .eq("user_id", userId)
    .single()) as { data: OrgMembership | null };
  return data;
}

// GET /api/v1/integrations/[id]
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Invalid integration ID" }, { status: 400 });
    }

    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations", "standard");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const membership = await getOrgMembership(supabase, user.id);
    if (!membership) return NextResponse.json({ error: "No organization found" }, { status: 404 });

    const { data: integration, error } = await (supabase.from("integrations") as any)
      .select("*")
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single();

    if (error || !integration) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    }

    // Decrypt for display
    const decryptedUrl = safeDecrypt(integration.webhook_url);
    let displayUrl = "";
    if (!decryptedUrl) {
      displayUrl = "[decryption error]";
    } else {
      try {
        const url = new URL(decryptedUrl);
        displayUrl = `${url.protocol}//${url.hostname}/***`;
      } catch {
        displayUrl = "[invalid URL]";
      }
    }

    return NextResponse.json({
      ...integration,
      webhook_url_display: displayUrl,
      // Don't return the actual encrypted values or signing secret
      webhook_url: undefined,
      signing_secret: undefined,
    });
  } catch (error) {
    console.error("Error fetching integration:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/integrations/[id]
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Invalid integration ID" }, { status: 400 });
    }

    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations", "standard");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const membership = await getOrgMembership(supabase, user.id);
    if (!membership) return NextResponse.json({ error: "No organization found" }, { status: 404 });

    if (!["owner", "admin"].includes(membership.role || "")) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    const body = await request.json();
    const validated = updateIntegrationSchema.parse(body);

    // Build update object
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (validated.name !== undefined) update.name = validated.name;
    if (validated.events !== undefined) update.events = validated.events;
    if (validated.is_active !== undefined) update.is_active = validated.is_active;
    if (validated.metadata !== undefined) update.metadata = validated.metadata;

    if (validated.webhook_url !== undefined) {
      if (!(await isUrlAllowedAsync(validated.webhook_url))) {
        return NextResponse.json(
          { error: "Webhook URL points to a private or internal address" },
          { status: 400 }
        );
      }
      update.webhook_url = safeEncrypt(validated.webhook_url);
    }

    const { data: updated, error } = await (supabase.from("integrations") as any)
      .update(update)
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .select("id, name, platform, events, is_active, metadata, updated_at")
      .single();

    if (error || !updated) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation error", details: error.errors }, { status: 400 });
    }
    console.error("Error updating integration:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/integrations/[id]
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Invalid integration ID" }, { status: 400 });
    }

    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations", "standard");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const membership = await getOrgMembership(supabase, user.id);
    if (!membership) return NextResponse.json({ error: "No organization found" }, { status: 404 });

    if (!["owner", "admin"].includes(membership.role || "")) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    const { data: deleted, error } = await (supabase.from("integrations") as any)
      .delete()
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .select("id")
      .single();

    if (error || !deleted) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("Error deleting integration:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
