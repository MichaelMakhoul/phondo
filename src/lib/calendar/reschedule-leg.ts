// SCRUM-586: the reschedule-leg ORCHESTRATION (previously inline in the dashboard
// PATCH route — SCRUM-399) so the owner assistant and the dashboard move an
// appointment through one code path. Free the OLD row FIRST (a row never
// conflicts with itself, but the NEW row would collide with the still-live old
// one on the GiST no-overlap constraint), insert the new leg linked by
// rescheduled_from_id, and ROLL BACK the old row if the insert fails so the
// customer keeps their slot. Pure field carry-over stays in reschedule-core.ts.
import { buildRescheduleLegFields } from "@/lib/calendar/reschedule-core";
import { generateConfirmationCode } from "@/lib/calendar/confirmation-code";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";

export interface RescheduleLegInput {
  orgId: string;
  oldId: string;
  /** Old row (BEFORE image) incl. `status` — the fields buildRescheduleLegFields carries. */
  before: Record<string, any>;
  /** Column overrides applied on top of the old row (start_time, end_time, …). */
  updates: Record<string, unknown>;
  leg: {
    provider: "manual" | "internal";
    metadata: Record<string, unknown>;
    /** Set when the move happened on a call (owner voice). Written to appointments.call_id. */
    callId?: string | null;
  };
  /**
   * Identity of the page raised when the old leg is orphaned (freed, not replaced,
   * and not restored): `message` is the alert's text and `tag` rides along as its
   * `bug` tag. The reason is always RESCHEDULE_LEG_ORPHANED. Defaults to the generic
   * reschedule page; a caller with an established page passes its own so the Sentry
   * issue and any alert rules keyed on the tag/message keep matching.
   */
  orphanPage?: { tag: string; message: string };
}

type DbError = { message?: string; code?: string };

export type RescheduleLegOutcome =
  | { ok: true; inserted: any } // new leg row (LEG_SELECT: *, service_types(name), practitioners(name))
  | { ok: false; reason: "free_failed"; error: DbError } // freeing the old row errored — no leg inserted (a free that committed anyway was restored)
  | { ok: false; reason: "not_active" } // old row no longer confirmed/pending — nothing changed
  | { ok: false; reason: "conflict" } // 23P01 slot clash, old row restored
  | { ok: false; reason: "insert_failed"; error: DbError } // old row restored
  | { ok: false; reason: "orphaned"; error: DbError }; // old row freed, no new leg, restore failed — paged

const LEG_SELECT = "*, service_types(name), practitioners(name)";

const DEFAULT_ORPHAN_PAGE = {
  tag: "reschedule_rollback_failed",
  message: "Reschedule rollback failed (orphaned old leg)",
};

