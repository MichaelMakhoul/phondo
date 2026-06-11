import { NextRequest, NextResponse, after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import crypto from "crypto";
import { createClient } from "@/lib/supabase/server";
import { isValidUUID } from "@/lib/security/validation";
import { validateOrgScopedRefs } from "@/lib/calendar/validate-org-scoped-refs";
import { isAllowedStatusTransition, MAX_BOOKING_HORIZON_MS } from "@/lib/calendar/appointment-lifecycle";
import { getClientHistory } from "@/lib/clients/client-history";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import { sendAppointmentConfirmationSMS } from "@/lib/sms/caller-sms";
import {
  assembleLifecycle,
  LIFECYCLE_COLS,
  pickName,
  type LifecycleLeg,
} from "@/lib/calendar/appointment-lifecycle";
import {
  decideRescheduleLeg,
  buildRescheduleLegFields,
  partitionRescheduleChanges,
} from "@/lib/calendar/reschedule-core";
import { getAppointmentLabels } from "@/lib/calendar/industry-labels";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  diffAppointmentFields,
  classifyEditEvent,
  recordAppointmentEvent,
  type AppointmentSnapshot,
} from "@/lib/appointments/events";
import { z } from "zod";

// SCRUM-398/399: columns the before-image needs — resolved names for the audit diff
// PLUS the raw fields/FKs a reschedule leg carries over to its new row.
const BEFORE_COLS =
  "id, attendee_name, attendee_first_name, attendee_last_name, attendee_phone, attendee_email, " +
  "notes, start_time, end_time, duration_minutes, status, service_type_id, practitioner_id, " +
  "service_types(name), practitioners(name)";

// SCRUM-398: project an appointment row (with embedded practitioner/service names)
// into the normalized snapshot the audit diff compares.
function toSnapshot(row: any): AppointmentSnapshot {
  return {
    name: row.attendee_name ?? null,
    phone: row.attendee_phone ?? null,
    email: row.attendee_email ?? null,
    notes: row.notes ?? null,
    startTime: row.start_time ?? null,
    status: row.status ?? null,
    practitioner: pickName(row.practitioners),
    service: pickName(row.service_types),
  };
}

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
  // SCRUM-399: opt-in — when a dashboard edit moves the time/practitioner/service
  // (a reschedule leg), text the customer the new time. Default off; ignored on a
  // plain in-place edit. Never a DB column — read separately, not added to `updates`.
  send_sms: z.boolean().optional(),
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

    // SCRUM-398: in-place edit events for the merged history timeline (manual edits
    // shown next to AI changes). Cover every leg in the chain so an edit on any leg
    // surfaces. Best-effort — a failure must not break the detail fetch.
    let events: Array<Record<string, unknown>> = [];
    try {
      const ids = lifecycle ? lifecycle.map((l) => l.id) : [appointment.id];
      const { data: evRows, error: evErr } = await (supabase as any)
        .from("appointment_events")
        .select("id, event_type, actor_type, channel, changed_fields, created_at")
        .in("appointment_id", ids)
        .eq("organization_id", orgId)
        .order("created_at", { ascending: true });
      // supabase-js resolves query failures as { data: null, error } WITHOUT throwing,
      // so surface it — otherwise the history silently renders without edit events.
      if (evErr) console.error("Appointment events fetch failed (non-fatal):", evErr.message);
      events = (evRows || []).map((e: any) => ({
        id: e.id,
        eventType: e.event_type,
        actorType: e.actor_type,
        channel: e.channel,
        changedFields: Array.isArray(e.changed_fields) ? e.changed_fields : [],
        createdAt: e.created_at,
      }));
    } catch (err: unknown) {
      console.error("Appointment events fetch failed (non-fatal):", err);
    }

    // SCRUM-397: industry-generic field labels (Dentist / Attorney / Technician …)
    // so the edit form and history aren't hardcoded to dental. Best-effort.
    let labels = getAppointmentLabels(null);
    try {
      const { data: org } = await (supabase as any)
        .from("organizations")
        .select("industry")
        .eq("id", orgId)
        .single();
      labels = getAppointmentLabels(org?.industry ?? null);
    } catch (err: unknown) {
      console.error("Org industry fetch for labels failed (non-fatal):", err);
    }

    return NextResponse.json({
      appointment,
      clientHistory,
      linkedCall,
      lifecycle,
      events,
      labels,
    });
  } catch (err: unknown) {
    console.error("GET /appointments/[id] error:", err);
    return NextResponse.json({ error: "Failed to fetch appointment" }, { status: 500 });
  }
}

