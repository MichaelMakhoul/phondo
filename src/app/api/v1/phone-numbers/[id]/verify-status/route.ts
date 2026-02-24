import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/v1/phone-numbers/[id]/verify-status
 *
 * Check if any call has been received on this phone number in the last 2 minutes.
 * Used during forwarding setup to verify that call forwarding is working.
 */
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

    const { data: membership, error: membershipError } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single();

    if (membershipError && membershipError.code !== "PGRST116") {
      console.error("[VerifyStatus] Membership lookup error:", { userId: user.id, error: membershipError });
      return NextResponse.json({ error: "Failed to check organization" }, { status: 500 });
    }

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    // Verify the phone number belongs to this org
    const { data: phoneNumber, error: phoneError } = await (supabase as any)
      .from("phone_numbers")
      .select("id, organization_id")
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single();

    if (phoneError || !phoneNumber) {
      return NextResponse.json({ error: "Phone number not found" }, { status: 404 });
    }

    // Check for any call received on this phone number in the last 2 minutes
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: recentCall, error: callError } = await (supabase as any)
      .from("calls")
      .select("id, caller_phone, created_at")
      .eq("phone_number_id", id)
      .gte("created_at", twoMinutesAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (callError) {
      console.error("[VerifyStatus] Failed to check recent calls:", { phoneNumberId: id, error: callError });
      return NextResponse.json({ error: "Failed to check call status" }, { status: 500 });
    }

    if (recentCall) {
      // A call was received — mark forwarding as active
      const { error: updateError } = await (supabase as any)
        .from("phone_numbers")
        .update({ forwarding_status: "active" })
        .eq("id", id);

      if (updateError) {
        console.error("[VerifyStatus] Failed to update forwarding_status:", { phoneNumberId: id, error: updateError });
        return NextResponse.json({ error: "Failed to update forwarding status" }, { status: 500 });
      }

      return NextResponse.json({
        verified: true,
        call: {
          callerPhone: recentCall.caller_phone,
          createdAt: recentCall.created_at,
        },
      });
    }

    return NextResponse.json({ verified: false });
  } catch (error) {
    console.error("[VerifyStatus] Unexpected error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
