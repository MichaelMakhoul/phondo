import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getTransferRules,
  createTransferRule,
} from "@/lib/transfer/transfer-service";
import { isValidUUID } from "@/lib/security/validation";

/**
 * GET /api/v1/transfer/rules
 *
 * Get transfer rules for an assistant
 *
 * Query params:
 * - assistantId: string (required)
 */
export async function GET(request: NextRequest) {
  try {
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

    // Get assistant ID from query
    const { searchParams } = new URL(request.url);
    const assistantId = searchParams.get("assistantId");

    if (!assistantId) {
      return NextResponse.json(
        { error: "Assistant ID is required" },
        { status: 400 }
      );
    }

    // Validate UUID format
    if (!isValidUUID(assistantId)) {
      return NextResponse.json(
        { error: "Invalid assistant ID format" },
        { status: 400 }
      );
    }

    // Verify assistant belongs to organization
    const { data: assistant } = await (supabase as any)
      .from("assistants")
      .select("id")
      .eq("id", assistantId)
      .eq("organization_id", organizationId)
      .single();

    if (!assistant) {
      return NextResponse.json(
        { error: "Assistant not found" },
        { status: 404 }
      );
    }

    // Get transfer rules
    const rules = await getTransferRules(organizationId, assistantId);

    return NextResponse.json({
      success: true,
      rules,
    });
  } catch (error) {
    console.error("Get transfer rules error:", error);
    const message = error instanceof Error ? error.message : "Failed to get transfer rules";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/transfer/rules
 *
 * Create a new transfer rule
 *
 * Body:
 * - assistantId: string
 * - name: string
 * - triggerKeywords?: string[]
 * - triggerIntent?: string
 * - transferToPhone: string
 * - transferToName?: string
 * - announcementMessage?: string
 * - priority?: number
 */
export async function POST(request: NextRequest) {
  try {
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

    const body = await request.json();
    const {
      assistantId,
      name,
      triggerKeywords,
      triggerIntent,
      transferToPhone,
      transferToName,
      announcementMessage,
      priority,
      destinations,
      requireConfirmation,
    } = body;

    // Validate required fields
    if (!assistantId) {
      return NextResponse.json(
        { error: "Assistant ID is required" },
        { status: 400 }
      );
    }

    // Validate UUID format
    if (!isValidUUID(assistantId)) {
      return NextResponse.json(
        { error: "Invalid assistant ID format" },
        { status: 400 }
      );
    }

    if (!name) {
      return NextResponse.json(
        { error: "Rule name is required" },
        { status: 400 }
      );
    }

    if (!transferToPhone) {
      return NextResponse.json(
        { error: "Transfer phone number is required" },
        { status: 400 }
      );
    }

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

    // Verify assistant belongs to organization
    const { data: assistant } = await (supabase as any)
      .from("assistants")
      .select("id")
      .eq("id", assistantId)
      .eq("organization_id", organizationId)
      .single();

    if (!assistant) {
      return NextResponse.json(
        { error: "Assistant not found" },
        { status: 404 }
      );
    }

    // Create the rule
    const rule = await createTransferRule(organizationId, assistantId, {
      name,
      triggerKeywords,
      triggerIntent,
      transferToPhone,
      transferToName,
      announcementMessage,
      priority,
      destinations,
      requireConfirmation,
    });

    return NextResponse.json({
      success: true,
      rule,
    });
  } catch (error) {
    console.error("Create transfer rule error:", error);
    const message = error instanceof Error ? error.message : "Failed to create transfer rule";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
