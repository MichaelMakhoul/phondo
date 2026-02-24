import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  updateTransferRule,
  deleteTransferRule,
} from "@/lib/transfer/transfer-service";
import { isValidUUID } from "@/lib/security/validation";

/**
 * PATCH /api/v1/transfer/rules/:id
 *
 * Update a transfer rule
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: ruleId } = await params;

    // Validate UUID format
    if (!isValidUUID(ruleId)) {
      return NextResponse.json(
        { error: "Invalid rule ID format" },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // Check authentication
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's organization
    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single();

    if (!membership) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 403 }
      );
    }

    const organizationId = membership.organization_id as string;

    // Verify rule exists and belongs to organization
    const { data: existingRule } = await (supabase as any)
      .from("transfer_rules")
      .select("id")
      .eq("id", ruleId)
      .eq("organization_id", organizationId)
      .single();

    if (!existingRule) {
      return NextResponse.json(
        { error: "Transfer rule not found" },
        { status: 404 }
      );
    }

    const body = await request.json();
    const {
      name,
      triggerKeywords,
      triggerIntent,
      transferToPhone,
      transferToName,
      announcementMessage,
      priority,
      isActive,
      destinations,
      requireConfirmation,
    } = body;

    // Validate destinations array if provided
    if (destinations !== undefined) {
      if (!Array.isArray(destinations)) {
        return NextResponse.json(
          { error: "Destinations must be an array" },
          { status: 400 }
        );
      }
      if (destinations.length > 5) {
        return NextResponse.json(
          { error: "Maximum 5 fallback destinations allowed" },
          { status: 400 }
        );
      }
      for (const dest of destinations) {
        if (!dest || typeof dest !== "object" || typeof dest.phone !== "string" || !dest.phone.trim()) {
          return NextResponse.json(
            { error: "Each destination must have a valid phone number" },
            { status: 400 }
          );
        }
      }
    }

    // Update the rule
    await updateTransferRule(ruleId, organizationId, {
      name,
      triggerKeywords,
      triggerIntent,
      transferToPhone,
      transferToName,
      announcementMessage,
      priority,
      isActive,
      destinations,
      requireConfirmation,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Update transfer rule error:", error);
    const message = error instanceof Error ? error.message : "Failed to update transfer rule";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/v1/transfer/rules/:id
 *
 * Delete a transfer rule
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: ruleId } = await params;

    // Validate UUID format
    if (!isValidUUID(ruleId)) {
      return NextResponse.json(
        { error: "Invalid rule ID format" },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // Check authentication
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's organization
    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single();

    if (!membership) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 403 }
      );
    }

    const organizationId = membership.organization_id as string;

    // Delete the rule
    await deleteTransferRule(ruleId, organizationId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete transfer rule error:", error);
    const message = error instanceof Error ? error.message : "Failed to delete transfer rule";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
