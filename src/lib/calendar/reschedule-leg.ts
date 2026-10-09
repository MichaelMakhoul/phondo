// SCRUM-586: the reschedule-leg ORCHESTRATION (previously inline in the dashboard
// PATCH route — SCRUM-399) so the owner assistant and the dashboard move an
// appointment through one code path. Free the OLD row FIRST (a row never
// conflicts with itself, but the NEW row would collide with the still-live old
// one on the GiST no-overlap constraint), insert the new leg linked by
// rescheduled_from_id, and ROLL BACK the old row if the insert fails so the
// customer keeps their slot. Pure field carry-over stays in reschedule-core.ts.
import * as Sentry from "@sentry/nextjs";
import { buildRescheduleLegFields } from "@/lib/calendar/reschedule-core";
import { generateConfirmationCode } from "@/lib/calendar/confirmation-code";

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
   * Sentry identity (`bug` tag + message) of the page raised when the rollback
   * fails and the old leg is orphaned. Defaults to the generic reschedule page;
   * a caller with an established page passes its own so the Sentry issue and any
   * alert rules keyed on the tag/message keep matching.
   */
  orphanPage?: { tag: string; message: string };
}

type DbError = { message?: string; code?: string };

export type RescheduleLegOutcome =
  | { ok: true; inserted: any } // new leg row (LEG_SELECT: *, service_types(name), practitioners(name))
  | { ok: false; reason: "free_failed"; error: DbError } // freeing the old row errored — no leg inserted, no rollback attempted
  | { ok: false; reason: "not_active" } // old row no longer confirmed/pending — nothing changed
  | { ok: false; reason: "conflict" } // 23P01 slot clash, old row restored
  | { ok: false; reason: "insert_failed"; error: DbError } // old row restored
  | { ok: false; reason: "orphaned"; error: DbError }; // rollback failed — Sentry paged

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

  // 3. The move failed — restore the old row. Guard on the status WE set so we
  //    only revive a row we froze, and .select() so a 0-row rollback (row
  //    concurrently changed/deleted) is a failure rather than a false success.
  const { data: restored, error: rbErr } = await supabase
    .from("appointments")
    .update({ status: before.status })
    .eq("id", oldId)
    .eq("organization_id", orgId)
    .eq("status", "rescheduled")
    .select("id");
  const rolledBack = !rbErr && Array.isArray(restored) && restored.length > 0;

  if (!rolledBack) {
    // Old freed, new not created, rollback didn't restore → the customer is
    // stranded with a superseded-but-not-replaced appointment. Page on-call, and
    // report it as orphaned even on a 23P01 — never the look-alike conflict,
    // which would mask the data loss.
    console.error("[reschedule-leg] rollback FAILED — orphaned old leg", {
      orgId, oldId, source, insErr: insErr.message, rbErr: rbErr?.message ?? "0 rows restored",
    });
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("bug", orphanPage.tag);
      scope.setExtras({ orgId, oldId, source });
      Sentry.captureMessage(orphanPage.message);
    });
    return { ok: false, reason: "orphaned", error: insErr };
  }

  // Rollback succeeded — the customer keeps their original appointment.
  if (insErr.code === "23P01") {
    return { ok: false, reason: "conflict" };
  }
  console.error("[reschedule-leg] failed to insert reschedule leg (original kept):", { orgId, oldId, source, error: insErr });
  return { ok: false, reason: "insert_failed", error: insErr };
}
