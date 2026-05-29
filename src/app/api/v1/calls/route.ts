import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Type for org_members query result
interface Membership {
  organization_id: string;
  role?: string;
}

// GET /api/v1/calls - List all calls
export async function GET(request: Request) {
  try {
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

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const assistantId = searchParams.get("assistantId");
    const phoneNumberId = searchParams.get("phoneNumberId");
    const status = searchParams.get("status");
    const direction = searchParams.get("direction");
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    // Build query
    let query = (supabase
      .from("calls") as any)
      .select(`
        *,
        assistants (id, name),
        phone_numbers (id, phone_number, friendly_name)
      `, { count: "exact" })
      .eq("organization_id", membership.organization_id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (assistantId) {
      query = query.eq("assistant_id", assistantId);
    }
    if (phoneNumberId) {
      query = query.eq("phone_number_id", phoneNumberId);
    }
    if (status) {
      query = query.eq("status", status);
    }
    if (direction) {
      query = query.eq("direction", direction);
    }

    const { data: calls, error, count } = await query;

    if (error) {
      // SCRUM-347 (L1): log DB detail server-side, return a generic client
      // message — raw PostgREST error text leaks schema/internal structure.
      console.error("Error listing calls (query):", error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    return NextResponse.json({
      calls,
      pagination: {
        total: count,
        limit,
        offset,
      },
    });
  } catch (error) {
    console.error("Error listing calls:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
