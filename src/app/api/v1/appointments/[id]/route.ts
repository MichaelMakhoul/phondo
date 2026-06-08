import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isValidUUID } from "@/lib/security/validation";
import { validateOrgScopedRefs } from "@/lib/calendar/validate-org-scoped-refs";
import { getClientHistory } from "@/lib/clients/client-history";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import {
  assembleLifecycle,
  LIFECYCLE_COLS,
  type LifecycleLeg,
} from "@/lib/calendar/appointment-lifecycle";
import { z } from "zod";

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

// SCRUM-389: reconstruct the reschedule lifecycle by walking the supersede chain
// (back to the root via rescheduled_from_id, then forward to the tip via the reverse
// FK). Org-scoped on every hop, bounded against cycles; the pure order-assembly +
// projection lives in lib/calendar/appointment-lifecycle (unit-tested). Best-effort.
const LIFECYCLE_CAP = 20; // defensive bound on chain length (cycles shouldn't occur)

async function buildAppointmentLifecycle(
  supabase: any,
  orgId: string,
  opened: any
): Promise<LifecycleLeg[] | null> {
  // Back-walk: opened → … → root, following rescheduled_from_id (unique parent).
  const ancestors: any[] = [];
  let cur = opened;
  for (let i = 0; i < LIFECYCLE_CAP && cur?.rescheduled_from_id; i++) {
    const { data: prev } = await supabase
      .from("appointments")
      .select(LIFECYCLE_COLS)
      .eq("id", cur.rescheduled_from_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!prev) break;
    ancestors.push(prev);
    cur = prev;
  }
  // Forward-walk: opened → … → tip, following the reverse FK (earliest successor).
  const descendants: any[] = [];
  cur = opened;
  for (let i = 0; i < LIFECYCLE_CAP; i++) {
    const { data: nextRows } = await supabase
      .from("appointments")
      .select(LIFECYCLE_COLS)
      .eq("rescheduled_from_id", cur.id)
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true })
      .limit(1);
    const next = nextRows?.[0];
    if (!next) break;
    descendants.push(next);
    cur = next;
  }

  return assembleLifecycle(ancestors, opened, descendants);
}

const updateSchema = z.object({
  attendee_first_name: z.string().min(1).max(100).optional(),
  attendee_last_name: z.string().max(100).optional(),
  attendee_phone: z.string().min(8).max(20).optional(),
  attendee_email: z.string().email().max(254).optional().nullable(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  duration_minutes: z.number().int().min(5).max(480).optional(),
  service_type_id: z.string().uuid().optional().nullable(),
  practitioner_id: z.string().uuid().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  status: z.enum(["pending", "confirmed", "cancelled", "rescheduled", "completed", "no_show"]).optional(),
});

// GET /api/v1/appointments/[id] — full details + client history
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Invalid appointment ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const orgId = await getOrgId(supabase, user.id);
    if (!orgId) return NextResponse.json({ error: "No organization" }, { status: 404 });

    // Fetch appointment with service type and practitioner names
    const { data: appointment, error } = await (supabase as any)
      .from("appointments")
      .select(`
        *,
        service_types(id, name, duration_minutes),
        practitioners(id, name, title)
      `)
      .eq("id", id)
      .eq("organization_id", orgId)
      .single();

    if (error || !appointment) {
      return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
    }

    // Get client history if phone number exists
    let clientHistory = null;
    if (appointment.attendee_phone) {
      try {
        clientHistory = await getClientHistory(appointment.attendee_phone, orgId);
      } catch (err: unknown) {
        console.error("Client history fetch failed (non-fatal):", err);
      }
    }

    // Get linked call if exists
    let linkedCall = null;
    if (appointment.call_id) {
      const { data: call } = await (supabase as any)
        .from("calls")
        .select("id, created_at, duration_seconds, summary, sentiment")
        .eq("id", appointment.call_id)
        .single();
      linkedCall = call;
    }

    // SCRUM-389: reconstruct the reschedule lifecycle (booked → moved → … → current/
    // cancelled). Best-effort — a failure here must not break the detail fetch.
    let lifecycle: LifecycleLeg[] | null = null;
    try {
      lifecycle = await buildAppointmentLifecycle(supabase, orgId, appointment);
    } catch (err: unknown) {
      console.error("Appointment lifecycle reconstruction failed (non-fatal):", err);
    }

    return NextResponse.json({
      appointment,
      clientHistory,
      linkedCall,
      lifecycle,
    });
  } catch (err: unknown) {
    console.error("GET /appointments/[id] error:", err);
    return NextResponse.json({ error: "Failed to fetch appointment" }, { status: 500 });
  }
}

