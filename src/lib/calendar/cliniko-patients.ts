/**
 * Patient find-or-create for Cliniko bookings (SCRUM-12).
 *
 * Cliniko's patient list canNOT be filtered by phone number, so matching is:
 *   1. Local link cache (crm_patient_links: phone key -> patient id), verified
 *      against the live patient record by name before trust.
 *   2. Name search (exact, then contains) with client-side phone corroboration
 *      against the returned patient_phone_numbers.
 *   3. Create a minimal patient; if name-matches existed but none corroborated,
 *      surface a duplicate warning for the practice to review/merge.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { ClinikoClient, ClinikoPatient } from "./cliniko";

export interface PatientResolution {
  patientId: string;
  created: boolean;
  /** When a new patient was created despite name matches that phone couldn't
   *  corroborate, the id of the nearest possible duplicate (for a review note).
   *  Only ever set when `created` is true. Structured (not a rendered sentence)
   *  so the consumer controls what identity, if any, is written where. */
  duplicatePatientId?: string;
}

/** Strip to digits and keep the last 9 — collapses 04xx / +614xx / 614xx AU forms. */
export function normalizePhoneForMatch(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 8) return null;
  return digits.slice(-9);
}

function foldName(name: string | null | undefined): string {
  return (name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/** Last names must match; first initials must match when both sides have one. */
export function namesLooselyMatch(aFirst: string, aLast: string, bFirst: string, bLast: string): boolean {
  const al = foldName(aLast);
  const bl = foldName(bLast);
  if (!al || al !== bl) return false;
  const af = foldName(aFirst);
  const bf = foldName(bFirst);
  if (!af || !bf) return true;
  return af[0] === bf[0];
}

function patientPhoneMatches(patient: ClinikoPatient, phoneKey: string | null): boolean {
  if (!phoneKey) return false;
  return (patient.patient_phone_numbers || []).some(
    (n) => normalizePhoneForMatch(n.number) === phoneKey
  );
}

function patientDisplayName(p: ClinikoPatient): string {
  return [p.first_name, p.last_name].filter(Boolean).join(" ");
}

async function readCachedLink(organizationId: string, phoneKey: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data, error } = await (supabase as any)
    .from("crm_patient_links")
    .select("external_patient_id, patient_name")
    .eq("organization_id", organizationId)
    .eq("provider", "cliniko")
    .eq("phone_key", phoneKey)
    .maybeSingle();
  if (error) {
    console.warn("[Cliniko] patient link cache read failed — treating as miss:", error.message || error);
    return null;
  }
  return data?.external_patient_id ? String(data.external_patient_id) : null;
}

async function upsertLink(organizationId: string, phoneKey: string, patient: ClinikoPatient): Promise<void> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await (supabase as any)
    .from("crm_patient_links")
    .upsert(
      {
        organization_id: organizationId,
        provider: "cliniko",
        phone_key: phoneKey,
        external_patient_id: patient.id,
        patient_name: patientDisplayName(patient),
        last_seen_at: now,
        updated_at: now,
      },
      { onConflict: "organization_id,provider,phone_key" }
    );
  if (error) {
    // Cache only — never fail a booking over it.
    console.warn("[Cliniko] patient link cache upsert failed:", error.message || error);
  }
}

export async function findOrCreateClinikoPatient(opts: {
  client: ClinikoClient;
  organizationId: string;
  firstName: string;
  lastName: string;
  phone?: string;
}): Promise<PatientResolution> {
  const { client, organizationId } = opts;
  const firstName = (opts.firstName || "").trim();
  const lastName = (opts.lastName || "").trim();
  const phoneKey = normalizePhoneForMatch(opts.phone);

  // 1) Link cache, verified against the live record before trusting it.
  if (phoneKey) {
    const cachedId = await readCachedLink(organizationId, phoneKey);
    if (cachedId) {
      const cached = await client.getPatient(cachedId);
      if (cached && !cached.archived_at && namesLooselyMatch(firstName, lastName, cached.first_name, cached.last_name)) {
        await upsertLink(organizationId, phoneKey, cached); // bump last_seen_at
        return { patientId: cached.id, created: false };
      }
      // Cache is stale (different caller now owns the number, patient archived,
      // or record renamed) — fall through to a real search.
    }
  }

  // 2) Name search: exact first, contains as fallback for hyphenated/short forms.
  let candidates = await client.findPatientsByName(firstName, lastName);
  if (candidates.length === 0) {
    candidates = await client.findPatientsByName(firstName, lastName, { contains: true });
  }
  candidates = candidates.filter((p) => !p.archived_at);

  if (candidates.length > 0) {
    if (phoneKey) {
      const corroborated = candidates.filter((p) => patientPhoneMatches(p, phoneKey));
      if (corroborated.length === 1) {
        await upsertLink(organizationId, phoneKey, corroborated[0]);
        return { patientId: corroborated[0].id, created: false };
      }
    } else if (candidates.length === 1) {
      // No caller phone to corroborate with — a single name match is the best
      // available signal (browser/test calls, withheld caller ID).
      return { patientId: candidates[0].id, created: false };
    }
  }

  // 3) Create a minimal patient. Name matches that failed corroboration become
  //    a review note for the practice rather than a guessed identity.
  const created = await client.createPatient({
    firstName,
    lastName,
    phone: opts.phone,
  });
  if (phoneKey) {
    await upsertLink(organizationId, phoneKey, created);
  }

  const nearest = candidates[0];
  return {
    patientId: created.id,
    created: true,
    ...(nearest && { duplicatePatientId: nearest.id }),
  };
}
