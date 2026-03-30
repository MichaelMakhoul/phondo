import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

interface Membership {
  organization_id: string;
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  allDay: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

async function getOrgId(supabase: any, userId: string): Promise<string | null> {
  const { data, error } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", userId)
    .single() as { data: Membership | null; error: any };
  if (error && error.code !== "PGRST116") {
    console.error("getOrgId DB error:", { userId, code: error.code, message: error.message });
  }
  return data?.organization_id || null;
}

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const orgId = await getOrgId(supabase, user.id);
    if (!orgId) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const { data, error } = await (supabase as any)
      .from("blocked_times")
      .select("id, title, start_time, end_time, all_day, reason, created_at")
      .eq("organization_id", orgId)
      .gte("end_time", new Date().toISOString()) // Only future/current blocks
      .order("start_time", { ascending: true });

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (err: any) {
    console.error("GET /blocked-times error:", err);
    return NextResponse.json({ error: "Failed to fetch blocked times" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const orgId = await getOrgId(supabase, user.id);
    if (!orgId) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const body = await request.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const { title, startTime, endTime, allDay, reason } = parsed.data;

    // Validate end > start
    if (new Date(endTime) <= new Date(startTime)) {
      return NextResponse.json({ error: "End time must be after start time" }, { status: 400 });
    }

    // Check for conflicting appointments (no codes — security sensitive)
    const { data: conflicts, error: conflictErr } = await (supabase as any)
      .from("appointments")
      .select("id, attendee_name, start_time")
      .eq("organization_id", orgId)
      .in("status", ["confirmed", "pending"])
      .lt("start_time", endTime)
      .gt("end_time", startTime);

    if (conflictErr) {
      console.error("Failed to check conflicts for blocked time:", conflictErr);
    }

    // Insert the block
    const { data: block, error } = await (supabase as any)
      .from("blocked_times")
      .insert({
        organization_id: orgId,
        title,
        start_time: startTime,
        end_time: endTime,
        all_day: allDay || false,
        reason: reason || null,
        created_by: user.id,
      })
      .select("id, title, start_time, end_time, all_day, reason, created_at")
      .single();

    if (error) throw error;

    return NextResponse.json({
      block,
      conflicts: conflicts || [],
      conflictCount: (conflicts || []).length,
    }, { status: 201 });
  } catch (err: any) {
    console.error("POST /blocked-times error:", err);
    return NextResponse.json({ error: "Failed to create blocked time" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const orgId = await getOrgId(supabase, user.id);
    if (!orgId) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const { error } = await (supabase as any)
      .from("blocked_times")
      .delete()
      .eq("id", id)
      .eq("organization_id", orgId);

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("DELETE /blocked-times error:", err);
    return NextResponse.json({ error: "Failed to delete blocked time" }, { status: 500 });
  }
}
