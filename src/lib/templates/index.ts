import { dentalTemplate } from './dental';
import { legalTemplate } from './legal';
import { homeServicesTemplate } from './home-services';
import { medicalTemplate } from './medical';
import { realEstateTemplate } from './real-estate';
import { otherTemplate } from './other';
import { salonTemplate } from './salon';
import { automotiveTemplate } from './automotive';
import { veterinaryTemplate } from './veterinary';
import { restaurantTemplate } from './restaurant';
import { accountingTemplate } from './accounting';
import { insuranceTemplate } from './insurance';
import { fitnessTemplate } from './fitness';
import { childcareTemplate } from './childcare';
import { funeralServicesTemplate } from './funeral-services';

export interface AssistantTemplate {
  industry: string;
  name: string;
  description: string;
  systemPrompt: string;
  firstMessage: string;
  sampleFAQs: Array<{ question: string; answer: string }>;
  voiceId: string;
  recommendedSettings: {
    maxCallDuration: number;
    silenceTimeout: number;
    interruptionThreshold: number;
  };
}

export const templates: Record<string, AssistantTemplate> = {
  dental: dentalTemplate,
  legal: legalTemplate,
  home_services: homeServicesTemplate,
  medical: medicalTemplate,
  real_estate: realEstateTemplate,
  salon: salonTemplate,
  automotive: automotiveTemplate,
  veterinary: veterinaryTemplate,
  restaurant: restaurantTemplate,
  accounting: accountingTemplate,
  insurance: insuranceTemplate,
  fitness: fitnessTemplate,
  childcare: childcareTemplate,
  funeral_services: funeralServicesTemplate,
  other: otherTemplate,
};

export const getTemplateByIndustry = (industry: string): AssistantTemplate => {
  return templates[industry] || templates.other;
};

export const getAllTemplates = (): AssistantTemplate[] => {
  return Object.values(templates);
};

export const getIndustryTemplates = (): AssistantTemplate[] => {
  return Object.values(templates);
};

export const industryOptions = [
  { value: 'dental', label: 'Dental Practice', description: 'Dentists, orthodontists, oral surgeons' },
  { value: 'legal', label: 'Law Firm', description: 'Attorneys, legal services' },
  { value: 'home_services', label: 'Home Services', description: 'Plumbers, electricians, HVAC, contractors' },
  { value: 'medical', label: 'Medical Practice', description: 'Doctors, clinics, healthcare providers' },
  // Phase 2 — coming soon (requires CRM/listing integration)
  // { value: 'real_estate', label: 'Real Estate', description: 'Agents, brokers, property management' },
  // Phase 2 — coming soon
  // { value: 'salon', label: 'Salon / Spa / Beauty', description: 'Hair salons, spas, nail salons, barbershops' },
  // Phase 2 — coming soon
  // { value: 'automotive', label: 'Automotive / Mechanic', description: 'Auto repair, mechanics, body shops' },
  // Phase 2 — coming soon
  // { value: 'veterinary', label: 'Veterinary / Pet Care', description: 'Vet clinics, animal hospitals, pet care' },
  // Phase 2 — coming soon
  // { value: 'restaurant', label: 'Restaurant / Hospitality', description: 'Restaurants, cafes, catering, hotels' },
  // Phase 2 — coming soon
  // { value: 'accounting', label: 'Accounting / Bookkeeping', description: 'Accountants, tax agents, bookkeepers' },
  // Phase 2 — coming soon
  // { value: 'insurance', label: 'Insurance', description: 'Insurance brokers, agencies, claims' },
  // Phase 2 — coming soon
  // { value: 'fitness', label: 'Fitness / Gym', description: 'Gyms, studios, personal training, wellness centres' },
  // Phase 2 — coming soon
  // { value: 'childcare', label: 'Childcare / Daycare', description: 'Childcare centres, daycare, early learning' },
  // Phase 2 — coming soon
  // { value: 'funeral_services', label: 'Funeral Services', description: 'Funeral homes, memorial services, cremation' },
  { value: 'other', label: 'Other Business', description: 'General business receptionist' },
];

export const populateTemplate = (
  template: AssistantTemplate,
  variables: { business_name?: string; knowledge_base?: string }
): { systemPrompt: string; firstMessage: string } => {
  let systemPrompt = template.systemPrompt;
  let firstMessage = template.firstMessage;

  if (variables.business_name) {
    systemPrompt = systemPrompt.replace(/{business_name}/g, variables.business_name);
    firstMessage = firstMessage.replace(/{business_name}/g, variables.business_name);
  }

  if (variables.knowledge_base) {
    systemPrompt = systemPrompt.replace(/{knowledge_base}/g, variables.knowledge_base);
  } else {
    systemPrompt = systemPrompt.replace(/{knowledge_base}/g, 'No additional business information provided yet.');
  }

  return { systemPrompt, firstMessage };
};

export const DEFAULT_RECORDING_DISCLOSURE =
  'Thank you for calling {business_name}. You are speaking with an AI assistant and this call may be recorded for quality purposes. If you\'d prefer not to be recorded, just let me know and I can transfer you to a team member. By staying on the line, you consent to both.';

export const RECORDING_DECLINE_SYSTEM_INSTRUCTION =
  'IMPORTANT: If the caller says they do not want to be recorded or do not consent to recording, politely acknowledge their preference and offer to transfer them to a team member using the transfer_call tool. Do not pressure them to stay on the line.';

export function resolveRecordingSettings(settings: Record<string, any> | undefined): {
  recordingEnabled: boolean;
  recordingDisclosure: string | null;
} {
  const recordingEnabled = settings?.recordingEnabled ?? true;
  const recordingDisclosure = recordingEnabled
    ? (settings?.recordingDisclosure?.trim() || DEFAULT_RECORDING_DISCLOSURE)
    : null;
  return { recordingEnabled, recordingDisclosure };
}

export function buildFirstMessageWithDisclosure(
  firstMessage: string,
  disclosure: string | null | undefined,
  businessName: string
): string {
  if (!disclosure) return firstMessage;
  const populated = disclosure.replace(/{business_name}/g, businessName || 'our office');
  return `${populated} ${firstMessage}`;
}

export {
  dentalTemplate,
  legalTemplate,
  homeServicesTemplate,
  medicalTemplate,
  realEstateTemplate,
  otherTemplate,
  salonTemplate,
  automotiveTemplate,
  veterinaryTemplate,
  restaurantTemplate,
  accountingTemplate,
  insuranceTemplate,
  fitnessTemplate,
  childcareTemplate,
  funeralServicesTemplate,
};
