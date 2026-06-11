import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { getPrimaryMembership } from "@/lib/auth/membership";

// SCRUM-428 (finding #33): limit/offset were parseInt'd raw from the query
// string — NaN propagated into .range() and an arbitrary limit let one
// request page the whole table. Bounded + defaulted here; bad values fall
// back to the defaults rather than 400ing the dashboard.
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).catch(50),
  offset: z.coerce.number().int().min(0).max(100_000).catch(0),
  // Mirrors the DB call_status enum exactly — "missed" is NOT a call_status
  // (missed-call semantics live in notification classification).
  status: z.enum(["queued", "ringing", "in-progress", "completed", "failed", "no-answer", "busy"]).optional().catch(undefined),
  direction: z.enum(["inbound", "outbound"]).optional().catch(undefined),
});

// GET /api/v1/calls - List all calls
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // SCRUM-428 (finding #38): first membership instead of .single(),
    // which errors (→ misleading 404) for multi-org users.
    const membership = await getPrimaryMembership(supabase, user.id);

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const assistantId = searchParams.get("assistantId");
    const phoneNumberId = searchParams.get("phoneNumberId");
    const { limit, offset, status, direction } = listQuerySchema.parse({
      limit: searchParams.get("limit") ?? undefined,
      offset: searchParams.get("offset") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      direction: searchParams.get("direction") ?? undefined,
    });

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
