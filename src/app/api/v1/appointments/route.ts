import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isValidPhoneNumber } from "@/lib/security/validation";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import { z } from "zod";
import crypto from "crypto";

interface Membership {
  organization_id: string;
}

async function getOrgId(supabase: any, userId: string): Promise<string | null> {
  const { data, error } = await (supabase as any)
    .from("org_members")
    .select("organization_id")
    .eq("user_id", userId)
    .single() as { data: Membership | null; error: any };
  if (error && error.code !== "PGRST116") {
    console.error("getOrgId error:", error.message);
  }
  return data?.organization_id || null;
}

const createSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().max(100).optional(),
  phone: z.string().min(8).max(20),
  email: z.string().email().max(254).optional(),
  start_time: z.string().datetime(),
  duration_minutes: z.number().int().min(5).max(480).optional(),
  service_type_id: z.string().uuid().optional(),
  practitioner_id: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
  send_sms: z.boolean().optional(),
});

// GET /api/v1/appointments — list with search/filter/sort
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const orgId = await getOrgId(supabase, user.id);
    if (!orgId) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const status = searchParams.get("status");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const sortBy = searchParams.get("sort") || "start_time";
    const sortDir = searchParams.get("dir") === "asc" ? true : false;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = (page - 1) * limit;

    let query = (supabase as any)
      .from("appointments")
      .select(`
        id, attendee_name, attendee_first_name, attendee_last_name,
        attendee_phone, attendee_email, start_time, end_time,
        duration_minutes, status, notes, confirmation_code, provider,
        created_at, service_type_id, practitioner_id,
        service_types(name), practitioners(name)
      `, { count: "exact" })
      .eq("organization_id", orgId);

    // Filters
    if (status && status !== "all") {
      query = query.eq("status", status);
    } else {
      query = query.neq("status", "cancelled");
    }
    if (from) query = query.gte("start_time", from);
    if (to) query = query.lte("start_time", to);

    // Search
    if (search) {
      query = query.or(
        `attendee_name.ilike.%${search}%,attendee_phone.ilike.%${search}%,confirmation_code.ilike.%${search}%`
      );
    }

    // Sort + paginate
    query = query
      .order(sortBy, { ascending: sortDir })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    return NextResponse.json({
      appointments: data || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err: unknown) {
    console.error("GET /appointments error:", err);
    return NextResponse.json({ error: "Failed to fetch appointments" }, { status: 500 });
  }
}

// POST /api/v1/appointments — manual creation
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const orgId = await getOrgId(supabase, user.id);
    if (!orgId) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const body = await request.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const d = parsed.data;

    if (!isValidPhoneNumber(d.phone)) {
      return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
    }

    if (new Date(d.start_time).getTime() < Date.now()) {
      return NextResponse.json({ error: "Cannot book in the past" }, { status: 400 });
    }

    const durationMinutes = d.duration_minutes || 30;
    const endTime = new Date(new Date(d.start_time).getTime() + durationMinutes * 60_000);
    const confirmationCode = crypto.randomInt(100000, 999999).toString();
    const fullName = [d.first_name, d.last_name].filter(Boolean).join(" ");

    const { data: appointment, error } = await (supabase as any)
      .from("appointments")
      .insert({
        organization_id: orgId,
        provider: "manual",
        attendee_name: fullName,
        attendee_first_name: d.first_name,
        attendee_last_name: d.last_name || null,
        attendee_phone: d.phone,
        attendee_email: d.email || null,
        start_time: d.start_time,
        end_time: endTime.toISOString(),
        duration_minutes: durationMinutes,
        status: "confirmed",
        notes: d.notes || null,
        confirmation_code: confirmationCode,
        service_type_id: d.service_type_id || null,
        practitioner_id: d.practitioner_id || null,
        metadata: { source: "dashboard_manual", created_by: user.id },
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === "23P01") {
        return NextResponse.json({ error: "This time conflicts with another appointment" }, { status: 409 });
      }
      throw error;
    }

    // SCRUM-245: invalidate voice-server schedule cache so any in-flight
    // or next calls see the new booking instead of stale slots.
    await invalidateVoiceScheduleCache(orgId);

    return NextResponse.json(appointment, { status: 201 });
  } catch (err: unknown) {
    console.error("POST /appointments error:", err);
    return NextResponse.json({ error: "Failed to create appointment" }, { status: 500 });
  }
}
