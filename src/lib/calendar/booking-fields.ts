// src/lib/calendar/booking-fields.ts
// SCRUM-602: the business's caller fields (Assistants → Caller Data Collection,
// `assistants.prompt_config.fields`) are read by the receptionist's booking path AND the
// owner assistant's — the owner handler asks for the required ones before its read-back,
// the booking path enforces the name rules as its backstop. Both must see the SAME row:
// an org on a plan with several assistants would otherwise let the two unordered
// `.limit(1)` reads pick different assistants, and a booking could pass the owner's check
// and still be refused after the owner's yes. Oldest assistant first, on both.

/** The one `prompt_config` row both booking paths read, in a fixed order. */
export function bookingFieldsQuery(supabase: any, organizationId: string): PromiseLike<{ data: { prompt_config?: unknown } | null; error: { code?: string; message?: string } | null }> {
  return supabase
    .from("assistants")
    .select("prompt_config")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
}
