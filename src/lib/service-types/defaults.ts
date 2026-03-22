export interface ServiceTypeDefault {
  name: string;
  duration_minutes: number;
  description?: string;
}

export const industryServiceDefaults: Record<string, ServiceTypeDefault[]> = {
  dental: [
    { name: "Check-up & Clean", duration_minutes: 45, description: "Routine dental examination and cleaning" },
    { name: "Consultation", duration_minutes: 30, description: "General dental consultation" },
    { name: "Emergency", duration_minutes: 30, description: "Urgent dental issue" },
    { name: "Filling", duration_minutes: 45, description: "Dental filling procedure" },
    { name: "Root Canal", duration_minutes: 90, description: "Root canal treatment" },
  ],
  medical: [
    { name: "Standard Consultation", duration_minutes: 15, description: "General doctor consultation" },
    { name: "Extended Consultation", duration_minutes: 30, description: "Longer consultation for complex issues" },
    { name: "Health Assessment", duration_minutes: 45, description: "Comprehensive health check" },
    { name: "Vaccination", duration_minutes: 15, description: "Immunisation appointment" },
  ],
  veterinary: [
    { name: "Routine Checkup", duration_minutes: 20, description: "General pet health examination" },
    { name: "Vaccination", duration_minutes: 15, description: "Pet vaccination" },
    { name: "Surgery Consultation", duration_minutes: 30, description: "Pre-surgery consultation" },
    { name: "Emergency", duration_minutes: 30, description: "Urgent pet care" },
  ],
  salon: [
    { name: "Haircut", duration_minutes: 30, description: "Standard haircut" },
    { name: "Cut & Colour", duration_minutes: 90, description: "Haircut with colour treatment" },
    { name: "Styling / Blowout", duration_minutes: 45, description: "Blow dry and styling" },
    { name: "Treatment", duration_minutes: 60, description: "Hair or scalp treatment" },
  ],
  fitness: [
    { name: "Personal Training", duration_minutes: 60, description: "One-on-one training session" },
    { name: "Group Class", duration_minutes: 45, description: "Group fitness class" },
    { name: "Assessment", duration_minutes: 30, description: "Fitness assessment" },
  ],
  legal: [
    { name: "Initial Consultation", duration_minutes: 30, description: "First meeting to discuss your matter" },
    { name: "Follow-up Meeting", duration_minutes: 15, description: "Follow-up on an existing matter" },
    { name: "Case Review", duration_minutes: 60, description: "Detailed case review session" },
  ],
  home_services: [
    { name: "Quote / Estimate", duration_minutes: 30, description: "On-site quote or estimate" },
    { name: "Service Call", duration_minutes: 60, description: "Standard service visit" },
    { name: "Emergency Callout", duration_minutes: 30, description: "Urgent service call" },
  ],
  other: [
    { name: "Appointment", duration_minutes: 30, description: "Standard appointment" },
    { name: "Consultation", duration_minutes: 60, description: "Extended consultation" },
  ],
};

export function getServiceDefaults(industry: string): ServiceTypeDefault[] {
  return industryServiceDefaults[industry] || industryServiceDefaults.other;
}
