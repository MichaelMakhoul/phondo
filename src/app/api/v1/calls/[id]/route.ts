import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { mergeEditableCollectedData } from "@/lib/calls/collected-data";

// Type for org_members query result
interface Membership {
  organization_id: string;
  role?: string;
}

const updateCallSchema = z.object({
  callerName: z.string().max(200).optional(),
  summary: z.string().max(2000).optional(),
  collectedData: z.record(z.string().max(500)).optional(),
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
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
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
    if (collectedData !== undefined) {
      // SCRUM-394: the client sends only the EDITABLE primitive fields (as strings).
      // Merge them over the stored collected_data so structured fields (e.g. an
      // `appointments` array of objects) are preserved instead of being flattened
      // to a string. The merge guard never lets an edited string clobber a
      // structured field.
      //
      // CRITICAL: never merge over `null` on a read failure — that would drop the
      // structured fields and persist a stripped object (the exact data loss this
      // ticket fixes). So we must check the SELECT error before writing: a
      // genuinely-missing row (wrong id/org → PGRST116) is a 404; any other read
      // error is a 500. We never blind-write a merge built on a failed read.
      const { data: existing, error: readError } = await (supabase
        .from("calls") as any)
        .select("collected_data")
        .eq("id", id)
        .eq("organization_id", membership.organization_id)
        .single();
      if (readError || !existing) {
        const notFound = (readError as { code?: string } | null)?.code === "PGRST116";
        if (!notFound) {
          console.error("Error reading collected_data before merge:", readError);
        }
        return NextResponse.json(
          { error: notFound ? "Call not found" : "Internal server error" },
          { status: notFound ? 404 : 500 }
        );
      }
      updates.collected_data = mergeEditableCollectedData(
        existing.collected_data ?? null,
        collectedData
      );
    }

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
