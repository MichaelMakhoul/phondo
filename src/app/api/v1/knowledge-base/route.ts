import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const createKBSchema = z.object({
  title: z.string().min(1).max(200),
  sourceType: z.enum(["website", "manual", "faq", "document"]),
  content: z.string().min(1),
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

    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single();

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
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single();

    if (!membership) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
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
