import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVapiClient } from "@/lib/vapi";
import { z } from "zod";

// Type for org_members query result
interface Membership {
  organization_id: string;
  role?: string;
}

// Loose E.164: 8-15 digits with leading +. Strict enough to reject obvious
// typos (numbers without country code, letters, punctuation other than +)
// but lenient enough not to fight Twilio's slightly broader acceptance set.
export const E164_REGEX = /^\+[1-9]\d{7,14}$/;

// Sensitive fields — changing these affects call routing for live customers
// and can redirect inbound calls to attacker-controlled numbers. Restrict
// to org owners and admins. Non-sensitive fields (assistant assignment,
// friendly name) remain available to all org members.
const SENSITIVE_FIELDS = ["aiEnabled", "fallbackForwardNumber"] as const;

export const updatePhoneNumberSchema = z.object({
  assistantId: z.string().uuid().nullable().optional(),
  friendlyName: z.string().optional(),
  forwardingStatus: z.enum(["pending_setup", "active", "paused"]).optional(),
  carrier: z.string().optional(),
  aiEnabled: z.boolean().optional(),
  // Tri-state semantics:
  //   undefined → field omitted, do NOT touch DB
  //   null      → explicit clear, write NULL (voicemail fallback resumes)
  //   ""        → also clear, normalised to null
  //   "+E.164"  → set the fallback after trim + regex validation
  // The transform must preserve `undefined` so that an unrelated PATCH
  // (e.g., assigning an assistant) does not silently wipe a saved fallback.
  fallbackForwardNumber: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      return v.trim();
    })
    .refine((v) => v === undefined || v === null || E164_REGEX.test(v), {
      message: "Fallback number must be in E.164 format (e.g., +61412345678)",
    }),
});

export type UpdatePhoneNumberInput = z.infer<typeof updatePhoneNumberSchema>;

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
      .select("organization_id, role")
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

    // Role gate for sensitive fields. Setting a fallback or pausing AI
    // affects call routing for the whole org — restrict to owner/admin.
    const isAdmin = !!membership.role && ["owner", "admin"].includes(membership.role);
    const wantsSensitiveChange = SENSITIVE_FIELDS.some(
      (key) => (validatedData as Record<string, unknown>)[key] !== undefined
    );
    if (wantsSensitiveChange && !isAdmin) {
      return NextResponse.json(
        { error: "Only org owners and admins can change AI status or fallback forwarding" },
        { status: 403 }
      );
    }

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

    // Sync to Vapi only if assistant or friendly name actually changed.
    // Calling Vapi with undefined assistantId/name can clobber the existing
    // mapping depending on SDK semantics; skip the call entirely when this
    // PATCH only touches local fields (ai_enabled, fallback_forward_number).
    const vapiFieldsChanged =
      validatedData.assistantId !== undefined ||
      validatedData.friendlyName !== undefined;
    if (vapiFieldsChanged && currentPhoneNumber.vapi_phone_number_id) {
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
    if (validatedData.fallbackForwardNumber !== undefined) {
      const fb = validatedData.fallbackForwardNumber;
      if (fb) {
        // Reject self-forward to the same row — would loop instantly
        if (fb === currentPhoneNumber.phone_number) {
          return NextResponse.json(
            { error: "Fallback number cannot be the same as this phone number" },
            { status: 400 }
          );
        }
        // Reject forward to ANY other Phondo-managed number in this org —
        // an A→B→A configuration creates a multi-hop loop billed per minute.
        const { data: orgNumberMatch } = await (supabase
          .from("phone_numbers") as any)
          .select("id")
          .eq("organization_id", membership.organization_id)
          .eq("phone_number", fb)
          .maybeSingle();
        if (orgNumberMatch) {
          return NextResponse.json(
            { error: "Fallback cannot be another Phondo-managed number in your organization (would create a forwarding loop)" },
            { status: 400 }
          );
        }
      }
      updateData.fallback_forward_number = fb;
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
      .select("vapi_phone_number_id, twilio_sid, telnyx_connection_id")
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