// PATCH /api/v1/appointments/[id] — edit appointment fields
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Invalid appointment ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const orgId = await getOrgId(supabase, user.id);
    if (!orgId) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const updates: Record<string, any> = {};
    const data = parsed.data;

    // Build update object — only include provided fields
    if (data.attendee_first_name !== undefined || data.attendee_last_name !== undefined) {
      if (data.attendee_first_name) updates.attendee_first_name = data.attendee_first_name;
      if (data.attendee_last_name !== undefined) updates.attendee_last_name = data.attendee_last_name;
      // Keep attendee_name in sync
      const first = data.attendee_first_name || "";
      const last = data.attendee_last_name || "";
      updates.attendee_name = [first, last].filter(Boolean).join(" ");
    }
    if (data.attendee_phone) updates.attendee_phone = data.attendee_phone;
    if (data.attendee_email !== undefined) updates.attendee_email = data.attendee_email;
    if (data.start_time) {
      if (new Date(data.start_time).getTime() < Date.now()) {
        return NextResponse.json({ error: "Cannot reschedule to a past time" }, { status: 400 });
      }
      updates.start_time = data.start_time;
    }
    if (data.end_time) updates.end_time = data.end_time;
    if (data.duration_minutes) updates.duration_minutes = data.duration_minutes;
    if (data.service_type_id !== undefined) updates.service_type_id = data.service_type_id;
    if (data.practitioner_id !== undefined) updates.practitioner_id = data.practitioner_id;
    if (data.notes !== undefined) updates.notes = data.notes;
    if (data.status) updates.status = data.status;

    // SCRUM-360: a referenced service_type / practitioner must belong to this org
    // (skips null, so clearing a field is still allowed).
    const refError = await validateOrgScopedRefs(supabase, orgId, {
      serviceTypeId: data.service_type_id,
      practitionerId: data.practitioner_id,
    });
    if (refError) {
      return NextResponse.json({ error: refError }, { status: 400 });
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const { data: updated, error } = await (supabase as any)
      .from("appointments")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", orgId)
      .select("*")
      .single();

    if (error) {
      if (error.code === "23P01") {
        return NextResponse.json({ error: "This time conflicts with another appointment" }, { status: 409 });
      }
      throw error;
    }

    // SCRUM-245: invalidate voice-server schedule cache so reschedules and
    // status/practitioner changes show up on the next call.
    // See appointments/route.ts POST for why we use after() instead of
    // bare fire-and-forget on Vercel.
    after(async () => {
      try {
        await invalidateVoiceScheduleCache(orgId);
      } catch (err) {
        console.error("[appointments PATCH] cache invalidation failed (non-fatal):", err);
      }
    });

    return NextResponse.json(updated);
  } catch (err: unknown) {
    console.error("PATCH /appointments/[id] error:", err);
    return NextResponse.json({ error: "Failed to update appointment" }, { status: 500 });
  }
}

// DELETE /api/v1/appointments/[id] — cancel appointment
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!isValidUUID(id)) {
      return NextResponse.json({ error: "Invalid appointment ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const orgId = await getOrgId(supabase, user.id);
    if (!orgId) return NextResponse.json({ error: "No organization" }, { status: 404 });

    const { error } = await (supabase as any)
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", id)
      .eq("organization_id", orgId);

    if (error) throw error;

    // SCRUM-245: invalidate voice-server schedule cache so the cancelled
    // slot reopens immediately for in-flight or next calls.
    // See appointments/route.ts POST for why we use after() instead of
    // bare fire-and-forget on Vercel.
    after(async () => {
      try {
        await invalidateVoiceScheduleCache(orgId);
      } catch (err) {
        console.error("[appointments DELETE] cache invalidation failed (non-fatal):", err);
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    console.error("DELETE /appointments/[id] error:", err);
    return NextResponse.json({ error: "Failed to cancel appointment" }, { status: 500 });
  }
}
