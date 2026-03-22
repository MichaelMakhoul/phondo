import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

interface Membership {
  organization_id: string;
  role?: string;
}

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };
    if (!membership) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 });

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.durationMinutes !== undefined) updates.duration_minutes = parsed.data.durationMinutes;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.isActive !== undefined) updates.is_active = parsed.data.isActive;
    if (parsed.data.sortOrder !== undefined) updates.sort_order = parsed.data.sortOrder;

    const { data, error } = await (supabase as any)
      .from("service_types")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };
    if (!membership) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const { error } = await (supabase as any)
      .from("service_types")
      .delete()
      .eq("id", id)
      .eq("organization_id", membership.organization_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