/**
 * SCRUM-399: perform a dashboard reschedule as a lifecycle LEG. Free the OLD row
 * FIRST (mark `rescheduled`) — a row never conflicts with itself, but the NEW row
 * would conflict with the still-live old one on the GiST no-overlap constraint, so
 * freeing first is what lets a move into the appointment's own/overlapping slot
 * succeed. Then insert the new leg; if that fails, ROLL BACK the old row to its
 * prior status so the customer keeps their appointment. Links rescheduled_from_id,
 * records audit events, and (opt-in) texts the customer the new time.
 */
async function rescheduleViaLeg(
  supabase: any,
  orgId: string,
  userId: string,
  oldId: string,
  before: any,
  updates: Record<string, any>,
  sendSms: boolean
): Promise<NextResponse> {
  // 1. Free the old leg — guarded on it still being active so we don't race a
  //    concurrent cancel/move (and never "revive" an already-terminal row).
  const { data: freed, error: freeErr } = await supabase
    .from("appointments")
    .update({ status: "rescheduled" })
    .eq("id", oldId)
    .eq("organization_id", orgId)
    .in("status", ["confirmed", "pending"])
    .select("id");

  if (freeErr) {
    console.error("[appointments PATCH] failed to free old leg for reschedule:", freeErr);
    return NextResponse.json({ error: "Failed to reschedule appointment" }, { status: 500 });
  }
  if (!freed || freed.length === 0) {
    return NextResponse.json(
      { error: "This appointment can no longer be edited (it may have been cancelled or moved)." },
      { status: 409 }
    );
  }

  // 2. Insert the new leg — the old row's fields with the staff edits applied. A
  //    fresh confirmation_code (the column is UNIQUE; the old code stays on the old
  //    row, which is now the inactive `rescheduled` leg).
  const legFields = buildRescheduleLegFields(before, updates);
  let { data: inserted, error: insErr } = await supabase
    .from("appointments")
    .insert({
      ...legFields,
      organization_id: orgId,
      provider: "manual",
      confirmation_code: crypto.randomInt(100000, 999999).toString(),
      rescheduled_from_id: oldId,
      metadata: { source: "dashboard_reschedule", created_by: userId, rescheduled_from: oldId },
    })
    .select("*, service_types(name), practitioners(name)")
    .single();

  // SCRUM-431 (finding #49): one retry on a confirmation-code collision —
  // same classification discipline as bookInternal.
  if (insErr && insErr.code === "23505" && /confirmation_code/i.test(insErr.message || "")) {
    console.warn("[Reschedule] Confirmation-code collision on leg insert — retrying once");
    ({ data: inserted, error: insErr } = await (supabase as any)
      .from("appointments")
      .insert({
        ...legFields,
        organization_id: orgId,
        provider: "manual",
        confirmation_code: crypto.randomInt(100000, 999999).toString(),
        rescheduled_from_id: oldId,
        metadata: { source: "dashboard_reschedule", created_by: userId, rescheduled_from: oldId },
      })
      .select("*, service_types(name), practitioners(name)")
      .single());
  }

  if (insErr) {
    // The move failed — restore the old row so the customer keeps their slot. Guard
    // on the status we ourselves set (`rescheduled`) so we only revive a row WE froze,
    // and `.select` the result so a 0-row rollback (row concurrently changed/deleted)
    // is treated as a failure rather than a false success.
    const { data: restored, error: rbErr } = await supabase
      .from("appointments")
      .update({ status: before.status })
      .eq("id", oldId)
      .eq("organization_id", orgId)
      .eq("status", "rescheduled")
      .select("id");
    const rolledBack = !rbErr && Array.isArray(restored) && restored.length > 0;

    if (!rolledBack) {
      // Old freed, new not created, AND rollback didn't restore it → the customer is
      // stranded with a superseded-but-not-replaced appointment. Page on-call, and
      // return a DISTINCT error so staff know the appointment needs manual review
      // (never the look-alike "time conflicts" 409, which would mask data loss).
      console.error("[appointments PATCH] reschedule rollback FAILED — orphaned old leg", {
        orgId, oldId, insErr: insErr.message, rbErr: rbErr?.message ?? "0 rows restored",
      });
      Sentry.withScope((scope) => {
        scope.setLevel("error");
        scope.setTag("bug", "dashboard_reschedule_rollback_failed");
        scope.setExtras({ orgId, oldId });
        Sentry.captureMessage("Dashboard reschedule rollback failed (orphaned old leg)");
      });
      return NextResponse.json(
        { error: "We couldn't complete the move and couldn't restore the original appointment — it needs manual review." },
        { status: 500 }
      );
    }

    // Rollback succeeded — the customer keeps their original appointment.
    if (insErr.code === "23P01") {
      return NextResponse.json({ error: "This time conflicts with another appointment" }, { status: 409 });
    }
    console.error("[appointments PATCH] failed to insert reschedule leg (original kept):", insErr);
    return NextResponse.json({ error: "Failed to reschedule appointment" }, { status: 500 });
  }

  after(async () => {
    try {
      await invalidateVoiceScheduleCache(orgId);
    } catch (err) {
      console.error("[appointments PATCH] cache invalidation failed (non-fatal):", err);
    }
    // Audit: the structural `rescheduled` event (not rendered standalone — the leg
    // already shows the move) plus, if a name/phone/email/notes was corrected in the
    // same save, an `edited` event ON the new leg so that detail change still shows.
    try {
      const admin = createAdminClient();
      const allChanges = diffAppointmentFields(toSnapshot(before), toSnapshot(inserted));
      const { legWorthy, inPlace } = partitionRescheduleChanges(allChanges);
      await recordAppointmentEvent(admin, {
        appointmentId: inserted.id,
        organizationId: orgId,
        eventType: "rescheduled",
        actorType: "staff",
        actorId: userId,
        channel: "dashboard",
        changedFields: legWorthy,
      });
      if (inPlace.length > 0) {
        await recordAppointmentEvent(admin, {
          appointmentId: inserted.id,
          organizationId: orgId,
          eventType: "edited",
          actorType: "staff",
          actorId: userId,
          channel: "dashboard",
          changedFields: inPlace,
        });
      }
    } catch (e) {
      console.error("[appointments PATCH] reschedule audit emit failed (non-fatal):", e);
    }
    // SCRUM-399: opt-in customer SMS for the new time. The old-slot cancellation SMS
    // is never sent — this is a move. sendAppointmentConfirmationSMS already honors
    // opt-outs, rate limits, and the org's customer-confirmation setting (it resolves
    // the org timezone itself when none is passed), so we pass undefined for timezone.
    if (sendSms) {
      if (!inserted.attendee_phone || !inserted.start_time) {
        // Staff explicitly requested a text but we can't send one — log it so the
        // unmet request is visible (the panel optimistically said "moved").
        console.warn("[appointments PATCH] reschedule SMS requested but skipped — missing phone/time", {
          orgId, appointmentId: inserted.id, hasPhone: !!inserted.attendee_phone,
        });
      } else {
        try {
          // The send can be REFUSED without throwing (opt-out, rate limit, plan/feature
          // gating, no org number…) — it returns { sent:false, reason }. Inspect it so a
          // staff-requested-but-undelivered text isn't a silent no-op.
          const smsResult = await sendAppointmentConfirmationSMS(
            orgId,
            inserted.attendee_phone,
            new Date(inserted.start_time),
            undefined,
            undefined,
            inserted.id
          );
          if (smsResult && smsResult.sent === false) {
            console.warn("[appointments PATCH] reschedule SMS not delivered", {
              orgId, appointmentId: inserted.id, status: smsResult.status, reason: smsResult.reason,
            });
          }
        } catch (e) {
          console.error("[appointments PATCH] reschedule SMS threw (non-fatal):", e);
        }
      }
    }
  });

  // Return the new leg + a marker so the panel re-points its view to it (the edited
  // id is now a superseded `rescheduled` row).
  return NextResponse.json({ ...inserted, rescheduled: { fromId: oldId, toId: inserted.id } });
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
      // SCRUM-431 (finding #51): same horizon as creation.
      if (new Date(data.start_time).getTime() > Date.now() + MAX_BOOKING_HORIZON_MS) {
        return NextResponse.json({ error: "Cannot reschedule more than a year in advance" }, { status: 400 });
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
    // SCRUM-444: `requireActive` — assigning a deactivated practitioner/service is
    // rejected. This only bites when the ref is being CHANGED: the validator sees
    // just the PATCH payload (never the stored row), and both dashboard callers
    // send only dirty fields (SCRUM-397), so time-only edits / status changes on
    // an appointment that carries a since-deactivated ref keep working.
    const refError = await validateOrgScopedRefs(
      supabase,
      orgId,
      { serviceTypeId: data.service_type_id, practitionerId: data.practitioner_id },
      { requireActive: true },
    );
    if (refError) {
      return NextResponse.json({ error: refError }, { status: 400 });
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    // SCRUM-398/399: capture the before-image (resolved names + raw FKs/fields). It's
    // needed BEFORE writing — to decide leg-vs-in-place, to diff for the audit log,
    // and to carry fields onto a reschedule leg. A read failure must NOT fall through
    // to a blind write (the SCRUM-394 lesson), so check the error explicitly.
    const { data: before, error: beforeErr } = await (supabase as any)
      .from("appointments")
      .select(BEFORE_COLS)
      .eq("id", id)
      .eq("organization_id", orgId)
      .single();

    if (beforeErr || !before) {
      if (beforeErr && beforeErr.code !== "PGRST116") {
        console.error("[appointments PATCH] before-image read failed:", beforeErr);
        return NextResponse.json({ error: "Failed to update appointment" }, { status: 500 });
      }
      return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
    }

    // SCRUM-399: a change to the time, practitioner, or service is a structural MOVE
    // — model it as a reschedule LEG (new row + old row marked `rescheduled` + link),
    // exactly like the AI path, rather than mutating the row in place. This keeps the
    // history attribution honest (the AI's original leg is preserved; the staff move
    // is its own leg) and resolves the Stage-2 multi-leg double-show.
    // SCRUM-431 (finding #52): block illegal manual status transitions —
    // e.g. completed→pending or reviving a cancelled/rescheduled leg (which
    // would resurrect a freed slot and corrupt the supersede chain).
    if (updates.status && !isAllowedStatusTransition(before.status, updates.status)) {
      return NextResponse.json(
        { error: `Cannot change a ${before.status} appointment to ${updates.status}.` },
        { status: 409 }
      );
    }

    if (decideRescheduleLeg(before, updates).isLeg) {
      return await rescheduleViaLeg(supabase, orgId, user.id, id, before, updates, data.send_sms === true);
    }

    // ── In-place edit (name/phone/email/notes/status only) ──────────────────────
    const { data: updated, error } = await (supabase as any)
      .from("appointments")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", orgId)
      .select("*, service_types(name), practitioners(name)")
      .single();

    if (error) {
      if (error.code === "23P01") {
        return NextResponse.json({ error: "This time conflicts with another appointment" }, { status: 409 });
      }
      throw error;
    }

    // SCRUM-398: record the in-place edit as an audit event. Best-effort, via the
    // admin client (the table is service-role-write-only), in after() so it never
    // delays or breaks the response. The diff compares resolved (name) values.
    const changes = diffAppointmentFields(toSnapshot(before), toSnapshot(updated));
    if (changes.length > 0) {
      after(async () => {
        try {
          await recordAppointmentEvent(createAdminClient(), {
            appointmentId: id,
            organizationId: orgId,
            eventType: classifyEditEvent(changes),
            actorType: "staff",
            actorId: user.id,
            channel: "dashboard",
            changedFields: changes,
          });
        } catch (e) {
          console.error("[appointments PATCH] audit emit failed (non-fatal):", e);
        }
      });
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

    // SCRUM-398: capture the prior status so the audit event records the transition.
    const { data: beforeDel } = await (supabase as any)
      .from("appointments")
      .select("status")
      .eq("id", id)
      .eq("organization_id", orgId)
      .single();

    // SCRUM-431 (finding #52): cancel is a status transition too — a
    // rescheduled (superseded) or completed leg must not be flipped to
    // cancelled (corrupts the chain / falsifies attendance history).
    if (beforeDel && !isAllowedStatusTransition(beforeDel.status, "cancelled")) {
      return NextResponse.json(
        { error: `Cannot cancel a ${beforeDel.status} appointment.` },
        { status: 409 }
      );
    }

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
      // SCRUM-398: audit the cancellation (the dashboard cancels via PATCH-status,
      // but DELETE is auth-reachable too, so keep the trail complete). Best-effort.
      if (beforeDel && beforeDel.status !== "cancelled") {
        try {
          await recordAppointmentEvent(createAdminClient(), {
            appointmentId: id,
            organizationId: orgId,
            eventType: "status_changed",
            actorType: "staff",
            actorId: user.id,
            channel: "dashboard",
            changedFields: [{ field: "status", from: beforeDel.status ?? null, to: "cancelled" }],
          });
        } catch (e) {
          console.error("[appointments DELETE] audit emit failed (non-fatal):", e);
        }
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    console.error("DELETE /appointments/[id] error:", err);
    return NextResponse.json({ error: "Failed to cancel appointment" }, { status: 500 });
  }
}
