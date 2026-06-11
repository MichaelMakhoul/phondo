import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { updatePhoneNumberSchema, SENSITIVE_FIELDS } from "./schema";
import { getUserRoleInOrg, isOrgAdmin } from "@/lib/auth/org-membership";

// GET /api/v1/phone-numbers/[id] - Get a single phone number
// SCRUM-276: resource-first resolution — load the row (RLS scopes to user's
// accessible orgs) instead of resolving membership first via `.single()`,
// which broke multi-org users.
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

    const { data: phoneNumber, error } = await (supabase
      .from("phone_numbers") as any)
      .select(`
        *,
        assistants (id, name)
      `)
      .eq("id", id)
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
// SCRUM-276: resource-first resolution — load row by id (RLS scopes to user's
// accessible orgs), then check role for THAT row's specific org.
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

    // Get current phone number — RLS automatically scopes to whichever orgs
    // this user has access to. A multi-org user finds rows from any of them.
    const { data: currentPhoneNumber } = await (supabase
      .from("phone_numbers") as any)
      .select("*")
      .eq("id", id)
      .single();

    if (!currentPhoneNumber) {
      return NextResponse.json({ error: "Phone number not found" }, { status: 404 });
    }

    // Now resolve the user's role IN THIS RESOURCE'S ORG. (user_id, org_id)
    // is unique, so .single() inside the helper is safe.
    const roleRow = await getUserRoleInOrg(supabase, user.id, currentPhoneNumber.organization_id);
    if (!roleRow) {
      // Shouldn't happen — RLS would have hidden the row if the user wasn't
      // a member — but defense-in-depth in case the policy is later widened.
      return NextResponse.json({ error: "Phone number not found" }, { status: 404 });
    }

    const body = await request.json();
    const validatedData = updatePhoneNumberSchema.parse(body);

    // Role gate for sensitive fields. Setting a fallback or pausing AI
    // affects call routing for the whole org — restrict to owner/admin.
    const wantsSensitiveChange = SENSITIVE_FIELDS.some(
      (key) => (validatedData as Record<string, unknown>)[key] !== undefined
    );
    if (wantsSensitiveChange && !isOrgAdmin(roleRow.role)) {
      return NextResponse.json(
        { error: "Only org owners and admins can change AI status or fallback forwarding" },
        { status: 403 }
      );
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
          .eq("organization_id", currentPhoneNumber.organization_id)
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
      .eq("organization_id", currentPhoneNumber.organization_id)
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
// SCRUM-276: resource-first resolution; mirrors GET/PATCH pattern.
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

    // Load phone number first (RLS scopes to user's accessible orgs).
    const { data: phoneNumber } = await (supabase
      .from("phone_numbers") as any)
      .select("organization_id, twilio_sid, telnyx_connection_id")
      .eq("id", id)
      .single();

    if (!phoneNumber) {
      return NextResponse.json({ error: "Phone number not found" }, { status: 404 });
    }

    // Now check role for THIS phone's org.
    const roleRow = await getUserRoleInOrg(supabase, user.id, phoneNumber.organization_id);
    if (!roleRow) {
      // RLS would normally hide this row from a non-member, but
      // defense-in-depth — treat as 404 (don't leak existence to non-members).
      return NextResponse.json({ error: "Phone number not found" }, { status: 404 });
    }
    if (!isOrgAdmin(roleRow.role)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
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

    // Delete from database only after external resources are cleaned up.
    // Scope by the phone's own org (defense-in-depth alongside the RLS load above).
    const { error } = await (supabase
      .from("phone_numbers") as any)
      .delete()
      .eq("id", id)
      .eq("organization_id", phoneNumber.organization_id);

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
