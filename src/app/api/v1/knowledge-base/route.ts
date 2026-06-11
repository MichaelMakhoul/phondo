import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { getPrimaryMembership, isOrgAdminRole } from "@/lib/auth/membership";
import { withRateLimit } from "@/lib/security/rate-limiter";

// SCRUM-428 (finding #36): content was unbounded — cap to the same 50k the
// upload route enforces (the KB feeds the live AI prompt; megabyte entries
// blow out context and storage).
const MAX_KB_CONTENT_LENGTH = 50_000;

const createKBSchema = z.object({
  title: z.string().min(1).max(200),
  sourceType: z.enum(["website", "manual", "faq", "document"]),
  content: z.string().min(1).max(MAX_KB_CONTENT_LENGTH),
  sourceUrl: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
});

// GET /api/v1/knowledge-base — list org KB entries (metadata only)
export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getPrimaryMembership(supabase as any, user.id);

    if (!membership) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }

    const { data: entries, error } = await (supabase as any)
      .from("knowledge_bases")
      .select("id, title, source_type, source_url, is_active, metadata, created_at")
      .eq("organization_id", membership.organization_id)
      .is("assistant_id", null)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to list knowledge bases:", error);
      return NextResponse.json(
        { error: "Failed to load knowledge base entries" },
        { status: 500 }
      );
    }

    return NextResponse.json(entries || []);
  } catch (error) {
    console.error("Error listing knowledge bases:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/knowledge-base — create a new org-level KB entry
export async function POST(request: Request) {
  try {
    // SCRUM-428 (finding #35): KB writes feed the live AI prompt — bound the
    // write rate per IP.
    const { allowed } = withRateLimit(request, "/api/v1/knowledge-base", "auth");
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getPrimaryMembership(supabase as any, user.id);

    if (!membership) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }

    // SCRUM-428 (finding #35): only owner/admin may rewrite what the live AI
    // tells callers.
    if (!isOrgAdminRole(membership.role)) {
      return NextResponse.json(
        { error: "Only organization owners and admins can edit the knowledge base" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const validated = createKBSchema.parse(body);

    const { data: entry, error } = await (supabase as any)
      .from("knowledge_bases")
      .insert({
        organization_id: membership.organization_id,
        assistant_id: null,
        title: validated.title,
        source_type: validated.sourceType,
        content: validated.content,
        source_url: validated.sourceUrl || null,
        metadata: validated.metadata || {},
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error("Failed to create knowledge base entry:", error);
      return NextResponse.json(
        { error: "Failed to save knowledge base entry" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ...entry,
    }, { status: 201 });
  } catch (error) {
    console.error("Error creating knowledge base:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.errors },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
