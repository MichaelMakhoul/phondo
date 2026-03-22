import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import { z } from "zod";

interface Membership {
  organization_id: string;
  role?: string;
}

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  title: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid practitioner ID" }, { status: 400 });
    }
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

    // Feature gate
    const hasAccess = await hasFeatureAccess(orgId, "practitioners");
    if (!hasAccess) {
      return NextResponse.json(
        { error: "Staff management requires a Professional or higher plan" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 });
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.title !== undefined) updates.title = parsed.data.title || null;
    if (parsed.data.isActive !== undefined) updates.is_active = parsed.data.isActive;

    const { data, error } = await (supabase as any)
      .from("practitioners")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", orgId)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Update service associations if provided
    if (parsed.data.serviceIds !== undefined) {
      // Validate serviceIds belong to this org
      if (parsed.data.serviceIds.length > 0) {
        const { data: validServices, error: validError } = await (supabase as any)
          .from("service_types")
          .select("id")
          .eq("organization_id", orgId)
          .in("id", parsed.data.serviceIds);

        if (validError) {
          console.error("[Practitioners] Failed to validate service IDs:", validError);
          return NextResponse.json({ error: "Failed to validate service IDs" }, { status: 500 });
        }

        const validIds = new Set((validServices || []).map((s: any) => s.id));
        const invalidIds = parsed.data.serviceIds.filter((sid) => !validIds.has(sid));
        if (invalidIds.length > 0) {
          return NextResponse.json({ error: `Service IDs do not belong to this organization: ${invalidIds.join(", ")}` }, { status: 400 });
        }
      }

      // Delete existing associations
      const { error: deleteError } = await (supabase as any)
        .from("practitioner_services")
        .delete()
        .eq("practitioner_id", id);

      if (deleteError) {
        console.error("[Practitioners] Failed to delete service associations:", deleteError);
        return NextResponse.json({ error: "Failed to update service associations" }, { status: 500 });
      }

      // Insert new associations
      if (parsed.data.serviceIds.length > 0) {
        const rows = parsed.data.serviceIds.map((sid) => ({
          practitioner_id: id,
          service_type_id: sid,
        }));

        const { error: insertError } = await (supabase as any)
          .from("practitioner_services")
          .insert(rows);

        if (insertError) {
          console.error("[Practitioners] Failed to insert service associations:", insertError);
          return NextResponse.json({ error: "Failed to update service associations" }, { status: 500 });
        }
      }
    }

    // Re-fetch with services
    const { data: full, error: refetchError } = await (supabase as any)
      .from("practitioners")
      .select(`
        id, name, title, is_active, created_at, updated_at,
        practitioner_services (
          service_type_id,
          service_types ( id, name, duration_minutes )
        )
      `)
      .eq("id", id)
      .single();

    if (refetchError || !full) {
      console.error("[Practitioners] Failed to re-fetch after update:", refetchError);
      return NextResponse.json({ error: "Practitioner updated but failed to re-fetch" }, { status: 500 });
    }

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

    return NextResponse.json(result);
  } catch (err) {
    console.error("[Practitioners] PATCH error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid practitioner ID" }, { status: 400 });
    }
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: membership } = await (supabase as any)
      .from("org_members")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };
    if (!membership) return NextResponse.json({ error: "No organization" }, { status: 404 });

    // Feature gate
    const hasAccess = await hasFeatureAccess(membership.organization_id, "practitioners");
    if (!hasAccess) {
      return NextResponse.json(
        { error: "Staff management requires a Professional or higher plan" },
        { status: 403 }
      );
    }

    // Soft delete: set is_active = false (preserves history for appointment references)
    const { data: updated, error } = await (supabase as any)
      .from("practitioners")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .select("id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[Practitioners] DELETE error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
