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
    console.error("[ServiceTypes] Failed to fetch:", error);
    return [];
  }
  return data || [];
}

export async function getServiceType(serviceTypeId: string): Promise<ServiceType | null> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("service_types")
    .select("id, name, duration_minutes, description")
    .eq("id", serviceTypeId)
    .single();

  if (error) return null;
  return data;
}
