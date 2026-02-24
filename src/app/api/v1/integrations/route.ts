import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import crypto from "crypto";
import { withRateLimit } from "@/lib/security/rate-limiter";
import { safeEncrypt, safeDecrypt } from "@/lib/security/encryption";
import { isUrlAllowed } from "@/lib/security/validation";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import type { OrgMembership } from "@/lib/integrations/types";

const createIntegrationSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(["zapier", "make", "google_sheets", "webhook"]).default("webhook"),
  webhook_url: z.string().url().max(2000),
  events: z
    .array(z.enum(["call.completed", "call.started", "call.missed", "voicemail.received"]))
    .min(1)
    .default(["call.completed"]),
  metadata: z.record(z.unknown()).optional().default({}),
});

// GET /api/v1/integrations - List all integrations for the org
export async function GET(request: Request) {
  try {
    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations", "standard");
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
      .single()) as { data: OrgMembership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    const { data: integrations, error } = await (supabase.from("integrations") as any)
      .select("id, name, platform, webhook_url, events, is_active, metadata, created_at, updated_at")
      .eq("organization_id", membership.organization_id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to list integrations:", error);
      return NextResponse.json({ error: "Failed to load integrations" }, { status: 500 });
    }

    // Mask webhook URLs for display (show domain only), strip encrypted values
    const masked = (integrations || []).map((i: Record<string, unknown>) => {
      const decrypted = safeDecrypt(i.webhook_url as string);
      let displayUrl = "";
      if (!decrypted) {
        displayUrl = "[decryption error]";
      } else {
        try {
          const url = new URL(decrypted);
          displayUrl = `${url.protocol}//${url.hostname}/***`;
        } catch {
          displayUrl = "[invalid URL]";
        }
      }
      const { webhook_url, signing_secret, ...safe } = i;
      return { ...safe, webhook_url_display: displayUrl };
    });

    const canCreate = await hasFeatureAccess(
      membership.organization_id,
      "webhookIntegrations"
    );

    return NextResponse.json({ integrations: masked, canCreate });
  } catch (error) {
    console.error("Error listing integrations:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/integrations - Create a new integration
export async function POST(request: Request) {
  try {
    const { allowed, headers } = withRateLimit(request, "/api/v1/integrations", "standard");
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
      .select("organization_id, role")
      .eq("user_id", user.id)
      .single()) as { data: OrgMembership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    if (!["owner", "admin"].includes(membership.role || "")) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    if (!(await hasFeatureAccess(membership.organization_id, "webhookIntegrations"))) {
      return NextResponse.json(
        { error: "Webhook integrations require a Professional or Business plan." },
        { status: 403 }
      );
    }

    const body = await request.json();
    const validated = createIntegrationSchema.parse(body);

    // SSRF protection
    if (!isUrlAllowed(validated.webhook_url)) {
      return NextResponse.json(
        { error: "Webhook URL points to a private or internal address" },
        { status: 400 }
      );
    }

    // Generate signing secret
    const signingSecret = crypto.randomBytes(32).toString("hex");

    // Encrypt sensitive fields
    const encryptedUrl = safeEncrypt(validated.webhook_url);
    const encryptedSecret = safeEncrypt(signingSecret);

    const { data: integration, error } = await (supabase.from("integrations") as any)
      .insert({
        organization_id: membership.organization_id,
        name: validated.name,
        platform: validated.platform,
        webhook_url: encryptedUrl,
        signing_secret: encryptedSecret,
        events: validated.events,
        metadata: validated.metadata,
      })
      .select("id, name, platform, events, is_active, metadata, created_at")
      .single();

    if (error) {
      console.error("Failed to create integration:", error);
      return NextResponse.json({ error: "Failed to create integration" }, { status: 500 });
    }

    // Return signing secret only on creation (like API keys)
    return NextResponse.json(
      {
        ...integration,
        signing_secret: signingSecret,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation error", details: error.errors }, { status: 400 });
    }
    console.error("Error creating integration:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
