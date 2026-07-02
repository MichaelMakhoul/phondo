/**
 * Cliniko catalog import (SCRUM-12): mirrors the practice's practitioners and
 * appointment types into the local `practitioners` / `service_types` tables so
 * every existing surface (prompt builder, round-robin, dashboard, verification)
 * keeps working unchanged for Cliniko-connected orgs.
 *
 * Rules:
 * - Upserts key on (organization_id, external_provider, external_id).
 * - `is_active` is intentionally NEVER written on upsert — new rows get the
 *   column default (true) and local operator toggles are preserved on re-sync.
 * - Rows whose external counterpart vanished/archived are deactivated, never
 *   deleted (history and FK references stay intact). Never force-reactivated.
 * - Practitioner↔service capability links are over-approximated (full cross
 *   product): Cliniko's available_times is the real capability filter, so an
 *   impossible combination simply never yields a slot.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
import type { ClinikoClient } from "./cliniko";

export interface ClinikoSyncResult {
  practitionersUpserted: number;
  serviceTypesUpserted: number;
  deactivated: number;
}

interface LocalRef {
  id: string;
  external_id: string;
}

export async function syncClinikoCatalog(
  organizationId: string,
  client: ClinikoClient,
  // The selected business (location). Scopes practitioners so a multi-location
  // account doesn't import the other site's staff (who would never have slots
  // at this location → perpetual "no availability"). Omitted → whole account.
  businessId?: string
): Promise<ClinikoSyncResult> {
  const supabase = createAdminClient();
  const errors: string[] = [];
  const now = new Date().toISOString();

  const [practitioners, appointmentTypes] = await Promise.all([
    client.listPractitioners(businessId),
    client.listAppointmentTypes(),
  ]);
  const activePractitioners = practitioners.filter((p) => p.active);
  const activeTypes = appointmentTypes.filter((t) => !t.archived_at);

  let practitionerRefs: LocalRef[] = [];
  if (activePractitioners.length > 0) {
    const { data, error } = await (supabase as any)
      .from("practitioners")
      .upsert(
        activePractitioners.map((p) => ({
          organization_id: organizationId,
          name: `${p.first_name} ${p.last_name}`.trim() || "Practitioner",
          external_provider: "cliniko",
          external_id: p.id,
          updated_at: now,
        })),
        { onConflict: "organization_id,external_provider,external_id" }
      )
      .select("id, external_id");
    if (error) errors.push(`practitioners upsert: ${error.message || error.code}`);
    else practitionerRefs = (data || []) as LocalRef[];
  }

  let serviceRefs: LocalRef[] = [];
  if (activeTypes.length > 0) {
    const { data, error } = await (supabase as any)
      .from("service_types")
      .upsert(
        activeTypes.map((t) => ({
          organization_id: organizationId,
          name: t.name,
          duration_minutes: t.duration_in_minutes,
          external_provider: "cliniko",
          external_id: t.id,
          updated_at: now,
        })),
        { onConflict: "organization_id,external_provider,external_id" }
      )
      .select("id, external_id");
    if (error) errors.push(`service_types upsert: ${error.message || error.code}`);
    else serviceRefs = (data || []) as LocalRef[];
  }

  // Deactivation pass: only ever disables; reactivation stays a local decision.
  let deactivated = 0;
  deactivated += await deactivateStale(supabase, "practitioners", organizationId, activePractitioners.map((p) => p.id), now, errors);
  deactivated += await deactivateStale(supabase, "service_types", organizationId, activeTypes.map((t) => t.id), now, errors);

  if (practitionerRefs.length > 0 && serviceRefs.length > 0) {
    const linkRows = practitionerRefs.flatMap((p) =>
      serviceRefs.map((s) => ({ practitioner_id: p.id, service_type_id: s.id }))
    );
    const { error } = await (supabase as any)
      .from("practitioner_services")
      .upsert(linkRows, { onConflict: "practitioner_id,service_type_id", ignoreDuplicates: true });
    if (error) errors.push(`practitioner_services upsert: ${error.message || error.code}`);
  }

  // Even a partial sync changes what the voice pipeline should see.
  await invalidateVoiceScheduleCache(organizationId);

  if (errors.length > 0) {
    throw new Error(`Cliniko catalog sync completed with errors: ${errors.join("; ")}`);
  }

  return {
    practitionersUpserted: practitionerRefs.length,
    serviceTypesUpserted: serviceRefs.length,
    deactivated,
  };
}

async function deactivateStale(
  supabase: unknown,
  table: "practitioners" | "service_types",
  organizationId: string,
  activeExternalIds: string[],
  now: string,
  errors: string[]
): Promise<number> {
  const activeSet = new Set(activeExternalIds);
  const { data, error } = await (supabase as any)
    .from(table)
    .select("id, external_id")
    .eq("organization_id", organizationId)
    .eq("external_provider", "cliniko")
    .eq("is_active", true);
  if (error) {
    errors.push(`${table} stale lookup: ${error.message || error.code}`);
    return 0;
  }
  const staleIds = ((data || []) as LocalRef[])
    .filter((row) => !activeSet.has(row.external_id))
    .map((row) => row.id);
  if (staleIds.length === 0) return 0;

  const { error: updateError } = await (supabase as any)
    .from(table)
    .update({ is_active: false, updated_at: now })
    .eq("organization_id", organizationId)
    .in("id", staleIds);
  if (updateError) {
    errors.push(`${table} deactivate: ${updateError.message || updateError.code}`);
    return 0;
  }
  return staleIds.length;
}
