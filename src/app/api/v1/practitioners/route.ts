import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { z } from "zod";

interface Membership {
  organization_id: string;
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  title: z.string().max(100).optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
});

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };
    if (!membership) return NextResponse.json({ error: "No organization" }, { status: 404 });

    // Fetch practitioners with their assigned services
    const { data: practitioners, error } = await (supabase as any)
      .from("practitioners")
      .select(`
        id, name, title, is_active, availability_override, created_at, updated_at,
        practitioner_services (
          service_type_id,
          service_types ( id, name, duration_minutes )
        )
      `)
      .eq("organization_id", membership.organization_id)
      .eq("is_active", true)
      .order("name", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Flatten the nested service data for easier consumption
    const result = (practitioners || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      title: p.title,
      isActive: p.is_active,
      availabilityOverride: p.availability_override,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      services: (p.practitioner_services || []).map((ps: any) => ({
        id: ps.service_types?.id ?? ps.service_type_id,
        name: ps.service_types?.name ?? null,
        durationMinutes: ps.service_types?.duration_minutes ?? null,
      })),
    }));

    return NextResponse.json(result);
  } catch (err) {
    console.error("[Practitioners] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };
    if (!membership) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const orgId = membership.organization_id;

    // Feature gate: practitioners require Professional+
    const hasAccess = await hasFeatureAccess(orgId, "practitioners");
    if (!hasAccess) {
      return NextResponse.json(
        { error: "Staff management requires a Professional or higher plan" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 });
    }

    const { name, title, serviceIds } = parsed.data;

    // Enforce practitioner limit based on plan
    const { count: existingCount, error: countError } = await (supabase as any)
      .from("practitioners")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("is_active", true);

    if (countError) {
      console.error("[Practitioners] Count query failed:", countError);
      return NextResponse.json({ error: "Failed to check practitioner count" }, { status: 500 });
    }

    // Plan limits are checked via the PLANS config — we import dynamically to avoid circular deps
    const { PLANS } = await import("@/lib/stripe/client");
    const { getSubscriptionInfo } = await import("@/lib/stripe/billing-service");
    const sub = await getSubscriptionInfo(orgId);
    if (sub) {
      const planConfig = PLANS[sub.plan] as any;
      const limit = planConfig?.practitionersLimit ?? 0;
      if (limit !== -1 && (existingCount ?? 0) >= limit) {
        return NextResponse.json(
          { error: `Your plan allows up to ${limit} practitioners. Upgrade to add more.` },
          { status: 403 }
        );
      }
    }

    // Insert practitioner
    const { data: practitioner, error: insertError } = await (supabase as any)
      .from("practitioners")
      .insert({
        organization_id: orgId,
        name,
        title: title || null,
      })
      .select()
      .single();

    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

    // Insert service associations
    if (serviceIds && serviceIds.length > 0) {
      const rows = serviceIds.map((sid) => ({
        practitioner_id: practitioner.id,
        service_type_id: sid,
      }));

      const { error: psError } = await (supabase as any)
        .from("practitioner_services")
        .insert(rows);

      if (psError) {
        console.error("[Practitioners] Failed to insert service associations:", psError);
        // Non-fatal — practitioner was created, services just weren't linked
      }
    }

    // Re-fetch with services to return consistent shape
    const { data: full } = await (supabase as any)
      .from("practitioners")
      .select(`
        id, name, title, is_active, created_at, updated_at,
        practitioner_services (
          service_type_id,
          service_types ( id, name, duration_minutes )
        )
      `)
      .eq("id", practitioner.id)
      .single();

    const result = {
      id: full.id,
      name: full.name,
      title: full.title,
      isActive: full.is_active,
      createdAt: full.created_at,
      updatedAt: full.updated_at,
      services: (full.practitioner_services || []).map((ps: any) => ({
        id: ps.service_types?.id ?? ps.service_type_id,
        name: ps.service_types?.name ?? null,
        durationMinutes: ps.service_types?.duration_minutes ?? null,
      })),
    };

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("[Practitioners] POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
