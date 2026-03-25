import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVapiClient } from "@/lib/vapi";
import { z } from "zod";

// Type for org_members query result
interface Membership {
  organization_id: string;
  role?: string;
}

const updatePhoneNumberSchema = z.object({
  assistantId: z.string().uuid().nullable().optional(),
  friendlyName: z.string().optional(),
  forwardingStatus: z.enum(["pending_setup", "active", "paused"]).optional(),
  carrier: z.string().optional(),
  aiEnabled: z.boolean().optional(),
});

// GET /api/v1/phone-numbers/[id] - Get a single phone number
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

    const { data: phoneNumber, error } = await (supabase
      .from("phone_numbers") as any)
      .select(`
        *,
        assistants (id, name)
      `)
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single();

    if (error || !phoneNumber) {
      return NextResponse.json({ error: "Phone number not found" }, { status: 404 });
    }

    return NextResponse.json(phoneNumber);
  } catch (error) {
    console.error("Error getting phone number:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/phone-numbers/[id] - Update a phone number (assign to assistant)
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

    // Get current phone number
    const { data: currentPhoneNumber } = await (supabase
      .from("phone_numbers") as any)
      .select("*")
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single();

    if (!currentPhoneNumber) {
      return NextResponse.json({ error: "Phone number not found" }, { status: 404 });
    }

    const body = await request.json();
    const validatedData = updatePhoneNumberSchema.parse(body);

    // Get Vapi assistant ID if assigning to an assistant
    let vapiAssistantId: string | undefined;
    if (validatedData.assistantId) {
      const { data: assistant } = await (supabase
        .from("assistants") as any)
        .select("vapi_assistant_id")
        .eq("id", validatedData.assistantId)
        .eq("organization_id", membership.organization_id)
        .single();

      if (assistant?.vapi_assistant_id) {
        vapiAssistantId = assistant.vapi_assistant_id;
      }
    }

    // Sync to Vapi (non-fatal — self-hosted is primary)
    if (currentPhoneNumber.vapi_phone_number_id) {
      try {
        const vapi = getVapiClient();
        await vapi.updatePhoneNumber(currentPhoneNumber.vapi_phone_number_id, {
          assistantId: vapiAssistantId,
          name: validatedData.friendlyName,
        });
      } catch (vapiErr) {
        console.warn("[PhoneNumbers] Vapi sync failed on PATCH (non-fatal):", vapiErr);
      }
    }

    // Update in database
    const updateData: Record<string, unknown> = {};
    if (validatedData.assistantId !== undefined) {
      updateData.assistant_id = validatedData.assistantId;
    }
    if (validatedData.friendlyName !== undefined) {
      updateData.friendly_name = validatedData.friendlyName;
    }
    if (validatedData.forwardingStatus !== undefined) {
      updateData.forwarding_status = validatedData.forwardingStatus;
    }
    if (validatedData.carrier !== undefined) {
      updateData.carrier = validatedData.carrier;
    }
    if (validatedData.aiEnabled !== undefined) {
      updateData.ai_enabled = validatedData.aiEnabled;
    }

    const { data: phoneNumber, error } = await (supabase
      .from("phone_numbers") as any)
      .update(updateData)
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .select(`
        *,
        assistants (id, name)
      `)
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(phoneNumber);
  } catch (error) {
    console.error("Error updating phone number:", error);
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

// DELETE /api/v1/phone-numbers/[id] - Release a phone number
export async function DELETE(
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
      .select("organization_id, role")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    if (!membership.role || !["owner", "admin"].includes(membership.role)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // Get phone number
    const { data: phoneNumber } = await (supabase
      .from("phone_numbers") as any)
      .select("vapi_phone_number_id, twilio_sid")
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single();

    if (!phoneNumber) {
      return NextResponse.json({ error: "Phone number not found" }, { status: 404 });
    }

    // Release from carrier first (paid resource — must not orphan)
    if (phoneNumber.telnyx_connection_id) {
      try {
        const { releaseNumber } = await import("@/lib/telnyx/client");
        await releaseNumber(phoneNumber.telnyx_connection_id);
      } catch (e) {
        console.error("Failed to release from Telnyx:", e);
        return NextResponse.json(
          { error: "Failed to release number from Telnyx. Please try again or contact support." },
          { status: 502 }
        );
      }
    } else if (phoneNumber.twilio_sid) {
      try {
        const { releaseNumber } = await import("@/lib/twilio/client");
        await releaseNumber(phoneNumber.twilio_sid);
      } catch (e) {
        console.error("Failed to release from Twilio:", e);
        return NextResponse.json(
          { error: "Failed to release number from Twilio. Please try again or contact support." },
          { status: 502 }
        );
      }
    }

    // Delete from Vapi
    if (phoneNumber.vapi_phone_number_id) {
      const vapi = getVapiClient();
      try {
        await vapi.deletePhoneNumber(phoneNumber.vapi_phone_number_id);
      } catch (e) {
        console.error("Failed to delete from Vapi:", e);
        // Twilio already released — Vapi deletion failure is non-critical
        // since the paid Twilio resource is already freed
      }
    }

    // Delete from database only after external resources are cleaned up
    const { error } = await (supabase
      .from("phone_numbers") as any)
      .delete()
      .eq("id", id)
      .eq("organization_id", membership.organization_id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting phone number:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
