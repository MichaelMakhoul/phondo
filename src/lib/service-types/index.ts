import { createAdminClient } from "@/lib/supabase/admin";

export interface ServiceType {
  id: string;
  name: string;
  duration_minutes: number;
  description: string | null;
}

export async function getActiveServiceTypes(organizationId: string): Promise<ServiceType[]> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("service_types")
    .select("id, name, duration_minutes, description")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("[ServiceTypes] CRITICAL: Failed to fetch service types — booking may use wrong routing:", { organizationId, error });
    return [];
  }
  return data || [];
}

/**
 * Fetch one org-scoped service type.
 *
 * SCRUM-444 review: not-found and DB errors must NOT be conflated. Returns null
 * ONLY for a true not-found (PGRST116 — unknown or cross-org id), so callers can
 * safely tell the caller "that appointment type doesn't exist here". A real DB
 * error THROWS instead — a transient blip must surface as "having trouble", not
 * as the service not existing.
 */
export async function getServiceType(serviceTypeId: string, organizationId: string): Promise<ServiceType | null> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("service_types")
    .select("id, name, duration_minutes, description")
    .eq("id", serviceTypeId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // no rows — genuine not-found
    console.error("[ServiceTypes] Failed to fetch service type:", { serviceTypeId, organizationId, error });
    throw new Error(`Failed to fetch service type: ${error.message}`);
  }
  return data;
}
