import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

// Type for org_members query result
interface Membership {
  organization_id: string;
  role?: string;
}

const updateCallSchema = z.object({
  callerName: z.string().max(200).optional(),
  summary: z.string().max(2000).optional(),
  collectedData: z.record(z.unknown()).optional(),
});

// GET /api/v1/calls/[id] - Get a single call
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    const { data: call, error } = await (supabase
      .from("calls") as any)
      .select(`
        *,
        assistants (id, name),
        phone_numbers (id, phone_number, friendly_name)
      `)
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single();

    if (error || !call) {
      return NextResponse.json({ error: "Call not found" }, { status: 404 });
    }

    return NextResponse.json(call);
  } catch (error) {
    console.error("Error getting call:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/calls/[id] - Update a call's editable fields
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    // Parse and validate request body
    const body = await request.json();
    const parsed = updateCallSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { callerName, summary, collectedData } = parsed.data;

    // Build update object (camelCase → snake_case)
    const updates: Record<string, unknown> = {};
    if (callerName !== undefined) updates.caller_name = callerName;
    if (summary !== undefined) updates.summary = summary;
    if (collectedData !== undefined) updates.collected_data = collectedData;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const { data: call, error } = await (supabase
      .from("calls") as any)
      .update(updates)
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .select(`
        *,
        assistants (id, name),
        phone_numbers (id, phone_number, friendly_name)
      `)
      .single();

    if (error || !call) {
      console.error("Error updating call:", error);
      return NextResponse.json({ error: "Call not found" }, { status: 404 });
    }

    return NextResponse.json(call);
  } catch (error) {
    console.error("Error updating call:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
