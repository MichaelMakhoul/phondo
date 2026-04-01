import { createAdminClient } from "@/lib/supabase/admin";

export type ClientType = "new" | "returning" | "regular";

export interface ClientHistory {
  clientType: ClientType;
  totalAppointments: number;
  totalCalls: number;
  firstSeen: string | null;
  lastSeen: string | null;
  previousAppointments: {
    id: string;
    start_time: string;
    status: string;
    service_type_name: string | null;
    practitioner_name: string | null;
  }[];
}

/**
 * Get client history by phone number.
 * Uses phone as primary identifier (most reliable — names are often misspelled).
 */
export async function getClientHistory(
  phone: string,
  organizationId: string
): Promise<ClientHistory> {
  const supabase = createAdminClient();

  // Normalize phone — match last 9 digits to handle format variations
  const digits = phone.replace(/\D/g, "");
  const phoneSuffix = digits.length > 9 ? digits.slice(-9) : digits;

  // Fetch appointments and calls in parallel
  const [appointmentsResult, callsResult] = await Promise.all([
    (supabase as any)
      .from("appointments")
      .select("id, start_time, status, service_type_id, practitioner_id, service_types(name), practitioners(name)")
      .eq("organization_id", organizationId)
      .ilike("attendee_phone", `%${phoneSuffix}%`)
      .order("start_time", { ascending: false })
      .limit(20),
    (supabase as any)
      .from("calls")
      .select("id, created_at", { count: "exact", head: false })
      .eq("organization_id", organizationId)
      .ilike("caller_phone", `%${phoneSuffix}%`)
      .limit(1), // Just need the count
  ]);

  const appointments = appointmentsResult.data || [];
  const totalCalls = callsResult.count || 0;
  const totalAppointments = appointments.length;

  // Determine client type
  const totalInteractions = totalAppointments + totalCalls;
  let clientType: ClientType = "new";
  if (totalInteractions >= 4) clientType = "regular";
  else if (totalInteractions >= 2) clientType = "returning";

  // Find first and last seen
  const allDates = [
    ...appointments.map((a: any) => a.start_time),
    ...(callsResult.data || []).map((c: any) => c.created_at),
  ].filter(Boolean).sort();

  return {
    clientType,
    totalAppointments,
    totalCalls,
    firstSeen: allDates[0] || null,
    lastSeen: allDates[allDates.length - 1] || null,
    previousAppointments: appointments.map((a: any) => ({
      id: a.id,
      start_time: a.start_time,
      status: a.status,
      service_type_name: a.service_types?.name || null,
      practitioner_name: a.practitioners?.name || null,
    })),
  };
}
