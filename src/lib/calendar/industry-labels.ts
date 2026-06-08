// SCRUM-397: industry-generic labels for appointment fields. The DB stores
// `practitioner_id` / `service_type_id` generically, but the UI must not say
// "Doctor" for a plumber or "Treatment" for a law firm. Resolve human-facing
// labels from `organizations.industry` (same keys as the prompt-builder
// FieldCategory / template set), falling back to neutral defaults.

export interface AppointmentLabels {
  /** Who performs the appointment (dentist / attorney / technician / …). */
  practitioner: string;
  /** What the appointment is for (treatment / matter / job / …). */
  service: string;
}

const DEFAULT_LABELS: AppointmentLabels = {
  practitioner: "Practitioner",
  service: "Service",
};

// Per-industry overrides. Keys match `organizations.industry`. Anything not listed
// (incl. "universal"/"other"/null) falls back to DEFAULT_LABELS — so a new or
// generic industry is never mislabeled, just neutral.
const INDUSTRY_LABELS: Record<string, AppointmentLabels> = {
  medical: { practitioner: "Provider", service: "Visit type" },
  dental: { practitioner: "Dentist", service: "Treatment" },
  legal: { practitioner: "Attorney", service: "Matter type" },
  home_services: { practitioner: "Technician", service: "Job type" },
  real_estate: { practitioner: "Agent", service: "Service" },
  salon: { practitioner: "Stylist", service: "Service" },
  automotive: { practitioner: "Technician", service: "Service" },
  veterinary: { practitioner: "Vet", service: "Service" },
  restaurant: { practitioner: "Host", service: "Booking type" },
  accounting: { practitioner: "Accountant", service: "Service" },
  insurance: { practitioner: "Agent", service: "Policy type" },
  fitness: { practitioner: "Trainer", service: "Class" },
  childcare: { practitioner: "Carer", service: "Service" },
  funeral_services: { practitioner: "Director", service: "Service" },
};

/**
 * Resolve the practitioner/service labels for an org's industry. Unknown or empty
 * industries get neutral defaults ("Practitioner" / "Service").
 */
export function getAppointmentLabels(
  industry: string | null | undefined
): AppointmentLabels {
  if (!industry) return DEFAULT_LABELS;
  return INDUSTRY_LABELS[industry] ?? DEFAULT_LABELS;
}
