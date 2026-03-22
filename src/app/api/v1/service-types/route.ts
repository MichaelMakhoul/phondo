import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

interface Membership {
  organization_id: string;
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  durationMinutes: z.number().int().min(5).max(480),
  description: z.string().max(500).optional(),
});

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };
    if (!membership) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const { data, error } = await (supabase as any)
      .from("service_types")
      .select("*")
      .eq("organization_id", membership.organization_id)
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    // TODO: Surface error state in UI — currently the frontend doesn't show an error banner on query failure
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[ServiceTypes] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
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
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 });

    const { name, durationMinutes, description } = parsed.data;

    // Enforce max service types limit (50)
    const { count: existingCount, error: countError } = await (supabase as any)
      .from("service_types")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", membership.organization_id);

    if (countError) {
      console.error("[ServiceTypes] Count query failed:", countError);
      return NextResponse.json({ error: "Failed to check service type count" }, { status: 500 });
    }

    if (existingCount !== null && existingCount >= 50) {
      return NextResponse.json({ error: "Maximum of 50 service types allowed" }, { status: 400 });
    }

    const { data, error } = await (supabase as any)
      .from("service_types")
      .insert({
        organization_id: membership.organization_id,
        name,
        duration_minutes: durationMinutes,
        description: description || null,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error("[ServiceTypes] POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
