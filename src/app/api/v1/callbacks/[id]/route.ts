import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID, sanitizeString } from "@/lib/security/validation";

// PATCH /api/v1/callbacks/[id] — update callback status
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Invalid callback ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: { organization_id: string } | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    let body: { status?: string; notes?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { status, notes } = body;

    if (!status || !["completed", "cancelled"].includes(status)) {
      return NextResponse.json(
        { error: "Status must be 'completed' or 'cancelled'" },
        { status: 400 }
      );
    }

    const admin = createAdminClient();

    // Verify the callback belongs to this org
    const { data: callback, error: fetchError } = await (admin as any)
      .from("callback_requests")
      .select("id, organization_id, status")
      .eq("id", id)
      .single();

    if (fetchError || !callback) {
      return NextResponse.json({ error: "Callback not found" }, { status: 404 });
    }

    if (callback.organization_id !== membership.organization_id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (callback.status !== "pending") {
      return NextResponse.json(
        { error: `Callback is already ${callback.status}` },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {
      status,
      updated_at: now,
    };

    if (status === "completed") {
      updateData.completed_at = now;
      updateData.completed_by = user.id;
      if (notes && typeof notes === "string") {
        updateData.completion_notes = sanitizeString(notes.trim(), 2000);
      }
    }

    const { error: updateError } = await (admin as any)
      .from("callback_requests")
      .update(updateData)
      .eq("id", id);

    if (updateError) {
      console.error("Failed to update callback:", {
        callbackId: id,
        error: updateError.message || updateError.code,
      });
      return NextResponse.json({ error: "Failed to update callback" }, { status: 500 });
    }

    return NextResponse.json({ success: true, status });
  } catch (error) {
    console.error("Error updating callback:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