export async function performRescheduleLeg(
  supabase: any,
  { orgId, oldId, before, updates, leg, orphanPage = DEFAULT_ORPHAN_PAGE }: RescheduleLegInput
): Promise<RescheduleLegOutcome> {
  // Which caller moved it — the shared log lines would otherwise be ambiguous.
  const source = leg.metadata.source;

  // Restore the old row. Guard on the status WE set so we only revive a row we
  // froze, and .select() so a 0-row rollback (row concurrently changed/deleted) is
  // a failure rather than a false success.
  const restoreOldLeg = async (): Promise<{ restored: boolean; rbErr: DbError | null }> => {
    const { data: restored, error: rbErr } = await supabase
      .from("appointments")
      .update({ status: before.status })
      .eq("id", oldId)
      .eq("organization_id", orgId)
      .eq("status", "rescheduled")
      .select("id");
    return { restored: !rbErr && Array.isArray(restored) && restored.length > 0, rbErr: rbErr ?? null };
  };

  // Old freed, new not created, rollback didn't restore → the customer is stranded
  // with a superseded-but-not-replaced appointment. Page on-call for EVERY caller:
  // pageSentry's [ALERT:error] line is the alertable signal (@sentry/nextjs has no
  // DSN in production, SCRUM-320).
  const pageOrphaned = (step: "free" | "insert", cause: DbError, rbErr: DbError | null) => {
    console.error("[reschedule-leg] rollback FAILED — orphaned old leg", {
      orgId,
      oldId,
      source,
      ...(step === "insert" ? { insErr: cause.message } : { freeErr: cause.message }),
      rbErr: rbErr?.message ?? "0 rows restored",
    });
    pageSentry({
      service: "next-api",
      reason: SENTRY_REASONS.RESCHEDULE_LEG_ORPHANED,
      level: "error",
      message: orphanPage.message,
      tags: { bug: orphanPage.tag },
      extras: {
        orgId,
        oldId,
        source,
        // The owner's call, when the move was made on one (never inserted anywhere else).
        ...(leg.callId ? { callId: leg.callId } : {}),
        ...(step === "insert" ? { insErrCode: cause.code } : { freeErrCode: cause.code }),
        rbErrCode: rbErr?.code,
      },
    });
  };

  // After a free that ERRORED: did it commit anyway (the response was lost)? Only
  // when the old row now reads `rescheduled` AND no leg points back at it — a row
  // that another move superseded has its own new leg and must never be revived. A
  // failed look answers "no" (logged): the caller reports free_failed, as before.
  const freeCommittedWithoutLeg = async (): Promise<boolean> => {
    const { data: row, error: readErr } = await supabase
      .from("appointments")
      .select("status")
      .eq("id", oldId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (readErr) {
      console.error("[reschedule-leg] could not re-read the old leg after a failed free:", { orgId, oldId, source, error: readErr });
      return false;
    }
    if (row?.status !== "rescheduled") return false;
    const { data: successors, error: succErr } = await supabase
      .from("appointments")
      .select("id")
      .eq("rescheduled_from_id", oldId)
      .eq("organization_id", orgId)
      .limit(1);
    if (succErr) {
      console.error("[reschedule-leg] could not look for a newer leg after a failed free:", { orgId, oldId, source, error: succErr });
      return false;
    }
    return Array.isArray(successors) && successors.length === 0;
  };

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
    console.error("[reschedule-leg] failed to free old leg:", { orgId, oldId, source, error: freeErr });
    // An error can hide a free that committed: the row would sit `rescheduled` with
    // no new leg while the caller reads "nothing changed". Undo it if so.
    if (await freeCommittedWithoutLeg()) {
      const { restored, rbErr } = await restoreOldLeg();
      if (!restored) {
        pageOrphaned("free", freeErr, rbErr);
        return { ok: false, reason: "orphaned", error: freeErr };
      }
    }
    return { ok: false, reason: "free_failed", error: freeErr };
  }
  if (!freed || freed.length === 0) {
    return { ok: false, reason: "not_active" };
  }

  // 2. Insert the new leg — the old row's fields with the edits applied, a fresh
  //    confirmation_code (UNIQUE; the old code stays on the superseded row).
  const legFields = buildRescheduleLegFields(before, updates);
  const newRow = () => ({
    ...legFields,
    organization_id: orgId,
    provider: leg.provider,
    confirmation_code: generateConfirmationCode(),
    rescheduled_from_id: oldId,
    metadata: leg.metadata,
    ...(leg.callId ? { call_id: leg.callId } : {}),
  });

  let { data: inserted, error: insErr } = await supabase
    .from("appointments")
    .insert(newRow())
    .select(LEG_SELECT)
    .single();

  // SCRUM-431 (finding #49): one retry on a confirmation-code collision — same
  // classification discipline as bookInternal.
  if (insErr && insErr.code === "23505" && /confirmation_code/i.test(insErr.message || "")) {
    console.warn("[reschedule-leg] confirmation-code collision on leg insert — retrying once", { orgId, oldId, source });
    ({ data: inserted, error: insErr } = await supabase
      .from("appointments")
      .insert(newRow())
      .select(LEG_SELECT)
      .single());
  }

  if (!insErr) {
    return { ok: true, inserted };
  }

  // 3. The move failed — restore the old row so the customer keeps their slot.
  const { restored, rbErr } = await restoreOldLeg();
  if (!restored) {
    // Report it as orphaned even on a 23P01 — never the look-alike conflict, which
    // would mask the data loss.
    pageOrphaned("insert", insErr, rbErr);
    return { ok: false, reason: "orphaned", error: insErr };
  }

  // Rollback succeeded — the customer keeps their original appointment.
  if (insErr.code === "23P01") {
    return { ok: false, reason: "conflict" };
  }
  console.error("[reschedule-leg] failed to insert reschedule leg (original kept):", { orgId, oldId, source, error: insErr });
  return { ok: false, reason: "insert_failed", error: insErr };
}
